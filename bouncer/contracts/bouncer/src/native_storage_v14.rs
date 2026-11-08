//! Fresh-state testnet prototype: bounded, public NEAR contract storage.
//! This is self-hosted protocol storage, not an independent storage vendor.
//! Data and transaction arguments are public; never put secrets here.
//! An owner-reviewed route and the native policy both constrain the agent.
use super::*;

const MAX_VALUE_BYTES: u32 = 4096;
const RECORD_PREFIX: &[u8] = b"\0bouncer-v14-storage-object\0";
const ROUTE_PREFIX: &[u8] = b"\0bouncer-v14-storage-route\0";

#[derive(Clone, Debug, PartialEq, Eq, near_sdk::serde::Serialize, near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct NativeStorageRoute {
    pub prefix: String,
    pub max_value_bytes: u32,
    pub route_revision: u64,
    pub policy_revision: u64,
    pub payee_revision: u64,
    pub active: bool,
}

#[derive(near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct NativeStorageObject {
    pub policy_id: String,
    pub object_id: String,
    pub value: String,
    pub value_sha256: String,
    pub value_bytes: u32,
    pub stake_yocto: U128,
}

#[derive(near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct NativeStorageRelease {
    pub refunded_to_vault_yocto: U128,
    pub permanently_reserved_yocto: U128,
}

