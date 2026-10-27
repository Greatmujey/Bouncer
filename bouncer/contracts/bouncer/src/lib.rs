use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, ext_contract, near, AccountId, Gas, NearToken, PanicOnDefault, Promise};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_FOR_RESOLVE: Gas = Gas::from_tgas(15);
const NS_PER_DAY: u64 = 24 * 60 * 60 * 1_000_000_000;

#[link(wasm_import_module = "env")]
extern "C" { fn panic_utf8(len: u64, ptr: u64) -> !; }
fn abort_with(msg: &str) -> ! {
    unsafe { panic_utf8(msg.len() as u64, msg.as_ptr() as u64); }
}
fn require(cond: bool, msg: &str) { if !cond { abort_with(msg); } }

#[ext_contract(ext_ft)]
trait ExtFt {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}
#[ext_contract(ext_self)]
trait ExtSelf {
    fn after_execute(&mut self, policy_id: String, token: AccountId, amount: U128);
    fn after_withdraw(&mut self, token: AccountId, amount: U128);
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

fn validate(
    s: &Bouncer, policy_id: &str, payee: &AccountId, amount: u128, attached: NearToken,
) -> Result<(AccountId, u128), String> {
    if attached != ONE_YOCTO {
        return Err("BLOCKED: requires exactly 1 yoctoNEAR (owner-only guard)".into());
    }
    let cap = *s.cap_of.get(policy_id).ok_or("no such policy")?;
    let token = s.token_of.get(policy_id).cloned().ok_or("policy missing token")?;
    if amount == 0 { return Err("amount must be > 0".into()); }
    if amount > cap { return Err("BLOCKED: amount exceeds per-tx cap".into()); }
    let n = s.allow_count.get(policy_id).cloned().unwrap_or(0);
    if n > 0 {
        let k = allow_key(policy_id, payee.as_str());
        if s.allow.get(&k) != Some(&true) {
            return Err(format!("BLOCKED: payee not in allowlist ({})", payee));
        }
    }
    let daily = s.daily_of.get(policy_id).cloned().unwrap_or(0);
    if daily > 0 {
        let bucket = env::block_timestamp() / NS_PER_DAY;
        let spent = s.daily_spent.get(&daily_key(policy_id, bucket)).cloned().unwrap_or(0);
        if spent.saturating_add(amount) > daily {
            return Err("BLOCKED: daily cap exceeded for this policy".into());
        }
    }
    let bal = s.balances.get(&token).cloned().unwrap_or(0);
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

    pub fn vault_balance(&self, token: AccountId) -> U128 {
        U128(self.balances.get(&token).cloned().unwrap_or(0))
    }

    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        let token = env::predecessor_account_id();
        let bal = self.balances.get(&token).cloned().unwrap_or(0);
        self.balances.insert(token.clone(), bal + amount.0);
        env::log_str("BOUNCER deposit received");
        let _ = (sender_id, msg);
        U128(0)
    }

    #[payable]
    pub fn withdraw(&mut self, token: AccountId, amount: U128) -> Promise {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        let bal = self.balances.get(&token).cloned().unwrap_or(0);
        if amount.0 > bal { abort_with("insufficient vault balance"); }
        self.balances.insert(token.clone(), bal - amount.0);
        ext_ft::ext(token.clone())
            .with_attached_deposit(ONE_YOCTO).with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(self.owner.clone(), amount, Some("bouncer:withdraw".into()))
            .then(ext_self::ext(env::current_account_id()).with_static_gas(GAS_FOR_RESOLVE).after_withdraw(token, amount))
    }

    #[payable]
    pub fn execute(&mut self, policy_id: String, payee: AccountId, amount: U128, memo: Option<String>) -> Promise {
        let attached = env::attached_deposit();
        let (token, bal) = validate(self, &policy_id, &payee, amount.0, attached).unwrap_or_else(|m| abort_with(&m));
        self.balances.insert(token.clone(), bal - amount.0);
        let bucket = env::block_timestamp() / NS_PER_DAY;
        let dk = daily_key(&policy_id, bucket);
        let spent = self.daily_spent.get(&dk).cloned().unwrap_or(0);
        self.daily_spent.insert(dk, spent + amount.0);
        env::log_str("BOUNCER payment executed");
        ext_ft::ext(token.clone())
            .with_attached_deposit(ONE_YOCTO).with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(payee, amount, memo)
            .then(ext_self::ext(env::current_account_id()).with_static_gas(GAS_FOR_RESOLVE).after_execute(policy_id, token, amount))
    }

    #[private]
    pub fn after_execute(&mut self, policy_id: String, token: AccountId, amount: U128) {
        if !matches!(env::promise_result(0), near_sdk::PromiseResult::Successful(_)) {
            let bal = self.balances.get(&token).cloned().unwrap_or(0);
            self.balances.insert(token.clone(), bal + amount.0);
            let bucket = env::block_timestamp() / NS_PER_DAY;
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
            self.balances.insert(token, bal + amount.0);
        }
    }

    pub fn check(&self, policy_id: String, payee: AccountId, amount: U128) -> (bool, String) {
        match validate(self, &policy_id, &payee, amount.0, ONE_YOCTO) {
            Ok(_) => (true, "ok: within cap, payee allowed, daily ok, vault funded".into()),
            Err(e) => (false, e),
        }
    }
    pub fn try_execute(&self, policy_id: String, payee: AccountId, amount: U128) -> (bool, String) {
        match validate(self, &policy_id, &payee, amount.0, ONE_YOCTO) {
            Ok(_) => (true, "would execute: policy satisfied".into()),
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
