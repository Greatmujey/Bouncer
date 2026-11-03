use near_sdk::json_types::U128;
#[cfg(feature = "exact-ft-v11")]
use near_sdk::json_types::U64;
use near_sdk::store::LookupMap;
use near_sdk::{env, ext_contract, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue, PublicKey};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const ZERO_NEAR: NearToken = NearToken::from_yoctonear(0);
const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(15);
// A transfer-call needs gas for both the independent receiver and the FT's
// resolve step. The outer transaction uses 300 TGas and reserves a callback.
const GAS_FOR_FT_TRANSFER_CALL: Gas = Gas::from_tgas(200);
const GAS_FOR_RESOLVE: Gas = Gas::from_tgas(15);
// OutLayer uses yield/resume. The caller must attach enough gas for this
// cross-contract request; the user's restricted key still attaches zero NEAR.
const GAS_FOR_OUTLAYER: Gas = Gas::from_tgas(220);
// `native` is a reserved policy asset, not a fungible-token contract.
const NATIVE_ASSET: &str = "native";
const OUTLAYER_TESTNET: &str = "outlayer.testnet";
const OUTLAYER_DEPOSIT_MSG: &str = r#"{"action":"deposit_balance"}"#;
const NATIVE_SURPLUS_RESERVE: u128 = 50_000_000_000_000_000_000_000; // 0.05 NEAR
const MAX_OUTLAYER_INPUT_BYTES: usize = 4096;
const MAX_FT_CALL_MESSAGE_BYTES: usize = 2048;
// This is a fresh-state testnet variant, not an upgrade to a deployed V9/V10.
// Combining the two experimental variants would create an unreviewed ABI.
#[cfg(all(feature = "exact-ft-v11", feature = "youtick-playback-v10"))]
compile_error!("exact-ft-v11 and youtick-playback-v10 are separate artifacts");
#[cfg(feature = "exact-ft-v11")]
const MAX_EXACT_FT_MEMO_BYTES: usize = 128;
#[cfg(feature = "exact-ft-v11")]
const MAX_EXACT_FT_EXPIRY_MS: u64 = 73 * 60 * 60 * 1_000;
// Only the separately built V10 testnet artifact exposes this narrow, owner-
// authorized playback grant. It does not change deployed V9 contracts.
#[cfg(feature = "youtick-playback-v10")]
const YOUTICK_ACCESS_TESTNET: &str = "video-access-v1-260907.youtick-dev-v3.testnet";
#[cfg(feature = "youtick-playback-v10")]
const YOUTICK_ORIGIN_SHA256: &str = "405f0f2f5400af2a2abaa3350ffaa0b95a56f16b85129d9a1a1663bdda989924";
#[cfg(feature = "youtick-playback-v10")]
const YOUTICK_PLAY_GRANT_TTL_MS: u64 = 600_000;
#[cfg(feature = "youtick-playback-v10")]
const GAS_FOR_YOUTICK_GRANT: Gas = Gas::from_tgas(70);
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
    fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> PromiseOrValue<U128>;
}
#[cfg(feature = "youtick-playback-v10")]
#[derive(near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct YoutickPlayGrantRequest {
    target_owner_id: AccountId,
    session_pk: String,
    scope: String,
    resource_id: Option<String>,
    ttl_ms: u64,
    origin_hash: Option<String>,
    device_hash: Option<String>,
    session_pok: String,
}

#[cfg(feature = "youtick-playback-v10")]
#[ext_contract(ext_youtick_access)]
trait ExtYoutickAccess {
    fn issue_session_grant(&mut self, request: YoutickPlayGrantRequest);
}

#[ext_contract(ext_self)]
trait ExtSelf {
    fn after_execute(&mut self, policy_id: String, token: AccountId, amount: U128, bucket: u64);
    fn after_execute_ft_call(&mut self, policy_id: String, token: AccountId, amount: U128, bucket: u64,
        policy_revision: u64, payee: AccountId, msg: String) -> Option<U128>;
    fn after_withdraw(&mut self, token: AccountId, amount: U128);
    fn after_native_withdraw(&mut self, amount: U128);
}

#[cfg(feature = "exact-ft-v11")]
#[ext_contract(ext_exact_self)]
trait ExtExactSelf {
    fn after_exact_ft_transfer(&mut self, intent_id: String, policy_id: String, token: AccountId,
        amount: U128, bucket: u64, policy_revision: u64);
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

/// An owner-reviewed, bounded paid project call. The input is pinned in its
/// entirety: an agent cannot change an operation, API destination or payload.
#[derive(Clone, Debug, PartialEq, Eq, near_sdk::serde::Serialize, near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct OutlayerProject {
    pub project_id: String,
    pub version_key: String,
    pub usd_policy_id: String,
    pub token: AccountId,
    pub attached_usd: U128,
    pub input_data: String,
    pub max_instructions: u64,
    pub max_memory_mb: u32,
    pub max_execution_seconds: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, near_sdk::serde::Serialize, near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct OutlayerProjectRouteView {
    pub project: OutlayerProject,
    pub route_revision: u64,
    pub native_policy_revision: u64,
    pub usd_policy_revision: u64,
    pub native_payee_revision: u64,
    pub usd_payee_revision: u64,
    pub active: bool,
}

#[derive(near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct FtCallRouteView {
    pub token: AccountId,
    pub msg: String,
    pub policy_revision: u64,
    pub route_revision: u64,
    /// False after a policy change; the owner must review and pin it again.
    pub active: bool,
}

/// A native OutLayer program and its exact input, reviewed together by the
/// owner. Policy/payee changes, program edits and clearing the route prevent
/// previously signed requests from being silently revived.
#[derive(Clone, Debug, PartialEq, Eq, near_sdk::serde::Serialize, near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct OutlayerInputRouteView {
    pub program: OutlayerProgram,
    pub input_data: String,
    pub route_revision: u64,
    pub policy_revision: u64,
    pub payee_revision: u64,
    pub active: bool,
}

/// A project-scoped native execution: unlike an inline WasmUrl, a Project
/// source supplies the provider's project storage namespace. No stablecoin is
/// attached or debited through this route.
#[derive(Clone, Debug, PartialEq, Eq, near_sdk::serde::Serialize, near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct OutlayerNativeProject {
    pub project_id: String,
    pub version_key: String,
    pub input_data: String,
    pub max_instructions: u64,
    pub max_memory_mb: u32,
    pub max_execution_seconds: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, near_sdk::serde::Serialize, near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct OutlayerNativeProjectRouteView {
    pub project: OutlayerNativeProject,
    pub route_revision: u64,
    pub policy_revision: u64,
    pub payee_revision: u64,
    pub active: bool,
}

/// A V11 intent is immutable once pinned. Its ID and token/payee/memo are
/// permanently reserved even if it is cancelled, expires or a transfer fails.
#[cfg(feature = "exact-ft-v11")]
#[near(serializers = [borsh])]
#[derive(Clone)]
struct ExactFtIntent {
    policy_id: String,
    token: AccountId,
    payee: AccountId,
    amount: u128,
    memo: String,
    review_hash: String,
    expires_at_ms: u64,
    agent_public_key: PublicKey,
    policy_revision: u64,
    payee_revision: u64,
    agent_revision: u64,
    consumed: bool,
    cancelled: bool,
}

#[cfg(feature = "exact-ft-v11")]
#[derive(near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct ExactFtIntentView {
    pub intent_id: String,
    pub policy_id: String,
    pub token: AccountId,
    pub payee: AccountId,
    pub amount: U128,
    pub memo: String,
    pub review_hash: String,
    pub expires_at_ms: U64,
    pub agent_public_key: PublicKey,
    pub policy_revision: u64,
    pub payee_revision: u64,
    pub agent_revision: u64,
    pub consumed: bool,
    pub cancelled: bool,
    /// Checks revisions, authority and time, not current funding or budget.
    pub active: bool,
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
    // Policy changes invalidate prior route reviews. Each route also has a
    // monotonic revision so a clear/re-pin cannot revive a stale signature.
    ft_policy_revisions: LookupMap<String, u64>,
    // (route revision, optional (token, exact message, policy revision)). A
    // tombstone retains the revision when an owner clears or revokes a route.
    ft_call_routes: LookupMap<(String, AccountId), (u64, Option<(AccountId, String, u64)>)>,
    // Conservative ledger for the explicitly recognized OutLayer prepaid
    // deposit action; other receivers/messages never mint this allowance.
    outlayer_prepaid: LookupMap<AccountId, u128>,
    // Revisions prevent a revoke/re-allow from silently reviving a project.
    allow_revisions: LookupMap<(String, AccountId), u64>,
    // (route revision, optional (encoded configuration, policy and payee
    // revisions for the native and prepaid-token policies)).
    outlayer_project_routes: LookupMap<String, (u64, Option<(String, u64, u64, u64, u64)>)>,
    // Revision and optional (encoded program, exact input, policy/payee
    // revisions). A tombstone prevents stale requests after clearing a route.
    outlayer_input_routes: LookupMap<String, (u64, Option<(String, String, u64, u64)>)>,
    // Exact native-only project source, version and input plus revisions.
    outlayer_native_projects: LookupMap<String, (u64, Option<(String, u64, u64)>)>,
    // These fields exist ONLY in the separate, fresh-state V11 artifact. Do
    // not deploy it over V9/V10 state; no migration has been implemented.
    #[cfg(feature = "exact-ft-v11")]
    exact_ft_policies: LookupMap<String, bool>,
    #[cfg(feature = "exact-ft-v11")]
    exact_ft_intents: LookupMap<String, ExactFtIntent>,
    #[cfg(feature = "exact-ft-v11")]
    exact_ft_memos: LookupMap<Vec<u8>, bool>,
    // Once any intent reserves this token/payee, unrestricted legacy FT
    // transfers to that pair stay disabled even under a different policy.
    #[cfg(feature = "exact-ft-v11")]
    exact_ft_payees: LookupMap<(AccountId, AccountId), bool>,
    #[cfg(feature = "exact-ft-v11")]
    exact_agent_revisions: LookupMap<(String, PublicKey), u64>,
}

#[cfg(feature = "exact-ft-v11")]
fn exact_memo_key(token: &AccountId, payee: &AccountId, memo: &str) -> Vec<u8> {
    // Account IDs and printable memo cannot contain NUL, so the encoding is
    // unambiguous. Omit amount/policy: a quote code is reserved globally for
    // this token/recipient, even under another policy or a different amount.
    let mut bytes = b"bouncer:exact-ft:v11\0".to_vec();
    for part in [token.as_str(), payee.as_str(), memo] {
        bytes.extend_from_slice(part.as_bytes());
        bytes.push(0);
    }
    env::sha256(&bytes)
}

#[cfg(feature = "exact-ft-v11")]
fn exact_intent_active(s: &Bouncer, i: &ExactFtIntent) -> bool {
    let payee_key = (i.policy_id.clone(), i.payee.clone());
    let agent_key = (i.policy_id.clone(), i.agent_public_key.clone());
    !i.consumed && !i.cancelled && env::block_timestamp() / 1_000_000 < i.expires_at_ms &&
        s.exact_ft_policies.get(&i.policy_id) == Some(&true) &&
        s.token_of.get(&i.policy_id) == Some(&i.token) &&
        s.ft_policy_revisions.get(&i.policy_id) == Some(&i.policy_revision) &&
        s.allow.get(&allow_key(&i.policy_id, i.payee.as_str())) == Some(&true) &&
        s.allow_revisions.get(&payee_key) == Some(&i.payee_revision) &&
        s.agents.get(&agent_key) == Some(&true) &&
        s.exact_agent_revisions.get(&agent_key) == Some(&i.agent_revision)
}

#[cfg(feature = "exact-ft-v11")]
fn advance_exact_agent_revision(s: &mut Bouncer, policy: &str, public_key: &PublicKey) {
    let key = (policy.to_owned(), public_key.clone());
    let revision = s.exact_agent_revisions.get(&key).copied().unwrap_or(0)
        .checked_add(1).unwrap_or_else(|| abort_with("agent revision overflow"));
    s.exact_agent_revisions.insert(key, revision);
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
    validate_with_balance(s, policy_id, payee, amount, None)
}

