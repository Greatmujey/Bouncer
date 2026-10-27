//! Bouncer: policy-enforced spending for AI agents on NEAR.
//!
//! Agents get a function-call key scoped to a small method whitelist.
//! Policy-mutating methods require exactly 1 yoctoNEAR, which function-call
//! keys cannot attach — NEAR rejects such tx at DepositWithFunctionCall.
//! That is a structural guarantee, not a software check.

use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, UnorderedMap, Vector};
use near_sdk::{env, ext_contract, near, AccountId, Gas, NearToken, PanicOnDefault, Promise};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_FOR_RESOLVE: Gas = Gas::from_tgas(20);
const SOLVER_FEE_BPS: u128 = 10; // 0.1%

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
#[near(serializers = [json])]
#[derive(Clone)]
pub struct Invoice {
    pub id: u64, pub payee: AccountId, pub amount: u128, pub memo: String,
    pub filed_by: AccountId, pub filed_at_ns: u64, pub paid: bool,
}
#[near(serializers = [json])]
#[derive(Clone)]
pub struct Bid { pub solver: AccountId, pub amount_out: u128, pub nonce: u64 }
#[near(serializers = [json])]
#[derive(Clone)]
pub struct CrossChainIntent {
    pub id: u64, pub policy_id: String, pub token_in: AccountId, pub amount_in: u128,
    pub dest_chain: String, pub dest_asset: String, pub dest_address: String,
    pub min_amount_out: u128, pub deadline_ns: u64, pub open: bool,
    pub best: Option<Bid>, pub settled: bool, pub fill_tx_hash: Option<String>,
}

