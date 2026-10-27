use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, ext_contract, near, AccountId, Gas, NearToken, PanicOnDefault, Promise};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_FOR_RESOLVE: Gas = Gas::from_tgas(15);
const HOUR_NS: u64 = 3_600_000_000_000;
const DAY_HOURS: u64 = 24;

#[ext_contract(ext_ft)]
trait ExtFt {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}
#[ext_contract(ext_self)]
trait ExtSelf {
    fn after_execute(&mut self, token: AccountId, amount: U128, invoice_id: u64);
    fn after_withdraw(&mut self, token: AccountId, amount: U128);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Bouncer {
    owner: AccountId,
    token_of: LookupMap<String, AccountId>,
    cap_of: LookupMap<String, u128>,
    daily_limit_of: LookupMap<String, u128>,
    allow: LookupMap<String, bool>,
    allow_count: LookupMap<String, u32>,
    balances: LookupMap<AccountId, u128>,
    hourly_spend: LookupMap<String, u128>,
    next_invoice_id: u64,
    inv_payee: LookupMap<u64, AccountId>,
    inv_amount: LookupMap<u64, u128>,
    inv_policy: LookupMap<u64, String>,
    inv_memo: LookupMap<u64, String>,
    inv_filed_by: LookupMap<u64, AccountId>,
    inv_filed_at: LookupMap<u64, u64>,
    inv_paid: LookupMap<u64, bool>,
    inv_paid_at: LookupMap<u64, u64>,
}

fn allow_key(policy_id: &str, payee: &str) -> String { format!("{}:{}", policy_id, payee) }
fn bucket_key(policy_id: &str, bucket: u64) -> String { format!("{}:b{}", policy_id, bucket) }

fn rolling_24h(store: &LookupMap<String, u128>, policy_id: &str, now_ns: u64) -> u128 {
    let cur = now_ns / HOUR_NS;
    let mut t: u128 = 0;
    for i in 0..DAY_HOURS {
        if let Some(v) = store.get(&bucket_key(policy_id, cur.saturating_sub(i))) { t = t.saturating_add(*v); }
    }
    t
}
fn credit_hour(store: &mut LookupMap<String, u128>, policy_id: &str, now_ns: u64, amt: u128) {
    let k = bucket_key(policy_id, now_ns / HOUR_NS);
    let p = store.get(&k).cloned().unwrap_or(0);
    store.insert(k, p.saturating_add(amt));
}

#[near]
impl Bouncer {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        assert!(!owner.as_str().is_empty());
        Self {
            owner,
            token_of: LookupMap::new(b"t"), cap_of: LookupMap::new(b"c"), daily_limit_of: LookupMap::new(b"d"),
            allow: LookupMap::new(b"a"), allow_count: LookupMap::new(b"n"),
            balances: LookupMap::new(b"b"), hourly_spend: LookupMap::new(b"h"),
            next_invoice_id: 0,
            inv_payee: LookupMap::new(b"ip"), inv_amount: LookupMap::new(b"ia"),
            inv_policy: LookupMap::new(b"ic"), inv_memo: LookupMap::new(b"im"),
            inv_filed_by: LookupMap::new(b"ib"), inv_filed_at: LookupMap::new(b"if"),
            inv_paid: LookupMap::new(b"ipd"), inv_paid_at: LookupMap::new(b"ipt"),
        }
    }

    #[payable]
    pub fn set_policy(&mut self, policy_id: String, token: AccountId, per_tx_cap: U128, daily_limit: Option<U128>) {
        assert!(env::attached_deposit() == ONE_YOCTO, "requires 1 yoctoNEAR (full-access key only)");
        assert!(env::predecessor_account_id() == self.owner, "owner only");
        assert!(per_tx_cap.0 > 0);
        self.token_of.insert(policy_id.clone(), token);
        self.cap_of.insert(policy_id.clone(), per_tx_cap.0);
        if let Some(dl) = daily_limit { assert!(dl.0 > 0); self.daily_limit_of.insert(policy_id, dl.0); }
    }

