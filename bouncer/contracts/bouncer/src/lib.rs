use near_sdk::near;

#[near(contract_state)]
#[derive(Default)]
pub struct Bouncer {}

#[near]
impl Bouncer {
    pub fn check(&self) -> bool { true }
}
