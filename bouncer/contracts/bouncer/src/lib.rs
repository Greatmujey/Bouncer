use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, ext_contract, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PublicKey};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const ZERO_NEAR: NearToken = NearToken::from_yoctonear(0);
const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_FOR_RESOLVE: Gas = Gas::from_tgas(15);
// OutLayer uses yield/resume. The caller must attach enough gas for this
// cross-contract request; the user's restricted key still attaches zero NEAR.
const GAS_FOR_OUTLAYER: Gas = Gas::from_tgas(220);
// `native` is a reserved policy asset, not a fungible-token contract.
const NATIVE_ASSET: &str = "native";
const OUTLAYER_TESTNET: &str = "outlayer.testnet";
const NATIVE_SURPLUS_RESERVE: u128 = 50_000_000_000_000_000_000_000; // 0.05 NEAR
const MAX_OUTLAYER_INPUT_BYTES: usize = 4096;
const NS_PER_HOUR: u64 = 60 * 60 * 1_000_000_000;
const WINDOW_HOURS: u64 = 24;
#[cfg(test)]
const NS_PER_DAY: u64 = WINDOW_HOURS * NS_PER_HOUR;

// Preserve readable errors in optimized WASM; use a normal panic in native tests.
#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
extern "C" { fn panic_utf8(len: u64, ptr: u64) -> !; }
#[cfg(target_arch = "wasm32")]
fn abort_with(msg: &str) -> ! {
    unsafe { panic_utf8(msg.len() as u64, msg.as_ptr() as u64); }
}
#[cfg(not(target_arch = "wasm32"))]
fn abort_with(msg: &str) -> ! { panic!("{}", msg); }
fn require(cond: bool, msg: &str) { if !cond { abort_with(msg); } }

#[ext_contract(ext_ft)]
trait ExtFt {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}
#[ext_contract(ext_self)]
trait ExtSelf {
    fn after_execute(&mut self, policy_id: String, token: AccountId, amount: U128, bucket: u64);
    fn after_withdraw(&mut self, token: AccountId, amount: U128);
    fn after_native_withdraw(&mut self, amount: U128);
}

/// Owner-reviewed source and resource limits; the agent must sign these exact
/// values, not merely a program name or a mutable external project version.
#[derive(Clone, Debug, PartialEq, Eq, near_sdk::serde::Serialize, near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct OutlayerProgram {
    pub url: String,
    pub sha256: String,
    pub build_target: String,
    pub max_instructions: u64,
    pub max_memory_mb: u32,
    pub max_execution_seconds: u64,
}

#[derive(near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct PolicyView {
    pub token: AccountId,
    pub per_tx_cap: U128,
    /// Zero means that the daily cap is disabled.
    pub daily_cap: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Bouncer {
    owner: AccountId,
    token_of: LookupMap<String, AccountId>,
    cap_of: LookupMap<String, u128>,
    daily_of: LookupMap<String, u128>,
    allow: LookupMap<String, bool>,
    allow_count: LookupMap<String, u32>,
    balances: LookupMap<AccountId, u128>,
    daily_spent: LookupMap<String, u128>,
    // The signing key is explicitly authorized per policy, not merely by account.
    agents: LookupMap<(String, PublicKey), bool>,
    // Native NEAR is accounted separately from protocol storage and gas funds.
    native_balance: u128,
    // JSON is stored as a string so the existing map can persist the exact
    // owner-approved program without accepting a mutable provider project ID.
    outlayer_programs: LookupMap<String, String>,
}

fn allow_key(pid: &str, p: &str) -> String {
    let mut s = String::with_capacity(pid.len() + 1 + p.len());
    s.push_str(pid); s.push(':'); s.push_str(p); s
}
fn daily_key(pid: &str, bucket: u64) -> String {
    let mut s = String::with_capacity(pid.len() + 22);
    s.push_str(pid); s.push('|');
    let mut b = bucket;
    let mut digits = [0u8; 20];
    let mut i = 0;
    if b == 0 { digits[i] = b'0'; i += 1; } else {
        while b > 0 { digits[i] = b'0' + (b % 10) as u8; b /= 10; i += 1; }
        digits[..i].reverse();
    }
    for d in digits.iter().take(i) { s.push(*d as char); }
    s
}

// Sum the current hour and 24 preceding hours. Including the oldest bucket
// makes this conservative: no spend less than 24 hours old can fall out of
// the budget; some spend may remain counted for up to one additional hour.
fn rolling_spent(s: &Bouncer, policy_id: &str, current_hour: u64) -> u128 {
    let mut total = 0u128;
    for offset in 0..=WINDOW_HOURS {
        let Some(hour) = current_hour.checked_sub(offset) else { break; };
        let spent = s.daily_spent.get(&daily_key(policy_id, hour)).copied().unwrap_or(0);
        total = total.saturating_add(spent);
    }
    total
}

