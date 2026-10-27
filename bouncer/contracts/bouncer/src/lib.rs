//! Bouncer: policy-enforced spending vault for AI agents on NEAR.
//!
//! Agents get a function-call key scoped to executor methods.
//! Policy-mutating / withdrawal methods require exactly 1 yoctoNEAR, which
//! function-call keys cannot attach — NEAR rejects DepositWithFunctionCall.
//! That is a structural guarantee, not a software check.

use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, ext_contract, near, AccountId, Gas, NearToken, PanicOnDefault, Promise};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_FOR_RESOLVE: Gas = Gas::from_tgas(20);

#[near(serializers = [json])]
#[derive(Clone)]
pub struct Window { pub period_ns: u64, pub limit: u128 }
#[near(serializers = [json])]
#[derive(Clone)]
pub struct Policy {
    pub label: String, pub token: AccountId, pub per_tx_cap: u128,
    pub windows: Vec<Window>, pub payee_allowlist: Vec<AccountId>,
}
#[near(serializers = [json])]
#[derive(Clone)]
pub struct Spend { pub payee: AccountId, pub amount: u128, pub memo: String, pub ns_since_epoch: u64 }

#[ext_contract(ext_ft)]
trait ExtFt {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}
#[ext_contract(ext_self)]
trait ExtSelf {
    fn after_execute_transfer(&mut self, policy_id: String, payee: AccountId, amount: u128, memo: String);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Bouncer {
    owner: AccountId,
    policies: LookupMap<String, Policy>,
    spends: LookupMap<String, Vector<Spend>>,
    balances: LookupMap<AccountId, u128>,
}

#[near]
impl Bouncer {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        assert!(!owner.as_str().is_empty(), "owner required");
        Self {
            owner,
            policies: LookupMap::new(b"p"),
            spends: LookupMap::new(b"s"),
            balances: LookupMap::new(b"b"),
        }
    }

    #[payable]
    pub fn set_policy(&mut self, policy_id: String, policy: Policy) {
        assert_one_yocto();
        assert!(env::predecessor_account_id() == self.owner, "owner only");
        assert!(policy.per_tx_cap > 0, "per_tx_cap must be > 0");
        for w in &policy.windows { assert!(w.period_ns > 0 && w.limit > 0, "window invalid"); }
        if !self.spends.contains_key(&policy_id) {
            self.spends.insert(policy_id.clone(), Vector::new(format!("sp:{}", policy_id).into_bytes()));
        }
        self.policies.insert(policy_id, policy);
    }

    pub fn get_policy(&self, policy_id: String) -> Option<Policy> { self.policies.get(&policy_id).cloned() }

    pub fn get_spends(&self, policy_id: String, from: Option<u64>, limit: Option<u64>) -> Vec<Spend> {
        let log = match self.spends.get(&policy_id) { Some(v) => v, None => return vec![] };
        log.iter().skip(from.unwrap_or(0) as usize).take(limit.unwrap_or(100) as usize).cloned().collect()
    }

    pub fn vault_balance(&self, token: AccountId) -> U128 { U128(self.balances.get(&token).cloned().unwrap_or(0)) }

    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        let token = env::predecessor_account_id();
        let amt = amount.0;
        // Only credit deposits for tokens referenced by an existing policy
        let known = self.policies.values().any(|p| p.token == token);
        if !known { return U128(amt); }
        let bal = self.balances.get(&token).cloned().unwrap_or(0);
        self.balances.insert(token.clone(), bal + amt);
        env::log_str(&format!("BOUNCER deposit {} from {} amt {} msg {}", token, sender_id, amt, msg));
        U128(0)
    }

    #[payable]
    pub fn withdraw(&mut self, token: AccountId, amount: U128) -> Promise {
        assert_one_yocto();
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
        let policy = self.policies.get(&policy_id).cloned().expect("no such policy");
        assert!(amt > 0 && amt <= policy.per_tx_cap, "amount out of range");
        if !policy.payee_allowlist.is_empty() {
            assert!(policy.payee_allowlist.contains(&payee), "payee not in allowlist");
        }
        let now = env::block_timestamp();
        if let Some(log) = self.spends.get(&policy_id) {
            for w in &policy.windows {
                let spent: u128 = log.iter()
                    .filter(|s| now.saturating_sub(s.ns_since_epoch) < w.period_ns)
                    .map(|s| s.amount).sum();
                assert!(spent.saturating_add(amt) <= w.limit, "over window");
            }
        }
        let bal = self.balances.get(&policy.token).cloned().unwrap_or(0);
        assert!(bal >= amt, "insufficient balance");
        self.balances.insert(policy.token.clone(), bal - amt);
        ext_ft::ext(policy.token.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(payee.clone(), amount, Some(memo.clone()))
            .then(ext_self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_RESOLVE)
                .after_execute_transfer(policy_id, payee, amt, memo))
    }

    #[private]
    pub fn after_execute_transfer(&mut self, policy_id: String, payee: AccountId, amount: u128, memo: String) {
        let ok = matches!(env::promise_result(0), near_sdk::PromiseResult::Successful(_));
        let policy = self.policies.get(&policy_id).cloned().expect("policy");
        if ok {
            let mut log = self.spends.get(&policy_id).cloned().expect("log");
            log.push(Spend { payee, amount, memo, ns_since_epoch: env::block_timestamp() });
            self.spends.insert(policy_id, log);
        } else {
            let bal = self.balances.get(&policy.token).cloned().unwrap_or(0);
            self.balances.insert(policy.token, bal + amount);
        }
    }

    pub fn check(&self, policy_id: String, payee: AccountId, amount: U128) -> (bool, String) {
        let policy = match self.policies.get(&policy_id) { Some(p) => p.clone(), None => return (false, "no such policy".into()) };
        if amount.0 == 0 { return (false, "amount must be > 0".into()); }
        if amount.0 > policy.per_tx_cap { return (false, format!("over per-tx cap (max {})", policy.per_tx_cap)); }
        if !policy.payee_allowlist.is_empty() && !policy.payee_allowlist.contains(&payee) {
            return (false, format!("payee {} not in allowlist", payee));
        }
        let bal = self.balances.get(&policy.token).cloned().unwrap_or(0);
        if bal < amount.0 { return (false, format!("vault holds {}; need {}", bal, amount.0)); }
        let now = env::block_timestamp();
        if let Some(log) = self.spends.get(&policy_id) {
            for w in &policy.windows {
                let spent: u128 = log.iter().filter(|s| now.saturating_sub(s.ns_since_epoch) < w.period_ns).map(|s| s.amount).sum();
                if spent.saturating_add(amount.0) > w.limit { return (false, format!("over {}ns window", w.period_ns)); }
            }
        }
        (true, "ok".into())
    }
}

fn assert_one_yocto() {
    assert!(env::attached_deposit() == ONE_YOCTO, "requires exactly 1 yoctoNEAR (full-access only)");
}
