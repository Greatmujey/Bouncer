use super::*;
use near_sdk::test_utils::{get_created_receipts, testing_env_with_promise_results, VMContextBuilder};
use near_sdk::{testing_env, CurveType, PromiseResult, VMContext};
use near_sdk::mock::MockAction;

const NOW: u64 = 25 * NS_PER_HOUR;
const MEMO: &str = "ma-0123456789";
const INTENT: &str = "research-1";
fn id(value: &str) -> AccountId { value.parse().unwrap() }
fn key(byte: u8) -> PublicKey { PublicKey::from_parts(CurveType::ED25519, vec![byte; 32]).unwrap() }
fn context(predecessor: &str, signer: &str, pk: &PublicKey, deposit: u128, timestamp: u64) -> VMContext {
    let mut b = VMContextBuilder::new();
    b.current_account_id(id("vault.testnet"))
        .predecessor_account_id(id(predecessor)).signer_account_id(id(signer))
        .signer_account_pk(pk.clone()).attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(timestamp).prepaid_gas(Gas::from_tgas(300));
    b.build()
}
fn owner(deposit: u128) -> VMContext { context("owner.testnet", "owner.testnet", &key(1), deposit, NOW) }
fn agent() -> VMContext { context("owner.testnet", "owner.testnet", &key(2), 0, NOW) }
fn expiry() -> U64 { U64(NOW / 1_000_000 + 60_000) }
fn empty() -> Bouncer {
    testing_env!(owner(1));
    let mut c = Bouncer::new(id("owner.testnet"));
    c.set_policy("research".into(), id("token.testnet"), U128(200), Some(U128(300)));
    c.grant_agent_key("research".into(), key(2));
    c.allow_payee("research".into(), id("vendor.testnet"));
    c.balances.insert(id("token.testnet"), 1_000);
    c
}
fn pin(c: &mut Bouncer, intent: &str, memo: &str) {
    c.set_exact_ft_intent(intent.into(), "research".into(), id("token.testnet"), id("vendor.testnet"),
        U128(100), memo.into(), "a".repeat(64), expiry(), key(2));
}
fn fixture() -> Bouncer {
    let mut c = empty();
    c.lock_ft_policy_to_intents("research".into());
    pin(&mut c, INTENT, MEMO);
    c
}
fn execute(c: &mut Bouncer) { drop(c.execute_exact_ft(INTENT.into())); }

#[test]
fn pinned_intent_dispatches_only_reviewed_terms_once_and_reserves_budget() {
    let mut c = fixture();
    assert_eq!(c.contract_version(), "bouncer-agent-v11-exact-ft-testnet");
    assert!(c.is_exact_ft_policy_locked("research".into()));
    assert!(c.is_exact_ft_payee_locked(id("token.testnet"), id("vendor.testnet")));
    let before = c.get_exact_ft_intent(INTENT.into()).unwrap();
    assert!(before.active && !before.consumed && !before.cancelled);
    assert_eq!(before.review_hash, "a".repeat(64));
    let json = near_sdk::serde_json::to_value(&before).unwrap();
    assert_eq!(json["amount"], "100");
    assert_eq!(json["expires_at_ms"], expiry().0.to_string());
    assert_eq!(json["agent_public_key"], String::from(&key(2)));
    testing_env!(agent());
    execute(&mut c);
    let after = c.get_exact_ft_intent(INTENT.into()).unwrap();
    assert!(!after.active && after.consumed && !after.cancelled);
    assert_eq!(c.vault_balance(id("token.testnet")).0, 900);
    assert_eq!(c.daily_spent("research".into()).0, 100);
    let receipts = get_created_receipts();
    let receipt = receipts.iter().find(|r| r.receiver_id == id("token.testnet")).expect("FT receipt");
    let (args, deposit) = receipt.actions.iter().find_map(|a| match a {
        MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } if method_name == b"ft_transfer" => Some((args, attached_deposit)),
        _ => None,
    }).expect("FT transfer");
    assert_eq!(*deposit, ONE_YOCTO);
    let args: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(args).unwrap();
    assert_eq!(args["receiver_id"], "vendor.testnet");
    assert_eq!(args["amount"], "100");
    assert_eq!(args["memo"], MEMO);
    let callback = receipts.iter().find(|r| r.receiver_id == id("vault.testnet")).expect("callback");
    assert!(callback.actions.iter().any(|a| matches!(a, MockAction::FunctionCallWeight { method_name, .. } if method_name == b"after_exact_ft_transfer")));
}

#[test]
#[should_panic(expected = "exact FT intent is consumed, cancelled, expired or stale")]
fn a_second_transaction_cannot_repeat_a_consumed_intent() {
    let mut c = fixture(); testing_env!(agent()); execute(&mut c); execute(&mut c);
}

