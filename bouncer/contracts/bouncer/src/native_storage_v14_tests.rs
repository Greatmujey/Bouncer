// Unit tests for the experimental native storage contract. No chain calls.
use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, CurveType, VMContext};

const N: u128 = 1_000_000_000_000_000_000_000_000;
fn id(s: &str) -> AccountId { s.parse().unwrap() }
fn key(b: u8) -> PublicKey { PublicKey::from_parts(CurveType::ED25519, vec![b; 32]).unwrap() }
fn context(signer: &str, predecessor: &str, pk: &PublicKey, deposit: u128, balance: u128) -> VMContext {
    let mut b = VMContextBuilder::new();
    b.current_account_id(id("vault.testnet")).predecessor_account_id(id(predecessor))
        .signer_account_id(id(signer)).signer_account_pk(pk.clone()).attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_yoctonear(balance)).block_timestamp(NS_PER_DAY).prepaid_gas(Gas::from_tgas(300));
    b.build()
}
fn fixture() -> (Bouncer, PublicKey, super::native_storage_v14::NativeStorageRoute) {
    let agent = key(2);
    testing_env!(context("owner.testnet", "owner.testnet", &key(1), 1, 100 * N));
    let mut b = Bouncer::new(id("owner.testnet"));
    b.set_policy("store".into(), id("native"), U128(N / 10), Some(U128(N / 5)));
    b.allow_payee("store".into(), id("vault.testnet"));
    b.grant_agent_key("store".into(), agent.clone());
    b.set_native_storage_route("store".into(), "mission-".into(), 128);
    let route = b.get_native_storage_route("store".into()).unwrap();
    testing_env!(context("owner.testnet", "owner.testnet", &key(1), N, 100 * N));
    b.deposit_native();
    testing_env!(context("owner.testnet", "owner.testnet", &agent, 0, 100 * N));
    (b, agent, route)
}
fn put(b: &mut Bouncer, route: &super::native_storage_v14::NativeStorageRoute, id: &str, value: &str) -> super::native_storage_v14::NativeStorageObject {
    b.execute_native_storage("store".into(), U128(N / 10), id.into(), value.into(), route.clone())
}

#[test]
fn writes_readable_public_object_and_charges_only_actual_stake() {
    let (mut b, _, route) = fixture();
    let object = put(&mut b, &route, "mission-a", "hello NEAR");
    assert_eq!(object.value, "hello NEAR");
    assert_eq!(object.value_bytes, 10);
    assert_eq!(object.value_sha256, "33b88705e8838920d0fafedb440a11e768ea6dbc16a44e0ff37a730af4879309");
    assert!(object.stake_yocto.0 > 0 && object.stake_yocto.0 <= N / 10);
    assert_eq!(b.vault_balance(id("native")).0, N - object.stake_yocto.0);
    assert_eq!(b.daily_spent("store".into()).0, object.stake_yocto.0);
    let read = b.get_native_storage_object("store".into(), "mission-a".into()).unwrap();
    assert_eq!(read.value, object.value);
    assert_eq!(read.value_sha256, object.value_sha256);
    assert_eq!(read.stake_yocto.0, object.stake_yocto.0);
    assert!(near_sdk::test_utils::get_created_receipts().is_empty());
}

#[test]
fn owner_release_refunds_only_freed_stake_and_keeps_rolling_spend() {
    let (mut b, _, route) = fixture();
    let object = put(&mut b, &route, "mission-release", "public content");
    testing_env!(context("owner.testnet", "owner.testnet", &key(1), 1, 100 * N));
    let refund = b.release_native_storage("store".into(), "mission-release".into(), object.value_sha256);
    assert!(refund.refunded_to_vault_yocto.0 > 0);
    assert!(refund.permanently_reserved_yocto.0 > 0);
    assert_eq!(refund.refunded_to_vault_yocto.0 + refund.permanently_reserved_yocto.0, object.stake_yocto.0);
    assert_eq!(b.vault_balance(id("native")).0, N - refund.permanently_reserved_yocto.0);
    assert_eq!(b.daily_spent("store".into()).0, object.stake_yocto.0);
    assert!(b.get_native_storage_object("store".into(), "mission-release".into()).is_none());
}

#[test]
#[should_panic(expected = "storage object ID already reserved")]
fn released_id_is_never_reusable() {
    let (mut b, agent, route) = fixture();
    let object = put(&mut b, &route, "mission-once", "first");
    testing_env!(context("owner.testnet", "owner.testnet", &key(1), 1, 100 * N));
    b.release_native_storage("store".into(), "mission-once".into(), object.value_sha256);
    testing_env!(context("owner.testnet", "owner.testnet", &agent, 0, 100 * N));
    put(&mut b, &route, "mission-once", "second");
}

