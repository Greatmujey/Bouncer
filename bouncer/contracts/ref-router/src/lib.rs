//! Experimental, one-shot NEAR testnet Ref adapter for a Bouncer vault.
//!
//! Ref's normal instant-swap output is a plain FT transfer, which does not
//! trigger Bouncer's vault deposit hook. This isolated adapter holds that
//! output and can send actual tokens back with `ft_transfer_call`, so the
//! vault credits a real incoming transfer instead of an unsafe balance delta.
//! Input settlement is not output delivery. Every ambiguous result must be
//! reconciled by its original hash; this contract never retries a swap.

use near_sdk::json_types::U128;
use near_sdk::{env, ext_contract, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue, PromiseResult};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const ZERO: NearToken = NearToken::from_yoctonear(0);
const REF: &str = "ref-finance-101.testnet";
const INPUT: &str = "wrap.testnet";
const OUTPUT: &str = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const INPUT_MESSAGE: &str = r#"{"action":"bouncer-ref-swap-v1"}"#;
const OUTPUT_MESSAGE: &str = "bouncer:ref-output-v1";
const MAX_INPUT: u128 = 10_000_000_000_000_000_000_000; // 0.01 testnet wNEAR
const MAX_MIN_OUTPUT: u128 = 100_000; // 0.1 testnet USDC, six decimals
const NATIVE_RESERVE: u128 = 50_000_000_000_000_000_000_000; // 0.05 testnet NEAR
const GAS_FOR_REF_CALL: Gas = Gas::from_tgas(140);
const GAS_FOR_INPUT_CALLBACK: Gas = Gas::from_tgas(12);
const GAS_FOR_TRANSFER_CALL: Gas = Gas::from_tgas(80);
const GAS_FOR_REF_WITHDRAW: Gas = Gas::from_tgas(80);

fn account(value: &str) -> AccountId { value.parse().unwrap_or_else(|_| env::panic_str("invalid fixed account")) }
fn require(ok: bool, message: &str) { if !ok { env::panic_str(message); } }
fn named_testnet(value: &AccountId) -> bool { value.as_str().ends_with(".testnet") }

#[ext_contract(ext_ft)]
trait ExtFt {
    fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> PromiseOrValue<U128>;
}
#[ext_contract(ext_ref)]
trait ExtRef {
    fn withdraw(&mut self, token_id: AccountId, amount: U128, unregister: Option<bool>) -> PromiseOrValue<U128>;
}
#[ext_contract(ext_self)]
trait ExtSelf {
    fn after_ref_input(&mut self) -> U128;
}

#[derive(near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct RouteView {
    pub version: String,
    pub owner: AccountId,
    pub vault: AccountId,
    pub exchange: AccountId,
    pub token_in: AccountId,
    pub token_out: AccountId,
    pub pool_id: u64,
    pub amount_in: U128,
    pub min_amount_out: U128,
    pub input_message: String,
    pub started: bool,
    /// `ready`, `inner_pending`, `inner_settled` or `inner_unknown`.
    /// Even `inner_settled` is not proof of output delivery or outer refund.
    pub input_state: String,
    pub inner_used: Option<U128>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct RefRouter {
    owner: AccountId,
    vault: AccountId,
    pool_id: u64,
    amount_in: u128,
    min_amount_out: u128,
    // One-shot: never automatically reset even after a refund or error.
    started: bool,
    input_state: u8, // 0 ready, 1 pending, 2 parsed inner result, 3 unknown
    inner_used: Option<u128>,
}

impl RefRouter {
    fn require_owner_zero(&self) {
        require(env::attached_deposit() == ZERO && env::predecessor_account_id() == self.owner && env::signer_account_id() == self.owner,
            "sweep requires the owner account and zero deposit");
    }
    fn require_owner_yocto(&self) {
        require(env::attached_deposit() == ONE_YOCTO, "owner-only method requires exactly 1 yoctoNEAR");
        require(env::predecessor_account_id() == self.owner, "owner-only method requires the owner");
    }
    fn transfer_to_vault(&self, token: AccountId, amount: U128) -> Promise {
        require(amount.0 > 0, "amount must be positive");
        ext_ft::ext(token).with_attached_deposit(ONE_YOCTO).with_static_gas(GAS_FOR_TRANSFER_CALL)
            .ft_transfer_call(self.vault.clone(), amount, Some("bouncer:ref-sweep".into()), OUTPUT_MESSAGE.into())
    }
}