#[test]
#[allow(deprecated)]
fn failed_transfer_refunds_original_bucket_but_never_reopens_the_intent() {
    let mut c = fixture(); testing_env!(agent()); execute(&mut c);
    testing_env_with_promise_results(context("vault.testnet", "owner.testnet", &key(2), 0, NOW + NS_PER_HOUR), PromiseResult::Failed);
    c.after_exact_ft_transfer(INTENT.into(), "research".into(), id("token.testnet"), U128(100), 25, 1);
    assert_eq!(c.vault_balance(id("token.testnet")).0, 1_000);
    assert_eq!(c.daily_spent("research".into()).0, 0);
    let state = c.get_exact_ft_intent(INTENT.into()).unwrap();
    assert!(state.consumed && !state.active);
}

#[test]
#[allow(deprecated)]
fn delayed_failure_after_a_policy_revision_keeps_budget_conservative() {
    let mut c = fixture(); testing_env!(agent()); execute(&mut c);
    testing_env!(owner(1));
    c.set_policy("research".into(), id("token.testnet"), U128(200), Some(U128(300)));
    testing_env_with_promise_results(context("vault.testnet", "owner.testnet", &key(2), 0, NOW), PromiseResult::Failed);
    c.after_exact_ft_transfer(INTENT.into(), "research".into(), id("token.testnet"), U128(100), 25, 1);
    assert_eq!(c.vault_balance(id("token.testnet")).0, 1_000);
    assert_eq!(c.daily_spent("research".into()).0, 100);
    assert!(c.get_exact_ft_intent(INTENT.into()).unwrap().consumed);
}

#[test]
#[allow(deprecated)]
fn successful_callback_leaves_the_reservation_consumed() {
    let mut c = fixture(); testing_env!(agent()); execute(&mut c);
    testing_env_with_promise_results(context("vault.testnet", "owner.testnet", &key(2), 0, NOW), PromiseResult::Successful(vec![]));
    c.after_exact_ft_transfer(INTENT.into(), "research".into(), id("token.testnet"), U128(100), 25, 1);
    assert_eq!(c.vault_balance(id("token.testnet")).0, 900);
    assert_eq!(c.daily_spent("research".into()).0, 100);
    assert!(c.get_exact_ft_intent(INTENT.into()).unwrap().consumed);
}

#[test]
#[should_panic(expected = "owner-only method requires exactly 1 yoctoNEAR")]
fn zero_deposit_agent_cannot_create_an_intent() {
    let mut c = fixture(); testing_env!(agent()); pin(&mut c, "other", "another-code");
}

#[test]
#[should_panic(expected = "ESCALATION BLOCKED: caller is not owner")]
fn stranger_cannot_create_an_intent_even_with_one_yocto() {
    let mut c = fixture(); testing_env!(context("attacker.testnet", "attacker.testnet", &key(3), 1, NOW));
    pin(&mut c, "other", "another-code");
}

#[test]
fn owner_contract_forwarding_is_trusted_not_a_proof_of_human_approval() {
    // Simulate an owner contract that attached 1 yocto to a cross-contract
    // call, originating from a different transaction signer. The guard checks
    // predecessor + deposit, not who controlled the forwarding method.
    let mut c = empty();
    testing_env!(context("owner.testnet", "requester.testnet", &key(3), 1, NOW));
    c.set_policy("forwarded".into(), id("token.testnet"), U128(5), Some(U128(7)));
    assert_eq!(c.cap_of.get("forwarded"), Some(&5));
}

#[test]
#[should_panic(expected = "owner-only method requires exactly 1 yoctoNEAR")]
fn agent_cannot_cancel_intent() { let mut c = fixture(); testing_env!(agent()); c.cancel_exact_ft_intent(INTENT.into()); }

#[test]
#[should_panic(expected = "owner-only method requires exactly 1 yoctoNEAR")]
fn agent_cannot_lock_a_policy() { let mut c = empty(); testing_env!(agent()); c.lock_ft_policy_to_intents("research".into()); }

#[test]
#[should_panic(expected = "exact FT policy must be locked first")]
fn owner_must_first_dedicate_the_policy() { let mut c = empty(); pin(&mut c, INTENT, MEMO); }

#[test]
#[should_panic(expected = "BLOCKED: execute_exact_ft requires zero deposit")]
fn exact_execution_never_accepts_an_attached_deposit() {
    let mut c = fixture(); testing_env!(context("owner.testnet", "owner.testnet", &key(2), 1, NOW)); execute(&mut c);
}

#[test]
#[should_panic(expected = "BLOCKED: caller is not the owner account")]
fn another_account_cannot_execute_even_with_the_same_signing_key() {
    let mut c = fixture(); testing_env!(context("attacker.testnet", "attacker.testnet", &key(2), 0, NOW)); execute(&mut c);
}

