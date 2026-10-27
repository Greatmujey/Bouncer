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
    token: LookupMap<String, AccountId>,
    cap: LookupMap<String, u128>,
    balances: LookupMap<AccountId, u128>,
}

#[near]
impl Bouncer {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        assert!(!owner.as_str().is_empty());
        Self {
            owner,
            token: LookupMap::new(b"t"),
            cap: LookupMap::new(b"c"),
            balances: LookupMap::new(b"b"),
        }
    }

    #[payable]
    pub fn set_policy(&mut self, policy_id: String, token: AccountId, per_tx_cap: U128) {
        assert!(env::attached_deposit() == ONE_YOCTO, "requires 1 yoctoNEAR");
        assert!(env::predecessor_account_id() == self.owner);
        assert!(per_tx_cap.0 > 0);
        self.token.insert(policy_id.clone(), token);
        self.cap.insert(policy_id, per_tx_cap.0);
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

    pub fn execute(&mut self, policy_id: String, payee: AccountId, amount: U128, memo: String) -> Promise {
        let amt = amount.0;
        let c = self.cap.get(&policy_id).cloned().expect("no policy");
        let t = self.token.get(&policy_id).cloned().expect("no policy token");
        assert!(amt > 0 && amt <= c, "amount out of range");
        let bal = self.balances.get(&t).cloned().unwrap_or(0);
        assert!(bal >= amt, "insufficient");
        self.balances.insert(t.clone(), bal - amt);
        ext_ft::ext(t)
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(payee, amount, Some(memo))
    }

    pub fn check(&self, policy_id: String, amount: U128) -> (bool, String) {
        let c = self.cap.get(&policy_id).cloned().unwrap_or(0);
        if c == 0 { return (false, "no policy".into()); }
        if amount.0 > c { return (false, "over cap".into()); }
        (true, "ok".into())
    }
}