#[ext_contract(ext_ft)]
trait ExtFt {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}
#[ext_contract(ext_self)]
trait ExtSelf {
    fn after_execute_transfer(&mut self, policy_id: String, payee: AccountId, amount: u128, memo: String);
    fn after_cross_fee_transfer(&mut self, intent_id: u64);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Bouncer {
    owner: AccountId,
    policies: LookupMap<String, Policy>,
    spends: LookupMap<String, Vector<Spend>>,
    balances: LookupMap<AccountId, u128>,
    invoices: LookupMap<String, UnorderedMap<u64, Invoice>>,
    next_invoice_id: u64,
    cross_intents: LookupMap<u64, CrossChainIntent>,
    next_cross_id: u64,
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
            invoices: LookupMap::new(b"iv"),
            next_invoice_id: 0,
            cross_intents: LookupMap::new(b"x"),
            next_cross_id: 0,
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
        if !self.invoices.contains_key(&policy_id) {
            self.invoices.insert(policy_id.clone(), UnorderedMap::new(format!("iv:{}", policy_id).into_bytes()));
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
            log.push(Spend { payee, amount, memo: memo.clone(), ns_since_epoch: env::block_timestamp() });
            self.spends.insert(policy_id.clone(), log);
            if let Some(rest) = memo.strip_prefix("invoice:") {
                let id_str = rest.split(' ').next().unwrap_or("");
                if let Ok(id) = id_str.parse::<u64>() {
                    if let Some(mut bucket) = self.invoices.get(&policy_id).cloned() {
                        if let Some(mut inv) = bucket.remove(&id) { inv.paid = true; bucket.insert(id, inv); self.invoices.insert(policy_id.clone(), bucket); }
                    }
                }
            }
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

    pub fn file_invoice(&mut self, policy_id: String, payee: AccountId, amount: U128, memo: String) -> u64 {
        assert!(self.policies.contains_key(&policy_id), "no such policy");
        let id = self.next_invoice_id;
        self.next_invoice_id += 1;
        let inv = Invoice { id, payee, amount: amount.0, memo, filed_by: env::predecessor_account_id(), filed_at_ns: env::block_timestamp(), paid: false };
        let mut bucket = self.invoices.get(&policy_id).cloned().expect("bucket");
        bucket.insert(id, inv);
        self.invoices.insert(policy_id, bucket);
        id
    }

    pub fn pay_invoice(&mut self, policy_id: String, invoice_id: u64) -> Promise {
        let bucket = self.invoices.get(&policy_id).cloned().expect("policy");
        let inv = bucket.get(&invoice_id).cloned().expect("invoice");
        assert!(!inv.paid, "invoice already paid");
        self.execute(policy_id, inv.payee, U128(inv.amount), format!("invoice:{} {}", invoice_id, inv.memo))
    }

    pub fn list_invoices(&self, policy_id: String, only_open: Option<bool>) -> Vec<Invoice> {
        let b = match self.invoices.get(&policy_id) { Some(x) => x, None => return vec![] };
        let oo = only_open.unwrap_or(false);
        b.values().filter(|i| !oo || !i.paid).cloned().collect()
    }

    pub fn open_cross_chain(&mut self, policy_id: String, dest_chain: String, dest_asset: String,
                            dest_address: String, amount: U128, min_amount_out: U128, ttl_ns: u64) -> u64 {
        let amt = amount.0;
        let policy = self.policies.get(&policy_id).cloned().expect("no such policy");
        assert!(amt > 0 && amt <= policy.per_tx_cap, "amount out of range");
        if !policy.payee_allowlist.is_empty() {
            let ok = policy.payee_allowlist.iter().any(|a| a.as_str() == dest_chain.as_str() || a.as_str() == &format!("{}:{}", dest_chain, dest_address));
            assert!(ok, "dest not in allowlist");
        }
        let now = env::block_timestamp();
        if let Some(log) = self.spends.get(&policy_id) {
            for w in &policy.windows {
                let spent: u128 = log.iter().filter(|s| now.saturating_sub(s.ns_since_epoch) < w.period_ns).map(|s| s.amount).sum();
                assert!(spent + amt <= w.limit, "over window");
            }
        }
        let bal = self.balances.get(&policy.token).cloned().unwrap_or(0);
        assert!(bal >= amt, "insufficient");
        self.balances.insert(policy.token.clone(), bal - amt);
        let id = self.next_cross_id; self.next_cross_id += 1;
        let intent = CrossChainIntent {
            id, policy_id: policy_id.clone(), token_in: policy.token.clone(), amount_in: amt,
            dest_chain, dest_asset, dest_address, min_amount_out: min_amount_out.0,
            deadline_ns: now.saturating_add(ttl_ns), open: true, best: None, settled: false, fill_tx_hash: None,
        };
        let mut log = self.spends.get(&policy_id).cloned().expect("log");
        log.push(Spend {
            payee: AccountId::new_unchecked(format!("cross:{}.intents", id)),
            amount: amt, memo: format!("cross escrow #{}", id), ns_since_epoch: now,
        });
        self.spends.insert(policy_id, log);
        self.cross_intents.insert(id, intent);
        id
    }

    pub fn bid(&mut self, intent_id: u64, amount_out: U128) {
        let solver = env::predecessor_account_id();
        let mut intent = self.cross_intents.get(&intent_id).cloned().expect("intent");
        assert!(intent.open && !intent.settled, "closed");
        assert!(env::block_timestamp() < intent.deadline_ns, "expired");
        assert!(amount_out.0 >= intent.min_amount_out, "below floor");
        let nonce = intent.best.as_ref().map(|b| b.nonce + 1).unwrap_or(0);
        let wins = intent.best.as_ref().map(|b| amount_out.0 > b.amount_out).unwrap_or(true);
        if wins { intent.best = Some(Bid { solver, amount_out: amount_out.0, nonce }); self.cross_intents.insert(intent_id, intent); }
    }

    pub fn confirm_cross_chain(&mut self, intent_id: u64, fill_tx_hash: String) -> Promise {
        let mut intent = self.cross_intents.get(&intent_id).cloned().expect("intent");
        assert!(intent.open && !intent.settled, "closed");
        assert!(env::block_timestamp() < intent.deadline_ns, "expired");
        let solver = intent.best.as_ref().map(|b| b.solver.clone()).unwrap_or_else(env::predecessor_account_id);
        intent.settled = true; intent.open = false; intent.fill_tx_hash = Some(fill_tx_hash.clone());
        self.cross_intents.insert(intent_id, intent.clone());
        let fee = intent.amount_in * SOLVER_FEE_BPS / 10_000u128;
        if fee > 0 {
            let bal = self.balances.get(&intent.token_in).cloned().unwrap_or(0);
            self.balances.insert(intent.token_in.clone(), bal - fee);
            ext_ft::ext(intent.token_in.clone())
                .with_attached_deposit(ONE_YOCTO)
                .with_static_gas(GAS_FOR_FT_TRANSFER)
                .ft_transfer(solver, U128(fee), Some(format!("solver:{}", intent_id)))
                .then(ext_self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_RESOLVE)
                    .after_cross_fee_transfer(intent_id))
        } else { Promise::new(env::current_account_id()) }
    }

    #[private]
    pub fn after_cross_fee_transfer(&mut self, intent_id: u64) {
        let ok = matches!(env::promise_result(0), near_sdk::PromiseResult::Successful(_));
        env::log_str(&format!("BOUNCER cross_fee id={} ok={}", intent_id, ok));
    }

    pub fn get_cross_intent(&self, intent_id: u64) -> Option<CrossChainIntent> { self.cross_intents.get(&intent_id).cloned() }
    pub fn get_intent(&self, intent_id: u64) -> Option<CrossChainIntent> { self.get_cross_intent(intent_id) }
}

fn assert_one_yocto() {
    assert!(env::attached_deposit() == ONE_YOCTO, "requires exactly 1 yoctoNEAR (full-access only)");
}