// The same caps/allowlist/budget checks also apply to a provider-held prepaid
// ledger; it must not be confused with the token balance inside the vault.
fn validate_with_balance(
    s: &Bouncer, policy_id: &str, payee: &AccountId, amount: u128, balance_override: Option<u128>,
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
    let bal = balance_override.unwrap_or_else(|| if token.as_str() == NATIVE_ASSET {
        s.native_balance
    } else {
        s.balances.get(&token).cloned().unwrap_or(0)
    });
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
            ft_policy_revisions: LookupMap::new(b"p"),
            ft_call_routes: LookupMap::new(b"f"),
            outlayer_prepaid: LookupMap::new(b"u"),
            allow_revisions: LookupMap::new(b"e"),
            outlayer_project_routes: LookupMap::new(b"j"),
            outlayer_input_routes: LookupMap::new(b"i"),
            outlayer_native_projects: LookupMap::new(b"q"),
            #[cfg(feature = "exact-ft-v11")]
            exact_ft_policies: LookupMap::new(&b"x1"[..]),
            #[cfg(feature = "exact-ft-v11")]
            exact_ft_intents: LookupMap::new(&b"x2"[..]),
            #[cfg(feature = "exact-ft-v11")]
            exact_ft_memos: LookupMap::new(&b"x3"[..]),
            #[cfg(feature = "exact-ft-v11")]
            exact_ft_payees: LookupMap::new(&b"x4"[..]),
            #[cfg(feature = "exact-ft-v11")]
            exact_agent_revisions: LookupMap::new(&b"x5"[..]),
        }
    }

    #[payable]
    pub fn set_policy(&mut self, policy_id: String, token: AccountId, per_tx_cap: U128, daily_cap: Option<U128>) {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        if per_tx_cap.0 == 0 { abort_with("per_tx_cap must be > 0"); }
        #[cfg(feature = "exact-ft-v11")]
        require(self.exact_ft_policies.get(&policy_id) != Some(&true) || token.as_str() != NATIVE_ASSET,
            "locked exact FT policy cannot become native");
        let revision = self.ft_policy_revisions.get(&policy_id).copied().unwrap_or(0)
            .checked_add(1).unwrap_or_else(|| abort_with("policy revision overflow"));
        self.ft_policy_revisions.insert(policy_id.clone(), revision);
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
        #[cfg(feature = "exact-ft-v11")]
        advance_exact_agent_revision(self, &policy_id, &public_key);
        self.agents.insert((policy_id, public_key), true);
    }

    #[payable]
    pub fn revoke_agent_key(&mut self, policy_id: String, public_key: PublicKey) {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        #[cfg(feature = "exact-ft-v11")]
        advance_exact_agent_revision(self, &policy_id, &public_key);
        self.agents.remove(&(policy_id, public_key));
    }

    pub fn is_agent_key_allowed(&self, policy_id: String, public_key: PublicKey) -> bool {
        self.agents.get(&(policy_id, public_key)) == Some(&true)
    }

    #[payable]
    pub fn allow_payee(&mut self, policy_id: String, payee: AccountId) {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        if !self.cap_of.contains_key(&policy_id) { abort_with("policy does not exist"); }
        let revision_key = (policy_id.clone(), payee.clone());
        let revision = self.allow_revisions.get(&revision_key).copied().unwrap_or(0)
            .checked_add(1).unwrap_or_else(|| abort_with("payee revision overflow"));
        self.allow_revisions.insert(revision_key, revision);
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
        let route_key = (policy_id.clone(), payee);
        let payee_revision = self.allow_revisions.get(&route_key).copied().unwrap_or(0)
            .checked_add(1).unwrap_or_else(|| abort_with("payee revision overflow"));
        self.allow_revisions.insert(route_key.clone(), payee_revision);
        if let Some((revision, _)) = self.ft_call_routes.get(&route_key) {
            let next = revision.checked_add(1).unwrap_or_else(|| abort_with("route revision overflow"));
            self.ft_call_routes.insert(route_key, (next, None));
        }
        if self.allow.remove(&k).is_some() {
            let n = self.allow_count.get(&policy_id).cloned().unwrap_or(1);
            self.allow_count.insert(policy_id, n.saturating_sub(1));
        }
    }

    /// Pin the exact NEP-141 receiver message for a previously allowed payee.
    /// This is powerful configuration: it may encode actions or destinations.
    /// Review the token, receiver and whole message before signing with 1 yocto.
    #[payable]
    pub fn set_ft_call_message(&mut self, policy_id: String, payee: AccountId, msg: String) {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        let token = self.token_of.get(&policy_id).cloned().unwrap_or_else(|| abort_with("policy does not exist"));
        require(token.as_str() != NATIVE_ASSET, "ft_transfer_call requires an FT policy");
        require(self.allow.get(&allow_key(&policy_id, payee.as_str())) == Some(&true),
            "payee must already be allowed");
        require(msg.len() <= MAX_FT_CALL_MESSAGE_BYTES, "FT receiver message is too large");
        let policy_revision = self.ft_policy_revisions.get(&policy_id).copied()
            .unwrap_or_else(|| abort_with("policy revision is missing"));
        let key = (policy_id, payee);
        let route_revision = self.ft_call_routes.get(&key).map(|v| v.0).unwrap_or(0)
            .checked_add(1).unwrap_or_else(|| abort_with("route revision overflow"));
        self.ft_call_routes.insert(key, (route_revision, Some((token, msg, policy_revision))));
    }

    #[payable]
    pub fn clear_ft_call_message(&mut self, policy_id: String, payee: AccountId) {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        let key = (policy_id, payee);
        let route_revision = self.ft_call_routes.get(&key).map(|v| v.0).unwrap_or(0)
            .checked_add(1).unwrap_or_else(|| abort_with("route revision overflow"));
        self.ft_call_routes.insert(key, (route_revision, None));
    }

    pub fn get_ft_call_route(&self, policy_id: String, payee: AccountId) -> Option<FtCallRouteView> {
        let (route_revision, data) = self.ft_call_routes.get(&(policy_id.clone(), payee))?;
        let (token, msg, policy_revision) = data.as_ref()?;
        Some(FtCallRouteView {
            token: token.clone(), msg: msg.clone(), policy_revision: *policy_revision, route_revision: *route_revision,
            active: self.ft_policy_revisions.get(&policy_id) == Some(policy_revision),
        })
    }

    /// Irreversibly dedicate an FT policy to exact, one-shot intents. The
    /// owner can still change its caps/payees with 1 yocto; such changes make
    /// older intents stale. Use a new policy for any unrestricted payments.
    #[cfg(feature = "exact-ft-v11")]
    #[payable]
    pub fn lock_ft_policy_to_intents(&mut self, policy_id: String) {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        require(env::current_account_id().as_str().ends_with(".testnet") && self.owner.as_str().ends_with(".testnet"),
            "testnet-named vault and owner required");
        let token = self.token_of.get(&policy_id).unwrap_or_else(|| abort_with("policy does not exist"));
        require(token.as_str() != NATIVE_ASSET, "exact intent policy must use an FT");
        self.exact_ft_policies.insert(policy_id, true);
    }

    #[cfg(feature = "exact-ft-v11")]
    pub fn is_exact_ft_policy_locked(&self, policy_id: String) -> bool {
        self.exact_ft_policies.get(&policy_id) == Some(&true)
    }

    #[cfg(feature = "exact-ft-v11")]
    pub fn is_exact_ft_payee_locked(&self, token: AccountId, payee: AccountId) -> bool {
        self.exact_ft_payees.get(&(token, payee)) == Some(&true)
    }

    /// Pin all transfer terms and a public review commitment under the 1-yocto
    /// owner guard. An intent ID and (token,payee,memo) can never be reused on
    /// this vault, including after cancellation, expiration or failed transfer.
    /// No token is transferred and no provider quote is authenticated here.
    #[cfg(feature = "exact-ft-v11")]
    #[payable]
    pub fn set_exact_ft_intent(&mut self, intent_id: String, policy_id: String, expected_token: AccountId,
        payee: AccountId, amount: U128, memo: String, review_hash: String, expires_at_ms: U64,
        agent_public_key: PublicKey) {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        require(self.exact_ft_policies.get(&policy_id) == Some(&true), "exact FT policy must be locked first");
        require(!intent_id.is_empty() && intent_id.len() <= 64 && intent_id.bytes().all(|b|
            b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-')), "invalid exact FT intent ID");
        require(!self.exact_ft_intents.contains_key(&intent_id), "exact FT intent ID already reserved");
        require(!memo.is_empty() && memo.len() <= MAX_EXACT_FT_MEMO_BYTES &&
            memo.bytes().all(|b| (0x20..=0x7e).contains(&b)) &&
            memo != "bouncer:withdraw" && memo != "bouncer:guarded-ft-call", "invalid exact FT memo");
        require(review_hash.len() == 64 && review_hash.bytes().all(|b|
            (b'0'..=b'9').contains(&b) || (b'a'..=b'f').contains(&b)), "invalid exact FT review hash");
        let now = env::block_timestamp() / 1_000_000;
        require(expires_at_ms.0 > now && expires_at_ms.0 <= now.saturating_add(MAX_EXACT_FT_EXPIRY_MS),
            "invalid exact FT expiry");
        let token = self.token_of.get(&policy_id).cloned().unwrap_or_else(|| abort_with("policy does not exist"));
        require(token == expected_token && token.as_str() != NATIVE_ASSET, "exact FT policy token differs from review");
        let cap = self.cap_of.get(&policy_id).copied().unwrap_or(0);
        require(amount.0 > 0 && amount.0 <= cap, "exact FT amount exceeds policy cap or is zero");
        require(self.allow.get(&allow_key(&policy_id, payee.as_str())) == Some(&true), "payee must already be allowed");
        let agent_key = (policy_id.clone(), agent_public_key.clone());
        require(self.agents.get(&agent_key) == Some(&true), "agent key must already be granted for policy");
        let policy_revision = self.ft_policy_revisions.get(&policy_id).copied().unwrap_or_else(|| abort_with("missing policy revision"));
        let payee_revision = self.allow_revisions.get(&(policy_id.clone(), payee.clone())).copied()
            .unwrap_or_else(|| abort_with("missing payee revision"));
        let agent_revision = self.exact_agent_revisions.get(&agent_key).copied().unwrap_or_else(|| abort_with("missing agent revision"));
        let memo_key = exact_memo_key(&token, &payee, &memo);
        require(!self.exact_ft_memos.contains_key(&memo_key), "token, payee and memo already reserved");
        self.exact_ft_memos.insert(memo_key, true);
        self.exact_ft_payees.insert((token.clone(), payee.clone()), true);
        self.exact_ft_intents.insert(intent_id, ExactFtIntent { policy_id, token, payee, amount: amount.0, memo,
            review_hash, expires_at_ms: expires_at_ms.0, agent_public_key, policy_revision, payee_revision,
            agent_revision, consumed: false, cancelled: false });
        env::log_str("BOUNCER exact FT intent pinned; no transfer");
    }

    #[cfg(feature = "exact-ft-v11")]
    #[payable]
    pub fn cancel_exact_ft_intent(&mut self, intent_id: String) {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        let mut intent = self.exact_ft_intents.get(&intent_id).cloned().unwrap_or_else(|| abort_with("unknown exact FT intent"));
        require(!intent.consumed && !intent.cancelled, "exact FT intent already consumed or cancelled");
        intent.cancelled = true;
        self.exact_ft_intents.insert(intent_id, intent);
        env::log_str("BOUNCER exact FT intent cancelled; ID and memo remain reserved");
    }

    #[cfg(feature = "exact-ft-v11")]
    pub fn get_exact_ft_intent(&self, intent_id: String) -> Option<ExactFtIntentView> {
        let i = self.exact_ft_intents.get(&intent_id)?;
        Some(ExactFtIntentView { intent_id, policy_id: i.policy_id.clone(), token: i.token.clone(), payee: i.payee.clone(),
            amount: U128(i.amount), memo: i.memo.clone(), review_hash: i.review_hash.clone(), expires_at_ms: U64(i.expires_at_ms),
            agent_public_key: i.agent_public_key.clone(), policy_revision: i.policy_revision, payee_revision: i.payee_revision,
            agent_revision: i.agent_revision, consumed: i.consumed, cancelled: i.cancelled, active: exact_intent_active(self, i) })
    }

    /// The agent supplies only an immutable intent ID, not an amount, token,
    /// payee, quote code or expiry. Consume before dispatch and never reset on
    /// failure: recovery must inspect the original transaction, not rebroadcast.
    #[cfg(feature = "exact-ft-v11")]
    #[payable]
    pub fn execute_exact_ft(&mut self, intent_id: String) -> Promise {
        require(env::attached_deposit() == ZERO_NEAR, "BLOCKED: execute_exact_ft requires zero deposit");
        require(env::predecessor_account_id() == self.owner && env::signer_account_id() == self.owner,
            "BLOCKED: caller is not the owner account");
        let mut intent = self.exact_ft_intents.get(&intent_id).cloned().unwrap_or_else(|| abort_with("BLOCKED: unknown exact FT intent"));
        require(env::signer_account_pk() == intent.agent_public_key, "BLOCKED: wrong exact FT agent key");
        require(exact_intent_active(self, &intent), "BLOCKED: exact FT intent is consumed, cancelled, expired or stale");
        let (token, bal) = validate(self, &intent.policy_id, &intent.payee, intent.amount).unwrap_or_else(|m| abort_with(&m));
        require(token == intent.token, "BLOCKED: exact FT token changed");
        let bucket = env::block_timestamp() / NS_PER_HOUR;
        let dk = daily_key(&intent.policy_id, bucket);
        let spent = self.daily_spent.get(&dk).copied().unwrap_or(0);
        let next = spent.checked_add(intent.amount).unwrap_or_else(|| abort_with("daily spend overflow"));
        intent.consumed = true;
        self.exact_ft_intents.insert(intent_id.clone(), intent.clone());
        self.balances.insert(token.clone(), bal - intent.amount);
        self.daily_spent.insert(dk, next);
        env::log_str("BOUNCER exact FT intent consumed; transfer initiated");
        ext_ft::ext(token.clone()).with_attached_deposit(ONE_YOCTO).with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(intent.payee, U128(intent.amount), Some(intent.memo))
            .then(ext_exact_self::ext(env::current_account_id()).with_static_gas(GAS_FOR_RESOLVE)
                .after_exact_ft_transfer(intent_id, intent.policy_id, token, U128(intent.amount), bucket, intent.policy_revision))
    }

    pub fn contract_version(&self) -> &'static str {
        #[cfg(feature = "exact-ft-v12")]
        { "bouncer-agent-v12-exact-ft-testnet" }
        #[cfg(all(feature = "exact-ft-v11", not(feature = "exact-ft-v12")))]
        { "bouncer-agent-v11-exact-ft-testnet" }
        #[cfg(feature = "youtick-playback-v10")]
        { "bouncer-agent-v10-youtick-testnet" }
        #[cfg(not(any(feature = "youtick-playback-v10", feature = "exact-ft-v11")))]
        { "bouncer-agent-v9" }
    }

    /// Separately built testnet-focused artifact: an owner may authorize a
    /// short-lived YouTick Play grant for this vault and a reviewed job.
    /// Account suffixes do not prove chain identity; clients must check testnet.
    /// This is not a payment, publication, retrieval or delivery proof. The
    /// fixed external access contract is trusted; on-chain code correspondence
    /// and live playback remain unproven. Restricted zero-deposit agent keys
    /// cannot call this 1-yocto owner-only method.
    #[cfg(feature = "youtick-playback-v10")]
    #[payable]
    pub fn issue_youtick_play_grant(&mut self, job_id: String, session_pk: String, device_hash: String, session_pok: String) -> Promise {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        let vault = env::current_account_id();
        require(vault.as_str().ends_with(".testnet") && self.owner.as_str().ends_with(".testnet"), "testnet vault and owner required");
        require(!job_id.is_empty() && job_id.len() <= 128 && job_id.bytes().all(|b|
            b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-')), "invalid YouTick job ID");
        let key: PublicKey = session_pk.parse().unwrap_or_else(|_| abort_with("invalid playback session key"));
        require(session_pk.len() <= 64 && key.as_bytes().len() == 33 && key.as_bytes()[0] == 0, "invalid playback session key");
        let hex = |s: &str, size: usize| s.len() == size && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        require(hex(&device_hash, 64) && hex(&session_pok, 128), "invalid playback binding or proof");
        let request = YoutickPlayGrantRequest { target_owner_id: vault, session_pk, scope: "Play".into(),
            resource_id: Some(job_id), ttl_ms: YOUTICK_PLAY_GRANT_TTL_MS,
            origin_hash: Some(YOUTICK_ORIGIN_SHA256.into()), device_hash: Some(device_hash), session_pok };
        let access: AccountId = YOUTICK_ACCESS_TESTNET.parse().unwrap_or_else(|_| abort_with("invalid fixed access account"));
        ext_youtick_access::ext(access).with_attached_deposit(ZERO_NEAR).with_static_gas(GAS_FOR_YOUTICK_GRANT)
            .issue_session_grant(request)
    }

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

    /// Conservative amount recorded as deposited to OutLayer and not yet
    /// reserved for a project. It is not a live provider balance query and may
    /// understate funds after an ambiguous or refunded provider execution.
    pub fn outlayer_prepaid_balance(&self, token: AccountId) -> U128 {
        U128(self.outlayer_prepaid.get(&token).copied().unwrap_or(0))
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
        #[cfg(feature = "exact-ft-v11")]
        require(self.exact_ft_policies.get(&policy_id) != Some(&true), "BLOCKED: policy requires exact FT intents");
        let (token, bal) = validate(self, &policy_id, &payee, amount.0).unwrap_or_else(|m| abort_with(&m));
        #[cfg(feature = "exact-ft-v11")]
        require(self.exact_ft_payees.get(&(token.clone(), payee.clone())) != Some(&true),
            "BLOCKED: token and payee require exact FT intents");
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

    /// Call an FT receiver using exactly the token and message the owner pinned.
    /// The agent cannot supply a new action, destination, or stale route. The
    /// full amount is reserved before dispatch; the callback only credits the
    /// returned unused amount after a well-formed NEP-141 result.
    #[payable]
    pub fn execute_ft_call(&mut self, policy_id: String, payee: AccountId, amount: U128,
        expected_token: AccountId, expected_msg: String, expected_policy_revision: u64,
        expected_route_revision: u64) -> Promise {
        require(env::attached_deposit() == ZERO_NEAR, "BLOCKED: execute_ft_call requires zero deposit");
        require(env::predecessor_account_id() == self.owner && env::signer_account_id() == self.owner,
            "BLOCKED: caller is not the owner account");
        require(self.agents.get(&(policy_id.clone(), env::signer_account_pk())) == Some(&true),
            "BLOCKED: signing key is not authorized for this policy");
        #[cfg(feature = "exact-ft-v11")]
        require(self.exact_ft_policies.get(&policy_id) != Some(&true), "BLOCKED: policy requires exact FT intents");
        require(expected_msg.len() <= MAX_FT_CALL_MESSAGE_BYTES, "FT receiver message is too large");
        let route = self.get_ft_call_route(policy_id.clone(), payee.clone())
            .unwrap_or_else(|| abort_with("BLOCKED: no owner-approved FT call route"));
        require(route.active && route.policy_revision == expected_policy_revision &&
            route.route_revision == expected_route_revision && route.token == expected_token && route.msg == expected_msg,
            "BLOCKED: FT call route changed since review");
        let (token, bal) = validate(self, &policy_id, &payee, amount.0).unwrap_or_else(|m| abort_with(&m));
        require(token == expected_token && token.as_str() != NATIVE_ASSET,
            "BLOCKED: FT policy token changed since review");
        #[cfg(feature = "exact-ft-v11")]
        require(self.exact_ft_payees.get(&(token.clone(), payee.clone())) != Some(&true),
            "BLOCKED: token and payee require exact FT intents");
        let bucket = env::block_timestamp() / NS_PER_HOUR;
        let dk = daily_key(&policy_id, bucket);
        let spent = self.daily_spent.get(&dk).copied().unwrap_or(0);
        let next_spent = spent.checked_add(amount.0).unwrap_or_else(|| abort_with("daily spend overflow"));
        self.balances.insert(token.clone(), bal - amount.0);
        self.daily_spent.insert(dk, next_spent);
        env::log_str("BOUNCER guarded ft_transfer_call initiated; full amount reserved");
        ext_ft::ext(token.clone())
            .with_attached_deposit(ONE_YOCTO).with_static_gas(GAS_FOR_FT_TRANSFER_CALL)
            .ft_transfer_call(payee.clone(), amount, Some("bouncer:guarded-ft-call".into()), route.msg.clone())
            .then(ext_self::ext(env::current_account_id()).with_static_gas(GAS_FOR_RESOLVE)
                .after_execute_ft_call(policy_id, token, amount, bucket, route.policy_revision, payee, route.msg))
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
        // Even changing a program away and back must not reactivate an old
        // signed exact-input route. The owner must explicitly review it again.
        if let Some((revision, _)) = self.outlayer_input_routes.get(&policy_id) {
            let next = revision.checked_add(1).unwrap_or_else(|| abort_with("input route revision overflow"));
            self.outlayer_input_routes.insert(policy_id.clone(), (next, None));
        }
        self.outlayer_programs.insert(policy_id, encoded);
    }

    pub fn get_outlayer_program(&self, policy_id: String) -> Option<OutlayerProgram> {
        self.outlayer_programs.get(&policy_id).map(|encoded|
            near_sdk::serde_json::from_str(encoded).unwrap_or_else(|_| abort_with("invalid stored OutLayer program")))
    }

    /// Pin the entire input alongside the already-reviewed program. The
    /// restricted key can later execute only this route, not supply a URL,
    /// alternate operation or other arbitrary program input.
    #[payable]
    pub fn set_outlayer_input(&mut self, policy_id: String, input_data: String) {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        require(input_data.len() <= MAX_OUTLAYER_INPUT_BYTES, "OutLayer input is too large");
        let input: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(&input_data)
            .unwrap_or_else(|_| abort_with("OutLayer input must be JSON"));
        require(input.is_object(), "OutLayer input must be a JSON object");
        require(self.token_of.get(&policy_id).map(|x| x.as_str()) == Some(NATIVE_ASSET),
            "OutLayer policy must use the native asset");
        let payee: AccountId = OUTLAYER_TESTNET.parse().unwrap_or_else(|_| abort_with("invalid OutLayer account"));
        require(self.allow.get(&allow_key(&policy_id, payee.as_str())) == Some(&true), "OutLayer payee must already be allowed");
        let program = self.outlayer_programs.get(&policy_id).cloned()
            .unwrap_or_else(|| abort_with("BLOCKED: no owner-approved OutLayer program"));
        let policy_revision = self.ft_policy_revisions.get(&policy_id).copied()
            .unwrap_or_else(|| abort_with("missing policy revision"));
        let payee_revision = self.allow_revisions.get(&(policy_id.clone(), payee)).copied()
            .unwrap_or_else(|| abort_with("missing payee revision"));
        let revision = self.outlayer_input_routes.get(&policy_id).map(|(v, _)| *v).unwrap_or(0)
            .checked_add(1).unwrap_or_else(|| abort_with("input route revision overflow"));
        self.outlayer_input_routes.insert(policy_id, (revision, Some((program, input_data, policy_revision, payee_revision))));
    }

    #[payable]
    pub fn clear_outlayer_input(&mut self, policy_id: String) {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        let revision = self.outlayer_input_routes.get(&policy_id).map(|(v, _)| *v).unwrap_or(0)
            .checked_add(1).unwrap_or_else(|| abort_with("input route revision overflow"));
        self.outlayer_input_routes.insert(policy_id, (revision, None));
    }

    pub fn get_outlayer_input(&self, policy_id: String) -> Option<OutlayerInputRouteView> {
        let (revision, entry) = self.outlayer_input_routes.get(&policy_id)?;
        let (encoded, input_data, policy_revision, payee_revision) = entry.as_ref()?;
        let program: OutlayerProgram = near_sdk::serde_json::from_str(encoded)
            .unwrap_or_else(|_| abort_with("invalid stored OutLayer input program"));
        let payee: AccountId = OUTLAYER_TESTNET.parse().unwrap_or_else(|_| abort_with("invalid OutLayer account"));
        let active = self.token_of.get(&policy_id).map(|x| x.as_str()) == Some(NATIVE_ASSET)
            && self.allow.get(&allow_key(&policy_id, payee.as_str())) == Some(&true)
            && self.ft_policy_revisions.get(&policy_id) == Some(policy_revision)
            && self.allow_revisions.get(&(policy_id.clone(), payee)) == Some(payee_revision)
            && self.outlayer_programs.get(&policy_id) == Some(encoded);
        Some(OutlayerInputRouteView { program, input_data: input_data.clone(), route_revision: *revision,
            policy_revision: *policy_revision, payee_revision: *payee_revision, active })
    }

    /// Approve a native-only Project source, pinned version and exact input.
    /// Project-scoped WASM may require provider storage even for read-only API
    /// requests; this path does not spend or attach any provider-held FT credit.
    #[payable]
    pub fn set_outlayer_native_project(&mut self, policy_id: String, project: OutlayerNativeProject) {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        require(self.token_of.get(&policy_id).map(|t| t.as_str()) == Some(NATIVE_ASSET),
            "project native policy must use native NEAR");
        let mut parts = project.project_id.split('/');
        let owner = parts.next().unwrap_or("");
        let name = parts.next().unwrap_or("");
        require(parts.next().is_none() && owner.ends_with(".testnet") && owner.parse::<AccountId>().is_ok() &&
            !name.is_empty() && name.len() <= 64 && name.bytes().all(|b|
                b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_'), "invalid OutLayer project id");
        require(project.version_key.len() == 64 && project.version_key.bytes().all(|b|
            (b'0'..=b'9').contains(&b) || (b'a'..=b'f').contains(&b)), "invalid pinned project version");
        require(project.input_data.len() <= MAX_OUTLAYER_INPUT_BYTES, "project input is too large");
        let input: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(&project.input_data)
            .unwrap_or_else(|_| abort_with("project input must be JSON"));
        require(input.is_object(), "project input must be a JSON object");
        require(project.max_instructions > 0 && project.max_instructions <= 500_000_000_000 &&
            project.max_memory_mb > 0 && project.max_memory_mb <= 4096 &&
            project.max_execution_seconds > 0 && project.max_execution_seconds <= 180,
            "invalid OutLayer project resource limits");
        let payee: AccountId = OUTLAYER_TESTNET.parse().unwrap_or_else(|_| abort_with("invalid OutLayer account"));
        require(self.allow.get(&allow_key(&policy_id, payee.as_str())) == Some(&true), "OutLayer payee must already be allowed");
        let pr = self.ft_policy_revisions.get(&policy_id).copied().unwrap_or_else(|| abort_with("missing policy revision"));
        let ar = self.allow_revisions.get(&(policy_id.clone(), payee)).copied().unwrap_or_else(|| abort_with("missing payee revision"));
        let revision = self.outlayer_native_projects.get(&policy_id).map(|v| v.0).unwrap_or(0)
            .checked_add(1).unwrap_or_else(|| abort_with("native project revision overflow"));
        let encoded = near_sdk::serde_json::to_string(&project).unwrap_or_else(|_| abort_with("cannot serialize native project"));
        self.outlayer_native_projects.insert(policy_id, (revision, Some((encoded, pr, ar))));
    }

    #[payable]
    pub fn clear_outlayer_native_project(&mut self, policy_id: String) {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        let revision = self.outlayer_native_projects.get(&policy_id).map(|v| v.0).unwrap_or(0)
            .checked_add(1).unwrap_or_else(|| abort_with("native project revision overflow"));
        self.outlayer_native_projects.insert(policy_id, (revision, None));
    }

    pub fn get_outlayer_native_project(&self, policy_id: String) -> Option<OutlayerNativeProjectRouteView> {
        let (revision, entry) = self.outlayer_native_projects.get(&policy_id)?;
        let (encoded, pr, ar) = entry.as_ref()?;
        let project: OutlayerNativeProject = near_sdk::serde_json::from_str(encoded)
            .unwrap_or_else(|_| abort_with("invalid stored native project"));
        let payee: AccountId = OUTLAYER_TESTNET.parse().unwrap_or_else(|_| abort_with("invalid OutLayer account"));
        let active = self.token_of.get(&policy_id).map(|t| t.as_str()) == Some(NATIVE_ASSET) &&
            self.ft_policy_revisions.get(&policy_id) == Some(pr) &&
            self.allow_revisions.get(&(policy_id.clone(), payee.clone())) == Some(ar) &&
            self.allow.get(&allow_key(&policy_id, payee.as_str())) == Some(&true);
        Some(OutlayerNativeProjectRouteView { project, route_revision: *revision,
            policy_revision: *pr, payee_revision: *ar, active })
    }

    /// One capped native Project request. No agent-controlled destination,
    /// version, input, secrets, or FT fee. The full native maximum remains
    /// conservatively spent, even when the provider reports a partial refund.
    #[payable]
    pub fn execute_outlayer_native_project(&mut self, policy_id: String, amount: U128,
        expected_route: OutlayerNativeProjectRouteView) -> Promise {
        require(env::attached_deposit() == ZERO_NEAR, "BLOCKED: execute_outlayer_native_project requires zero deposit");
        require(env::predecessor_account_id() == self.owner && env::signer_account_id() == self.owner,
            "BLOCKED: caller is not the owner account");
        require(self.agents.get(&(policy_id.clone(), env::signer_account_pk())) == Some(&true),
            "BLOCKED: signing key is not authorized for this policy");
        let route = self.get_outlayer_native_project(policy_id.clone())
            .unwrap_or_else(|| abort_with("BLOCKED: no owner-approved native project"));
        require(route.active && route == expected_route, "BLOCKED: native project route changed since review");
        let payee: AccountId = OUTLAYER_TESTNET.parse().unwrap_or_else(|_| abort_with("invalid OutLayer account"));
        let (token, balance) = validate(self, &policy_id, &payee, amount.0).unwrap_or_else(|m| abort_with(&m));
        require(token.as_str() == NATIVE_ASSET, "BLOCKED: native project policy changed");
        let bucket = env::block_timestamp() / NS_PER_HOUR;
        let key = daily_key(&policy_id, bucket);
        let next = self.daily_spent.get(&key).copied().unwrap_or(0)
            .checked_add(amount.0).unwrap_or_else(|| abort_with("daily spend overflow"));
        self.native_balance = balance - amount.0;
        self.daily_spent.insert(key, next);
        let project = route.project;
        let args = near_sdk::serde_json::json!({
            "source": {"Project": {"project_id": project.project_id, "version_key": project.version_key}},
            "resource_limits": {"max_instructions": project.max_instructions, "max_memory_mb": project.max_memory_mb,
                "max_execution_seconds": project.max_execution_seconds},
            "input_data": project.input_data, "secrets_ref": null, "response_format": "Json",
            "payer_account_id": self.owner.clone(), "params": null,
        });
        env::log_str("BOUNCER independent native project initiated; full maximum reserved");
        Promise::new(payee).function_call("request_execution", args.to_string().into_bytes(),
            NearToken::from_yoctonear(amount.0), GAS_FOR_OUTLAYER)
    }

    /// Approve exactly one OutLayer project version, input and prepaid fee for
    /// a pair of separate native and FT policies. Any policy or payee edit
    /// invalidates the route until the owner reviews and pins it again.
    #[payable]
    pub fn set_outlayer_project(&mut self, native_policy_id: String, project: OutlayerProject) {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        require(self.token_of.get(&native_policy_id).map(|t| t.as_str()) == Some(NATIVE_ASSET),
            "project native policy must use native NEAR");
        require(!project.usd_policy_id.is_empty() && project.usd_policy_id.len() <= 128 &&
            native_policy_id != project.usd_policy_id, "project requires a separate prepaid-token policy");
        require(self.token_of.get(&project.usd_policy_id) == Some(&project.token) &&
            project.token.as_str() != NATIVE_ASSET, "project prepaid policy token mismatch");
        require(project.attached_usd.0 > 0 && self.cap_of.get(&project.usd_policy_id)
            .map_or(false, |cap| *cap >= project.attached_usd.0), "project prepaid fee exceeds its policy cap");
        let mut parts = project.project_id.split('/');
        let owner = parts.next().unwrap_or("");
        let name = parts.next().unwrap_or("");
        require(parts.next().is_none() && owner.ends_with(".testnet") && owner.parse::<AccountId>().is_ok() &&
            !name.is_empty() && name.len() <= 64 && name.bytes().all(|b|
                b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_'), "invalid OutLayer project id");
        require(project.version_key.len() == 64 && project.version_key.bytes().all(|b|
            (b'0'..=b'9').contains(&b) || (b'a'..=b'f').contains(&b)), "invalid pinned project version");
        require(project.input_data.len() <= MAX_OUTLAYER_INPUT_BYTES, "project input is too large");
        let input: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(&project.input_data)
            .unwrap_or_else(|_| abort_with("project input must be JSON"));
        require(input.is_object() && input.get("operation").and_then(|v| v.as_str())
            .map_or(false, |op| !op.is_empty() && op.len() <= 128), "project input must pin an operation");
        require(project.max_instructions > 0 && project.max_instructions <= 500_000_000_000 &&
            project.max_memory_mb > 0 && project.max_memory_mb <= 4096 &&
            project.max_execution_seconds > 0 && project.max_execution_seconds <= 180,
            "invalid OutLayer project resource limits");
        let payee: AccountId = OUTLAYER_TESTNET.parse().unwrap_or_else(|_| abort_with("invalid OutLayer account"));
        require(self.allow.get(&allow_key(&native_policy_id, payee.as_str())) == Some(&true) &&
            self.allow.get(&allow_key(&project.usd_policy_id, payee.as_str())) == Some(&true),
            "OutLayer must be allowed by both policies");
        let nr = self.ft_policy_revisions.get(&native_policy_id).copied().unwrap_or_else(|| abort_with("missing native policy revision"));
        let ur = self.ft_policy_revisions.get(&project.usd_policy_id).copied().unwrap_or_else(|| abort_with("missing token policy revision"));
        let na = self.allow_revisions.get(&(native_policy_id.clone(), payee.clone())).copied().unwrap_or_else(|| abort_with("missing native payee revision"));
        let ua = self.allow_revisions.get(&(project.usd_policy_id.clone(), payee)).copied().unwrap_or_else(|| abort_with("missing token payee revision"));
        let revision = self.outlayer_project_routes.get(&native_policy_id).map(|v| v.0).unwrap_or(0)
            .checked_add(1).unwrap_or_else(|| abort_with("project route revision overflow"));
        let encoded = near_sdk::serde_json::to_string(&project).unwrap_or_else(|_| abort_with("cannot serialize project"));
        self.outlayer_project_routes.insert(native_policy_id, (revision, Some((encoded, nr, ur, na, ua))));
    }

    #[payable]
    pub fn clear_outlayer_project(&mut self, native_policy_id: String) {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        let revision = self.outlayer_project_routes.get(&native_policy_id).map(|v| v.0).unwrap_or(0)
            .checked_add(1).unwrap_or_else(|| abort_with("project route revision overflow"));
        self.outlayer_project_routes.insert(native_policy_id, (revision, None));
    }

    pub fn get_outlayer_project(&self, native_policy_id: String) -> Option<OutlayerProjectRouteView> {
        let (revision, stored) = self.outlayer_project_routes.get(&native_policy_id)?;
        let (encoded, nr, ur, na, ua) = stored.as_ref()?;
        let project: OutlayerProject = near_sdk::serde_json::from_str(encoded)
            .unwrap_or_else(|_| abort_with("invalid stored project"));
        let payee: AccountId = OUTLAYER_TESTNET.parse().unwrap_or_else(|_| abort_with("invalid OutLayer account"));
        let active = self.ft_policy_revisions.get(&native_policy_id) == Some(nr) &&
            self.ft_policy_revisions.get(&project.usd_policy_id) == Some(ur) &&
            self.allow_revisions.get(&(native_policy_id.clone(), payee.clone())) == Some(na) &&
            self.allow_revisions.get(&(project.usd_policy_id.clone(), payee.clone())) == Some(ua) &&
            self.allow.get(&allow_key(&native_policy_id, payee.as_str())) == Some(&true) &&
            self.allow.get(&allow_key(&project.usd_policy_id, payee.as_str())) == Some(&true);
        // A later exact-intent reservation for this token/payee must also
        // invalidate a previously approved prepaid project route. V11 did not
        // enforce this pair lock for provider-held credit.
        #[cfg(feature = "exact-ft-v12")]
        let active = active && self.exact_ft_payees.get(&(project.token.clone(), payee)) != Some(&true);
        Some(OutlayerProjectRouteView { project, route_revision: *revision, native_policy_revision: *nr,
            usd_policy_revision: *ur, native_payee_revision: *na, usd_payee_revision: *ua, active })
    }

    /// Spend a bounded amount of provider-held credit AND native compute under
    /// two independent policy budgets. Both maxima remain reserved even if the
    /// provider rejects/refunds: its asynchronously held balance can be
    /// ambiguous, and retrying or crediting it optimistically could overspend.
    #[payable]
    pub fn execute_outlayer_project(&mut self, native_policy_id: String, amount: U128,
        expected_route: OutlayerProjectRouteView) -> Promise {
        require(env::attached_deposit() == ZERO_NEAR, "BLOCKED: execute_outlayer_project requires zero deposit");
        require(env::predecessor_account_id() == self.owner && env::signer_account_id() == self.owner,
            "BLOCKED: caller is not the owner account");
        let route = self.get_outlayer_project(native_policy_id.clone())
            .unwrap_or_else(|| abort_with("BLOCKED: no owner-approved OutLayer project"));
        require(route.active && route == expected_route, "BLOCKED: OutLayer project route changed since review");
        let project = route.project;
        #[cfg(feature = "exact-ft-v11")]
        require(self.exact_ft_policies.get(&project.usd_policy_id) != Some(&true), "BLOCKED: policy requires exact FT intents");
        let signing_key = env::signer_account_pk();
        require(self.agents.get(&(native_policy_id.clone(), signing_key.clone())) == Some(&true) &&
            self.agents.get(&(project.usd_policy_id.clone(), signing_key)) == Some(&true),
            "BLOCKED: signing key needs both project policies");
        let payee: AccountId = OUTLAYER_TESTNET.parse().unwrap_or_else(|_| abort_with("invalid OutLayer account"));
        #[cfg(feature = "exact-ft-v12")]
        require(self.exact_ft_payees.get(&(project.token.clone(), payee.clone())) != Some(&true),
            "BLOCKED: token and payee require exact FT intents");
        let (native, native_balance) = validate(self, &native_policy_id, &payee, amount.0).unwrap_or_else(|m| abort_with(&m));
        require(native.as_str() == NATIVE_ASSET, "BLOCKED: project native policy changed");
        let prepaid = self.outlayer_prepaid.get(&project.token).copied().unwrap_or(0);
        let (usd_token, prepaid_balance) = validate_with_balance(self, &project.usd_policy_id, &payee,
            project.attached_usd.0, Some(prepaid)).unwrap_or_else(|m| abort_with(&m));
        require(usd_token == project.token, "BLOCKED: project prepaid token changed");
        let bucket = env::block_timestamp() / NS_PER_HOUR;
        let native_key = daily_key(&native_policy_id, bucket);
        let usd_key = daily_key(&project.usd_policy_id, bucket);
        let native_spent = self.daily_spent.get(&native_key).copied().unwrap_or(0)
            .checked_add(amount.0).unwrap_or_else(|| abort_with("native project spend overflow"));
        let usd_spent = self.daily_spent.get(&usd_key).copied().unwrap_or(0)
            .checked_add(project.attached_usd.0).unwrap_or_else(|| abort_with("prepaid project spend overflow"));
        self.native_balance = native_balance - amount.0;
        self.outlayer_prepaid.insert(project.token.clone(), prepaid_balance - project.attached_usd.0);
        self.daily_spent.insert(native_key, native_spent);
        self.daily_spent.insert(usd_key, usd_spent);
        let args = near_sdk::serde_json::json!({
            "source": {"Project": {"project_id": project.project_id, "version_key": project.version_key}},
            "resource_limits": {"max_instructions": project.max_instructions, "max_memory_mb": project.max_memory_mb,
                "max_execution_seconds": project.max_execution_seconds},
            "input_data": project.input_data, "secrets_ref": null, "response_format": "Json",
            "payer_account_id": self.owner.clone(), "params": {"attached_usd": project.attached_usd},
        });
        env::log_str("BOUNCER independent paid project initiated; native and prepaid maxima reserved");
        Promise::new(payee).function_call("request_execution", args.to_string().into_bytes(),
            NearToken::from_yoctonear(amount.0), GAS_FOR_OUTLAYER)
    }

    /// Restricted-key path for programs whose input must be owner-pinned.
    /// The complete route, including monotonic revisions, is signed by the
    /// agent and compared again on-chain before reserving any funds.
    #[payable]
    pub fn execute_outlayer_pinned(&mut self, policy_id: String, amount: U128,
        expected_route: OutlayerInputRouteView) -> Promise {
        require(env::attached_deposit() == ZERO_NEAR, "BLOCKED: execute_outlayer_pinned requires zero deposit");
        let route = self.get_outlayer_input(policy_id.clone())
            .unwrap_or_else(|| abort_with("BLOCKED: no owner-approved OutLayer input route"));
        require(route.active && route == expected_route, "BLOCKED: OutLayer input route changed since review");
        self.execute_outlayer(policy_id, amount, route.input_data, route.program)
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

    /// NEP-141's final `ft_transfer_call` result is the amount USED, not the
    /// amount refunded. A failed/malformed result can be ambiguous (the token
    /// or receiver may have acted); conservatively leave the whole reservation
    /// in place and expose `null`, never assume it is safe to retry or recredit.
    #[private]
    pub fn after_execute_ft_call(&mut self, policy_id: String, token: AccountId, amount: U128,
        bucket: u64, policy_revision: u64, payee: AccountId, msg: String) -> Option<U128> {
        let used = match env::promise_result(0) {
            near_sdk::PromiseResult::Successful(bytes) => near_sdk::serde_json::from_slice::<U128>(&bytes)
                .ok().map(|v| v.0).filter(|v| *v <= amount.0),
            _ => None,
        };
        let Some(used) = used else {
            env::log_str("BOUNCER ft_transfer_call unresolved; full reservation retained");
            return None;
        };
        let unused = amount.0 - used;
        // Only OutLayer's exact documented deposit action creates an internal
        // prepaid allowance. This assumes the owner-trusted token and provider
        // honor NEP-141 and OutLayer's published deposit semantics; arbitrary
        // accepted FT calls never mint this allowance.
        if used > 0 && payee.as_str() == OUTLAYER_TESTNET && msg == OUTLAYER_DEPOSIT_MSG {
            let prior = self.outlayer_prepaid.get(&token).copied().unwrap_or(0);
            let next = prior.checked_add(used).unwrap_or_else(|| abort_with("prepaid allowance overflow"));
            self.outlayer_prepaid.insert(token.clone(), next);
            env::log_str("BOUNCER OutLayer prepaid allowance recorded");
        }
        if unused > 0 {
            let bal = self.balances.get(&token).copied().unwrap_or(0);
            let updated = bal.checked_add(unused).unwrap_or_else(|| abort_with("FT call refund balance overflow"));
            self.balances.insert(token, updated);
            // Never subtract a differently denominated/changed policy's budget.
            // Keep it conservative if the owner changed the policy in flight.
            if self.ft_policy_revisions.get(&policy_id) == Some(&policy_revision) {
                let dk = daily_key(&policy_id, bucket);
                if let Some(spent) = self.daily_spent.get(&dk).copied() {
                    self.daily_spent.insert(dk, spent.saturating_sub(unused));
                }
            }
        }
        env::log_str(&format!("BOUNCER ft_transfer_call settled; used={}; unused={}", used, unused));
        Some(U128(used))
    }

    /// A failed token receipt restores the vault balance, but never reopens
    /// the intent or its memo. A changed policy keeps the old spend counted
    /// conservatively rather than releasing a differently reviewed budget.
    #[cfg(feature = "exact-ft-v11")]
    #[private]
    pub fn after_exact_ft_transfer(&mut self, intent_id: String, policy_id: String, token: AccountId,
        amount: U128, bucket: u64, policy_revision: u64) {
        if !matches!(env::promise_result(0), near_sdk::PromiseResult::Successful(_)) {
            let bal = self.balances.get(&token).copied().unwrap_or(0);
            let updated = bal.checked_add(amount.0).unwrap_or_else(|| abort_with("exact FT refund balance overflow"));
            self.balances.insert(token, updated);
            if self.ft_policy_revisions.get(&policy_id) == Some(&policy_revision) {
                let dk = daily_key(&policy_id, bucket);
                if let Some(spent) = self.daily_spent.get(&dk).copied() {
                    self.daily_spent.insert(dk, spent.saturating_sub(amount.0));
                }
            }
            env::log_str("BOUNCER exact FT transfer failed; vault refunded, intent stays consumed");
        } else {
            env::log_str("BOUNCER exact FT transfer succeeded; intent stays consumed");
        }
        let _ = intent_id;
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

    #[cfg(feature = "youtick-playback-v10")]
    #[test]
    fn testnet_play_grant_is_owner_authorized_and_narrowly_bound() {
        use near_sdk::mock::MockAction;
        use near_sdk::test_utils::get_created_receipts;
        let (mut contract, _) = fixture();
        testing_env!(owner_context(&key(1), 1, NS_PER_DAY));
        let session_pk = String::from(&key(4));
        drop(contract.issue_youtick_play_grant("job:one".into(), session_pk.clone(), "a".repeat(64), "b".repeat(128)));
        assert_eq!(contract.contract_version(), "bouncer-agent-v10-youtick-testnet");
        assert_eq!(contract.vault_balance(id("token.testnet")).0, 1_000);
        let receipts = get_created_receipts();
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].receiver_id, id(YOUTICK_ACCESS_TESTNET));
        let (args, deposit) = receipts[0].actions.iter().find_map(|action| match action {
            MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } if method_name == b"issue_session_grant" => Some((args, attached_deposit)),
            _ => None,
        }).expect("expected only the fixed grant method");
        assert_eq!(*deposit, ZERO_NEAR);
        let value: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(args).unwrap();
        let request = &value["request"];
        assert_eq!(request["target_owner_id"], "bouncer.testnet");
        assert_eq!(request["session_pk"], session_pk);
        assert_eq!(request["scope"], "Play");
        assert_eq!(request["resource_id"], "job:one");
        assert_eq!(request["ttl_ms"], YOUTICK_PLAY_GRANT_TTL_MS);
        assert_eq!(request["origin_hash"], YOUTICK_ORIGIN_SHA256);
        assert_eq!(request["device_hash"], "a".repeat(64));
        assert_eq!(request["session_pok"], "b".repeat(128));
    }

    #[cfg(feature = "youtick-playback-v10")]
    #[test]
    #[should_panic(expected = "owner-only method requires exactly 1 yoctoNEAR")]
    fn agent_cannot_issue_a_playback_grant() {
        let (mut contract, agent) = fixture();
        testing_env!(owner_context(&agent, 0, NS_PER_DAY));
        drop(contract.issue_youtick_play_grant("job".into(), String::from(&key(4)), "a".repeat(64), "b".repeat(128)));
    }

    #[cfg(feature = "youtick-playback-v10")]
    #[test]
    #[should_panic(expected = "ESCALATION BLOCKED: caller is not owner")]
    fn attacker_cannot_issue_a_grant_even_with_one_yocto() {
        let (mut contract, _) = fixture();
        testing_env!(context("attacker.testnet", "attacker.testnet", &key(4), 1, NS_PER_DAY));
        drop(contract.issue_youtick_play_grant("job".into(), String::from(&key(4)), "a".repeat(64), "b".repeat(128)));
    }

    #[cfg(feature = "youtick-playback-v10")]
    #[test]
    #[should_panic(expected = "testnet vault and owner required")]
    fn playback_grant_is_unavailable_from_mainnet_named_vault() {
        let (mut contract, _) = fixture();
        let mut b = VMContextBuilder::new();
        b.current_account_id(id("vault.near")).predecessor_account_id(id("bouncer.testnet"))
            .signer_account_id(id("bouncer.testnet")).signer_account_pk(key(1))
            .attached_deposit(NearToken::from_yoctonear(1)).prepaid_gas(Gas::from_tgas(300));
        testing_env!(b.build());
        drop(contract.issue_youtick_play_grant("job".into(), String::from(&key(4)), "a".repeat(64), "b".repeat(128)));
    }

    #[cfg(feature = "youtick-playback-v10")]
    #[test]
    #[should_panic(expected = "invalid YouTick job ID")]
    fn malformed_playback_job_is_rejected() {
        let (mut contract, _) = fixture(); testing_env!(owner_context(&key(1), 1, NS_PER_DAY));
        drop(contract.issue_youtick_play_grant("job\\nother".into(), String::from(&key(4)), "a".repeat(64), "b".repeat(128)));
    }

    #[cfg(feature = "youtick-playback-v10")]
    #[test]
    #[should_panic(expected = "invalid playback session key")]
    fn malformed_playback_key_is_rejected() {
        let (mut contract, _) = fixture(); testing_env!(owner_context(&key(1), 1, NS_PER_DAY));
        drop(contract.issue_youtick_play_grant("job".into(), "attacker".into(), "a".repeat(64), "b".repeat(128)));
    }

    #[cfg(feature = "youtick-playback-v10")]
    #[test]
    #[should_panic(expected = "invalid playback binding or proof")]
    fn malformed_playback_proof_is_rejected() {
        let (mut contract, _) = fixture(); testing_env!(owner_context(&key(1), 1, NS_PER_DAY));
        drop(contract.issue_youtick_play_grant("job".into(), String::from(&key(4)), "a".repeat(64), "XYZ".into()));
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

    const PINNED_FT_MSG: &str = r#"{"action":"purchase","plan":"basic"}"#;

    // A policy revision does not clear the hour's numeric spend. Exercise a
    // delayed old-token refund alongside a partially refunded FT call and a
    // newer-token transfer, without changing the existing callback ABI.
    #[test]
    #[allow(deprecated)]
    fn delayed_refunds_after_policy_change_do_not_release_newer_reservations() {
        let (mut contract, agent) = ft_call_fixture();
        testing_env!(owner_context(&agent, 0, NS_PER_DAY));
        drop(contract.execute("compute".into(), id("vendor.testnet"), U128(100), None, id("token.testnet")));
        send_ft_call(&mut contract, 100);
        assert_eq!(contract.daily_spent("compute".into()).0, 200);
        assert_eq!(contract.vault_balance(id("token.testnet")).0, 800);

        testing_env!(owner_context(&key(1), 1, NS_PER_DAY));
        contract.set_policy("compute".into(), id("other-token.testnet"), U128(200), Some(U128(300)));
        contract.balances.insert(id("other-token.testnet"), 500);
        testing_env!(owner_context(&agent, 0, NS_PER_DAY));
        drop(contract.execute("compute".into(), id("vendor.testnet"), U128(50), None, id("other-token.testnet")));
        assert_eq!(contract.daily_spent("compute".into()).0, 250);

        testing_env_with_promise_results(context("bouncer.testnet", "bouncer.testnet", &agent, 0, NS_PER_DAY),
            PromiseResult::Successful(b"\"60\"".to_vec()));
        assert_eq!(contract.after_execute_ft_call("compute".into(), id("token.testnet"), U128(100), WINDOW_HOURS,
            1, id("vendor.testnet"), PINNED_FT_MSG.into()).map(|u| u.0), Some(60));
        // Changed FT policy revision retains the original full numeric budget.
        assert_eq!(contract.daily_spent("compute".into()).0, 250);
        testing_env_with_promise_results(context("bouncer.testnet", "bouncer.testnet", &agent, 0, NS_PER_DAY),
            PromiseResult::Failed);
        contract.after_execute("compute".into(), id("token.testnet"), U128(100), WINDOW_HOURS);
        assert_eq!(contract.vault_balance(id("token.testnet")).0, 940);
        assert_eq!(contract.vault_balance(id("other-token.testnet")).0, 450);
        // Old FT reservation (100) plus newer-token transfer (50) remain.
        assert_eq!(contract.daily_spent("compute".into()).0, 150);
        assert_eq!(contract.check("compute".into(), id("vendor.testnet"), U128(151)).1,
            "BLOCKED: daily cap exceeded for this policy");
    }

    fn ft_call_fixture() -> (Bouncer, PublicKey) {
        let (mut contract, agent) = fixture();
        testing_env!(owner_context(&key(1), 1, NS_PER_DAY));
        contract.set_ft_call_message("compute".into(), id("vendor.testnet"), PINNED_FT_MSG.into());
        (contract, agent)
    }
    fn send_ft_call(contract: &mut Bouncer, amount: u128) {
        drop(contract.execute_ft_call("compute".into(), id("vendor.testnet"), U128(amount),
            id("token.testnet"), PINNED_FT_MSG.into(), 1, 1));
    }

    #[test]
    fn ft_call_reserves_budget_and_dispatches_only_the_exact_pinned_message() {
        use near_sdk::mock::MockAction;
        use near_sdk::test_utils::get_created_receipts;
        let (mut contract, agent) = ft_call_fixture();
        let route = contract.get_ft_call_route("compute".into(), id("vendor.testnet")).unwrap();
        assert!(route.active);
        assert_eq!((route.policy_revision, route.route_revision), (1, 1));
        assert_eq!(route.token, id("token.testnet"));
        assert_eq!(route.msg, PINNED_FT_MSG);
        testing_env!(owner_context(&agent, 0, NS_PER_DAY));
        send_ft_call(&mut contract, 100);
        assert_eq!(contract.vault_balance(id("token.testnet")).0, 900);
        assert_eq!(contract.daily_spent("compute".into()).0, 100);
        let receipts = get_created_receipts();
        let receipt = receipts.iter().find(|r| r.receiver_id == id("token.testnet")).expect("FT receipt");
        let (args, deposit) = receipt.actions.iter().find_map(|a| match a {
            MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } if method_name == b"ft_transfer_call" => Some((args, attached_deposit)),
            _ => None,
        }).expect("ft_transfer_call action");
        assert_eq!(*deposit, ONE_YOCTO);
        let args: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(args).unwrap();
        assert_eq!(args["receiver_id"], "vendor.testnet");
        assert_eq!(args["amount"], "100");
        assert_eq!(args["msg"], PINNED_FT_MSG);
    }

    #[test]
    #[should_panic(expected = "owner-only method requires exactly 1 yoctoNEAR")]
    fn agent_cannot_pin_a_new_ft_receiver_action() {
        let (mut contract, agent) = ft_call_fixture();
        testing_env!(owner_context(&agent, 0, NS_PER_DAY));
        contract.set_ft_call_message("compute".into(), id("vendor.testnet"), "attacker action".into());
    }

    #[test]
    #[should_panic(expected = "BLOCKED: FT call route changed since review")]
    fn agent_cannot_modify_ft_receiver_message() {
        let (mut contract, agent) = ft_call_fixture();
        testing_env!(owner_context(&agent, 0, NS_PER_DAY));
        drop(contract.execute_ft_call("compute".into(), id("vendor.testnet"), U128(100),
            id("token.testnet"), "attacker action".into(), 1, 1));
    }

    #[test]
    #[should_panic(expected = "BLOCKED: FT call route changed since review")]
    fn agent_cannot_change_the_pinned_ft_token() {
        let (mut contract, agent) = ft_call_fixture();
        testing_env!(owner_context(&agent, 0, NS_PER_DAY));
        drop(contract.execute_ft_call("compute".into(), id("vendor.testnet"), U128(100),
            id("other-token.testnet"), PINNED_FT_MSG.into(), 1, 1));
    }

    #[test]
    #[should_panic(expected = "BLOCKED: execute_ft_call requires zero deposit")]
    fn ft_call_requires_zero_deposit_from_the_restricted_key() {
        let (mut contract, agent) = ft_call_fixture();
        testing_env!(owner_context(&agent, 1, NS_PER_DAY));
        send_ft_call(&mut contract, 100);
    }

    #[test]
    #[should_panic(expected = "FT receiver message is too large")]
    fn owner_cannot_pin_an_unbounded_ft_message() {
        let (mut contract, _) = ft_call_fixture();
        testing_env!(owner_context(&key(1), 1, NS_PER_DAY));
        contract.set_ft_call_message("compute".into(), id("vendor.testnet"), "x".repeat(MAX_FT_CALL_MESSAGE_BYTES + 1));
    }

    #[test]
    #[should_panic(expected = "payee must already be allowed")]
    fn owner_must_allow_a_payee_before_pinning_its_message() {
        let (mut contract, _) = ft_call_fixture();
        testing_env!(owner_context(&key(1), 1, NS_PER_DAY));
        contract.set_ft_call_message("compute".into(), id("other.testnet"), "".into());
    }

    #[test]
    #[should_panic(expected = "BLOCKED: amount exceeds per-tx cap")]
    fn ft_call_cannot_exceed_the_policy_cap() {
        let (mut contract, agent) = ft_call_fixture();
        testing_env!(owner_context(&agent, 0, NS_PER_DAY));
        send_ft_call(&mut contract, 201);
    }

    #[test]
    #[should_panic(expected = "BLOCKED: daily cap exceeded for this policy")]
    fn ft_call_cannot_bypass_the_rolling_budget_with_small_calls() {
        let (mut contract, agent) = ft_call_fixture();
        testing_env!(owner_context(&agent, 0, NS_PER_DAY));
        send_ft_call(&mut contract, 200);
        send_ft_call(&mut contract, 101);
    }

    #[test]
    #[should_panic(expected = "BLOCKED: signing key is not authorized for this policy")]
    fn ft_call_requires_an_explicitly_granted_key() {
        let (mut contract, _) = ft_call_fixture();
        testing_env!(owner_context(&key(3), 0, NS_PER_DAY));
        send_ft_call(&mut contract, 100);
    }

    #[test]
    #[should_panic(expected = "BLOCKED: FT call route changed since review")]
    fn a_policy_edit_invalidates_even_a_previously_signed_route() {
        let (mut contract, agent) = ft_call_fixture();
        testing_env!(owner_context(&key(1), 1, NS_PER_DAY));
        contract.set_policy("compute".into(), id("token.testnet"), U128(200), Some(U128(300)));
        assert!(!contract.get_ft_call_route("compute".into(), id("vendor.testnet")).unwrap().active);
        testing_env!(owner_context(&agent, 0, NS_PER_DAY));
        send_ft_call(&mut contract, 100);
    }

    #[test]
    fn ft_routes_require_review_again_after_policy_change_and_cannot_revive_after_revoke() {
        let (mut contract, _) = ft_call_fixture();
        testing_env!(owner_context(&key(1), 1, NS_PER_DAY));
        contract.set_policy("compute".into(), id("other-token.testnet"), U128(200), Some(U128(300)));
        contract.set_policy("compute".into(), id("token.testnet"), U128(200), Some(U128(300)));
        assert!(!contract.get_ft_call_route("compute".into(), id("vendor.testnet")).unwrap().active);
        contract.set_ft_call_message("compute".into(), id("vendor.testnet"), PINNED_FT_MSG.into());
        let route = contract.get_ft_call_route("compute".into(), id("vendor.testnet")).unwrap();
        assert!(route.active);
        assert_eq!((route.policy_revision, route.route_revision), (3, 2));
        contract.revoke_payee("compute".into(), id("vendor.testnet"));
        contract.allow_payee("compute".into(), id("vendor.testnet"));
        assert!(contract.get_ft_call_route("compute".into(), id("vendor.testnet")).is_none());
        contract.set_ft_call_message("compute".into(), id("vendor.testnet"), PINNED_FT_MSG.into());
        assert_eq!(contract.get_ft_call_route("compute".into(), id("vendor.testnet")).unwrap().route_revision, 4);
    }

    #[test]
    #[should_panic(expected = "BLOCKED: FT call route changed since review")]
    fn clearing_and_repinning_the_same_message_does_not_revive_a_stale_signature() {
        let (mut contract, agent) = ft_call_fixture();
        testing_env!(owner_context(&key(1), 1, NS_PER_DAY));
        contract.clear_ft_call_message("compute".into(), id("vendor.testnet"));
        contract.set_ft_call_message("compute".into(), id("vendor.testnet"), PINNED_FT_MSG.into());
        testing_env!(owner_context(&agent, 0, NS_PER_DAY));
        send_ft_call(&mut contract, 100);
    }

    #[test]
    #[allow(deprecated)]
    fn ft_call_partial_refund_uses_the_used_amount_and_original_hour() {
        let (mut contract, agent) = ft_call_fixture();
        testing_env!(owner_context(&agent, 0, NS_PER_DAY));
        send_ft_call(&mut contract, 100);
        contract.daily_spent.insert(daily_key("compute", WINDOW_HOURS + 1), 75);
        testing_env_with_promise_results(context("bouncer.testnet", "bouncer.testnet", &agent, 0, NS_PER_DAY + NS_PER_HOUR),
            PromiseResult::Successful(b"\"60\"".to_vec()));
        assert_eq!(contract.after_execute_ft_call("compute".into(), id("token.testnet"), U128(100), WINDOW_HOURS, 1, id("vendor.testnet"), PINNED_FT_MSG.into()).map(|u| u.0), Some(60));
        assert_eq!(contract.vault_balance(id("token.testnet")).0, 940);
        assert_eq!(*contract.daily_spent.get(&daily_key("compute", WINDOW_HOURS)).unwrap(), 60);
        assert_eq!(*contract.daily_spent.get(&daily_key("compute", WINDOW_HOURS + 1)).unwrap(), 75);
    }

    #[allow(deprecated)]
    fn assert_ft_call_accounting(used: u128, expected_balance: u128, expected_spent: u128) {
        let (mut contract, agent) = ft_call_fixture();
        testing_env!(owner_context(&agent, 0, NS_PER_DAY));
        send_ft_call(&mut contract, 100);
        testing_env_with_promise_results(context("bouncer.testnet", "bouncer.testnet", &agent, 0, NS_PER_DAY),
            PromiseResult::Successful(format!("\"{}\"", used).into_bytes()));
        assert_eq!(contract.after_execute_ft_call("compute".into(), id("token.testnet"), U128(100), WINDOW_HOURS, 1, id("vendor.testnet"), PINNED_FT_MSG.into()).map(|u| u.0), Some(used));
        assert_eq!(contract.vault_balance(id("token.testnet")).0, expected_balance);
        assert_eq!(contract.daily_spent("compute".into()).0, expected_spent);
    }
    #[test]
    fn ft_call_fully_refunds_when_nothing_was_used() { assert_ft_call_accounting(0, 1_000, 0); }
    #[test]
    fn ft_call_retains_full_reservation_when_all_was_used() { assert_ft_call_accounting(100, 900, 100); }

    #[test]
    #[allow(deprecated)]
    fn ambiguous_or_malformed_ft_call_results_never_release_the_reservation() {
        let (mut contract, agent) = ft_call_fixture();
        testing_env!(owner_context(&agent, 0, NS_PER_DAY));
        send_ft_call(&mut contract, 100);
        for result in [PromiseResult::Failed, PromiseResult::Successful(b"null".to_vec()),
            PromiseResult::Successful(b"60".to_vec()), PromiseResult::Successful(b"\"101\"".to_vec()),
            PromiseResult::Successful(b"bad".to_vec())] {
            testing_env_with_promise_results(context("bouncer.testnet", "bouncer.testnet", &agent, 0, NS_PER_DAY), result);
            assert!(contract.after_execute_ft_call("compute".into(), id("token.testnet"), U128(100), WINDOW_HOURS, 1, id("vendor.testnet"), PINNED_FT_MSG.into()).is_none());
            assert_eq!(contract.vault_balance(id("token.testnet")).0, 900);
            assert_eq!(contract.daily_spent("compute".into()).0, 100);
        }
    }

    #[test]
    #[allow(deprecated)]
    fn ft_refund_does_not_release_budget_after_policy_was_changed_in_flight() {
        let (mut contract, agent) = ft_call_fixture();
        testing_env!(owner_context(&agent, 0, NS_PER_DAY));
        send_ft_call(&mut contract, 100);
        testing_env!(owner_context(&key(1), 1, NS_PER_DAY));
        contract.set_policy("compute".into(), id("other-token.testnet"), U128(200), Some(U128(300)));
        testing_env_with_promise_results(context("bouncer.testnet", "bouncer.testnet", &agent, 0, NS_PER_DAY),
            PromiseResult::Successful(b"\"60\"".to_vec()));
        assert_eq!(contract.after_execute_ft_call("compute".into(), id("token.testnet"), U128(100), WINDOW_HOURS, 1, id("vendor.testnet"), PINNED_FT_MSG.into()).map(|u| u.0), Some(60));
        assert_eq!(contract.vault_balance(id("token.testnet")).0, 940);
        assert_eq!(contract.daily_spent("compute".into()).0, 100);
    }

    #[test]
    #[allow(deprecated)]
    fn only_the_exact_outlayer_deposit_action_credits_prepaid_allowance() {
        let (mut contract, agent) = ft_call_fixture();
        testing_env!(owner_context(&agent, 0, NS_PER_DAY));
        send_ft_call(&mut contract, 100);
        testing_env_with_promise_results(context("bouncer.testnet", "bouncer.testnet", &agent, 0, NS_PER_DAY),
            PromiseResult::Successful(b"\"100\"".to_vec()));
        contract.after_execute_ft_call("compute".into(), id("token.testnet"), U128(100), WINDOW_HOURS, 1,
            id("vendor.testnet"), OUTLAYER_DEPOSIT_MSG.into());
        assert_eq!(contract.outlayer_prepaid_balance(id("token.testnet")).0, 0);
        contract.after_execute_ft_call("compute".into(), id("token.testnet"), U128(100), WINDOW_HOURS, 1,
            id(OUTLAYER_TESTNET), "other".into());
        assert_eq!(contract.outlayer_prepaid_balance(id("token.testnet")).0, 0);
        contract.after_execute_ft_call("compute".into(), id("token.testnet"), U128(100), WINDOW_HOURS, 1,
            id(OUTLAYER_TESTNET), OUTLAYER_DEPOSIT_MSG.into());
        assert_eq!(contract.outlayer_prepaid_balance(id("token.testnet")).0, 100);
    }

    fn paid_project() -> OutlayerProject {
        OutlayerProject { project_id: "connectors.outlayer.testnet/connector-probe".into(), version_key: "a".repeat(64),
            usd_policy_id: "project-usd".into(), token: id("usdc.fakes.testnet"), attached_usd: U128(30),
            input_data: r#"{"operation":"fetch"}"#.into(), max_instructions: 100_000_000,
            max_memory_mb: 256, max_execution_seconds: 60 }
    }
    fn project_fixture() -> (Bouncer, PublicKey, OutlayerProjectRouteView) {
        let owner_key = key(1); let agent = key(2);
        testing_env!(context("owner.testnet", "owner.testnet", &owner_key, 1, NS_PER_DAY));
        let mut contract = Bouncer::new(id("owner.testnet"));
        for (policy, token, cap, daily) in [("project-native", NATIVE_ASSET, 200, 300),
            ("project-usd", "usdc.fakes.testnet", 40, 50)] {
            contract.set_policy(policy.into(), id(token), U128(cap), Some(U128(daily)));
            contract.allow_payee(policy.into(), id(OUTLAYER_TESTNET));
            contract.grant_agent_key(policy.into(), agent.clone());
        }
        contract.native_balance = 500;
        contract.outlayer_prepaid.insert(id("usdc.fakes.testnet"), 100);
        contract.set_outlayer_project("project-native".into(), paid_project());
        let route = contract.get_outlayer_project("project-native".into()).unwrap();
        (contract, agent, route)
    }

    #[test]
    fn paid_project_reserves_two_assets_and_pins_project_version_fee_and_input() {
        use near_sdk::mock::MockAction;
        use near_sdk::test_utils::get_created_receipts;
        let (mut contract, agent, route) = project_fixture();
        assert!(route.active);
        testing_env!(context("owner.testnet", "owner.testnet", &agent, 0, NS_PER_DAY));
        drop(contract.execute_outlayer_project("project-native".into(), U128(100), route));
        assert_eq!(contract.vault_balance(id(NATIVE_ASSET)).0, 400);
        assert_eq!(contract.outlayer_prepaid_balance(id("usdc.fakes.testnet")).0, 70);
        assert_eq!(contract.daily_spent("project-native".into()).0, 100);
        assert_eq!(contract.daily_spent("project-usd".into()).0, 30);
        let receipts = get_created_receipts();
        let receipt = receipts.iter().find(|r| r.receiver_id == id(OUTLAYER_TESTNET)).unwrap();
        let (args, deposit) = receipt.actions.iter().find_map(|a| match a {
            MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } if method_name == b"request_execution" => Some((args, attached_deposit)),
            _ => None,
        }).unwrap();
        assert_eq!(*deposit, NearToken::from_yoctonear(100));
        let args: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(args).unwrap();
        assert_eq!(args["source"]["Project"]["project_id"], "connectors.outlayer.testnet/connector-probe");
        assert_eq!(args["source"]["Project"]["version_key"], "a".repeat(64));
        assert_eq!(args["params"]["attached_usd"], "30");
        assert_eq!(args["input_data"], r#"{"operation":"fetch"}"#);
        assert_eq!(args["payer_account_id"], "owner.testnet");
        assert!(args["secrets_ref"].is_null());
        assert_eq!(receipts.len(), 1); // never optimistically recredit a provider refund
    }

    #[test]
    #[should_panic(expected = "owner-only method requires exactly 1 yoctoNEAR")]
    fn agent_cannot_change_the_paid_project() {
        let (mut contract, agent, _) = project_fixture();
        testing_env!(context("owner.testnet", "owner.testnet", &agent, 0, NS_PER_DAY));
        contract.set_outlayer_project("project-native".into(), paid_project());
    }

    #[test]
    #[should_panic(expected = "BLOCKED: OutLayer project route changed since review")]
    fn agent_cannot_modify_the_pinned_project_input() {
        let (mut contract, agent, mut route) = project_fixture();
        route.project.input_data = r#"{"operation":"other"}"#.into();
        testing_env!(context("owner.testnet", "owner.testnet", &agent, 0, NS_PER_DAY));
        drop(contract.execute_outlayer_project("project-native".into(), U128(100), route));
    }

    #[test]
    #[should_panic(expected = "BLOCKED: signing key needs both project policies")]
    fn paid_project_requires_grants_for_both_assets() {
        let (mut contract, agent, route) = project_fixture();
        testing_env!(context("owner.testnet", "owner.testnet", &key(1), 1, NS_PER_DAY));
        contract.revoke_agent_key("project-usd".into(), agent.clone());
        testing_env!(context("owner.testnet", "owner.testnet", &agent, 0, NS_PER_DAY));
        drop(contract.execute_outlayer_project("project-native".into(), U128(100), route));
    }

    #[test]
    #[should_panic(expected = "BLOCKED: daily cap exceeded for this policy")]
    fn project_prepaid_spend_has_an_independent_rolling_budget() {
        let (mut contract, agent, route) = project_fixture();
        testing_env!(context("owner.testnet", "owner.testnet", &agent, 0, NS_PER_DAY));
        drop(contract.execute_outlayer_project("project-native".into(), U128(100), route.clone()));
        drop(contract.execute_outlayer_project("project-native".into(), U128(100), route));
    }

    #[test]
    #[should_panic(expected = "BLOCKED: insufficient vault balance")]
    fn project_cannot_spend_unrecorded_provider_credit() {
        let (mut contract, agent, route) = project_fixture();
        contract.outlayer_prepaid.insert(id("usdc.fakes.testnet"), 29);
        testing_env!(context("owner.testnet", "owner.testnet", &agent, 0, NS_PER_DAY));
        drop(contract.execute_outlayer_project("project-native".into(), U128(100), route));
    }

    #[test]
    fn project_routes_never_revive_after_policy_or_payee_changes() {
        let (mut contract, _, route) = project_fixture();
        testing_env!(context("owner.testnet", "owner.testnet", &key(1), 1, NS_PER_DAY));
        contract.revoke_payee("project-usd".into(), id(OUTLAYER_TESTNET));
        contract.allow_payee("project-usd".into(), id(OUTLAYER_TESTNET));
        assert!(!contract.get_outlayer_project("project-native".into()).unwrap().active);
        contract.set_outlayer_project("project-native".into(), paid_project());
        let repinned = contract.get_outlayer_project("project-native".into()).unwrap();
        assert!(repinned.active && repinned.route_revision > route.route_revision);
        contract.set_policy("project-usd".into(), id("usdc.fakes.testnet"), U128(40), Some(U128(50)));
        assert!(!contract.get_outlayer_project("project-native".into()).unwrap().active);
        contract.set_outlayer_project("project-native".into(), paid_project());
        let again = contract.get_outlayer_project("project-native".into()).unwrap();
        contract.clear_outlayer_project("project-native".into());
        contract.set_outlayer_project("project-native".into(), paid_project());
        assert!(contract.get_outlayer_project("project-native".into()).unwrap().route_revision > again.route_revision);
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

    fn native_project() -> OutlayerNativeProject {
        OutlayerNativeProject { project_id: "author.testnet/price-oracle".into(), version_key: "a".repeat(64),
            input_data: "{\"command\":\"fetch_external\",\"token_id\":\"near\",\"source\":\"coingecko\"}".into(),
            max_instructions: 10_000_000, max_memory_mb: 128, max_execution_seconds: 60 }
    }
    fn native_project_fixture() -> (Bouncer, PublicKey, OutlayerNativeProjectRouteView) {
        let (mut contract, agent, _) = native_fixture();
        testing_env!(context("owner.testnet", "owner.testnet", &key(1), 1, NS_PER_DAY));
        contract.set_outlayer_native_project("external-compute".into(), native_project());
        let route = contract.get_outlayer_native_project("external-compute".into()).unwrap();
        (contract, agent, route)
    }

    #[test]
    fn native_project_pins_version_input_and_spends_only_native() {
        use near_sdk::mock::MockAction;
        use near_sdk::test_utils::get_created_receipts;
        let (mut contract, agent, route) = native_project_fixture();
        assert!(route.active);
        testing_env!(context("owner.testnet", "owner.testnet", &agent, 0, NS_PER_DAY));
        drop(contract.execute_outlayer_native_project("external-compute".into(), U128(100), route.clone()));
        assert_eq!(contract.vault_balance(id(NATIVE_ASSET)).0, 400);
        assert_eq!(contract.daily_spent("external-compute".into()).0, 100);
        let receipts = get_created_receipts();
        let receipt = receipts.iter().find(|r| r.receiver_id == id(OUTLAYER_TESTNET)).unwrap();
        let args = receipt.actions.iter().find_map(|a| match a {
            MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } if method_name == b"request_execution" => {
                assert_eq!(*attached_deposit, NearToken::from_yoctonear(100)); Some(args)
            }, _ => None,
        }).unwrap();
        let args: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(args).unwrap();
        assert_eq!(args["source"]["Project"]["project_id"], route.project.project_id);
        assert_eq!(args["source"]["Project"]["version_key"], route.project.version_key);
        assert_eq!(args["input_data"], route.project.input_data);
        assert_eq!(args["payer_account_id"], "owner.testnet");
        assert!(args["secrets_ref"].is_null() && args["params"].is_null());
    }

    #[test]
    #[should_panic(expected = "owner-only method requires exactly 1 yoctoNEAR")]
    fn agent_cannot_change_native_project() {
        let (mut contract, agent, _) = native_project_fixture();
        testing_env!(context("owner.testnet", "owner.testnet", &agent, 0, NS_PER_DAY));
        contract.set_outlayer_native_project("external-compute".into(), native_project());
    }
    #[test]
    #[should_panic(expected = "BLOCKED: native project route changed since review")]
    fn agent_cannot_change_native_project_input() {
        let (mut contract, agent, mut route) = native_project_fixture();
        route.project.input_data = "{\"command\":\"arbitrary\"}".into();
        testing_env!(context("owner.testnet", "owner.testnet", &agent, 0, NS_PER_DAY));
        drop(contract.execute_outlayer_native_project("external-compute".into(), U128(100), route));
    }
    #[test]
    #[should_panic(expected = "BLOCKED: native project route changed since review")]
    fn agent_cannot_change_native_project_version() {
        let (mut contract, agent, mut route) = native_project_fixture();
        route.project.version_key = "b".repeat(64);
        testing_env!(context("owner.testnet", "owner.testnet", &agent, 0, NS_PER_DAY));
        drop(contract.execute_outlayer_native_project("external-compute".into(), U128(100), route));
    }
    #[test]
    #[should_panic(expected = "BLOCKED: signing key is not authorized for this policy")]
    fn native_project_requires_an_explicit_key_grant() {
        let (mut contract, _, route) = native_project_fixture();
        testing_env!(context("owner.testnet", "owner.testnet", &key(3), 0, NS_PER_DAY));
        drop(contract.execute_outlayer_native_project("external-compute".into(), U128(100), route));
    }
    #[test]
    #[should_panic(expected = "BLOCKED: amount exceeds per-tx cap")]
    fn native_project_respects_cap() {
        let (mut contract, agent, route) = native_project_fixture();
        testing_env!(context("owner.testnet", "owner.testnet", &agent, 0, NS_PER_DAY));
        drop(contract.execute_outlayer_native_project("external-compute".into(), U128(201), route));
    }
    #[test]
    #[should_panic(expected = "BLOCKED: daily cap exceeded for this policy")]
    fn native_project_respects_rolling_budget() {
        let (mut contract, agent, route) = native_project_fixture();
        testing_env!(context("owner.testnet", "owner.testnet", &agent, 0, NS_PER_DAY));
        drop(contract.execute_outlayer_native_project("external-compute".into(), U128(200), route.clone()));
        drop(contract.execute_outlayer_native_project("external-compute".into(), U128(101), route));
    }
    #[test]
    #[should_panic(expected = "invalid OutLayer project id")]
    fn native_project_rejects_mainnet_project() {
        let (mut contract, _, _) = native_project_fixture();
        let mut project = native_project(); project.project_id = "author.near/price-oracle".into();
        testing_env!(context("owner.testnet", "owner.testnet", &key(1), 1, NS_PER_DAY));
        contract.set_outlayer_native_project("external-compute".into(), project);
    }
    #[test]
    #[should_panic(expected = "invalid pinned project version")]
    fn native_project_rejects_unpinned_version() {
        let (mut contract, _, _) = native_project_fixture();
        let mut project = native_project(); project.version_key = "".into();
        testing_env!(context("owner.testnet", "owner.testnet", &key(1), 1, NS_PER_DAY));
        contract.set_outlayer_native_project("external-compute".into(), project);
    }
    #[test]
    fn native_project_edits_revoke_old_routes_without_revival() {
        let (mut contract, _, original) = native_project_fixture();
        testing_env!(context("owner.testnet", "owner.testnet", &key(1), 1, NS_PER_DAY));
        contract.revoke_payee("external-compute".into(), id(OUTLAYER_TESTNET));
        contract.allow_payee("external-compute".into(), id(OUTLAYER_TESTNET));
        assert!(!contract.get_outlayer_native_project("external-compute".into()).unwrap().active);
        contract.set_outlayer_native_project("external-compute".into(), original.project.clone());
        let after = contract.get_outlayer_native_project("external-compute".into()).unwrap();
        assert!(after.active && after.route_revision > original.route_revision);
        contract.set_policy("external-compute".into(), id(NATIVE_ASSET), U128(200), Some(U128(300)));
        assert!(!contract.get_outlayer_native_project("external-compute".into()).unwrap().active);
        contract.set_outlayer_native_project("external-compute".into(), original.project.clone());
        let repinned = contract.get_outlayer_native_project("external-compute".into()).unwrap();
        contract.clear_outlayer_native_project("external-compute".into());
        assert!(contract.get_outlayer_native_project("external-compute".into()).is_none());
        contract.set_outlayer_native_project("external-compute".into(), original.project);
        assert!(contract.get_outlayer_native_project("external-compute".into()).unwrap().route_revision > repinned.route_revision);
    }
    #[test]
    #[should_panic(expected = "BLOCKED: native project route changed since review")]
    fn old_native_project_signature_stays_blocked_after_clear_and_repin() {
        let (mut contract, agent, old) = native_project_fixture();
        testing_env!(context("owner.testnet", "owner.testnet", &key(1), 1, NS_PER_DAY));
        contract.clear_outlayer_native_project("external-compute".into());
        contract.set_outlayer_native_project("external-compute".into(), old.project.clone());
        testing_env!(context("owner.testnet", "owner.testnet", &agent, 0, NS_PER_DAY));
        drop(contract.execute_outlayer_native_project("external-compute".into(), U128(100), old));
    }

    fn pinned_native_fixture() -> (Bouncer, PublicKey, OutlayerInputRouteView) {
        let (mut contract, agent, _) = native_fixture();
        testing_env!(context("owner.testnet", "owner.testnet", &key(1), 1, NS_PER_DAY));
        contract.set_outlayer_input("external-compute".into(), "{\"command\":\"fetch_external\",\"token_id\":\"near\",\"source\":\"coingecko\"}".into());
        let route = contract.get_outlayer_input("external-compute".into()).unwrap();
        (contract, agent, route)
    }

    #[test]
    fn pinned_outlayer_executes_exact_owner_input_and_reserves_budget() {
        use near_sdk::mock::MockAction;
        use near_sdk::test_utils::get_created_receipts;
        let (mut contract, agent, route) = pinned_native_fixture();
        assert!(route.active);
        testing_env!(context("owner.testnet", "owner.testnet", &agent, 0, NS_PER_DAY));
        drop(contract.execute_outlayer_pinned("external-compute".into(), U128(100), route.clone()));
        assert_eq!(contract.vault_balance(id(NATIVE_ASSET)).0, 400);
        assert_eq!(contract.daily_spent("external-compute".into()).0, 100);
        let receipts = get_created_receipts();
        let receipt = receipts.iter().find(|r| r.receiver_id == id(OUTLAYER_TESTNET)).unwrap();
        let args = receipt.actions.iter().find_map(|a| match a {
            MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } if method_name == b"request_execution" => {
                assert_eq!(*attached_deposit, NearToken::from_yoctonear(100)); Some(args)
            }, _ => None,
        }).unwrap();
        let args: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(args).unwrap();
        assert_eq!(args["input_data"], route.input_data);
        assert_eq!(args["source"]["WasmUrl"]["hash"], route.program.sha256);
    }

    #[test]
    #[should_panic(expected = "owner-only method requires exactly 1 yoctoNEAR")]
    fn agent_cannot_pin_a_different_outlayer_input() {
        let (mut contract, agent, _) = pinned_native_fixture();
        testing_env!(context("owner.testnet", "owner.testnet", &agent, 0, NS_PER_DAY));
        contract.set_outlayer_input("external-compute".into(), "{\"command\":\"arbitrary\"}".into());
    }

    #[test]
    #[should_panic(expected = "BLOCKED: OutLayer input route changed since review")]
    fn agent_cannot_change_the_exact_outlayer_input() {
        let (mut contract, agent, mut route) = pinned_native_fixture();
        route.input_data = "{\"command\":\"arbitrary\"}".into();
        testing_env!(context("owner.testnet", "owner.testnet", &agent, 0, NS_PER_DAY));
        drop(contract.execute_outlayer_pinned("external-compute".into(), U128(100), route));
    }

    #[test]
    #[should_panic(expected = "BLOCKED: signing key is not authorized for this policy")]
    fn pinned_outlayer_requires_an_explicit_agent_grant() {
        let (mut contract, _, route) = pinned_native_fixture();
        testing_env!(context("owner.testnet", "owner.testnet", &key(3), 0, NS_PER_DAY));
        drop(contract.execute_outlayer_pinned("external-compute".into(), U128(100), route));
    }

    #[test]
    #[should_panic(expected = "BLOCKED: amount exceeds per-tx cap")]
    fn pinned_outlayer_respects_per_transaction_cap() {
        let (mut contract, agent, route) = pinned_native_fixture();
        testing_env!(context("owner.testnet", "owner.testnet", &agent, 0, NS_PER_DAY));
        drop(contract.execute_outlayer_pinned("external-compute".into(), U128(201), route));
    }

    #[test]
    #[should_panic(expected = "BLOCKED: daily cap exceeded for this policy")]
    fn pinned_outlayer_respects_rolling_budget() {
        let (mut contract, agent, route) = pinned_native_fixture();
        testing_env!(context("owner.testnet", "owner.testnet", &agent, 0, NS_PER_DAY));
        drop(contract.execute_outlayer_pinned("external-compute".into(), U128(200), route.clone()));
        drop(contract.execute_outlayer_pinned("external-compute".into(), U128(101), route));
    }

    #[test]
    #[should_panic(expected = "OutLayer input must be a JSON object")]
    fn owner_cannot_pin_non_object_outlayer_input() {
        let (mut contract, _, _) = pinned_native_fixture();
        testing_env!(context("owner.testnet", "owner.testnet", &key(1), 1, NS_PER_DAY));
        contract.set_outlayer_input("external-compute".into(), "[]".into());
    }

    #[test]
    #[should_panic(expected = "OutLayer input is too large")]
    fn owner_cannot_pin_unbounded_outlayer_input() {
        let (mut contract, _, _) = pinned_native_fixture();
        testing_env!(context("owner.testnet", "owner.testnet", &key(1), 1, NS_PER_DAY));
        contract.set_outlayer_input("external-compute".into(), "x".repeat(MAX_OUTLAYER_INPUT_BYTES + 1));
    }

    #[test]
    fn route_changes_and_revocations_do_not_revive_stale_requests() {
        let (mut contract, _, initial) = pinned_native_fixture();
        testing_env!(context("owner.testnet", "owner.testnet", &key(1), 1, NS_PER_DAY));
        contract.set_policy("external-compute".into(), id(NATIVE_ASSET), U128(200), Some(U128(300)));
        assert!(!contract.get_outlayer_input("external-compute".into()).unwrap().active);
        contract.set_outlayer_input("external-compute".into(), initial.input_data.clone());
        let after_policy = contract.get_outlayer_input("external-compute".into()).unwrap();
        assert!(after_policy.active && after_policy.route_revision > initial.route_revision);
        contract.revoke_payee("external-compute".into(), id(OUTLAYER_TESTNET));
        contract.allow_payee("external-compute".into(), id(OUTLAYER_TESTNET));
        assert!(!contract.get_outlayer_input("external-compute".into()).unwrap().active);
        contract.set_outlayer_input("external-compute".into(), initial.input_data.clone());
        let after_payee = contract.get_outlayer_input("external-compute".into()).unwrap();
        // Even re-setting the same program tombstones the route.
        contract.set_outlayer_program("external-compute".into(), initial.program.clone());
        assert!(contract.get_outlayer_input("external-compute".into()).is_none());
        contract.set_outlayer_input("external-compute".into(), initial.input_data.clone());
        let after_program = contract.get_outlayer_input("external-compute".into()).unwrap();
        assert!(after_program.route_revision > after_payee.route_revision);
        contract.clear_outlayer_input("external-compute".into());
        assert!(contract.get_outlayer_input("external-compute".into()).is_none());
        contract.set_outlayer_input("external-compute".into(), initial.input_data);
        let after_clear = contract.get_outlayer_input("external-compute".into()).unwrap();
        assert!(after_clear.active && after_clear.route_revision > after_program.route_revision);
    }

    #[test]
    #[should_panic(expected = "BLOCKED: OutLayer input route changed since review")]
    fn stale_outlayer_input_signature_stays_blocked_after_repin() {
        let (mut contract, agent, old) = pinned_native_fixture();
        testing_env!(context("owner.testnet", "owner.testnet", &key(1), 1, NS_PER_DAY));
        contract.clear_outlayer_input("external-compute".into());
        contract.set_outlayer_input("external-compute".into(), old.input_data.clone());
        testing_env!(context("owner.testnet", "owner.testnet", &agent, 0, NS_PER_DAY));
        drop(contract.execute_outlayer_pinned("external-compute".into(), U128(100), old));
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

#[cfg(all(test, feature = "exact-ft-v11"))]
#[path = "exact_ft_tests.rs"]
mod exact_ft_tests;