#[test]
#[should_panic(expected = "owner-only method requires exactly 1 yoctoNEAR")]
fn agent_cannot_release_or_escalate() {
    let (mut b, _, route) = fixture();
    let object = put(&mut b, &route, "mission-a", "public");
    b.release_native_storage("store".into(), "mission-a".into(), object.value_sha256);
}

#[test]
#[should_panic(expected = "storage route changed since review")]
fn policy_edit_invalidates_old_route() {
    let (mut b, agent, route) = fixture();
    testing_env!(context("owner.testnet", "owner.testnet", &key(1), 1, 100 * N));
    b.set_policy("store".into(), id("native"), U128(N / 10), Some(U128(N / 5)));
    assert!(!b.get_native_storage_route("store".into()).unwrap().active);
    testing_env!(context("owner.testnet", "owner.testnet", &agent, 0, 100 * N));
    put(&mut b, &route, "mission-a", "public");
}

#[test]
#[should_panic(expected = "storage route changed since review")]
fn allowlist_revoke_and_readd_does_not_revive_route() {
    let (mut b, agent, route) = fixture();
    testing_env!(context("owner.testnet", "owner.testnet", &key(1), 1, 100 * N));
    b.revoke_payee("store".into(), id("vault.testnet"));
    b.allow_payee("store".into(), id("vault.testnet"));
    testing_env!(context("owner.testnet", "owner.testnet", &agent, 0, 100 * N));
    put(&mut b, &route, "mission-a", "public");
}

#[test]
#[should_panic(expected = "storage route changed since review")]
fn clear_and_repin_does_not_revive_old_route() {
    let (mut b, agent, route) = fixture();
    testing_env!(context("owner.testnet", "owner.testnet", &key(1), 1, 100 * N));
    b.clear_native_storage_route("store".into());
    b.set_native_storage_route("store".into(), "mission-".into(), 128);
    assert!(b.get_native_storage_route("store".into()).unwrap().route_revision > route.route_revision);
    testing_env!(context("owner.testnet", "owner.testnet", &agent, 0, 100 * N));
    put(&mut b, &route, "mission-a", "public");
}

#[test]
#[should_panic(expected = "signing key is not authorized")]
fn unknown_key_cannot_store() {
    let (mut b, _, route) = fixture();
    testing_env!(context("owner.testnet", "owner.testnet", &key(3), 0, 100 * N));
    put(&mut b, &route, "mission-a", "public");
}

#[test]
#[should_panic(expected = "storage requires zero deposit")]
fn agent_must_attach_zero() {
    let (mut b, agent, route) = fixture();
    testing_env!(context("owner.testnet", "owner.testnet", &agent, 1, 100 * N));
    put(&mut b, &route, "mission-a", "public");
}

#[test]
#[should_panic(expected = "storage object ID outside route")]
fn object_outside_prefix_is_blocked() {
    let (mut b, _, route) = fixture();
    put(&mut b, &route, "other-a", "public");
}

#[test]
#[should_panic(expected = "storage value exceeds route")]
fn value_size_is_utf8_bytes_not_characters() {
    let (mut b, _, route) = fixture();
    put(&mut b, &route, "mission-a", &"🦀".repeat(33));
}

#[test]
#[should_panic(expected = "amount exceeds per-tx cap")]
fn worst_case_is_subject_to_cap() {
    let (mut b, _, route) = fixture();
    b.execute_native_storage("store".into(), U128(N / 10 + 1), "mission-a".into(), "public".into(), route);
}

#[test]
#[should_panic(expected = "daily cap exceeded")]
fn rolling_budget_cannot_be_bypassed() {
    let (mut b, _, route) = fixture();
    b.daily_spent.insert(daily_key("store", NS_PER_DAY / NS_PER_HOUR), N / 5 - N / 10 + 1);
    put(&mut b, &route, "mission-a", "public");
}

#[test]
#[should_panic(expected = "storage stake exceeds reviewed maximum")]
fn actual_stake_cannot_exceed_signed_maximum() {
    let (mut b, _, route) = fixture();
    b.execute_native_storage("store".into(), U128(1), "mission-a".into(), "public".into(), route);
}

#[test]
#[should_panic(expected = "vault needs storage and operational reserve")]
fn cannot_consume_the_vaults_operational_reserve() {
    let (mut b, agent, route) = fixture();
    testing_env!(context("owner.testnet", "owner.testnet", &agent, 0, N));
    put(&mut b, &route, "mission-a", "public");
}
