use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, ext_contract, near, AccountId, Gas, NearToken, PanicOnDefault, Promise};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_FOR_RESOLVE: Gas = Gas::from_tgas(15);

// Internal helper: near-sdk 5.x with panic=abort + LTO sometimes truncates format-string
// assert!() messages to an `unreachable` opcode in wasm. Using env::panic_str (which takes
// a plain &str) keeps the message visible on-chain and in nearblocks receipts.
fn require(cond: bool, msg: &str) {
    if !cond { env::panic_str(msg); }
}

#[ext_contract(ext_ft)]
trait ExtFt {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}
#[ext_contract(ext_self)]
trait ExtSelf {
    fn after_execute(&mut self, token: AccountId, amount: U128);
    fn after_withdraw(&mut self, token: AccountId, amount: U128);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Bouncer {
    owner: AccountId,
    token_of: LookupMap<String, AccountId>,
    cap_of: LookupMap<String, u128>,
    allow: LookupMap<String, bool>,
    allow_count: LookupMap<String, u32>,
    balances: LookupMap<AccountId, u128>,
}

fn allow_key(pid: &str, p: &str) -> String {
    let mut s = String::with_capacity(pid.len() + 1 + p.len());
    s.push_str(pid);
    s.push(':');
    s.push_str(p);
    s
}

#[near]
impl Bouncer {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        require(!owner.as_str().is_empty(), "owner must not be empty");
        Self {
            owner,
            token_of: LookupMap::new(b"t"), cap_of: LookupMap::new(b"c"),
            allow: LookupMap::new(b"a"), allow_count: LookupMap::new(b"n"),
            balances: LookupMap::new(b"b"),
        }
    }

    #[payable]
    pub fn set_policy(&mut self, policy_id: String, token: AccountId, per_tx_cap: U128) {
        require(env::attached_deposit() == ONE_YOCTO, "requires exactly 1 yoctoNEAR (owner-only, full-access key required)");
        require(env::predecessor_account_id() == self.owner, "owner only");
        require(per_tx_cap.0 > 0, "per_tx_cap must be > 0");
        self.token_of.insert(policy_id.clone(), token);
        self.cap_of.insert(policy_id, per_tx_cap.0);
    }

    #[payable]
    pub fn allow_payee(&mut self, policy_id: String, payee: AccountId) {
        require(env::attached_deposit() == ONE_YOCTO, "requires 1 yoctoNEAR");
        require(env::predecessor_account_id() == self.owner, "owner only");
        require(self.cap_of.contains_key(&policy_id), "policy does not exist");
        let k = allow_key(&policy_id, payee.as_str());
        if self.allow.get(&k).is_none() {
            let n = self.allow_count.get(&policy_id).cloned().unwrap_or(0);
            self.allow_count.insert(policy_id.clone(), n + 1);
        }
        self.allow.insert(k, true);
    }

    #[payable]
    pub fn revoke_payee(&mut self, policy_id: String, payee: AccountId) {
        require(env::attached_deposit() == ONE_YOCTO, "requires 1 yoctoNEAR");
        require(env::predecessor_account_id() == self.owner, "owner only");
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
        require(env::attached_deposit() == ONE_YOCTO, "requires 1 yoctoNEAR");
        require(env::predecessor_account_id() == self.owner, "owner only");
        let bal = self.balances.get(&token).cloned().unwrap_or(0);
        require(amount.0 <= bal, "insufficient vault balance");
        self.balances.insert(token.clone(), bal - amount.0);
        ext_ft::ext(token.clone())
            .with_attached_deposit(ONE_YOCTO).with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(self.owner.clone(), amount, Some("bouncer:withdraw".into()))
            .then(ext_self::ext(env::current_account_id()).with_static_gas(GAS_FOR_RESOLVE).after_withdraw(token, amount))
    }

    #[payable]
    pub fn execute(&mut self, policy_id: String, payee: AccountId, amount: U128, memo: String) -> Promise {
        require(env::attached_deposit() == ONE_YOCTO, "execute requires 1 yoctoNEAR");
        let cap = match self.cap_of.get(&policy_id) {
            Some(c) => *c,
            None => env::panic_str("no such policy"),
        };
        let token = match self.token_of.get(&policy_id) {
            Some(t) => t.clone(),
            None => env::panic_str("policy has no token"),
        };
        require(amount.0 > 0, "amount must be > 0");
        require(amount.0 <= cap, "BLOCKED: amount exceeds per-tx cap");
        let n = self.allow_count.get(&policy_id).cloned().unwrap_or(0);
        if n > 0 {
            let k = allow_key(&policy_id, payee.as_str());
            require(self.allow.get(&k) == Some(&true), "BLOCKED: payee not in allowlist");
        }
        let bal = self.balances.get(&token).cloned().unwrap_or(0);
        require(bal >= amount.0, "insufficient vault balance (fund the vault first)");
        self.balances.insert(token.clone(), bal - amount.0);
        let _ = memo;
        ext_ft::ext(token.clone())
            .with_attached_deposit(ONE_YOCTO).with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(payee, amount, None)
            .then(ext_self::ext(env::current_account_id()).with_static_gas(GAS_FOR_RESOLVE).after_execute(token, amount))
    }

    #[private]
    pub fn after_execute(&mut self, token: AccountId, amount: U128) {
        if !matches!(env::promise_result(0), near_sdk::PromiseResult::Successful(_)) {
            let bal = self.balances.get(&token).cloned().unwrap_or(0);
            self.balances.insert(token, bal + amount.0);
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
        let cap = match self.cap_of.get(&policy_id) { Some(c) => *c, None => return (false, "no such policy".into()) };
        let token = match self.token_of.get(&policy_id) { Some(t) => t.clone(), None => return (false, "policy missing token".into()) };
        if amount.0 == 0 { return (false, "amount must be > 0".into()); }
        if amount.0 > cap { return (false, format!("over per-tx cap (max {})", cap)); }
        let n = self.allow_count.get(&policy_id).cloned().unwrap_or(0);
        if n > 0 {
            let k = allow_key(&policy_id, payee.as_str());
            if self.allow.get(&k) != Some(&true) { return (false, format!("payee {} not in allowlist", payee)); }
        }
        let bal = self.balances.get(&token).cloned().unwrap_or(0);
        if bal < amount.0 { return (false, format!("vault holds {}; need {}", bal, amount.0)); }
        (true, "ok".into())
    }
}