#[near]
impl RefRouter {
    /// Deploy and initialize from the router account itself, preferably in one
    /// transaction. The route is immutable; make a new adapter for a new trade.
    #[init]
    pub fn new(owner: AccountId, vault: AccountId, pool_id: u64, amount_in: U128, min_amount_out: U128) -> Self {
        let current = env::current_account_id();
        require(env::predecessor_account_id() == current, "only the router account can initialize");
        require(named_testnet(&current) && named_testnet(&owner) && named_testnet(&vault), "named testnet accounts required");
        require(owner != vault && current != owner && current != vault, "owner, vault and router must be distinct");
        require(pool_id == 1845 || pool_id == 2206, "pool is not in the bounded testnet list");
        require(amount_in.0 > 0 && amount_in.0 <= MAX_INPUT, "input exceeds the testnet bound");
        require(min_amount_out.0 > 0 && min_amount_out.0 <= MAX_MIN_OUTPUT, "minimum output exceeds the testnet bound");
        Self { owner, vault, pool_id, amount_in: amount_in.0, min_amount_out: min_amount_out.0,
            started: false, input_state: 0, inner_used: None }
    }

    pub fn contract_version(&self) -> &'static str { "bouncer-ref-router-v1" }

    pub fn get_route(&self) -> RouteView {
        let state = match self.input_state { 0 => "ready", 1 => "inner_pending", 2 => "inner_settled", _ => "inner_unknown" };
        RouteView { version: self.contract_version().into(), owner: self.owner.clone(), vault: self.vault.clone(),
            exchange: account(REF), token_in: account(INPUT), token_out: account(OUTPUT), pool_id: self.pool_id,
            amount_in: U128(self.amount_in), min_amount_out: U128(self.min_amount_out), input_message: INPUT_MESSAGE.into(),
            started: self.started, input_state: state.into(), inner_used: self.inner_used.map(U128) }
    }