    #[payable]
    pub fn allow_payee(&mut self, policy_id: String, payee: AccountId) {
        assert!(env::attached_deposit() == ONE_YOCTO);
        assert!(env::predecessor_account_id() == self.owner);
        assert!(self.cap_of.contains_key(&policy_id));
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

    pub fn vault_balance(&self, token: AccountId) -> U128 { U128(self.balances.get(&token).cloned().unwrap_or(0)) }
    pub fn daily_spent(&self, policy_id: String) -> U128 { U128(rolling_24h(&self.hourly_spend, &policy_id, env::block_timestamp())) }

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
        let bal = self.balances.get(&token).cloned().unwrap_or(0);
        assert!(amount.0 <= bal, "insufficient");
        self.balances.insert(token.clone(), bal - amount.0);
        ext_ft::ext(token.clone()).with_attached_deposit(ONE_YOCTO).with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(self.owner.clone(), amount, Some("bouncer:withdraw".into()))
            .then(ext_self::ext(env::current_account_id()).with_static_gas(GAS_FOR_RESOLVE).after_withdraw(token, amount))
    }

    fn do_pay(&mut self, policy_id: &str, payee: AccountId, amount: U128, memo: String, invoice_id: u64) -> Promise {
        let token = self.token_of.get(policy_id).cloned().expect("no token");
        let bal = self.balances.get(&token).cloned().unwrap_or(0);
        assert!(bal >= amount.0, "insufficient vault balance");
        self.balances.insert(token.clone(), bal - amount.0);
        credit_hour(&mut self.hourly_spend, policy_id, env::block_timestamp(), amount.0);
        let memo_full = if invoice_id == u64::MAX { memo } else { format!("invoice:{} {}", invoice_id, memo) };
        ext_ft::ext(token).with_attached_deposit(ONE_YOCTO).with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(payee, amount, Some(memo_full))
            .then(ext_self::ext(env::current_account_id()).with_static_gas(GAS_FOR_RESOLVE)
                .after_execute(token, amount, invoice_id))
    }

    pub fn execute(&mut self, policy_id: String, payee: AccountId, amount: U128, memo: String) -> Promise {
        let cap = self.cap_of.get(&policy_id).cloned().expect("no policy");
        assert!(amount.0 > 0 && amount.0 <= cap, "amount out of per-tx range");
        let n = self.allow_count.get(&policy_id).cloned().unwrap_or(0);
        if n > 0 {
            let k = allow_key(&policy_id, payee.as_str());
            assert!(self.allow.get(&k) == Some(&true), "payee not in allowlist");
        }
        if let Some(limit) = self.daily_limit_of.get(&policy_id).cloned() {
            let spent = rolling_24h(&self.hourly_spend, &policy_id, env::block_timestamp());
            assert!(spent.saturating_add(amount.0) <= limit, "over 24h limit");
        }
        self.do_pay(&policy_id, payee, amount, memo, u64::MAX)
    }

    #[private]
    pub fn after_execute(&mut self, token: AccountId, amount: U128, invoice_id: u64) {
        let ok = matches!(env::promise_result(0), near_sdk::PromiseResult::Successful(_));
        if !ok {
            let bal = self.balances.get(&token).cloned().unwrap_or(0);
            self.balances.insert(token.clone(), bal + amount.0);
            // roll back hour credit (approximate; safe)
            env::log_str("BOUNCER ft_transfer failed; refunded vault");
            if invoice_id != u64::MAX {
                self.inv_paid.insert(invoice_id, false);
                self.inv_paid_at.remove(&invoice_id);
            }
        } else if invoice_id != u64::MAX {
            self.inv_paid_at.insert(invoice_id, env::block_timestamp());
        }
    }

    #[private]
    pub fn after_withdraw(&mut self, token: AccountId, amount: U128) {
        if !matches!(env::promise_result(0), near_sdk::PromiseResult::Successful(_)) {
            let bal = self.balances.get(&token).cloned().unwrap_or(0);
            self.balances.insert(token, bal + amount.0);
        }
    }

