use near_sdk::near;

#[near(contract_state)]
pub struct Bouncer { owner: String }

#[near]
impl Bouncer {
    #[init]
    pub fn new(owner: String) -> Self {
        assert!(!owner.is_empty());
        Self { owner }
    }
    pub fn check(&self) -> bool { true }
}