fn validate(
    s: &Bouncer, policy_id: &str, payee: &AccountId, amount: u128,
) -> Result<(AccountId, u128), String> {
    let cap = *s.cap_of.get(policy_id).ok_or("no such policy")?;
    let token = s.token_of.get(policy_id).cloned().ok_or("policy missing token")?;
    if amount == 0 { return Err("amount must be > 0".into()); }
    if amount > cap { return Err("BLOCKED: amount exceeds per-tx cap".into()); }
    // Fail closed: a policy with no allowed payees cannot spend.
    let k = allow_key(policy_id, payee.as_str());
    if s.allow.get(&k) != Some(&true) {
        return Err("BLOCKED: payee not in allowlist".into());
    }
    let daily = s.daily_of.get(policy_id).cloned().unwrap_or(0);
    if daily > 0 {
        let bucket = env::block_timestamp() / NS_PER_HOUR;
        let spent = rolling_spent(s, policy_id, bucket);
        if spent.checked_add(amount).map_or(true, |next| next > daily) {
            return Err("BLOCKED: daily cap exceeded for this policy".into());
        }
    }
    let bal = if token.as_str() == NATIVE_ASSET {
        s.native_balance
    } else {
        s.balances.get(&token).cloned().unwrap_or(0)
    };
    if bal < amount { return Err("BLOCKED: insufficient vault balance (fund first)".into()); }
    Ok((token, bal))
}

fn require_owner(s: &Bouncer, attached: NearToken) -> Result<(), String> {
    if attached != ONE_YOCTO {
        return Err("ESCALATION BLOCKED: owner-only method requires exactly 1 yoctoNEAR".into());
    }
    if env::predecessor_account_id() != s.owner {
        return Err("ESCALATION BLOCKED: caller is not owner".into());
    }
    Ok(())
}

