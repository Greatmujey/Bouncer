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
    allow_of: LookupMap<String, String>,
    balances: LookupMap<AccountId, u128>,
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
            allow_of: LookupMap::new(b"a"),
            balances: LookupMap::new(b"b"),
        }
    }

    #[payable]
    pub fn set_policy(
        &mut self,
        policy_id: String,
        token: AccountId,
        per_tx_cap: U128,
        allowlist_csv: String,
    ) {
        assert!(env::attached_deposit() == ONE_YOCTO, "requires 1 yoctoNEAR");
        assert!(env::predecessor_account_id() == self.owner, "owner only");
        assert!(per_tx_cap.0 > 0, "cap must be > 0");
        self.token_of.insert(policy_id.clone(), token);
        self.cap_of.insert(policy_id.clone(), per_tx_cap.0);
        self.allow_of.insert(policy_id, allowlist_csv);
    }

    pub fn vault_balance(&self, token: AccountId) -> U128 {
        U128(self.balances.get(&token).cloned().unwrap_or(0))
    }

    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        let token = env::predecessor_account_id();
        let amt = amount.0;
        let known = self.token_of.values().any(|t| t == &token);
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
        assert!(amt <= bal);
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
        assert!(amt > 0 && amt <= cap, "amount out of range");
        if let Some(allow) = self.allow_of.get(&policy_id) {
            if !allow.is_empty() {
                let ps = payee.to_string();
                assert!(allow.split(',').any(|s| s == ps), "payee not in allowlist");
            }
        }
        let bal = self.balances.get(&token).cloned().unwrap_or(0);
        assert!(bal >= amt, "insufficient");
        self.balances.insert(token.clone(), bal - amt);
        ext_ft::ext(token)
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(payee, amount, Some(memo))
    }

    pub fn check(&self, policy_id: String, payee: AccountId, amount: U128) -> (bool, String) {
        let cap = match self.cap_of.get(&policy_id) { Some(c) => *c, None => return (false, "no policy".into()) };
        let token = match self.token_of.get(&policy_id) { Some(t) => t.clone(), None => return (false, "no token".into()) };
        if amount.0 == 0 { return (false, "zero".into()); }
        if amount.0 > cap { return (false, format!("over cap {}", cap)); }
        if let Some(allow) = self.allow_of.get(&policy_id) {
            if !allow.is_empty() {
                let ps = payee.to_string();
                if !allow.split(',').any(|s| s == ps) {
                    return (false, format!("{} not in allowlist", payee));
                }
            }
        }
        let bal = self.balances.get(&token).cloned().unwrap_or(0);
        if bal < amount.0 { return (false, format!("vault {} need {}", bal, amount.0)); }
        (true, "ok".into())
    }
}
