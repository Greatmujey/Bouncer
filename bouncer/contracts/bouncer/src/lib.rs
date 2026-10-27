//! Bouncer: policy-enforced spending vault for AI agents on NEAR.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, ext_contract, near, AccountId, Gas, NearToken, PanicOnDefault, Promise};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(15);

#[near(serializers = [json])]
#[derive(Clone)]
pub struct Window { pub period_ns: u64, pub limit: u128 }
#[near(serializers = [json])]
#[derive(Clone)]
pub struct Policy {
    pub label: String, pub token: AccountId, pub per_tx_cap: u128,
    pub windows: Vec<Window>, pub payee_allowlist: Vec<AccountId>,
}

#[ext_contract(ext_ft)]
trait ExtFt {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Bouncer {
    owner: AccountId,
    policies: LookupMap<String, Policy>,
    balances: LookupMap<AccountId, u128>,
}

#[near]
impl Bouncer {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        assert!(!owner.as_str().is_empty());
        Self {
            owner,
            policies: LookupMap::new(b"p"),
            balances: LookupMap::new(b"b"),
        }
    }

    #[payable]
    pub fn set_policy(&mut self, policy_id: String, policy: Policy) {
        assert!(env::attached_deposit() == ONE_YOCTO, "requires 1 yoctoNEAR");
        assert!(env::predecessor_account_id() == self.owner, "owner only");
        assert!(policy.per_tx_cap > 0);
        for w in &policy.windows { assert!(w.period_ns > 0 && w.limit > 0); }
        self.policies.insert(policy_id, policy);
    }

    pub fn get_policy(&self, policy_id: String) -> Option<Policy> {
        self.policies.get(&policy_id).cloned()
    }

    pub fn vault_balance(&self, token: AccountId) -> U128 {
        U128(self.balances.get(&token).cloned().unwrap_or(0))
    }

    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        let token = env::predecessor_account_id();
        let amt = amount.0;
        let known = self.policies.values().any(|p| p.token == token);
        if !known { return U128(amt); }
        let bal = self.balances.get(&token).cloned().unwrap_or(0);
        self.balances.insert(token.clone(), bal + amt);
        env::log_str(&format!("BOUNCER deposit {} from {} amt {} msg {}", token, sender_id, amt, msg));
        U128(0)
    }

    #[payable]
    pub fn withdraw(&mut self, token: AccountId, amount: U128) -> Promise {
        assert!(env::attached_deposit() == ONE_YOCTO);
        assert!(env::predecessor_account_id() == self.owner);
        let amt = amount.0;
        let bal = self.balances.get(&token).cloned().unwrap_or(0);
        assert!(amt <= bal, "insufficient");
        self.balances.insert(token.clone(), bal - amt);
        ext_ft::ext(token)
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(self.owner.clone(), amount, Some("bouncer:withdraw".into()))
    }

    pub fn check(&self, policy_id: String, payee: AccountId, amount: U128) -> (bool, String) {
        let p = match self.policies.get(&policy_id) { Some(x) => x.clone(), None => return (false, "no such policy".into()) };
        if amount.0 == 0 { return (false, "zero".into()); }
        if amount.0 > p.per_tx_cap { return (false, "over cap".into()); }
        if !p.payee_allowlist.is_empty() && !p.payee_allowlist.contains(&payee) {
            return (false, "payee not in allowlist".into());
        }
        let bal = self.balances.get(&p.token).cloned().unwrap_or(0);
        if bal < amount.0 { return (false, format!("vault {}; need {}", bal, amount.0)); }
        (true, "ok".into())
    }
}
