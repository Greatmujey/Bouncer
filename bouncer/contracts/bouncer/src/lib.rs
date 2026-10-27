//! Minimal Bouncer skeleton — confirming near-sdk 5.14 compiles.
//! Real logic will be restored after the build pipeline is green.

use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId, PanicOnDefault};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Bouncer {
    owner: AccountId,
}

#[near]
impl Bouncer {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self { owner }
    }

    pub fn owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn check(&self, _policy_id: String, _payee: AccountId, _amount: U128) -> (bool, String) {
        (true, "ok".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    #[test]
    fn new_works() {
        let ctx = VMContextBuilder::new()
            .predecessor_account_id(near_sdk::test_utils::accounts(0))
            .build();
        testing_env!(ctx);
        let c = Bouncer::new(near_sdk::test_utils::accounts(0));
        assert_eq!(c.owner(), near_sdk::test_utils::accounts(0));
    }
}