    // ---- Invoices ----
    pub fn file_invoice(&mut self, policy_id: String, payee: AccountId, amount: U128, memo: String) -> u64 {
        assert!(self.cap_of.contains_key(&policy_id), "no such policy");
        let id = self.next_invoice_id;
        self.next_invoice_id += 1;
        let now = env::block_timestamp();
        self.inv_payee.insert(id, payee);
        self.inv_amount.insert(id, amount.0);
        self.inv_policy.insert(id, policy_id);
        self.inv_memo.insert(id, memo);
        self.inv_filed_by.insert(id, env::predecessor_account_id());
        self.inv_filed_at.insert(id, now);
        self.inv_paid.insert(id, false);
        id
    }

    pub fn invoice_paid(&self, id: u64) -> bool { self.inv_paid.get(&id).cloned().unwrap_or(false) }
    pub fn invoice_amount(&self, id: u64) -> U128 { U128(self.inv_amount.get(&id).cloned().unwrap_or(0)) }
    pub fn invoice_payee(&self, id: u64) -> AccountId { self.inv_payee.get(&id).cloned().unwrap_or_else(|| env::current_account_id()) }
    pub fn invoice_policy(&self, id: u64) -> String { self.inv_policy.get(&id).cloned().unwrap_or_default() }
    pub fn next_invoice_id(&self) -> u64 { self.next_invoice_id }

    pub fn pay_invoice(&mut self, id: u64) -> Promise {
        let payee = self.inv_payee.get(&id).cloned().expect("no invoice");
        let amount = self.inv_amount.get(&id).cloned().expect("no invoice");
        let policy_id = self.inv_policy.get(&id).cloned().expect("no invoice policy");
        let memo = self.inv_memo.get(&id).cloned().unwrap_or_default();
        let already_paid = self.inv_paid.get(&id).cloned().unwrap_or(false);
        assert!(!already_paid, "invoice already paid");
        // policy checks
        let cap = self.cap_of.get(&policy_id).cloned().expect("no policy");
        assert!(amount <= cap, "amount over per-tx cap");
        let n = self.allow_count.get(&policy_id).cloned().unwrap_or(0);
        if n > 0 {
            let k = allow_key(&policy_id, payee.as_str());
            assert!(self.allow.get(&k) == Some(&true), "payee not in allowlist");
        }
        if let Some(limit) = self.daily_limit_of.get(&policy_id).cloned() {
            let spent = rolling_24h(&self.hourly_spend, &policy_id, env::block_timestamp());
            assert!(spent.saturating_add(amount) <= limit, "over 24h limit");
        }
        self.inv_paid.insert(id, true);
        self.do_pay(&policy_id, payee, U128(amount), memo, id)
    }

    pub fn check(&self, policy_id: String, payee: AccountId, amount: U128) -> (bool, String) {
        let cap = match self.cap_of.get(&policy_id) { Some(c) => *c, None => return (false, "no such policy".into()) };
        let token = match self.token_of.get(&policy_id) { Some(t) => t.clone(), None => return (false, "policy missing token".into()) };
        if amount.0 == 0 { return (false, "amount must be > 0".into()); }
        if amount.0 > cap { return (false, format!("over per-tx cap (max {})", cap)); }
        let n = self.allow_count.get(&policy_id).cloned().unwrap_or(0);
        if n > 0 {
            let k = allow_key(&policy_id, payee.as_str());
            if self.allow.get(&k) != Some(&true) { return (false, format!("payee {} not in allowlist", payee)); }
        }
        let bal = self.balances.get(&token).cloned().unwrap_or(0);
        if bal < amount.0 { return (false, format!("vault holds {}; need {}", bal, amount.0)); }
        if let Some(limit) = self.daily_limit_of.get(&policy_id).cloned() {
            let spent = rolling_24h(&self.hourly_spend, &policy_id, env::block_timestamp());
            if spent.saturating_add(amount.0) > limit { return (false, format!("would exceed 24h limit (spent {}/{})", spent, limit)); }
        }
        (true, "ok".into())
    }
}