    /// Only the fixed Bouncer vault can trigger the exact fixed trade. Invalid
    /// calls and later attempts return all incoming tokens unused. No raw FT
    /// balance is ever added to Bouncer's ledger here.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        if self.started || env::predecessor_account_id().as_str() != INPUT || sender_id != self.vault ||
            amount.0 != self.amount_in || msg != INPUT_MESSAGE {
            return PromiseOrValue::Value(amount);
        }
        self.started = true;
        self.input_state = 1;
        let swap_msg = near_sdk::serde_json::json!({"force": 0, "actions": [{
            "pool_id": self.pool_id, "token_in": INPUT, "token_out": OUTPUT,
            "amount_in": self.amount_in.to_string(), "min_amount_out": self.min_amount_out.to_string()
        }]}).to_string();
        env::log_str("BOUNCER ref-router one-shot input accepted; output is not yet verified");
        let promise = ext_ft::ext(account(INPUT)).with_attached_deposit(ONE_YOCTO).with_static_gas(GAS_FOR_REF_CALL)
            .ft_transfer_call(account(REF), amount, Some("bouncer:ref-router-v1".into()), swap_msg)
            .then(ext_self::ext(env::current_account_id()).with_static_gas(GAS_FOR_INPUT_CALLBACK).after_ref_input());
        PromiseOrValue::Promise(promise)
    }

    /// NEP-141's inner result is the amount USED. Return only a proven unused
    /// amount to the outer resolver. Unknown/malformed results retain the full
    /// reservation and remain one-shot; they do not authorize a retry.
    #[private]
    pub fn after_ref_input(&mut self) -> U128 {
        if !self.started || self.input_state != 1 { return U128(0); }
        let parsed = if env::promise_results_count() == 1 {
            match env::promise_result(0) {
                PromiseResult::Successful(bytes) if bytes.len() <= 80 => near_sdk::serde_json::from_slice::<U128>(&bytes).ok(),
                _ => None,
            }
        } else { None };
        match parsed {
            Some(U128(used)) if used <= self.amount_in => {
                self.inner_used = Some(used);
                self.input_state = 2;
                env::log_str(&format!("BOUNCER ref-router inner input settled; used={}; output unverified", used));
                U128(self.amount_in - used)
            }
            _ => {
                self.input_state = 3;
                env::log_str("BOUNCER ref-router input unresolved; full reservation retained");
                U128(0)
            }
        }
    }

    /// A separately scoped owner function-call key can sweep only real Circle
    /// testnet output to the immutable Bouncer vault. Verify the original swap
    /// and this transfer by receipts; an inner-settled result alone is not proof.
    #[payable]
    pub fn sweep_output(&mut self, amount: U128) -> Promise {
        self.require_owner_zero();
        require(self.started && self.input_state == 2, "original input must be reconciled before sweeping");
        self.transfer_to_vault(account(OUTPUT), amount)
    }

    /// Manual recovery only, never an automatic retry. Both allowed tokens go
    /// only to the immutable vault by transfer-call, not to an arbitrary payee.
    #[payable]
    pub fn recover_to_vault(&mut self, token: AccountId, amount: U128) -> Promise {
        self.require_owner_yocto();
        require(token.as_str() == INPUT || token.as_str() == OUTPUT, "unsupported recovery token");
        self.transfer_to_vault(token, amount)
    }

    /// If Ref retained an output after a failed plain transfer, an owner may
    /// recover Circle testnet USDC to this adapter, then transfer-call it to
    /// the vault. Inspect Ref's account and original FINAL receipts first.
    #[payable]
    pub fn recover_ref_output(&mut self, amount: U128) -> Promise {
        self.require_owner_yocto();
        require(self.started && amount.0 > 0, "original swap and positive amount required");
        ext_ref::ext(account(REF)).with_attached_deposit(ONE_YOCTO).with_static_gas(GAS_FOR_REF_WITHDRAW)
            .withdraw(account(OUTPUT), amount, Some(false))
    }

    /// Return unused native testnet NEAR only to the immutable owner, retaining
    /// storage and a small execution reserve. Never release it while the inner
    /// call is pending; this does not close an unresolved payment.
    #[payable]
    pub fn reclaim_native(&mut self, amount: U128) -> Promise {
        self.require_owner_yocto();
        require(self.input_state != 1, "inner call is still pending");
        let storage = (env::storage_usage() as u128).saturating_mul(env::storage_byte_cost().as_yoctonear());
        let free = env::account_balance().as_yoctonear().saturating_sub(storage).saturating_sub(NATIVE_RESERVE);
        require(amount.0 > 0 && amount.0 <= free, "insufficient unreserved native balance");
        Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(amount.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::{get_created_receipts, testing_env_with_promise_results, VMContextBuilder};
    use near_sdk::{testing_env, CurveType, PublicKey, VMContext};

    fn id(value: &str) -> AccountId { value.parse().unwrap() }
    fn context(predecessor: &str, signer: &str, deposit: u128) -> VMContext {
        let key = PublicKey::from_parts(CurveType::ED25519, vec![3; 32]).unwrap();
        let mut b = VMContextBuilder::new();
        b.current_account_id(id("router.testnet"))
            .predecessor_account_id(id(predecessor)).signer_account_id(id(signer)).signer_account_pk(key)
            .attached_deposit(NearToken::from_yoctonear(deposit)).prepaid_gas(Gas::from_tgas(300));
        b.build()
    }
    fn fixture() -> RefRouter {
        testing_env!(context("router.testnet", "router.testnet", 0));
        RefRouter::new(id("owner.testnet"), id("vault.testnet"), 1845, U128(100), U128(42))
    }
    fn start(router: &mut RefRouter) {
        testing_env!(context(INPUT, "owner.testnet", 0));
        drop(router.ft_on_transfer(id("vault.testnet"), U128(100), INPUT_MESSAGE.into()));
    }
    #[allow(deprecated)]
    fn callback(router: &mut RefRouter, result: PromiseResult) -> U128 {
        testing_env_with_promise_results(context("router.testnet", "owner.testnet", 0), result);
        router.after_ref_input()
    }
    fn only_call(receiver: &str, method: &str) -> (near_sdk::serde_json::Value, NearToken) {
        let receipts = get_created_receipts();
        let receipt = receipts.iter().find(|r| r.receiver_id == id(receiver)).expect("expected receiver");
        let (args, deposit) = receipt.actions.iter().find_map(|action| match action {
            MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } if method_name == method.as_bytes() => Some((args, attached_deposit)),
            _ => None,
        }).expect("expected method");
        (near_sdk::serde_json::from_slice(args).unwrap(), *deposit)
    }

    #[test]
    #[should_panic(expected = "only the router account can initialize")]
    fn outsider_cannot_front_run_initialization() {
        testing_env!(context("attacker.testnet", "attacker.testnet", 0));
        RefRouter::new(id("attacker.testnet"), id("vault.testnet"), 1845, U128(100), U128(42));
    }

    #[test]
    #[should_panic(expected = "pool is not in the bounded testnet list")]
    fn route_cannot_use_an_arbitrary_pool() {
        testing_env!(context("router.testnet", "router.testnet", 0));
        RefRouter::new(id("owner.testnet"), id("vault.testnet"), 1, U128(100), U128(42));
    }

    #[test]
    #[should_panic(expected = "input exceeds the testnet bound")]
    fn route_cannot_exceed_its_testnet_input_bound() {
        testing_env!(context("router.testnet", "router.testnet", 0));
        RefRouter::new(id("owner.testnet"), id("vault.testnet"), 1845, U128(MAX_INPUT + 1), U128(42));
    }

    #[test]
    fn only_the_exact_vault_order_starts_one_swap() {
        let mut router = fixture();
        for (predecessor, sender, amount, msg) in [
            ("other.testnet", "vault.testnet", 100, INPUT_MESSAGE),
            (INPUT, "attacker.testnet", 100, INPUT_MESSAGE),
            (INPUT, "vault.testnet", 99, INPUT_MESSAGE),
            (INPUT, "vault.testnet", 100, "changed"),
        ] {
            testing_env!(context(predecessor, "owner.testnet", 0));
            match router.ft_on_transfer(id(sender), U128(amount), msg.into()) {
                PromiseOrValue::Value(refund) => assert_eq!(refund.0, amount),
                _ => panic!("unexpected dispatch"),
            }
            assert!(!router.get_route().started);
        }
        start(&mut router);
        let (args, deposit) = only_call(INPUT, "ft_transfer_call");
        assert_eq!(deposit, ONE_YOCTO);
        assert_eq!(args["receiver_id"], REF);
        assert_eq!(args["amount"], "100");
        assert_eq!(args["memo"], "bouncer:ref-router-v1");
        let msg: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(args["msg"].as_str().unwrap()).unwrap();
        assert_eq!(msg["force"], 0);
        assert_eq!(msg["actions"].as_array().unwrap().len(), 1);
        assert_eq!(msg["actions"][0]["pool_id"], 1845);
        assert_eq!(msg["actions"][0]["token_in"], INPUT);
        assert_eq!(msg["actions"][0]["token_out"], OUTPUT);
        assert_eq!(msg["actions"][0]["amount_in"], "100");
        assert_eq!(msg["actions"][0]["min_amount_out"], "42");
        assert_eq!(router.get_route().input_state, "inner_pending");
        testing_env!(context(INPUT, "owner.testnet", 0));
        match router.ft_on_transfer(id("vault.testnet"), U128(100), INPUT_MESSAGE.into()) {
            PromiseOrValue::Value(refund) => assert_eq!(refund.0, 100),
            _ => panic!("one-shot router dispatched twice"),
        }
    }

    #[test]
    fn exact_inner_settlement_returns_only_unused_input_to_the_outer_resolver() {
        for (used, unused) in [(0, 100), (60, 40), (100, 0)] {
            let mut router = fixture(); start(&mut router);
            let result = callback(&mut router, PromiseResult::Successful(format!("\"{}\"", used).into_bytes()));
            assert_eq!(result.0, unused);
            let view = router.get_route();
            assert_eq!(view.input_state, "inner_settled");
            assert_eq!(view.inner_used.unwrap().0, used);
            // A second callback cannot release more input or reset the one-shot.
            assert_eq!(callback(&mut router, PromiseResult::Successful(b"\"0\"".to_vec())).0, 0);
            assert!(router.get_route().started);
        }
    }

    #[test]
    fn failed_malformed_or_oversized_inner_results_never_release_input_or_reset() {
        for result in [PromiseResult::Failed, PromiseResult::Successful(b"null".to_vec()),
            PromiseResult::Successful(b"60".to_vec()), PromiseResult::Successful(b"\"101\"".to_vec()),
            PromiseResult::Successful(vec![b'x'; 81])] {
            let mut router = fixture(); start(&mut router);
            assert_eq!(callback(&mut router, result).0, 0);
            let view = router.get_route();
            assert_eq!(view.input_state, "inner_unknown"); assert!(view.started); assert!(view.inner_used.is_none());
        }
    }

    #[test]
    fn scoped_sweep_moves_real_output_only_to_the_original_vault() {
        let mut router = fixture(); start(&mut router);
        assert_eq!(callback(&mut router, PromiseResult::Successful(b"\"100\"".to_vec())).0, 0);
        testing_env!(context("owner.testnet", "owner.testnet", 0));
        drop(router.sweep_output(U128(70)));
        let (args, deposit) = only_call(OUTPUT, "ft_transfer_call");
        assert_eq!(deposit, ONE_YOCTO);
        assert_eq!(args["receiver_id"], "vault.testnet");
        assert_eq!(args["amount"], "70");
        assert_eq!(args["msg"], OUTPUT_MESSAGE);
    }

    #[test]
    #[should_panic(expected = "original input must be reconciled before sweeping")]
    fn unresolved_input_blocks_the_agent_sweep() {
        let mut router = fixture(); start(&mut router);
        callback(&mut router, PromiseResult::Failed);
        testing_env!(context("owner.testnet", "owner.testnet", 0));
        drop(router.sweep_output(U128(42)));
    }

    #[test]
    #[should_panic(expected = "sweep requires the owner account and zero deposit")]
    fn unrelated_account_cannot_operate_the_sweep() {
        let mut router = fixture(); start(&mut router);
        callback(&mut router, PromiseResult::Successful(b"\"100\"".to_vec()));
        testing_env!(context("attacker.testnet", "attacker.testnet", 0));
        drop(router.sweep_output(U128(42)));
    }

    #[test]
    #[should_panic(expected = "owner-only method requires exactly 1 yoctoNEAR")]
    fn restricted_key_cannot_enable_emergency_recovery_without_the_yocto_guard() {
        let mut router = fixture();
        testing_env!(context("owner.testnet", "owner.testnet", 0));
        drop(router.recover_to_vault(id(INPUT), U128(10)));
    }

    #[test]
    fn owner_recovery_destinations_are_fixed_and_never_choose_a_payee() {
        let mut router = fixture(); start(&mut router);
        testing_env!(context("owner.testnet", "owner.testnet", 1));
        drop(router.recover_ref_output(U128(42)));
        let (args, deposit) = only_call(REF, "withdraw");
        assert_eq!(deposit, ONE_YOCTO); assert_eq!(args["token_id"], OUTPUT); assert_eq!(args["amount"], "42");
        testing_env!(context("owner.testnet", "owner.testnet", 1));
        drop(router.recover_to_vault(id(INPUT), U128(10)));
        let (args, deposit) = only_call(INPUT, "ft_transfer_call");
        assert_eq!(deposit, ONE_YOCTO); assert_eq!(args["receiver_id"], "vault.testnet");
    }

    #[test]
    #[should_panic(expected = "unsupported recovery token")]
    fn owner_cannot_recover_an_unrelated_token_through_the_adapter() {
        let mut router = fixture();
        testing_env!(context("owner.testnet", "owner.testnet", 1));
        drop(router.recover_to_vault(id("other.testnet"), U128(1)));
    }
}
