use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, ext_contract, near, AccountId, Gas, NearToken, PanicOnDefault, Promise};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(20);

#[ext_contract(ext_ft)]
trait ExtFt {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Bouncer {
    owner: AccountId,
    token_of: LookupMap<String, AccountId>,
    cap_of: LookupMap<String, u128>,
    // composite key "policy_id:payee" -> true if allowed.
    // If no entry exists for a policy, all payees are allowed.
    allow: LookupMap<String, bool>,
    // policy_id -> count of allowlisted payees (0 = allow any)
    allow_count: LookupMap<String, u32>,
    balances: LookupMap<AccountId, u128>,
}

fn allow_key(policy_id: &str, payee: &str) -> String {
    format!("{}:{}", policy_id, payee)
}

#[near]
impl Bouncer {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        assert!(!owner.as_str().is_empty());
        Self {
            owner,
            token_of: LookupMap::new(b"t"),
            cap_of: LookupMap::new(b"c"),
            allow: LookupMap::new(b"a"),
            allow_count: LookupMap::new(b"n"),
            balances: LookupMap::new(b"b"),
        }
    }

    #[payable]
    pub fn set_policy(&mut self, policy_id: String, token: AccountId, per_tx_cap: U128) {
        assert!(env::attached_deposit() == ONE_YOCTO, "requires 1 yoctoNEAR (full-access key only)");
        assert!(env::predecessor_account_id() == self.owner, "owner only");
        assert!(per_tx_cap.0 > 0);
        self.token_of.insert(policy_id.clone(), token);
        self.cap_of.insert(policy_id, per_tx_cap.0);
    }

    /// Add a payee to a policy's allowlist. Once at least one payee is added, only listed payees are allowed.
    #[payable]
    pub fn allow_payee(&mut self, policy_id: String, payee: AccountId) {
        assert!(env::attached_deposit() == ONE_YOCTO);
        assert!(env::predecessor_account_id() == self.owner);
        assert!(self.cap_of.contains_key(&policy_id), "no such policy");
        let k = allow_key(&policy_id, payee.as_str());
        if self.allow.get(&k).is_none() {
            let n = self.allow_count.get(&policy_id).cloned().unwrap_or(0);
            self.allow_count.insert(policy_id.clone(), n + 1);
        }
        self.allow.insert(k, true);
    }

    #[payable]
    pub fn revoke_payee(&mut self, policy_id: String, payee: AccountId) {
        assert!(env::attached_deposit() == ONE_YOCTO);
        assert!(env::predecessor_account_id() == self.owner);
        let k = allow_key(&policy_id, payee.as_str());
        if self.allow.remove(&k).is_some() {
            let n = self.allow_count.get(&policy_id).cloned().unwrap_or(1);
            let next = n.saturating_sub(1);
            self.allow_count.insert(policy_id, next);
        }
    }

    pub fn vault_balance(&self, token: AccountId) -> U128 {
        U128(self.balances.get(&token).cloned().unwrap_or(0))
    }

    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        let token = env::predecessor_account_id();
        let amt = amount.0;
        let bal = self.balances.get(&token).cloned().unwrap_or(0);
        self.balances.insert(token.clone(), bal + amt);
        env::log_str(&format!("BOUNCER deposit {} from {} amt {} msg {}", token, sender_id, amt, msg));
        U128(0)
    }

    #[payable]
    pub fn withdraw(&mut self, token: AccountId, amount: U128) -> Promise {
        assert!(env::attached_deposit() == ONE_YOCTO);
        assert!(env::predecessor_account_id() == self.owner, "owner only");
        let amt = amount.0;
        let bal = self.balances.get(&token).cloned().unwrap_or(0);
        assert!(amt <= bal, "insufficient");
        self.balances.insert(token.clone(), bal - amt);
        ext_ft::ext(token)
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(self.owner.clone(), amount, Some("bouncer:withdraw".into()))
    }

    pub fn execute(&mut self, policy_id: String, payee: AccountId, amount: U128, memo: String) -> Promise {
        let amt = amount.0;
        let cap = self.cap_of.get(&policy_id).cloned().expect("no policy");
        let token = self.token_of.get(&policy_id).cloned().expect("no token");
        assert!(amt > 0 && amt <= cap, "amount out of per-tx range");
        let n = self.allow_count.get(&policy_id).cloned().unwrap_or(0);
        if n > 0 {
            let k = allow_key(&policy_id, payee.as_str());
            assert!(self.allow.get(&k) == Some(&true), "payee not in allowlist");
        }
        let bal = self.balances.get(&token).cloned().unwrap_or(0);
        assert!(bal >= amt, "insufficient vault balance");
        self.balances.insert(token.clone(), bal - amt);
        ext_ft::ext(token)
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(payee, amount, Some(memo))
    }

    pub fn check(&self, policy_id: String, payee: AccountId, amount: U128) -> (bool, String) {
        let cap = match self.cap_of.get(&policy_id) { Some(c) => *c, None => return (false, "no such policy".into()) };
        let token = match self.token_of.get(&policy_id) { Some(t) => t.clone(), None => return (false, "policy missing token".into()) };
        if amount.0 == 0 { return (false, "amount must be > 0".into()); }
        if amount.0 > cap { return (false, format!("over per-tx cap (max {})", cap)); }
        let n = self.allow_count.get(&policy_id).cloned().unwrap_or(0);
        if n > 0 {
            let k = allow_key(&policy_id, payee.as_str());
            if self.allow.get(&k) != Some(&true) {
                return (false, format!("payee {} not in allowlist", payee));
            }
        }
        let bal = self.balances.get(&token).cloned().unwrap_or(0);
        if bal < amount.0 { return (false, format!("vault holds {}; need {}", bal, amount.0)); }
        (true, "ok".into())
    }
}