#[test]
#[should_panic(expected = "BLOCKED: wrong exact FT agent key")]
fn different_agent_cannot_execute_the_intent() {
    let mut c = fixture(); testing_env!(context("owner.testnet", "owner.testnet", &key(3), 0, NOW)); execute(&mut c);
}

#[test]
#[should_panic(expected = "BLOCKED: unknown exact FT intent")]
fn missing_id_cannot_trigger_a_transfer() { let mut c = fixture(); testing_env!(agent()); drop(c.execute_exact_ft("wrong".into())); }

#[test]
#[should_panic(expected = "BLOCKED: policy requires exact FT intents")]
fn locked_policy_cannot_use_unrestricted_execute() {
    let mut c = fixture(); testing_env!(agent());
    drop(c.execute("research".into(), id("vendor.testnet"), U128(100), Some("arbitrary".into()), id("token.testnet")));
}

#[test]
#[should_panic(expected = "BLOCKED: token and payee require exact FT intents")]
fn another_policy_cannot_send_a_containing_memo_to_the_reserved_token_and_payee() {
    let mut c = fixture(); testing_env!(owner(1));
    c.set_policy("legacy".into(), id("token.testnet"), U128(200), Some(U128(300)));
    c.grant_agent_key("legacy".into(), key(2)); c.allow_payee("legacy".into(), id("vendor.testnet"));
    testing_env!(agent());
    drop(c.execute("legacy".into(), id("vendor.testnet"), U128(100), Some(format!("prefix-{}-suffix", MEMO)), id("token.testnet")));
}

#[test]
#[should_panic(expected = "BLOCKED: policy requires exact FT intents")]
fn locked_policy_cannot_use_a_pinned_ft_transfer_call_either() {
    let mut c = fixture(); testing_env!(owner(1));
    c.set_ft_call_message("research".into(), id("vendor.testnet"), "{}".into());
    testing_env!(agent());
    drop(c.execute_ft_call("research".into(), id("vendor.testnet"), U128(100), id("token.testnet"), "{}".into(), 1, 1));
}

#[test]
#[should_panic(expected = "BLOCKED: token and payee require exact FT intents")]
fn another_policy_cannot_transfer_call_to_the_reserved_token_and_payee() {
    let mut c = fixture(); testing_env!(owner(1));
    c.set_policy("legacy".into(), id("token.testnet"), U128(200), Some(U128(300)));
    c.grant_agent_key("legacy".into(), key(2)); c.allow_payee("legacy".into(), id("vendor.testnet"));
    c.set_ft_call_message("legacy".into(), id("vendor.testnet"), "{}".into());
    testing_env!(agent());
    drop(c.execute_ft_call("legacy".into(), id("vendor.testnet"), U128(100), id("token.testnet"), "{}".into(), 1, 1));
}

#[test]
#[should_panic(expected = "token, payee and memo already reserved")]
fn the_same_memo_cannot_be_pinned_under_another_intent_or_amount() {
    let mut c = fixture();
    c.set_exact_ft_intent("second".into(), "research".into(), id("token.testnet"), id("vendor.testnet"),
        U128(50), MEMO.into(), "b".repeat(64), expiry(), key(2));
}

#[test]
#[should_panic(expected = "exact FT intent ID already reserved")]
fn cancelled_intent_ids_are_never_reused() {
    let mut c = fixture(); c.cancel_exact_ft_intent(INTENT.into()); pin(&mut c, INTENT, "new-code");
}

#[test]
#[should_panic(expected = "token, payee and memo already reserved")]
fn cancelled_memos_are_never_reused() {
    let mut c = fixture(); c.cancel_exact_ft_intent(INTENT.into()); pin(&mut c, "new-id", MEMO);
}

#[test]
fn policy_payee_and_key_changes_each_make_a_pinned_intent_stale() {
    let mut c = fixture();
    c.set_policy("research".into(), id("token.testnet"), U128(200), Some(U128(300)));
    assert!(!c.get_exact_ft_intent(INTENT.into()).unwrap().active);
    pin(&mut c, "payee-change", "new-one");
    c.revoke_payee("research".into(), id("vendor.testnet"));
    c.allow_payee("research".into(), id("vendor.testnet"));
    assert!(!c.get_exact_ft_intent("payee-change".into()).unwrap().active);
    pin(&mut c, "key-change", "new-two");
    c.revoke_agent_key("research".into(), key(2));
    c.grant_agent_key("research".into(), key(2));
    assert!(!c.get_exact_ft_intent("key-change".into()).unwrap().active);
}

#[test]
#[should_panic(expected = "exact FT intent is consumed, cancelled, expired or stale")]
fn expired_intent_cannot_execute() {
    let mut c = fixture(); testing_env!(context("owner.testnet", "owner.testnet", &key(2), 0, NOW + 60_000_000_000)); execute(&mut c);
}

