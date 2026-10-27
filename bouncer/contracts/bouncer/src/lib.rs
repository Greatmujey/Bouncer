use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, AccountId, NearToken, PanicOnDefault};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Bouncer {
    owner: AccountId,
    caps: LookupMap<String, u128>,
    balances: LookupMap<AccountId, u128>,
}

#[near]
impl Bouncer {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        assert!(!owner.as_str().is_empty());
        Self {
            owner,
            caps: LookupMap::new(b"c"),
            balances: LookupMap::new(b"b"),
        }
    }

    #[payable]
    pub fn set_cap(&mut self, policy_id: String, cap: U128) {
        assert!(env::attached_deposit() == ONE_YOCTO, "requires 1 yoctoNEAR");
        assert!(env::predecessor_account_id() == self.owner, "owner only");
        assert!(cap.0 > 0, "cap must be > 0");
        self.caps.insert(policy_id, cap.0);
    }

    pub fn get_cap(&self, policy_id: String) -> U128 {
        U128(self.caps.get(&policy_id).cloned().unwrap_or(0))
    }

    pub fn vault_balance(&self, token: AccountId) -> U128 {
        U128(self.balances.get(&token).cloned().unwrap_or(0))
    }

    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        let token = env::predecessor_account_id();
        let bal = self.balances.get(&token).cloned().unwrap_or(0);
        self.balances.insert(token.clone(), bal + amount.0);
        env::log_str(&format!("BOUNCER deposit {} from {} amt {} msg {}", token, sender_id, amount.0, msg));
        U128(0)
    }

    pub fn check(&self, policy_id: String, _payee: AccountId, amount: U128) -> (bool, String) {
        let cap = self.caps.get(&policy_id).cloned().unwrap_or(0);
        if cap == 0 { return (false, "no policy".into()); }
        if amount.0 > cap { return (false, "over cap".into()); }
        (true, "ok".into())
    }
}