#[near]
impl Bouncer {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        if owner.as_str().is_empty() { abort_with("owner must not be empty"); }
        Self {
            owner,
            token_of: LookupMap::new(b"t"), cap_of: LookupMap::new(b"c"),
            daily_of: LookupMap::new(b"d"),
            allow: LookupMap::new(b"a"), allow_count: LookupMap::new(b"n"),
            balances: LookupMap::new(b"b"),
            daily_spent: LookupMap::new(b"s"),
            agents: LookupMap::new(b"k"),
            native_balance: 0,
            outlayer_programs: LookupMap::new(b"o"),
        }
    }

    #[payable]
    pub fn set_policy(&mut self, policy_id: String, token: AccountId, per_tx_cap: U128, daily_cap: Option<U128>) {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        if per_tx_cap.0 == 0 { abort_with("per_tx_cap must be > 0"); }
        self.token_of.insert(policy_id.clone(), token);
        self.cap_of.insert(policy_id.clone(), per_tx_cap.0);
        self.daily_of.insert(policy_id, daily_cap.map(|u| u.0).unwrap_or(0));
    }

    /// Authorize a public key belonging to the owner account for one policy.
    /// The owner must separately install it as a function-call access key scoped
    /// to execute; an entry here alone does not create a NEAR access key.
    #[payable]
    pub fn grant_agent_key(&mut self, policy_id: String, public_key: PublicKey) {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        require(self.cap_of.contains_key(&policy_id), "policy does not exist");
        self.agents.insert((policy_id, public_key), true);
    }

    #[payable]
    pub fn revoke_agent_key(&mut self, policy_id: String, public_key: PublicKey) {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        self.agents.remove(&(policy_id, public_key));
    }

    pub fn is_agent_key_allowed(&self, policy_id: String, public_key: PublicKey) -> bool {
        self.agents.get(&(policy_id, public_key)) == Some(&true)
    }

    #[payable]
    pub fn allow_payee(&mut self, policy_id: String, payee: AccountId) {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        if !self.cap_of.contains_key(&policy_id) { abort_with("policy does not exist"); }
        let k = allow_key(&policy_id, payee.as_str());
        if self.allow.get(&k).is_none() {
            let n = self.allow_count.get(&policy_id).cloned().unwrap_or(0);
            self.allow_count.insert(policy_id.clone(), n + 1);
        }
        self.allow.insert(k, true);
    }

    #[payable]
    pub fn revoke_payee(&mut self, policy_id: String, payee: AccountId) {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        let k = allow_key(&policy_id, payee.as_str());
        if self.allow.remove(&k).is_some() {
            let n = self.allow_count.get(&policy_id).cloned().unwrap_or(1);
            self.allow_count.insert(policy_id, n.saturating_sub(1));
        }
    }

    pub fn contract_version(&self) -> &'static str { "bouncer-agent-v5" }

    /// Lets clients verify the refund recipient; a version string alone does
    /// not verify deployed code or the RPC.
    pub fn get_owner(&self) -> AccountId { self.owner.clone() }

    pub fn get_policy(&self, policy_id: String) -> Option<PolicyView> {
        Some(PolicyView {
            token: self.token_of.get(&policy_id)?.clone(),
            per_tx_cap: U128(*self.cap_of.get(&policy_id)?),
            daily_cap: U128(self.daily_of.get(&policy_id).copied().unwrap_or(0)),
        })
    }

    pub fn vault_balance(&self, token: AccountId) -> U128 {
        if token.as_str() == NATIVE_ASSET { U128(self.native_balance) }
        else { U128(self.balances.get(&token).cloned().unwrap_or(0)) }
    }

    /// Conservative rolling 24-hour spend; hour buckets can retain a spend
    /// for up to one extra hour. Zero/disabled limits still track spend.
    pub fn daily_spent(&self, policy_id: String) -> U128 {
        U128(rolling_spent(self, &policy_id, env::block_timestamp() / NS_PER_HOUR))
    }

    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        let token = env::predecessor_account_id();
        // A real FT named `native` must never be mistaken for the NEAR vault.
        // Return it unused so the token contract resolves/refunds the transfer.
        if token.as_str() == NATIVE_ASSET { return amount; }
        let bal = self.balances.get(&token).cloned().unwrap_or(0);
        let updated = bal.checked_add(amount.0).unwrap_or_else(|| abort_with("vault balance overflow"));
        self.balances.insert(token.clone(), updated);
        env::log_str("BOUNCER deposit received");
        let _ = (sender_id, msg);
        U128(0)
    }

    #[payable]
    pub fn withdraw(&mut self, token: AccountId, amount: U128) -> Promise {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        require(token.as_str() != NATIVE_ASSET, "use withdraw_native for native NEAR");
        let bal = self.balances.get(&token).cloned().unwrap_or(0);
        if amount.0 > bal { abort_with("insufficient vault balance"); }
        self.balances.insert(token.clone(), bal - amount.0);
        ext_ft::ext(token.clone())
            .with_attached_deposit(ONE_YOCTO).with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(self.owner.clone(), amount, Some("bouncer:withdraw".into()))
            .then(ext_self::ext(env::current_account_id()).with_static_gas(GAS_FOR_RESOLVE).after_withdraw(token, amount))
    }

    #[payable]
    pub fn execute(&mut self, policy_id: String, payee: AccountId, amount: U128, memo: Option<String>, expected_token: AccountId) -> Promise {
        // Only direct transactions signed by the owner account may invoke execute.
        // The signing key must also be explicitly granted for this policy.
        require(env::attached_deposit() == ZERO_NEAR, "BLOCKED: execute requires zero deposit");
        require(env::predecessor_account_id() == self.owner && env::signer_account_id() == self.owner,
            "BLOCKED: caller is not the owner account");
        let signing_key = env::signer_account_pk();
        require(self.agents.get(&(policy_id.clone(), signing_key)) == Some(&true),
            "BLOCKED: signing key is not authorized for this policy");
        let (token, bal) = validate(self, &policy_id, &payee, amount.0).unwrap_or_else(|m| abort_with(&m));
        // Bind the signed payment to the token the agent reviewed, even if the
        // owner changes the policy between preflight and transaction execution.
        require(token == expected_token, "BLOCKED: policy token does not match expected token");
        require(token.as_str() != NATIVE_ASSET, "BLOCKED: native policy requires execute_outlayer");
        let bucket = env::block_timestamp() / NS_PER_HOUR;
        let dk = daily_key(&policy_id, bucket);
        let spent = self.daily_spent.get(&dk).cloned().unwrap_or(0);
        let next_spent = spent.checked_add(amount.0).unwrap_or_else(|| abort_with("daily spend overflow"));
        self.balances.insert(token.clone(), bal - amount.0);
        self.daily_spent.insert(dk, next_spent);
        env::log_str("BOUNCER payment initiated");
        // The contract, not the function-call key, pays the required 1 yoctoNEAR.
        ext_ft::ext(token.clone())
            .with_attached_deposit(ONE_YOCTO).with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(payee, amount, memo)
            .then(ext_self::ext(env::current_account_id()).with_static_gas(GAS_FOR_RESOLVE).after_execute(policy_id, token, amount, bucket))
    }

    /// Anyone may fund this native-NEAR vault; only the owner can withdraw it
    /// and only a policy-granted restricted key can request approved compute.
    #[payable]
    pub fn deposit_native(&mut self) {
        let amount = env::attached_deposit().as_yoctonear();
        require(amount > 0, "native deposit must be positive");
        self.native_balance = self.native_balance.checked_add(amount)
            .unwrap_or_else(|| abort_with("native vault balance overflow"));
        env::log_str("BOUNCER native deposit received");
    }

    #[payable]
    pub fn withdraw_native(&mut self, amount: U128) -> Promise {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        require(amount.0 > 0 && amount.0 <= self.native_balance, "insufficient native vault balance");
        self.native_balance -= amount.0;
        Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(amount.0))
            .then(ext_self::ext(env::current_account_id()).with_static_gas(GAS_FOR_RESOLVE).after_native_withdraw(amount))
    }

    /// Recover owner-controlled native NEAR not represented in the vault,
    /// including a full refund from a request rejected before OutLayer accepted
    /// it. Storage, the tracked vault, and an operational reserve stay covered.
    /// This deliberately does not amend the conservative rolling spend.
    #[payable]
    pub fn withdraw_native_surplus(&mut self, amount: U128) -> Promise {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        let storage = (env::storage_usage() as u128)
            .saturating_mul(env::storage_byte_cost().as_yoctonear());
        let available = env::account_balance().as_yoctonear()
            .saturating_sub(storage).saturating_sub(self.native_balance)
            .saturating_sub(NATIVE_SURPLUS_RESERVE);
        require(amount.0 > 0 && amount.0 <= available, "insufficient unreserved native surplus");
        Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(amount.0))
    }

    /// The source and maximum resource limits are owner-controlled, not supplied
    /// by a model or an untrusted marketplace. Updating them requires 1 yocto.
    #[payable]
    pub fn set_outlayer_program(&mut self, policy_id: String, program: OutlayerProgram) {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        require(self.token_of.get(&policy_id).map(|x| x.as_str()) == Some(NATIVE_ASSET),
            "OutLayer policy must use the native asset");
        require(program.url.starts_with("https://") && program.url.len() <= 512 &&
            !program.url.bytes().any(|b| b <= 0x20 || b == 0x7f), "invalid program URL");
        require(program.sha256.len() == 64 && program.sha256.bytes().all(|b|
            (b'0'..=b'9').contains(&b) || (b'a'..=b'f').contains(&b)), "invalid program sha256");
        require(program.build_target == "wasm32-wasip1" || program.build_target == "wasm32-wasip2",
            "invalid WASI target");
        require(program.max_instructions > 0 && program.max_instructions <= 500_000_000_000 &&
            program.max_memory_mb > 0 && program.max_memory_mb <= 4096 &&
            program.max_execution_seconds > 0 && program.max_execution_seconds <= 180,
            "invalid OutLayer resource limits");
        let encoded = near_sdk::serde_json::to_string(&program)
            .unwrap_or_else(|_| abort_with("cannot serialize OutLayer program"));
        self.outlayer_programs.insert(policy_id, encoded);
    }

    pub fn get_outlayer_program(&self, policy_id: String) -> Option<OutlayerProgram> {
        self.outlayer_programs.get(&policy_id).map(|encoded|
            near_sdk::serde_json::from_str(encoded).unwrap_or_else(|_| abort_with("invalid stored OutLayer program")))
    }

    /// Request one independent testnet execution with an explicitly capped
    /// native-NEAR deposit. OutLayer refunds unused deposit directly to owner;
    /// the full maximum remains counted in the vault/spend budget. Do not
    /// restore it based on a failed or `null` result: provider acceptance,
    /// partial charges and cross-contract refunds can be ambiguous.
    #[payable]
    pub fn execute_outlayer(&mut self, policy_id: String, amount: U128, input_data: String,
        expected_program: OutlayerProgram) -> Promise {
        require(env::attached_deposit() == ZERO_NEAR, "BLOCKED: execute_outlayer requires zero deposit");
        require(env::predecessor_account_id() == self.owner && env::signer_account_id() == self.owner,
            "BLOCKED: caller is not the owner account");
        require(self.agents.get(&(policy_id.clone(), env::signer_account_pk())) == Some(&true),
            "BLOCKED: signing key is not authorized for this policy");
        require(input_data.len() <= MAX_OUTLAYER_INPUT_BYTES, "OutLayer input is too large");
        let input: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(&input_data)
            .unwrap_or_else(|_| abort_with("OutLayer input must be JSON"));
        require(input.is_object(), "OutLayer input must be a JSON object");
        let program = self.get_outlayer_program(policy_id.clone())
            .unwrap_or_else(|| abort_with("BLOCKED: no owner-approved OutLayer program"));
        require(program == expected_program, "BLOCKED: OutLayer program changed since review");
        let payee: AccountId = OUTLAYER_TESTNET.parse().unwrap_or_else(|_| abort_with("invalid OutLayer account"));
        let (token, balance) = validate(self, &policy_id, &payee, amount.0).unwrap_or_else(|m| abort_with(&m));
        require(token.as_str() == NATIVE_ASSET, "BLOCKED: OutLayer requires a native policy");
        let bucket = env::block_timestamp() / NS_PER_HOUR;
        let key = daily_key(&policy_id, bucket);
        let previous = self.daily_spent.get(&key).copied().unwrap_or(0);
        let next = previous.checked_add(amount.0).unwrap_or_else(|| abort_with("daily spend overflow"));
        self.native_balance = balance - amount.0;
        self.daily_spent.insert(key, next);
        let args = near_sdk::serde_json::json!({
            "source": {"WasmUrl": {"url": program.url, "hash": program.sha256, "build_target": program.build_target}},
            "resource_limits": {"max_instructions": program.max_instructions, "max_memory_mb": program.max_memory_mb,
                "max_execution_seconds": program.max_execution_seconds},
            "input_data": input_data, "secrets_ref": null, "response_format": "Json",
            "payer_account_id": self.owner.clone(), "params": null,
        });
        env::log_str("BOUNCER independent compute initiated; full maximum reserved");
        Promise::new(payee).function_call("request_execution", args.to_string().into_bytes(),
            NearToken::from_yoctonear(amount.0), GAS_FOR_OUTLAYER)
    }

    #[private]
    pub fn after_native_withdraw(&mut self, amount: U128) {
        if !matches!(env::promise_result(0), near_sdk::PromiseResult::Successful(_)) {
            self.native_balance = self.native_balance.checked_add(amount.0)
                .unwrap_or_else(|| abort_with("native refund balance overflow"));
            env::log_str("BOUNCER native withdrawal failed; vault refunded");
        }
    }

    #[private]
    pub fn after_execute(&mut self, policy_id: String, token: AccountId, amount: U128, bucket: u64) {
        if !matches!(env::promise_result(0), near_sdk::PromiseResult::Successful(_)) {
            let bal = self.balances.get(&token).cloned().unwrap_or(0);
            let updated = bal.checked_add(amount.0).unwrap_or_else(|| abort_with("refund balance overflow"));
            self.balances.insert(token.clone(), updated);
            // Use the original execution hour even if the callback crosses a boundary.
            let dk = daily_key(&policy_id, bucket);
            if let Some(s) = self.daily_spent.get(&dk).cloned() {
                self.daily_spent.insert(dk, s.saturating_sub(amount.0));
            }
            env::log_str("BOUNCER ft_transfer failed; vault refunded");
        }
    }
    #[private]
    pub fn after_withdraw(&mut self, token: AccountId, amount: U128) {
        if !matches!(env::promise_result(0), near_sdk::PromiseResult::Successful(_)) {
            let bal = self.balances.get(&token).cloned().unwrap_or(0);
            let updated = bal.checked_add(amount.0).unwrap_or_else(|| abort_with("refund balance overflow"));
            self.balances.insert(token, updated);
        }
    }

    pub fn check(&self, policy_id: String, payee: AccountId, amount: U128) -> (bool, String) {
        match validate(self, &policy_id, &payee, amount.0) {
            Ok(_) => (true, "ok: within cap, payee allowed, daily ok, vault funded".into()),
            Err(e) => (false, e),
        }
    }
    pub fn try_execute(&self, policy_id: String, payee: AccountId, amount: U128) -> (bool, String) {
        match validate(self, &policy_id, &payee, amount.0) {
            Ok(_) => (true, "policy satisfied; caller authorization not checked".into()),
            Err(e) => (false, e),
        }
    }
    pub fn try_set_policy(&self, attached_yoctos: U128, predecessor: AccountId, per_tx_cap: U128) -> (bool, String) {
        let deposit = NearToken::from_yoctonear(attached_yoctos.0);
        if deposit != ONE_YOCTO {
            return (false, "BLOCKED: requires exactly 1 yoctoNEAR (owner-only guard)".into());
        }
        if predecessor != self.owner {
            return (false, "BLOCKED: caller is not owner".into());
        }
        if per_tx_cap.0 == 0 { return (false, "per_tx_cap must be > 0".into()); }
        (true, "set_policy would succeed".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{testing_env_with_promise_results, VMContextBuilder};
    use near_sdk::{testing_env, CurveType, PromiseResult, VMContext};

    fn id(value: &str) -> AccountId { value.parse().unwrap() }
    fn key(byte: u8) -> PublicKey {
        PublicKey::from_parts(CurveType::ED25519, vec![byte; 32]).unwrap()
    }
    fn context(predecessor: &str, signer: &str, pk: &PublicKey, deposit: u128, timestamp: u64) -> VMContext {
        let mut b = VMContextBuilder::new();
        b.current_account_id(id("bouncer.testnet"))
            .predecessor_account_id(id(predecessor))
            .signer_account_id(id(signer))
            .signer_account_pk(pk.clone())
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(timestamp)
            .prepaid_gas(Gas::from_tgas(300));
        b.build()
    }
    fn owner_context(pk: &PublicKey, deposit: u128, timestamp: u64) -> VMContext {
        context("bouncer.testnet", "bouncer.testnet", pk, deposit, timestamp)
    }
    fn fixture() -> (Bouncer, PublicKey) {
        let owner_key = key(1);
        let agent_key = key(2);
        testing_env!(owner_context(&owner_key, 1, NS_PER_DAY));
        let mut contract = Bouncer::new(id("bouncer.testnet"));
        contract.set_policy("compute".into(), id("token.testnet"), U128(200), Some(U128(300)));
        contract.grant_agent_key("compute".into(), agent_key.clone());
        contract.allow_payee("compute".into(), id("vendor.testnet"));
        contract.balances.insert(id("token.testnet"), 1_000);
        (contract, agent_key)
    }

    #[test]
    fn authorized_agent_can_execute_without_deposit() {
        let (mut contract, agent) = fixture();
        testing_env!(owner_context(&agent, 0, NS_PER_DAY));
        drop(contract.execute("compute".into(), id("vendor.testnet"), U128(100), None, id("token.testnet")));
        assert_eq!(contract.vault_balance(id("token.testnet")).0, 900);
        assert_eq!(*contract.daily_spent.get(&daily_key("compute", WINDOW_HOURS)).unwrap(), 100);
    }

    #[test]
    #[should_panic(expected = "BLOCKED: caller is not the owner account")]
    fn unrelated_account_cannot_execute() {
        let (mut contract, agent) = fixture();
        testing_env!(context("attacker.testnet", "attacker.testnet", &agent, 0, NS_PER_DAY));
        drop(contract.execute("compute".into(), id("vendor.testnet"), U128(100), None, id("token.testnet")));
    }

    #[test]
    #[should_panic(expected = "BLOCKED: signing key is not authorized for this policy")]
    fn another_key_on_owner_account_is_not_automatically_authorized() {
        let (mut contract, _) = fixture();
        testing_env!(owner_context(&key(3), 0, NS_PER_DAY));
        drop(contract.execute("compute".into(), id("vendor.testnet"), U128(100), None, id("token.testnet")));
    }

    #[test]
    #[should_panic(expected = "BLOCKED: signing key is not authorized for this policy")]
    fn agent_key_cannot_spend_under_another_policy() {
        let (mut contract, agent) = fixture();
        testing_env!(owner_context(&key(1), 1, NS_PER_DAY));
        contract.set_policy("storage".into(), id("token.testnet"), U128(200), Some(U128(300)));
        contract.allow_payee("storage".into(), id("vendor.testnet"));
        testing_env!(owner_context(&agent, 0, NS_PER_DAY));
        drop(contract.execute("storage".into(), id("vendor.testnet"), U128(100), None, id("token.testnet")));
    }

    #[test]
    #[should_panic(expected = "BLOCKED: execute requires zero deposit")]
    fn execute_refuses_a_deposit() {
        let (mut contract, agent) = fixture();
        testing_env!(owner_context(&agent, 1, NS_PER_DAY));
        drop(contract.execute("compute".into(), id("vendor.testnet"), U128(100), None, id("token.testnet")));
    }

    #[test]
    #[should_panic(expected = "owner-only method requires exactly 1 yoctoNEAR")]
    fn agent_cannot_grant_itself_another_policy_without_deposit() {
        let (mut contract, agent) = fixture();
        testing_env!(owner_context(&agent, 0, NS_PER_DAY));
        contract.grant_agent_key("compute".into(), agent);
    }

    #[test]
    #[should_panic(expected = "ESCALATION BLOCKED: caller is not owner")]
    fn non_owner_cannot_grant_even_with_one_yocto() {
        let (mut contract, agent) = fixture();
        testing_env!(context("attacker.testnet", "attacker.testnet", &agent, 1, NS_PER_DAY));
        contract.grant_agent_key("compute".into(), agent);
    }

    #[test]
    #[should_panic(expected = "BLOCKED: signing key is not authorized for this policy")]
    fn revoked_agent_key_cannot_execute() {
        let (mut contract, agent) = fixture();
        testing_env!(owner_context(&key(1), 1, NS_PER_DAY));
        contract.revoke_agent_key("compute".into(), agent.clone());
        assert!(!contract.is_agent_key_allowed("compute".into(), agent.clone()));
        testing_env!(owner_context(&agent, 0, NS_PER_DAY));
        drop(contract.execute("compute".into(), id("vendor.testnet"), U128(100), None, id("token.testnet")));
    }

    #[test]
    fn an_empty_allowlist_fails_closed_after_revocation() {
        let (mut contract, agent) = fixture();
        testing_env!(owner_context(&key(1), 1, NS_PER_DAY));
        contract.revoke_payee("compute".into(), id("vendor.testnet"));
        testing_env!(owner_context(&agent, 0, NS_PER_DAY));
        let (ok, reason) = contract.check("compute".into(), id("vendor.testnet"), U128(100));
        assert!(!ok);
        assert_eq!(reason, "BLOCKED: payee not in allowlist");
    }

    #[test]
    fn limits_and_balance_are_checked_for_each_policy() {
        let (mut contract, agent) = fixture();
        testing_env!(owner_context(&agent, 0, NS_PER_DAY));
        assert!(contract.check("compute".into(), id("vendor.testnet"), U128(200)).0);
        assert_eq!(contract.check("compute".into(), id("vendor.testnet"), U128(201)).1,
            "BLOCKED: amount exceeds per-tx cap");
        drop(contract.execute("compute".into(), id("vendor.testnet"), U128(200), None, id("token.testnet")));
        assert_eq!(contract.check("compute".into(), id("vendor.testnet"), U128(101)).1,
            "BLOCKED: daily cap exceeded for this policy");
    }

    #[test]
    fn rolling_budget_does_not_reset_at_midnight_or_release_early() {
        let (mut contract, agent) = fixture();
        let start = 40 * NS_PER_HOUR + 59 * 60 * 1_000_000_000;
        testing_env!(owner_context(&agent, 0, start));
        drop(contract.execute("compute".into(), id("vendor.testnet"), U128(200), None, id("token.testnet")));
        // Midnight and just under 24 hours later must both retain the spend.
        for timestamp in [48 * NS_PER_HOUR + 1, start + NS_PER_DAY - 1, 65 * NS_PER_HOUR - 1] {
            testing_env!(owner_context(&agent, 0, timestamp));
            assert_eq!(contract.daily_spent("compute".into()).0, 200);
            assert_eq!(contract.check("compute".into(), id("vendor.testnet"), U128(101)).1,
                "BLOCKED: daily cap exceeded for this policy");
        }
        // The conservative oldest hour expires on the next hour boundary.
        testing_env!(owner_context(&agent, 0, 65 * NS_PER_HOUR));
        assert_eq!(contract.daily_spent("compute".into()).0, 0);
        assert!(contract.check("compute".into(), id("vendor.testnet"), U128(101)).0);
    }

    #[test]
    fn earliest_hour_is_counted_once_and_budget_addition_cannot_overflow() {
        let (mut contract, agent) = fixture();
        testing_env!(owner_context(&agent, 0, 0));
        contract.daily_spent.insert(daily_key("compute", 0), 200);
        assert!(contract.check("compute".into(), id("vendor.testnet"), U128(100)).0);
        testing_env!(owner_context(&key(1), 1, 0));
        contract.set_policy("compute".into(), id("token.testnet"), U128(u128::MAX), Some(U128(u128::MAX)));
        contract.daily_spent.insert(daily_key("compute", 0), u128::MAX);
        testing_env!(owner_context(&agent, 0, 0));
        assert_eq!(contract.check("compute".into(), id("vendor.testnet"), U128(1)).1,
            "BLOCKED: daily cap exceeded for this policy");
    }

    #[test]
    #[should_panic(expected = "BLOCKED: policy token does not match expected token")]
    fn cannot_spend_when_policy_token_differs_from_signed_request() {
        let (mut contract, agent) = fixture();
        testing_env!(owner_context(&agent, 0, NS_PER_DAY));
        drop(contract.execute("compute".into(), id("vendor.testnet"), U128(100), None, id("other-token.testnet")));
    }

    #[test]
    fn policy_view_reports_the_token_and_limits() {
        let (contract, _) = fixture();
        let policy = contract.get_policy("compute".into()).unwrap();
        assert_eq!(policy.token, id("token.testnet"));
        assert_eq!(policy.per_tx_cap.0, 200);
        assert_eq!(policy.daily_cap.0, 300);
        assert!(contract.get_policy("unknown".into()).is_none());
    }

    #[test]
    #[allow(deprecated)]
    fn failed_transfer_refunds_original_bucket_even_across_midnight() {
        let (mut contract, agent) = fixture();
        testing_env!(owner_context(&agent, 0, NS_PER_DAY));
        drop(contract.execute("compute".into(), id("vendor.testnet"), U128(100), None, id("token.testnet")));
        contract.daily_spent.insert(daily_key("compute", WINDOW_HOURS + 1), 75);
        let callback_context = context("bouncer.testnet", "bouncer.testnet", &agent, 0, NS_PER_DAY + NS_PER_HOUR);
        testing_env_with_promise_results(callback_context, PromiseResult::Failed);
        contract.after_execute("compute".into(), id("token.testnet"), U128(100), WINDOW_HOURS);
        assert_eq!(contract.vault_balance(id("token.testnet")).0, 1_000);
        assert_eq!(*contract.daily_spent.get(&daily_key("compute", WINDOW_HOURS)).unwrap(), 0);
        assert_eq!(*contract.daily_spent.get(&daily_key("compute", WINDOW_HOURS + 1)).unwrap(), 75);
    }

    fn program() -> OutlayerProgram {
        OutlayerProgram {
            url: "https://example.org/pinned.wasm".into(), sha256: "a".repeat(64),
            build_target: "wasm32-wasip1".into(), max_instructions: 10_000_000,
            max_memory_mb: 128, max_execution_seconds: 60,
        }
    }
    fn native_fixture() -> (Bouncer, PublicKey, OutlayerProgram) {
        let owner_key = key(1);
        let agent = key(2);
        testing_env!(context("owner.testnet", "owner.testnet", &owner_key, 1, NS_PER_DAY));
        let mut contract = Bouncer::new(id("owner.testnet"));
        contract.set_policy("external-compute".into(), id(NATIVE_ASSET), U128(200), Some(U128(300)));
        contract.allow_payee("external-compute".into(), id(OUTLAYER_TESTNET));
        contract.grant_agent_key("external-compute".into(), agent.clone());
        let p = program();
        contract.set_outlayer_program("external-compute".into(), p.clone());
        testing_env!(context("owner.testnet", "owner.testnet", &owner_key, 500, NS_PER_DAY));
        contract.deposit_native();
        (contract, agent, p)
    }

    #[test]
    fn outlayer_reserves_full_maximum_and_pins_refund_and_program() {
        use near_sdk::mock::MockAction;
        use near_sdk::test_utils::get_created_receipts;
        let (mut contract, agent, p) = native_fixture();
        testing_env!(context("owner.testnet", "owner.testnet", &agent, 0, NS_PER_DAY));
        assert!(contract.check("external-compute".into(), id(OUTLAYER_TESTNET), U128(100)).0);
        drop(contract.execute_outlayer("external-compute".into(), U128(100), "{\"min\":1,\"max\":100}".into(), p.clone()));
        assert_eq!(contract.vault_balance(id(NATIVE_ASSET)).0, 400);
        assert_eq!(contract.daily_spent("external-compute".into()).0, 100);
        let receipts = get_created_receipts();
        let receipt = receipts.iter().find(|r| r.receiver_id == id(OUTLAYER_TESTNET)).expect("OutLayer receipt");
        let (args, deposit) = receipt.actions.iter().find_map(|a| match a {
            MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } if method_name == b"request_execution" => Some((args, attached_deposit)),
            _ => None,
        }).expect("request_execution action");
        assert_eq!(*deposit, NearToken::from_yoctonear(100));
        let args: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(args).unwrap();
        assert_eq!(args["payer_account_id"], "owner.testnet");
        assert_eq!(args["source"]["WasmUrl"]["hash"], p.sha256);
        assert_eq!(args["source"]["WasmUrl"]["url"], p.url);
        assert_eq!(args["resource_limits"]["max_instructions"], p.max_instructions);
        assert_eq!(args["input_data"], "{\"min\":1,\"max\":100}");
        assert!(args["secrets_ref"].is_null());
        // No callback credits a provider-reported or ambiguous refund back into
        // the vault or budget; OutLayer sends unused funds to the owner.
        assert_eq!(receipts.len(), 1);
    }

    #[test]
    #[should_panic(expected = "owner-only method requires exactly 1 yoctoNEAR")]
    fn agent_cannot_change_approved_program() {
        let (mut contract, agent, p) = native_fixture();
        testing_env!(context("owner.testnet", "owner.testnet", &agent, 0, NS_PER_DAY));
        contract.set_outlayer_program("external-compute".into(), p);
    }

    #[test]
    #[should_panic(expected = "BLOCKED: OutLayer program changed since review")]
    fn agent_cannot_change_the_pinned_program() {
        let (mut contract, agent, mut p) = native_fixture();
        p.sha256 = "b".repeat(64);
        testing_env!(context("owner.testnet", "owner.testnet", &agent, 0, NS_PER_DAY));
        drop(contract.execute_outlayer("external-compute".into(), U128(100), "{}".into(), p));
    }

    #[test]
    #[should_panic(expected = "BLOCKED: amount exceeds per-tx cap")]
    fn outlayer_cannot_exceed_policy_cap() {
        let (mut contract, agent, p) = native_fixture();
        testing_env!(context("owner.testnet", "owner.testnet", &agent, 0, NS_PER_DAY));
        drop(contract.execute_outlayer("external-compute".into(), U128(201), "{}".into(), p));
    }

    #[test]
    #[should_panic(expected = "BLOCKED: payee not in allowlist")]
    fn outlayer_must_be_explicitly_allowlisted() {
        let (mut contract, agent, p) = native_fixture();
        testing_env!(context("owner.testnet", "owner.testnet", &key(1), 1, NS_PER_DAY));
        contract.revoke_payee("external-compute".into(), id(OUTLAYER_TESTNET));
        testing_env!(context("owner.testnet", "owner.testnet", &agent, 0, NS_PER_DAY));
        drop(contract.execute_outlayer("external-compute".into(), U128(100), "{}".into(), p));
    }

    #[test]
    #[should_panic(expected = "BLOCKED: signing key is not authorized for this policy")]
    fn outlayer_rejects_ungranted_key() {
        let (mut contract, _, p) = native_fixture();
        testing_env!(context("owner.testnet", "owner.testnet", &key(3), 0, NS_PER_DAY));
        drop(contract.execute_outlayer("external-compute".into(), U128(100), "{}".into(), p));
    }

    #[test]
    #[should_panic(expected = "OutLayer input must be a JSON object")]
    fn outlayer_rejects_non_object_input() {
        let (mut contract, agent, p) = native_fixture();
        testing_env!(context("owner.testnet", "owner.testnet", &agent, 0, NS_PER_DAY));
        drop(contract.execute_outlayer("external-compute".into(), U128(100), "[]".into(), p));
    }

    #[test]
    #[should_panic(expected = "BLOCKED: native policy requires execute_outlayer")]
    fn native_cannot_be_spent_as_an_ft() {
        let (mut contract, agent, _) = native_fixture();
        testing_env!(context("owner.testnet", "owner.testnet", &agent, 0, NS_PER_DAY));
        drop(contract.execute("external-compute".into(), id(OUTLAYER_TESTNET), U128(100), None, id(NATIVE_ASSET)));
    }

    #[test]
    fn ft_named_native_is_returned_without_crediting_native_vault() {
        let (mut contract, _, _) = native_fixture();
        testing_env!(context("native", "owner.testnet", &key(1), 0, NS_PER_DAY));
        assert_eq!(contract.ft_on_transfer(id("sender.testnet"), U128(100), "".into()).0, 100);
        assert_eq!(contract.vault_balance(id(NATIVE_ASSET)).0, 500);
    }

    #[test]
    #[allow(deprecated)]
    fn failed_native_withdrawal_restores_tracked_balance() {
        let (mut contract, _, _) = native_fixture();
        testing_env!(context("owner.testnet", "owner.testnet", &key(1), 1, NS_PER_DAY));
        drop(contract.withdraw_native(U128(100)));
        assert_eq!(contract.vault_balance(id(NATIVE_ASSET)).0, 400);
        testing_env_with_promise_results(context("bouncer.testnet", "owner.testnet", &key(1), 0, NS_PER_DAY), PromiseResult::Failed);
        contract.after_native_withdraw(U128(100));
        assert_eq!(contract.vault_balance(id(NATIVE_ASSET)).0, 500);
    }

    #[test]
    #[should_panic(expected = "insufficient unreserved native surplus")]
    fn owner_cannot_claim_surplus_without_storage_and_vault_reserves() {
        let (mut contract, _, _) = native_fixture();
        testing_env!(context("owner.testnet", "owner.testnet", &key(1), 1, NS_PER_DAY));
        drop(contract.withdraw_native_surplus(U128(u128::MAX)));
    }
}
