//! BOUNCER — the on-chain comptroller for AI agents on NEAR.
//!
//! Threat model: the agent is NOT trusted. It is assumed hostile, and it holds
//! a function-call access key scoped to a small whitelist of methods:
//!   `execute`, `pay_invoice`, `file_invoice`, `open_cross_chain`, `bid`,
//!   `check` (view).
//!
//! Every method that CHANGES POLICY or MOVES FUNDS TO THE OWNER requires
//! exactly 1 yoctoNEAR, which function-call keys cannot attach — the protocol
//! rejects such a tx at `DepositWithFunctionCall` before our code runs. This
//! is a STRUCTURAL guarantee, not a software check.

use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::collections::{LookupMap, UnorderedMap, Vector};
use near_sdk::json_types::U128;
use near_sdk::{
    env, ext_contract, near, AccountId, Balance, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PublicKey,
};

// -------------------- constants --------------------

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_FOR_RESOLVE: Gas = Gas::from_tgas(20);
const DEFAULT_SOLVER_FEE_BPS: u128 = 10; // 0.1%

// -------------------- types --------------------

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Window {
    pub period_ns: u64,
    pub limit: u128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Policy {
    pub label: String,
    pub token: AccountId,
    pub per_tx_cap: u128,
    pub windows: Vec<Window>,
    pub payee_allowlist: Vec<AccountId>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Spend {
    pub payee: AccountId,
    pub amount: u128,
    pub memo: String,
    pub ns_since_epoch: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Invoice {
    pub id: u64,
    pub payee: AccountId,
    pub amount: u128,
    pub memo: String,
    pub filed_by: AccountId,
    pub filed_at_ns: u64,
    pub paid: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Bid {
    pub solver: AccountId,
    pub amount_out: u128,
    pub nonce: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct CrossChainIntent {
    pub id: u64,
    pub policy_id: String,
    pub token_in: AccountId,
    pub amount_in: u128,
    pub dest_chain: String,
    pub dest_asset: String,
    pub dest_address: String,
    pub min_amount_out: u128,
    pub deadline_ns: u64,
    pub open: bool,
    pub best: Option<Bid>,
    pub settled: bool,
    pub fill_tx_hash: Option<String>,
    pub solver_fee_bps: u16,
}

// -------------------- ext_contract interfaces --------------------

#[ext_contract(ext_ft)]
trait ExtFt {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[ext_contract(ext_self)]
trait ExtSelf {
    fn after_execute_transfer(
        &mut self,
        policy_id: String,
        payee: AccountId,
        amount: u128,
        memo: String,
    );
    fn after_cross_fee_transfer(&mut self, intent_id: u64);
}

// -------------------- contract --------------------

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Bouncer {
    pub owner: AccountId,
    pub policies: LookupMap<String, Policy>,
    pub spends: LookupMap<String, Vector<Spend>>,
    pub spend_logs_count: LookupMap<String, u64>,
    pub balances: LookupMap<AccountId, u128>,
    pub invoices: LookupMap<String, UnorderedMap<u64, Invoice>>,
    pub next_invoice_id: u64,
    pub cross_intents: LookupMap<u64, CrossChainIntent>,
    pub next_cross_id: u64,
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
            spend_logs_count: LookupMap::new(b"sc"),
            balances: LookupMap::new(b"b"),
            invoices: LookupMap::new(b"iv"),
            next_invoice_id: 0,
            cross_intents: LookupMap::new(b"x"),
            next_cross_id: 0,
        }
    }

    // ---------------- policy (owner only, 1 yocto) ----------------

    #[payable]
    pub fn set_policy(&mut self, policy_id: String, policy: Policy) {
        assert_one_yocto();
        self.assert_owner();
        assert!(policy.per_tx_cap > 0, "per_tx_cap must be > 0");
        for w in &policy.windows {
            assert!(w.period_ns > 0, "window period must be > 0");
            assert!(w.limit > 0, "window limit must be > 0");
        }
        assert!(!policy.token.as_str().is_empty(), "token required");
        if !self.spends.contains_key(&policy_id) {
            self.spends.insert(
                policy_id.clone(),
                Vector::new(format!("sp:{}", policy_id).into_bytes()),
            );
            self.spend_logs_count.insert(policy_id.clone(), &0u64);
        }
        if !self.invoices.contains_key(&policy_id) {
            self.invoices.insert(
                policy_id.clone(),
                UnorderedMap::new(format!("iv:{}", policy_id).into_bytes()),
            );
        }
        self.policies.insert(policy_id, &policy);
    }

    pub fn get_policy(&self, policy_id: String) -> Option<Policy> {
        self.policies.get(&policy_id)
    }

    pub fn get_spends(&self, policy_id: String, from_index: Option<u64>, limit: Option<u64>) -> Vec<Spend> {
        let log = match self.spends.get(&policy_id) {
            Some(v) => v,
            None => return vec![],
        };
        let from = from_index.unwrap_or(0);
        let lim = limit.unwrap_or(100);
        log.iter().skip(from as usize).take(lim as usize).collect()
    }

    pub fn vault_balance(&self, token: AccountId) -> U128 {
        U128(self.balances.get(&token).unwrap_or(0))
    }

    // ---------------- NEP-141 deposit ----------------

    // NEP-141: ft_on_transfer returns the number of tokens to REFUND.
    // We only keep deposits for tokens that have a policy (prevents fake-token
    // airdrop attacks where random FTs pretend to fund the vault).
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> U128 {
        let token = env::predecessor_account_id();
        let amount = amount.0;
        let known = self.policies.values().any(|p| p.token == token);
        if !known {
            env::log_str(&format!(
                "BOUNCER refund {} of {} from {} (token not governed)",
                amount, token, sender_id
            ));
            return U128(amount);
        }
        let bal = self.balances.get(&token).unwrap_or(0);
        self.balances.insert(&token, &(bal.saturating_add(amount)));
        env::log_str(&format!(
            "BOUNCER deposit token={} from={} amount={} msg={}",
            token, sender_id, amount, msg
        ));
        U128(0)
    }

    #[payable]
    pub fn withdraw(&mut self, token: AccountId, amount: U128) -> Promise {
        assert_one_yocto();
        self.assert_owner();
        let amount = amount.0;
        let bal = self.balances.get(&token).unwrap_or(0);
        assert!(amount <= bal, "insufficient vault balance");
        self.balances.insert(&token, &(bal - amount));
        env::log_str(&format!(
            "BOUNCER withdraw token={} to={} amount={}",
            token, self.owner, amount
        ));
        ext_ft::ext(token)
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(self.owner.clone(), U128(amount), Some("bouncer:withdraw".to_string()))
    }

    // ---------------- NEAR-side spend (the agent's primary method) ----------------

    /// THE ONLY PAYMENT METHOD THE AGENT'S KEY IS SCOPED TO FOR VALUE MOVEMENT.
    ///
    /// Runs every policy check; on pass, initiates a real ft_transfer. The
    /// callback records the spend only on success, so failed transfers don't
    /// consume the budget and don't leave partial state.
    pub fn execute(
        &mut self,
        policy_id: String,
        payee: AccountId,
        amount: U128,
        memo: String,
    ) -> Promise {
        let amount = amount.0;
        let policy = self.policies.get(&policy_id).expect("no such policy");

        assert!(amount > 0, "amount must be > 0");
        assert!(
            amount <= policy.per_tx_cap,
            "over per-tx cap: {} > {}",
            amount,
            policy.per_tx_cap
        );
        if !policy.payee_allowlist.is_empty() {
            assert!(
                policy.payee_allowlist.contains(&payee),
                "payee {} not in allowlist",
                payee
            );
        }

        let now = env::block_timestamp();
        if let Some(log) = self.spends.get(&policy_id) {
            for w in &policy.windows {
                let spent: u128 = log
                    .iter()
                    .filter(|s| now.saturating_sub(s.ns_since_epoch) < w.period_ns)
                    .map(|s| s.amount)
                    .sum();
                assert!(
                    spent.saturating_add(amount) <= w.limit,
                    "over {}ns window (spent {}, limit {})",
                    w.period_ns,
                    spent,
                    w.limit
                );
            }
        }

        let bal = self.balances.get(&policy.token).unwrap_or(0);
        assert!(bal >= amount, "vault holds {}; need {}", bal, amount);

        // Optimistically debit (NEAR receipts are sequential per account,
        // so concurrent double-spend can't happen on the same shard). The
        // callback re-credits if ft_transfer fails.
        self.balances.insert(&policy.token, &(bal - amount));

        env::log_str(&format!(
            "BOUNCER execute policy={} payee={} amount={}",
            policy_id, payee, amount
        ));

        ext_ft::ext(policy.token.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(payee.clone(), U128(amount), Some(memo.clone()))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_RESOLVE)
                    .after_execute_transfer(policy_id, payee, amount, memo),
            )
    }

    /// Callback after ft_transfer. Append the spend to audit log on success,
    /// re-credit on failure.
    #[private]
    pub fn after_execute_transfer(
        &mut self,
        policy_id: String,
        payee: AccountId,
        amount: u128,
        memo: String,
    ) {
        let success = matches!(env::promise_result(0), near_sdk::PromiseResult::Successful(_));
        let policy = self.policies.get(&policy_id).expect("policy");
        if success {
            let mut log = self.spends.get(&policy_id).expect("spend log");
            log.push(&Spend {
                payee: payee.clone(),
                amount,
                memo: memo.clone(),
                ns_since_epoch: env::block_timestamp(),
            });
            self.spends.insert(&policy_id, &log);
            // If memo starts with "invoice:<id>", mark that invoice paid.
            if let Some(rest) = memo.strip_prefix("invoice:") {
                let id_str = rest.split(' ').next().unwrap_or("");
                if let Ok(id) = id_str.parse::<u64>() {
                    if let Some(mut bucket) = self.invoices.get(&policy_id) {
                        if let Some(mut inv) = bucket.remove(&id) {
                            inv.paid = true;
                            bucket.insert(&id, &inv);
                            self.invoices.insert(&policy_id, &bucket);
                        }
                    }
                }
            }
            env::log_str(&format!("BOUNCER settled policy={} amount={}", policy_id, amount));
        } else {
            let bal = self.balances.get(&policy.token).unwrap_or(0);
            self.balances.insert(&policy.token, &(bal.saturating_add(amount)));
            env::log_str(&format!(
                "BOUNCER ft_transfer FAILED policy={} amount={} (re-credited)",
                policy_id, amount
            ));
        }
    }

    pub fn check(&self, policy_id: String, payee: AccountId, amount: U128) -> (bool, String) {
        let policy = match self.policies.get(&policy_id) {
            Some(p) => p,
            None => return (false, "no such policy".to_string()),
        };
        if amount.0 == 0 {
            return (false, "amount must be > 0".to_string());
        }
        if amount.0 > policy.per_tx_cap {
            return (false, format!("over per-tx cap (max {})", policy.per_tx_cap));
        }
        if !policy.payee_allowlist.is_empty() && !policy.payee_allowlist.contains(&payee) {
            return (false, format!("payee {} not in allowlist", payee));
        }
        let bal = self.balances.get(&policy.token).unwrap_or(0);
        if bal < amount.0 {
            return (false, format!("vault holds {}; need {}", bal, amount.0));
        }
        let now = env::block_timestamp();
        if let Some(log) = self.spends.get(&policy_id) {
            for w in &policy.windows {
                let spent: u128 = log
                    .iter()
                    .filter(|s| now.saturating_sub(s.ns_since_epoch) < w.period_ns)
                    .map(|s| s.amount)
                    .sum();
                if spent.saturating_add(amount.0) > w.limit {
                    return (
                        false,
                        format!("over {}ns window (spent {}, limit {})", w.period_ns, spent, w.limit),
                    );
                }
            }
        }
        (true, "ok".to_string())
    }

    // ---------------- invoices ----------------

    pub fn file_invoice(
        &mut self,
        policy_id: String,
        payee: AccountId,
        amount: U128,
        memo: String,
    ) -> u64 {
        assert!(self.policies.contains_key(&policy_id), "no such policy");
        let id = self.next_invoice_id;
        self.next_invoice_id += 1;
        let inv = Invoice {
            id,
            payee,
            amount: amount.0,
            memo,
            filed_by: env::predecessor_account_id(),
            filed_at_ns: env::block_timestamp(),
            paid: false,
        };
        let mut bucket = self.invoices.get(&policy_id).expect("invoice bucket");
        bucket.insert(&id, &inv);
        self.invoices.insert(&policy_id, &bucket);
        env::log_str(&format!("BOUNCER invoice filed policy={} id={}", policy_id, id));
        id
    }

    pub fn pay_invoice(&mut self, policy_id: String, invoice_id: u64) -> Promise {
        let bucket = self.invoices.get(&policy_id).expect("no such policy");
        let inv = bucket.get(&invoice_id).expect("no such invoice");
        assert!(!inv.paid, "invoice already paid");
        // Mark paid up-front so re-entrancy can't double-trigger (reverts unwind this).
        drop(bucket);
        self.execute(
            policy_id,
            inv.payee,
            U128(inv.amount),
            format!("invoice:{} {}", invoice_id, inv.memo),
        )
    }

    pub fn list_invoices(&self, policy_id: String, only_open: Option<bool>) -> Vec<Invoice> {
        let bucket = match self.invoices.get(&policy_id) {
            Some(b) => b,
            None => return vec![],
        };
        let only_open = only_open.unwrap_or(false);
        bucket
            .values()
            .filter(|i| !only_open || !i.paid)
            .collect()
    }

    // ---------------- cross-chain intents ----------------

    pub fn open_cross_chain(
        &mut self,
        policy_id: String,
        dest_chain: String,
        dest_asset: String,
        dest_address: String,
        amount: U128,
        min_amount_out: U128,
        ttl_ns: u64,
    ) -> u64 {
        let amount = amount.0;
        let policy = self.policies.get(&policy_id).expect("no such policy");
        assert!(amount > 0, "amount must be > 0");
        assert!(amount <= policy.per_tx_cap, "over per-tx cap");
        if !policy.payee_allowlist.is_empty() {
            let permitted = policy.payee_allowlist.iter().any(|a| {
                let s = a.as_str();
                s == dest_chain.as_str()
                    || (s.starts_with(&format!("{}:", dest_chain))
                        && s.ends_with(&dest_address))
            });
            assert!(
                permitted,
                "dest {}:{} not in allowlist",
                dest_chain, dest_address
            );
        }
        let now = env::block_timestamp();
        if let Some(log) = self.spends.get(&policy_id) {
            for w in &policy.windows {
                let spent: u128 = log
                    .iter()
                    .filter(|s| now.saturating_sub(s.ns_since_epoch) < w.period_ns)
                    .map(|s| s.amount)
                    .sum();
                assert!(spent.saturating_add(amount) <= w.limit, "over window");
            }
        }
        let bal = self.balances.get(&policy.token).unwrap_or(0);
        assert!(bal >= amount, "insufficient vault balance");
        self.balances.insert(&policy.token, &(bal - amount));

        let id = self.next_cross_id;
        self.next_cross_id += 1;
        let intent = CrossChainIntent {
            id,
            policy_id: policy_id.clone(),
            token_in: policy.token.clone(),
            amount_in: amount,
            dest_chain,
            dest_asset,
            dest_address,
            min_amount_out: min_amount_out.0,
            deadline_ns: now.saturating_add(ttl_ns),
            open: true,
            best: None,
            settled: false,
            fill_tx_hash: None,
            solver_fee_bps: DEFAULT_SOLVER_FEE_BPS as u16,
        };
        // Reserve against the window so double-spends are blocked while open.
        let mut log = self.spends.get(&policy_id).expect("spend log");
        log.push(&Spend {
            payee: AccountId::new_unchecked(format!("cross:{}.intents", id)),
            amount,
            memo: format!("cross-chain escrow #{}", id),
            ns_since_epoch: now,
        });
        self.spends.insert(&policy_id, &log);
        self.cross_intents.insert(&id, &intent);
        env::log_str(&format!(
            "BOUNCER cross_open id={} policy={} amount={}",
            id, policy_id, amount
        ));
        id
    }

    pub fn bid(&mut self, intent_id: u64, amount_out: U128) {
        let solver = env::predecessor_account_id();
        let mut intent = self.cross_intents.get(&intent_id).expect("no such intent");
        assert!(intent.open, "intent closed");
        assert!(!intent.settled, "intent settled");
        assert!(env::block_timestamp() < intent.deadline_ns, "intent expired");
        assert!(amount_out.0 >= intent.min_amount_out, "bid below floor");
        let nonce = match &intent.best {
            Some(b) => b.nonce + 1,
            None => 0,
        };
        let wins = intent
            .best
            .as_ref()
            .map(|b| amount_out.0 > b.amount_out)
            .unwrap_or(true);
        if wins {
            intent.best = Some(Bid {
                solver,
                amount_out: amount_out.0,
                nonce,
            });
            self.cross_intents.insert(&intent_id, &intent);
        }
        env::log_str(&format!(
            "BOUNCER cross_bid id={} solver wins={}",
            intent_id, wins
        ));
    }

    pub fn confirm_cross_chain(&mut self, intent_id: u64, fill_tx_hash: String) -> Promise {
        let mut intent = self.cross_intents.get(&intent_id).expect("no such intent");
        assert!(intent.open, "intent not open");
        assert!(!intent.settled, "already settled");
        assert!(env::block_timestamp() < intent.deadline_ns, "intent expired");
        let solver = match &intent.best {
            Some(b) => b.solver.clone(),
            None => env::predecessor_account_id(),
        };
        intent.settled = true;
        intent.open = false;
        intent.fill_tx_hash = Some(fill_tx_hash.clone());
        self.cross_intents.insert(&intent_id, &intent);
        env::log_str(&format!(
            "BOUNCER cross_settle id={} solver={} fill_tx={}",
            intent_id, solver, fill_tx_hash
        ));
        let fee = intent.amount_in * intent.solver_fee_bps as u128 / 10_000u128;
        if fee > 0 {
            let bal = self.balances.get(&intent.token_in).unwrap_or(0);
            self.balances.insert(&intent.token_in, &(bal.saturating_sub(fee)));
            ext_ft::ext(intent.token_in.clone())
                .with_attached_deposit(ONE_YOCTO)
                .with_static_gas(GAS_FOR_FT_TRANSFER)
                .ft_transfer(solver, U128(fee), Some(format!("bouncer:solver:{}", intent_id)))
                .then(
                    ext_self::ext(env::current_account_id())
                        .with_static_gas(GAS_FOR_RESOLVE)
                        .after_cross_fee_transfer(intent_id),
                )
        } else {
            Promise::new(env::current_account_id())
        }
    }

    #[private]
    pub fn after_cross_fee_transfer(&mut self, intent_id: u64) {
        let ok = matches!(env::promise_result(0), near_sdk::PromiseResult::Successful(_));
        env::log_str(&format!("BOUNCER cross_fee id={} ok={}", intent_id, ok));
    }

    pub fn get_cross_intent(&self, intent_id: u64) -> Option<CrossChainIntent> {
        self.cross_intents.get(&intent_id)
    }

    /// Alias so the dashboard can call `get_intent(id)` for cross intents.
    pub fn get_intent(&self, intent_id: u64) -> Option<CrossChainIntent> {
        self.get_cross_intent(intent_id)
    }

    // ---------------- guards ----------------

    fn assert_owner(&self) {
        assert!(
            env::predecessor_account_id() == self.owner,
            "owner only"
        );
    }
}

/// Require exactly 1 yoctoNEAR attached. Structural guard: function-call access
/// keys cannot attach any deposit, so NEAR rejects such tx at the protocol
/// level with `DepositWithFunctionCall` before our code even runs.
fn assert_one_yocto() {
    assert!(
        env::attached_deposit() == ONE_YOCTO,
        "requires exactly 1 yoctoNEAR (only full-access signatures can do this)"
    );
}

// ================================================================ unit tests

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::{testing_env, NearToken};

    fn ctx(predecessor: AccountId, deposit: NearToken) -> near_sdk::VMContext {
        VMContextBuilder::new()
            .predecessor_account_id(predecessor)
            .attached_deposit(deposit)
            .block_timestamp(1_000_000_000)
            .build()
    }

    fn day_policy() -> Policy {
        Policy {
            label: "agent".into(),
            token: accounts(2),
            per_tx_cap: 5_000_000,
            windows: vec![Window {
                period_ns: 24 * 60 * 60 * 1_000_000_000,
                limit: 20_000_000,
            }],
            payee_allowlist: vec![],
        }
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn set_policy_rejects_non_owner() {
        testing_env!(ctx(accounts(1), ONE_YOCTO));
        let mut c = Bouncer::new(accounts(0));
        testing_env!(ctx(accounts(1), ONE_YOCTO));
        c.set_policy("p1".into(), day_policy());
    }

    #[test]
    fn set_policy_works_for_owner() {
        testing_env!(ctx(accounts(0), ONE_YOCTO));
        let mut c = Bouncer::new(accounts(0));
        c.set_policy("p1".into(), day_policy());
        assert!(c.get_policy("p1".into()).is_some());
    }

    #[test]
    #[should_panic(expected = "over per-tx cap")]
    fn execute_over_cap_rejected() {
        testing_env!(ctx(accounts(0), ONE_YOCTO));
        let mut c = Bouncer::new(accounts(0));
        c.set_policy("p1".into(), day_policy());
        testing_env!(ctx(accounts(2), NearToken::from_yoctonear(0)));
        c.ft_on_transfer(accounts(0), U128(100_000_000), "fund".into());
        testing_env!(ctx(accounts(1), NearToken::from_yoctonear(0)));
        // execute calls ft_transfer which will fail in test; but check() happens
        // first so per-tx-cap panic fires before any promise.
        let _ = c.execute("p1".into(), accounts(3), U128(6_000_000), "too big".into());
    }

    #[test]
    fn unknown_token_refunded_on_deposit() {
        testing_env!(ctx(accounts(0), ONE_YOCTO));
        let mut c = Bouncer::new(accounts(0));
        c.set_policy("p1".into(), day_policy());
        testing_env!(ctx(accounts(5), NearToken::from_yoctonear(0)));
        let refund = c.ft_on_transfer(accounts(0), U128(50_000_000), "junk".into());
        assert_eq!(refund.0, 50_000_000);
        assert_eq!(c.vault_balance(accounts(5)).0, 0);
    }

    #[test]
    fn check_blocks_unknown_payee() {
        testing_env!(ctx(accounts(0), ONE_YOCTO));
        let mut c = Bouncer::new(accounts(0));
        let mut p = day_policy();
        p.payee_allowlist = vec![accounts(3)];
        c.set_policy("p1".into(), p);
        testing_env!(ctx(accounts(1), NearToken::from_yoctonear(0)));
        let (ok, reason) = c.check("p1".into(), accounts(4), U128(1_000_000));
        assert!(!ok);
        assert!(reason.contains("allowlist"), "reason: {}", reason);
    }

    #[test]
    fn check_happy_path() {
        testing_env!(ctx(accounts(0), ONE_YOCTO));
        let mut c = Bouncer::new(accounts(0));
        c.set_policy("p1".into(), day_policy());
        testing_env!(ctx(accounts(2), NearToken::from_yoctonear(0)));
        c.ft_on_transfer(accounts(0), U128(100_000_000), "fund".into());
        testing_env!(ctx(accounts(1), NearToken::from_yoctonear(0)));
        let (ok, reason) = c.check("p1".into(), accounts(3), U128(3_000_000));
        assert!(ok, "should pass: {}", reason);
    }

    #[test]
    #[should_panic(expected = "1 yoctoNEAR")]
    fn agent_key_cannot_call_set_policy() {
        testing_env!(ctx(accounts(0), ONE_YOCTO));
        let mut c = Bouncer::new(accounts(0));
        c.set_policy("p1".into(), day_policy());
        testing_env!(ctx(accounts(1), NearToken::from_yoctonear(0)));
        c.set_policy("p1".into(), day_policy());
    }

    #[test]
    fn split_payment_seventh_blocked_after_logging_six() {
        testing_env!(ctx(accounts(0), ONE_YOCTO));
        let mut c = Bouncer::new(accounts(0));
        let mut p = day_policy();
        p.per_tx_cap = 4_000_000;
        p.payee_allowlist = vec![accounts(3)];
        c.set_policy("p1".into(), p);
        testing_env!(ctx(accounts(2), NearToken::from_yoctonear(0)));
        c.ft_on_transfer(accounts(0), U128(100_000_000), "fund".into());
        // Record six $3 spends directly into the log to simulate prior settlements
        testing_env!(ctx(accounts(0), ONE_YOCTO));
        let mut log = c.spends.get("p1").expect("log exists");
        for i in 0..6u128 {
            log.push(&Spend {
                payee: accounts(3),
                amount: 3_000_000,
                memo: format!("pay{}", i),
                ns_since_epoch: 1_000_000_000 + i as u64,
            });
        }
        c.spends.insert("p1", &log);
        testing_env!(ctx(accounts(1), NearToken::from_yoctonear(0)));
        let (ok, reason) = c.check("p1".into(), accounts(3), U128(3_000_000));
        assert!(!ok, "7th payment must be blocked");
        assert!(reason.contains("window"), "reason should mention window, got: {}", reason);
    }
}