#[test]
#[should_panic(expected = "locked exact FT policy cannot become native")]
fn locked_ft_policy_cannot_be_converted_to_native() {
    let mut c = fixture(); c.set_policy("research".into(), id("native"), U128(200), Some(U128(300)));
}

#[test]
#[should_panic(expected = "invalid exact FT expiry")]
fn owner_cannot_pin_an_unbounded_expiry() {
    let mut c = empty(); c.lock_ft_policy_to_intents("research".into());
    c.set_exact_ft_intent(INTENT.into(), "research".into(), id("token.testnet"), id("vendor.testnet"),
        U128(100), MEMO.into(), "a".repeat(64), U64(NOW / 1_000_000 + MAX_EXACT_FT_EXPIRY_MS + 1), key(2));
}

#[test]
#[should_panic(expected = "invalid exact FT memo")]
fn internal_or_nonprintable_memos_cannot_be_reserved() {
    let mut c = empty(); c.lock_ft_policy_to_intents("research".into()); pin(&mut c, INTENT, "bouncer:withdraw");
}

#[test]
#[should_panic(expected = "exact FT amount exceeds policy cap or is zero")]
fn pinning_cannot_exceed_the_existing_cap() {
    let mut c = empty(); c.lock_ft_policy_to_intents("research".into());
    c.set_exact_ft_intent(INTENT.into(), "research".into(), id("token.testnet"), id("vendor.testnet"),
        U128(201), MEMO.into(), "a".repeat(64), expiry(), key(2));
}

#[test]
#[should_panic(expected = "BLOCKED: daily cap exceeded for this policy")]
fn multiple_pinned_intents_still_share_the_existing_rolling_budget() {
    let mut c = fixture(); pin(&mut c, "two", "code-two"); pin(&mut c, "three", "code-three"); pin(&mut c, "four", "code-four");
    testing_env!(agent());
    execute(&mut c); drop(c.execute_exact_ft("two".into())); drop(c.execute_exact_ft("three".into())); drop(c.execute_exact_ft("four".into()));
}

#[test]
#[should_panic(expected = "token, payee and memo already reserved")]
fn another_exact_policy_cannot_reserve_the_same_token_payee_and_memo() {
    let mut c = fixture();
    c.set_policy("other-policy".into(), id("token.testnet"), U128(200), Some(U128(300)));
    c.allow_payee("other-policy".into(), id("vendor.testnet"));
    c.grant_agent_key("other-policy".into(), key(2));
    c.lock_ft_policy_to_intents("other-policy".into());
    c.set_exact_ft_intent("other-id".into(), "other-policy".into(), id("token.testnet"), id("vendor.testnet"),
        U128(100), MEMO.into(), "b".repeat(64), expiry(), key(2));
}

#[test]
fn locking_one_token_payee_pair_does_not_block_an_unrelated_pair() {
    let mut c = fixture();
    c.set_policy("other-policy".into(), id("other-token.testnet"), U128(200), Some(U128(300)));
    c.allow_payee("other-policy".into(), id("vendor.testnet"));
    c.grant_agent_key("other-policy".into(), key(2));
    c.balances.insert(id("other-token.testnet"), 1_000);
    testing_env!(agent());
    drop(c.execute("other-policy".into(), id("vendor.testnet"), U128(100), Some("other".into()), id("other-token.testnet")));
    assert_eq!(c.vault_balance(id("other-token.testnet")).0, 900);
    assert!(!c.get_exact_ft_intent(INTENT.into()).unwrap().consumed);
}

#[test]
#[should_panic(expected = "BLOCKED: policy requires exact FT intents")]
fn a_locked_ft_policy_cannot_be_used_for_an_outlayer_prepaid_project() {
    let mut c = fixture();
    c.set_policy("native-project".into(), id(NATIVE_ASSET), U128(200), Some(U128(300)));
    c.allow_payee("native-project".into(), id(OUTLAYER_TESTNET));
    c.grant_agent_key("native-project".into(), key(2));
    c.allow_payee("research".into(), id(OUTLAYER_TESTNET));
    c.native_balance = 500;
    c.outlayer_prepaid.insert(id("token.testnet"), 100);
    let project = OutlayerProject { project_id: "connectors.outlayer.testnet/connector-probe".into(), version_key: "a".repeat(64),
        usd_policy_id: "research".into(), token: id("token.testnet"), attached_usd: U128(30),
        input_data: r#"{"operation":"fetch"}"#.into(), max_instructions: 100_000_000,
        max_memory_mb: 256, max_execution_seconds: 60 };
    c.set_outlayer_project("native-project".into(), project);
    let route = c.get_outlayer_project("native-project".into()).unwrap();
    assert!(route.active);
    testing_env!(agent());
    drop(c.execute_outlayer_project("native-project".into(), U128(100), route));
}
