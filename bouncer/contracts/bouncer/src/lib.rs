use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, ext_contract, near, AccountId, Gas, NearToken, PanicOnDefault, Promise};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_FOR_RESOLVE: Gas = Gas::from_tgas(15);
const HOUR_NS: u64 = 3_600_000_000_000;
const DAY_HOURS: u64 = 24;
const DAY_NS: u64 = HOUR_NS * DAY_HOURS;

#[ext_contract(ext_ft)]
trait ExtFt {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[ext_contract(ext_self)]
trait ExtSelf {
    fn after_execute(&mut self, token: AccountId, amount: U128);
    fn after_withdraw(&mut self, token: AccountId, amount: U128);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Bouncer {
    owner: AccountId,
    token_of: LookupMap<String, AccountId>,
    cap_of: LookupMap<String, u128>,
    daily_limit_of: LookupMap<String, u128>,
    // allow: "policy_id:payee" -> true
    allow: LookupMap<String, bool>,
    allow_count: LookupMap<String, u32>,
    balances: LookupMap<AccountId, u128>,
    // bucket_key "policy_id:hour_bucket" -> amount spent in that hour
    hourly_spend: LookupMap<String, u128>,
}

fn allow_key(policy_id: &str, payee: &str) -> String { format!("{}:{}", policy_id, payee) }
fn bucket_key(policy_id: &str, bucket: u64) -> String { format!("{}:b{}", policy_id, bucket) }

/// Sum the last 24 hourly buckets; prune older ones lazily.
fn rolling_24h_spent(store: &LookupMap<String, u128>, policy_id: &str, now_ns: u64) -> u128 {
    let cur_bucket = now_ns / HOUR_NS;
    let mut total: u128 = 0;
    for i in 0..DAY_HOURS {
        let b = cur_bucket.saturating_sub(i);
        if let Some(v) = store.get(&bucket_key(policy_id, b)) {
            total = total.saturating_add(*v);
        }
    }
    total
}

fn credit_hour(store: &mut LookupMap<String, u128>, policy_id: &str, now_ns: u64, amt: u128) {
    let b = now_ns / HOUR_NS;
    let k = bucket_key(policy_id, b);
    let prev = store.get(&k).cloned().unwrap_or(0);
    store.insert(k, prev.saturating_add(amt));
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
            daily_limit_of: LookupMap::new(b"d"),
            allow: LookupMap::new(b"a"),
            allow_count: LookupMap::new(b"n"),
            balances: LookupMap::new(b"b"),
            hourly_spend: LookupMap::new(b"h"),
        }
    }

    #[payable]
    pub fn set_policy(
        &mut self,
        policy_id: String,
        token: AccountId,
        per_tx_cap: U128,
        daily_limit: Option<U128>,
    ) {
        assert!(env::attached_deposit() == ONE_YOCTO, "requires 1 yoctoNEAR (full-access key only)");
        assert!(env::predecessor_account_id() == self.owner, "owner only");
        assert!(per_tx_cap.0 > 0);
        self.token_of.insert(policy_id.clone(), token);
        self.cap_of.insert(policy_id.clone(), per_tx_cap.0);
        if let Some(dl) = daily_limit {
            assert!(dl.0 > 0);
            self.daily_limit_of.insert(policy_id, dl.0);
        }
    }

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
            self.allow_count.insert(policy_id, n.saturating_sub(1));
        }
    }

    pub fn vault_balance(&self, token: AccountId) -> U128 {
        U128(self.balances.get(&token).cloned().unwrap_or(0))
    }

    pub fn daily_spent(&self, policy_id: String) -> U128 {
        U128(rolling_24h_spent(&self.hourly_spend, &policy_id, env::block_timestamp()))
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
        ext_ft::ext(token.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(self.owner.clone(), amount, Some("bouncer:withdraw".into()))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_RESOLVE)
                    .after_withdraw(token, amount),
            )
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
        let now = env::block_timestamp();
        if let Some(limit) = self.daily_limit_of.get(&policy_id).cloned() {
            let spent = rolling_24h_spent(&self.hourly_spend, &policy_id, now);
            assert!(spent.saturating_add(amt) <= limit, "over 24h limit");
        }
        let bal = self.balances.get(&token).cloned().unwrap_or(0);
        assert!(bal >= amt, "insufficient vault balance");
        self.balances.insert(token.clone(), bal - amt);
        credit_hour(&mut self.hourly_spend, &policy_id, now, amt);
        ext_ft::ext(token.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(payee, amount, Some(memo))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_RESOLVE)
                    .after_execute(token, amount),
            )
    }

    #[private]
    pub fn after_execute(&mut self, token: AccountId, amount: U128) {
        let success = matches!(env::promise_result(0), near_sdk::PromiseResult::Successful(_));
        if !success {
            let bal = self.balances.get(&token).cloned().unwrap_or(0);
            self.balances.insert(token, bal + amount.0);
            env::log_str("BOUNCER ft_transfer failed; refunded vault");
        }
    }

    #[private]
    pub fn after_withdraw(&mut self, token: AccountId, amount: U128) {
        let success = matches!(env::promise_result(0), near_sdk::PromiseResult::Successful(_));
        if !success {
            let bal = self.balances.get(&token).cloned().unwrap_or(0);
            self.balances.insert(token, bal + amount.0);
            env::log_str("BOUNCER withdraw failed; refunded vault");
        }
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
        if let Some(limit) = self.daily_limit_of.get(&policy_id).cloned() {
            let spent = rolling_24h_spent(&self.hourly_spend, &policy_id, env::block_timestamp());
            if spent.saturating_add(amount.0) > limit {
                return (false, format!("would exceed 24h limit (spent {}/{} )", spent, limit));
            }
        }
        (true, "ok".into())
    }
}
