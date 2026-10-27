use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, AccountId, PanicOnDefault};

const ONE_YOCTO: near_sdk::NearToken = near_sdk::NearToken::from_yoctonear(1);

#[near(serializers = [json])]
#[derive(Clone)]
pub struct Policy {
    pub label: String,
    pub token: AccountId,
    pub per_tx_cap: u128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Bouncer {
    owner: AccountId,
    policies: LookupMap<String, Policy>,
}

#[near]
impl Bouncer {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        assert!(!owner.as_str().is_empty());
        Self { owner, policies: LookupMap::new(b"p") }
    }

    #[payable]
    pub fn set_policy(&mut self, policy_id: String, policy: Policy) {
        assert!(env::attached_deposit() == ONE_YOCTO, "requires 1 yoctoNEAR");
        assert!(env::predecessor_account_id() == self.owner, "owner only");
        self.policies.insert(policy_id, policy);
    }

    pub fn get_policy(&self, policy_id: String) -> Option<Policy> {
        self.policies.get(&policy_id).cloned()
    }

    pub fn check(&self, policy_id: String, payee: AccountId, amount: U128) -> (bool, String) {
        let p = match self.policies.get(&policy_id) { Some(x) => x.clone(), None => return (false, "no such policy".into()) };
        if amount.0 == 0 { return (false, "zero".into()); }
        if amount.0 > p.per_tx_cap { return (false, "over cap".into()); }
        let _ = payee;
        (true, "ok".into())
    }
}