fn valid_policy(policy: &str) -> bool { !policy.is_empty() && policy.len() <= 128 }
fn valid_name(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && value.bytes().all(|b|
        b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}
fn route_key(policy: &str) -> Vec<u8> {
    let mut key = ROUTE_PREFIX.to_vec(); key.extend(env::sha256(policy.as_bytes())); key
}
fn object_key(policy: &str, object: &str) -> Vec<u8> {
    // Two fixed-size hashes and separate prefixes avoid ambiguous concatenation
    // and collisions with the existing LookupMap and contract STATE keys.
    let mut key = RECORD_PREFIX.to_vec();
    key.extend(env::sha256(policy.as_bytes())); key.extend(env::sha256(object.as_bytes())); key
}
fn load_route(policy: &str) -> Option<NativeStorageRoute> {
    env::storage_read(&route_key(policy)).map(|b| near_sdk::serde_json::from_slice(&b)
        .unwrap_or_else(|_| abort_with("invalid native storage route")))
}
fn save_route(policy: &str, route: &NativeStorageRoute) {
    let bytes = near_sdk::serde_json::to_vec(route).unwrap_or_else(|_| abort_with("invalid native storage route"));
    env::storage_write(&route_key(policy), &bytes);
}
fn as_hex(bytes: &[u8]) -> String {
    const HEX: &[u8] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for &b in bytes { result.push(HEX[(b >> 4) as usize] as char); result.push(HEX[(b & 15) as usize] as char); }
    result
}
fn object_from_record(policy: String, object: String, record: &[u8]) -> Option<NativeStorageObject> {
    require(record.len() >= 17, "invalid native storage record");
    if record[0] == 0 { require(record.len() == 17, "invalid native storage tombstone"); return None; }
    require(record[0] == 1, "invalid native storage record");
    let stake = u128::from_le_bytes(record[1..17].try_into().unwrap());
    let value = String::from_utf8(record[17..].to_vec()).unwrap_or_else(|_| abort_with("invalid native storage value"));
    Some(NativeStorageObject { policy_id: policy, object_id: object, value_sha256: as_hex(&env::sha256(value.as_bytes())),
        value_bytes: value.len() as u32, value, stake_yocto: U128(stake) })
}
fn storage_backed(native_balance: u128) -> bool {
    let required = (env::storage_usage() as u128).checked_mul(env::storage_byte_cost().as_yoctonear())
        .and_then(|n| n.checked_add(native_balance)).and_then(|n| n.checked_add(NATIVE_SURPLUS_RESERVE));
    required.map_or(false, |n| env::account_balance().as_yoctonear() >= n)
}

#[near]
impl Bouncer {
    /// The owner authorizes only this vault, prefix and maximum object size.
    /// Any subsequent policy or allowlist edit invalidates the entire route;
    /// its monotonic revision prevents old signed calls being revived.
    #[payable]
    pub fn set_native_storage_route(&mut self, policy_id: String, prefix: String, max_value_bytes: u32) {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        require(env::current_account_id().as_str().ends_with(".testnet") && self.owner.as_str().ends_with(".testnet"),
            "testnet-named vault and owner required");
        require(valid_policy(&policy_id) && valid_name(&prefix, 48) && max_value_bytes > 0 && max_value_bytes <= MAX_VALUE_BYTES,
            "invalid native storage route");
        require(self.token_of.get(&policy_id).map(|t| t.as_str()) == Some(NATIVE_ASSET), "native storage requires native policy");
        let vault = env::current_account_id();
        require(self.allow.get(&allow_key(&policy_id, vault.as_str())) == Some(&true), "vault must be allowlisted for storage");
        let revision = load_route(&policy_id).map(|r| r.route_revision).unwrap_or(0)
            .checked_add(1).unwrap_or_else(|| abort_with("storage route revision overflow"));
        let route = NativeStorageRoute { prefix, max_value_bytes, route_revision: revision,
            policy_revision: self.ft_policy_revisions.get(&policy_id).copied().unwrap_or(0),
            payee_revision: self.allow_revisions.get(&(policy_id.clone(), vault)).copied().unwrap_or(0), active: true };
        save_route(&policy_id, &route);
    }

    #[payable]
    pub fn clear_native_storage_route(&mut self, policy_id: String) {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        require(valid_policy(&policy_id), "invalid storage policy id");
        let mut route = load_route(&policy_id).unwrap_or_else(|| abort_with("no storage route"));
        route.route_revision = route.route_revision.checked_add(1).unwrap_or_else(|| abort_with("storage route revision overflow"));
        route.active = false;
        save_route(&policy_id, &route);
    }

    pub fn get_native_storage_route(&self, policy_id: String) -> Option<NativeStorageRoute> {
        if !valid_policy(&policy_id) { return None; }
        let mut route = load_route(&policy_id)?;
        let vault = env::current_account_id();
        route.active = route.active && self.token_of.get(&policy_id).map(|t| t.as_str()) == Some(NATIVE_ASSET) &&
            self.ft_policy_revisions.get(&policy_id) == Some(&route.policy_revision) &&
            self.allow.get(&allow_key(&policy_id, vault.as_str())) == Some(&true) &&
            self.allow_revisions.get(&(policy_id, vault)) == Some(&route.payee_revision);
        Some(route)
    }

    /// Atomically reserve NEAR storage stake under the policy and write one
    /// immutable, PUBLIC object. No external transfer or provider is involved.
    /// `amount` is the reviewed worst case; only actual additional protocol
    /// storage stake is deducted. Object IDs are never reusable, even if the
    /// owner releases their data. One yocto is NEVER attached by an agent key.
    #[payable]
    pub fn execute_native_storage(&mut self, policy_id: String, amount: U128, object_id: String,
        value: String, expected_route: NativeStorageRoute) -> NativeStorageObject {
        require(env::attached_deposit() == ZERO_NEAR, "BLOCKED: native storage requires zero deposit");
        require(env::predecessor_account_id() == self.owner && env::signer_account_id() == self.owner,
            "BLOCKED: caller is not the owner account");
        require(self.agents.get(&(policy_id.clone(), env::signer_account_pk())) == Some(&true),
            "BLOCKED: signing key is not authorized for this policy");
        let route = self.get_native_storage_route(policy_id.clone()).unwrap_or_else(|| abort_with("BLOCKED: no storage route"));
        require(route.active && route == expected_route, "BLOCKED: storage route changed since review");
        require(valid_name(&object_id, 64) && object_id.starts_with(&route.prefix), "BLOCKED: storage object ID outside route");
        require(!value.is_empty() && value.len() <= route.max_value_bytes as usize, "BLOCKED: storage value exceeds route");
        let vault = env::current_account_id();
        // Validate the entire worst-case reservation before touching storage.
        let (token, balance) = validate(self, &policy_id, &vault, amount.0).unwrap_or_else(|m| abort_with(&m));
        require(token.as_str() == NATIVE_ASSET, "BLOCKED: storage policy changed");
        let key = object_key(&policy_id, &object_id);
        require(!env::storage_has_key(&key), "BLOCKED: storage object ID already reserved");
        let mut record = Vec::with_capacity(17 + value.len());
        record.push(1); record.extend_from_slice(&0u128.to_le_bytes()); record.extend_from_slice(value.as_bytes());
        let before = env::storage_usage();
        env::storage_write(&key, &record);
        let additional = env::storage_usage().checked_sub(before).unwrap_or_else(|| abort_with("invalid storage usage"));
        let stake = (additional as u128).checked_mul(env::storage_byte_cost().as_yoctonear())
            .unwrap_or_else(|| abort_with("storage stake overflow"));
        require(stake > 0 && stake <= amount.0, "BLOCKED: storage stake exceeds reviewed maximum");
        record[1..17].copy_from_slice(&stake.to_le_bytes());
        env::storage_write(&key, &record); // fixed-width stake; no added storage
        let next_balance = balance - stake;
        let bucket = env::block_timestamp() / NS_PER_HOUR;
        let dk = daily_key(&policy_id, bucket);
        let spent = self.daily_spent.get(&dk).copied().unwrap_or(0);
        let next = spent.checked_add(stake).unwrap_or_else(|| abort_with("daily spend overflow"));
        self.daily_spent.insert(dk, next);
        // LookupMap buffers writes. Include a newly created rolling-budget row
        // in storage_usage before checking that every tracked NEAR and the
        // operational reserve remain backed. A panic reverts the entire call.
        self.daily_spent.flush();
        require(storage_backed(next_balance), "BLOCKED: vault needs storage and operational reserve");
        self.native_balance = next_balance;
        env::log_str("BOUNCER public native storage written; stake reserved");
        object_from_record(policy_id, object_id, &record).unwrap()
    }

    /// Preflight only: a missing ID does not prove a transaction was never
    /// sent, and cannot replace the original-hash journal or trusted RPC.
    pub fn native_storage_id_reserved(&self, policy_id: String, object_id: String) -> bool {
        require(valid_policy(&policy_id) && valid_name(&object_id, 64), "invalid native storage object");
        env::storage_has_key(&object_key(&policy_id, &object_id))
    }

    /// Anyone can read this PUBLIC value. A tombstone is returned as None.
    pub fn get_native_storage_object(&self, policy_id: String, object_id: String) -> Option<NativeStorageObject> {
        if !valid_policy(&policy_id) || !valid_name(&object_id, 64) { return None; }
        let record = env::storage_read(&object_key(&policy_id, &object_id))?;
        object_from_record(policy_id, object_id, &record)
    }

    /// Owner-only release of the value. A minimal tombstone permanently keeps
    /// the ID reserved. Only actually released protocol stake, never more than
    /// the original reservation, is credited back; rolling spend stays counted.
    /// On-chain data and transaction history cannot be made private by deletion.
    #[payable]
    pub fn release_native_storage(&mut self, policy_id: String, object_id: String, expected_sha256: String) -> NativeStorageRelease {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        require(valid_policy(&policy_id) && valid_name(&object_id, 64), "invalid native storage object");
        let key = object_key(&policy_id, &object_id);
        let old = env::storage_read(&key).unwrap_or_else(|| abort_with("storage object missing"));
        let object = object_from_record(policy_id, object_id, &old).unwrap_or_else(|| abort_with("storage object already released"));
        require(object.value_sha256 == expected_sha256, "storage object changed since review");
        let before = env::storage_usage();
        let mut tombstone = vec![0]; tombstone.extend_from_slice(&0u128.to_le_bytes());
        env::storage_write(&key, &tombstone);
        let released = before.checked_sub(env::storage_usage()).unwrap_or_else(|| abort_with("invalid storage release"));
        let refund = (released as u128).checked_mul(env::storage_byte_cost().as_yoctonear())
            .unwrap_or_else(|| abort_with("storage release overflow")).min(object.stake_yocto.0);
        let balance = self.native_balance.checked_add(refund).unwrap_or_else(|| abort_with("native refund balance overflow"));
        require(storage_backed(balance), "BLOCKED: vault needs storage and operational reserve");
        self.native_balance = balance;
        env::log_str("BOUNCER public native storage released; tombstone retained");
        NativeStorageRelease { refunded_to_vault_yocto: U128(refund), permanently_reserved_yocto: U128(object.stake_yocto.0 - refund) }
    }
}
