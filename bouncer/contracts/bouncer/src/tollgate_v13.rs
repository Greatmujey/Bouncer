//! Experimental fresh-state V13 native-NEAR channel adapter, testnet only.
//! It is not deployed, audited, an FT purchase, or proof of HTTP delivery.
//! A Tollgate voucher is not resource-bound. Open reserves the whole attached
//! budget; detached channel refunds do not automatically credit this ledger.
use super::*;
use near_sdk::CurveType;

const CHANNEL: &str = "channels.tollgate-busel.testnet";
const SELLER: &str = "seller.tollgate-busel.testnet";
const GAS_OPEN: Gas = Gas::from_tgas(45);
const GAS_CLOSE: Gas = Gas::from_tgas(30);

#[ext_contract(ext_tollgate_self)]
trait ExtTollgateSelf {
    fn after_tollgate_open(&mut self, intent_id: String) -> Option<U64>;
    fn after_tollgate_recovery(&mut self, intent_id: String, candidate_id: U64, generation: U64) -> Option<U64>;
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub(super) struct TollgateIntent {
    policy_id: String,
    amount: u128,
    agent_public_key: PublicKey,
    voucher_public_key: PublicKey,
    review_hash: String,
    expires_at_ms: u64,
    channel_lifetime_sec: u64,
    dispute_window_sec: u64,
    policy_revision: u64,
    contract_revision: u64,
    seller_revision: u64,
    agent_revision: u64,
    consumed: bool,
    cancelled: bool,
    callback_recorded: bool,
    promise_failed: bool,
    recovering: bool,
    recovery_generation: u64,
    channel_verified: bool,
    channel_id: Option<u64>,
}

#[derive(near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct ChannelRecoveryView {
    channel_id: U64,
    owner: AccountId,
    seller: AccountId,
    agent_pubkey: PublicKey,
    deposit: U128,
    storage_fee: U128,
    status: String,
}

#[derive(near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct TollgateIntentView {
    pub intent_id: String,
    pub policy_id: String,
    pub channel_contract: AccountId,
    pub seller: AccountId,
    pub amount: U128,
    pub agent_public_key: PublicKey,
    pub voucher_public_key: PublicKey,
    pub review_hash: String,
    pub expires_at_ms: U64,
    pub channel_lifetime_sec: U64,
    pub dispute_window_sec: U64,
    pub policy_revision: u64,
    pub contract_revision: u64,
    pub seller_revision: u64,
    pub agent_revision: u64,
    pub consumed: bool,
    pub cancelled: bool,
    pub callback_recorded: bool,
    pub promise_failed: bool,
    pub recovering: bool,
    pub recovery_generation: U64,
    pub channel_verified: bool,
    pub channel_id: Option<U64>,
    pub active: bool,
}

fn channel_id() -> AccountId { CHANNEL.parse().unwrap_or_else(|_| abort_with("invalid channel constant")) }
fn seller_id() -> AccountId { SELLER.parse().unwrap_or_else(|_| abort_with("invalid seller constant")) }
// Shared by opening and the cooperative voucher client. This view cannot
// revoke a voucher already signed: the provider contract has its own key and
// the entire channel deposit remains at risk until closure.
fn authorization_current(s: &Bouncer, i: &TollgateIntent) -> bool {
    let channel = channel_id();
    let seller = seller_id();
    let agent = (i.policy_id.clone(), i.agent_public_key.clone());
    !i.cancelled && env::block_timestamp() / 1_000_000 < i.expires_at_ms &&
        s.token_of.get(&i.policy_id).map(|t| t.as_str()) == Some(NATIVE_ASSET) &&
        s.ft_policy_revisions.get(&i.policy_id) == Some(&i.policy_revision) &&
        s.allow.get(&allow_key(&i.policy_id, channel.as_str())) == Some(&true) &&
        s.allow.get(&allow_key(&i.policy_id, seller.as_str())) == Some(&true) &&
        s.allow_revisions.get(&(i.policy_id.clone(), channel)) == Some(&i.contract_revision) &&
        s.allow_revisions.get(&(i.policy_id.clone(), seller)) == Some(&i.seller_revision) &&
        s.agents.get(&agent) == Some(&true) && s.exact_agent_revisions.get(&agent) == Some(&i.agent_revision)
}
fn active(s: &Bouncer, i: &TollgateIntent) -> bool {
    !i.consumed && authorization_current(s, i)
}

#[near]
impl Bouncer {
    /// Pin a single channel opening and exact voucher public key under the
    /// 1-yocto owner guard. Both destination contract and seller must already
    /// be allowlisted. IDs and voucher keys stay reserved on failure/cancel.
    #[payable]
    pub fn set_tollgate_intent(&mut self, intent_id: String, policy_id: String, amount: U128,
        agent_public_key: PublicKey, voucher_public_key: PublicKey, review_hash: String,
        expires_at_ms: U64, channel_lifetime_sec: U64, dispute_window_sec: U64) {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        require(env::current_account_id().as_str().ends_with(".testnet") && self.owner.as_str().ends_with(".testnet"),
            "testnet-named vault and owner required");
        require(!intent_id.is_empty() && intent_id.len() <= 64 && intent_id.bytes().all(|b|
            b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-')), "invalid Tollgate intent ID");
        require(!self.tollgate_intents.contains_key(&intent_id), "Tollgate intent ID already reserved");
        require(voucher_public_key.curve_type() == CurveType::ED25519 && voucher_public_key != agent_public_key &&
            voucher_public_key != env::signer_account_pk(), "dedicated ed25519 voucher key required");
        require(!self.tollgate_voucher_keys.contains_key(&voucher_public_key), "voucher key already reserved");
        require(review_hash.len() == 64 && review_hash.bytes().all(|b|
            (b'0'..=b'9').contains(&b) || (b'a'..=b'f').contains(&b)), "invalid Tollgate review hash");
        let now = env::block_timestamp() / 1_000_000;
        require(expires_at_ms.0 > now && expires_at_ms.0 <= now.saturating_add(MAX_EXACT_FT_EXPIRY_MS),
            "invalid Tollgate intent expiry");
        require((180..=86_400).contains(&channel_lifetime_sec.0) && (15..=300).contains(&dispute_window_sec.0) &&
            channel_lifetime_sec.0 > dispute_window_sec.0.saturating_add(120), "invalid channel lifetime or dispute window");
        require(self.token_of.get(&policy_id).map(|t| t.as_str()) == Some(NATIVE_ASSET), "Tollgate policy must use native NEAR");
        require(amount.0 > 0 && amount.0 <= self.cap_of.get(&policy_id).copied().unwrap_or(0), "Tollgate amount exceeds cap or is zero");
        let channel = channel_id(); let seller = seller_id();
        require(self.allow.get(&allow_key(&policy_id, channel.as_str())) == Some(&true) &&
            self.allow.get(&allow_key(&policy_id, seller.as_str())) == Some(&true), "channel contract and seller must be allowed");
        let agent = (policy_id.clone(), agent_public_key.clone());
        require(self.agents.get(&agent) == Some(&true), "agent key must already be granted");
        let policy_revision = self.ft_policy_revisions.get(&policy_id).copied().unwrap_or_else(|| abort_with("missing policy revision"));
        let contract_revision = self.allow_revisions.get(&(policy_id.clone(), channel)).copied().unwrap_or_else(|| abort_with("missing channel revision"));
        let seller_revision = self.allow_revisions.get(&(policy_id.clone(), seller)).copied().unwrap_or_else(|| abort_with("missing seller revision"));
        let agent_revision = self.exact_agent_revisions.get(&agent).copied().unwrap_or_else(|| abort_with("missing agent revision"));
        self.tollgate_voucher_keys.insert(voucher_public_key.clone(), true);
        self.tollgate_intents.insert(intent_id, TollgateIntent { policy_id, amount: amount.0, agent_public_key,
            voucher_public_key, review_hash, expires_at_ms: expires_at_ms.0, channel_lifetime_sec: channel_lifetime_sec.0,
            dispute_window_sec: dispute_window_sec.0, policy_revision, contract_revision, seller_revision,
            agent_revision, consumed: false, cancelled: false, callback_recorded: false, promise_failed: false, recovering: false, recovery_generation: 0, channel_verified: false, channel_id: None });
        env::log_str("BOUNCER testnet native channel intent pinned; no payment or voucher");
    }

    #[payable]
    pub fn cancel_tollgate_intent(&mut self, intent_id: String) {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        let mut intent = self.tollgate_intents.get(&intent_id).cloned().unwrap_or_else(|| abort_with("unknown Tollgate intent"));
        require(!intent.consumed && !intent.cancelled, "Tollgate intent already consumed or cancelled");
        intent.cancelled = true; self.tollgate_intents.insert(intent_id, intent);
    }

    pub fn get_tollgate_intent(&self, intent_id: String) -> Option<TollgateIntentView> {
        let i = self.tollgate_intents.get(&intent_id)?;
        Some(TollgateIntentView { intent_id, policy_id: i.policy_id.clone(), channel_contract: channel_id(), seller: seller_id(),
            amount: U128(i.amount), agent_public_key: i.agent_public_key.clone(), voucher_public_key: i.voucher_public_key.clone(),
            review_hash: i.review_hash.clone(), expires_at_ms: U64(i.expires_at_ms), channel_lifetime_sec: U64(i.channel_lifetime_sec),
            dispute_window_sec: U64(i.dispute_window_sec), policy_revision: i.policy_revision, contract_revision: i.contract_revision,
            seller_revision: i.seller_revision, agent_revision: i.agent_revision, consumed: i.consumed, cancelled: i.cancelled,
            callback_recorded: i.callback_recorded, promise_failed: i.promise_failed, recovering: i.recovering, recovery_generation: U64(i.recovery_generation), channel_verified: i.channel_verified, channel_id: i.channel_id.map(U64), active: active(self, i) })
    }

    /// Advisory gate for a cooperative off-chain voucher client after opening.
    /// Every original policy, allowlist and agent revision must still match,
    /// the intent must be unexpired, and the owner must have verified the
    /// channel. This view cannot stop a stolen key or an already issued voucher
    /// and cannot eliminate a change between a view and an HTTP request.
    pub fn is_tollgate_voucher_authorized(&self, intent_id: String) -> bool {
        match self.tollgate_intents.get(&intent_id) {
            Some(i) => i.consumed && i.callback_recorded && !i.promise_failed && !i.recovering &&
                i.channel_verified && i.channel_id.is_some() && authorization_current(self, i),
            None => false,
        }
    }

    /// Consume once before dispatch. The agent cannot choose destination,
    /// amount, voucher key, lifetime or seller. Full channel budget and storage
    /// cost count against the native policy; no Circle tokens are involved.
    #[payable]
    pub fn execute_tollgate_intent(&mut self, intent_id: String) -> Promise {
        require(env::attached_deposit() == ZERO_NEAR, "BLOCKED: Tollgate execution requires zero deposit");
        require(env::predecessor_account_id() == self.owner && env::signer_account_id() == self.owner,
            "BLOCKED: caller is not the owner account");
        let mut i = self.tollgate_intents.get(&intent_id).cloned().unwrap_or_else(|| abort_with("BLOCKED: unknown Tollgate intent"));
        require(env::signer_account_pk() == i.agent_public_key && active(self, &i), "BLOCKED: Tollgate intent is unauthorized, consumed, expired or stale");
        let (token, balance) = validate(self, &i.policy_id, &channel_id(), i.amount).unwrap_or_else(|m| abort_with(&m));
        require(token.as_str() == NATIVE_ASSET, "BLOCKED: Tollgate policy token changed");
        // The tracked ledger must also fit the actual liquid account after
        // retaining storage and a gas reserve, including unrelated donations.
        let storage = (env::storage_usage() as u128).saturating_mul(env::storage_byte_cost().as_yoctonear());
        let liquid = env::account_balance().as_yoctonear().saturating_sub(storage).saturating_sub(NATIVE_SURPLUS_RESERVE);
        require(balance <= liquid, "BLOCKED: native ledger exceeds liquid account reserve");
        let bucket = env::block_timestamp() / NS_PER_HOUR;
        let dk = daily_key(&i.policy_id, bucket);
        let next = self.daily_spent.get(&dk).copied().unwrap_or(0).checked_add(i.amount)
            .unwrap_or_else(|| abort_with("daily spend overflow"));
        i.consumed = true;
        self.tollgate_intents.insert(intent_id.clone(), i.clone());
        self.native_balance = balance - i.amount;
        self.daily_spent.insert(dk, next);
        let args = near_sdk::serde_json::json!({"seller": seller_id(), "agent_pubkey": i.voucher_public_key,
            "expires_in_sec": U64(i.channel_lifetime_sec), "dispute_window_sec": U64(i.dispute_window_sec)});
        env::log_str("BOUNCER testnet native channel opening initiated; full budget reserved");
        Promise::new(channel_id()).function_call("open_channel", args.to_string().into_bytes(),
            NearToken::from_yoctonear(i.amount), GAS_OPEN)
            .then(ext_tollgate_self::ext(env::current_account_id()).with_static_gas(GAS_FOR_RESOLVE)
                .after_tollgate_open(intent_id))
    }

    /// A failed promise can be a downstream failure after the provider has
    /// accepted funds, so it is NOT proof of a refund. Failed or malformed
    /// results keep the full reservation; the intent and key remain consumed.
    #[private]
    pub fn after_tollgate_open(&mut self, intent_id: String) -> Option<U64> {
        let mut i = self.tollgate_intents.get(&intent_id).cloned().unwrap_or_else(|| abort_with("unknown Tollgate intent"));
        require(i.consumed && !i.callback_recorded, "Tollgate callback already recorded or not pending");
        i.callback_recorded = true;
        match env::promise_result(0) {
            near_sdk::PromiseResult::Failed => {
                i.promise_failed = true;
                env::log_str("BOUNCER channel promise failed; full reservation retained, reconcile actual refund");
            }
            near_sdk::PromiseResult::Successful(bytes) => {
                let reported = if bytes.len() <= 128 {
                    near_sdk::serde_json::from_slice::<U64>(&bytes).ok().map(|v| v.0).filter(|v| *v <= u32::MAX as u64)
                } else { None };
                // A recovery callback can win the race; never overwrite its
                // already verified channel ID with a late or malformed return.
                if !i.channel_verified { i.channel_id = reported; }
                if i.channel_id.is_none() { env::log_str("BOUNCER channel result unknown; full reservation retained"); }
            }
        }
        let result = i.channel_id.map(U64); self.tollgate_intents.insert(intent_id, i); result
    }

    /// Check a candidate channel against the provider's current view before
    /// allowing close. This also recovers an ID after a missing/failed callback.
    /// Only the owner can request it; retrying this zero-value view moves no
    /// funds. A provider that can upgrade can still lie, so this is not proof.
    #[payable]
    pub fn verify_tollgate_channel(&mut self, intent_id: String, candidate_id: U64) -> Promise {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        require(candidate_id.0 <= u32::MAX as u64, "invalid Tollgate channel ID");
        let mut i = self.tollgate_intents.get(&intent_id).cloned().unwrap_or_else(|| abort_with("unknown Tollgate intent"));
        require(i.consumed && !i.recovering && !i.channel_verified, "Tollgate channel already verified or recovery pending");
        i.recovery_generation = i.recovery_generation.checked_add(1).unwrap_or_else(|| abort_with("recovery generation overflow"));
        let generation = i.recovery_generation;
        i.recovering = true;
        self.tollgate_intents.insert(intent_id.clone(), i);
        let args = near_sdk::serde_json::json!({"channel_id": candidate_id});
        Promise::new(channel_id()).function_call("get_channel", args.to_string().into_bytes(), ZERO_NEAR, GAS_CLOSE)
            .then(ext_tollgate_self::ext(env::current_account_id()).with_static_gas(GAS_FOR_RESOLVE)
                .after_tollgate_recovery(intent_id, candidate_id, U64(generation)))
    }

    /// Owner can recover from a lost view callback without moving funds. The
    /// generation invalidates a late callback from the previous attempt.
    #[payable]
    pub fn reset_tollgate_verification(&mut self, intent_id: String) {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        let mut i = self.tollgate_intents.get(&intent_id).cloned().unwrap_or_else(|| abort_with("unknown Tollgate intent"));
        require(i.consumed && i.recovering && !i.channel_verified, "Tollgate verification is not pending");
        i.recovery_generation = i.recovery_generation.checked_add(1).unwrap_or_else(|| abort_with("recovery generation overflow"));
        i.recovering = false;
        self.tollgate_intents.insert(intent_id, i);
    }

    #[private]
    pub fn after_tollgate_recovery(&mut self, intent_id: String, candidate_id: U64, generation: U64) -> Option<U64> {
        let mut i = self.tollgate_intents.get(&intent_id).cloned().unwrap_or_else(|| abort_with("unknown Tollgate intent"));
        // Ignore a callback from a reset or completed verification, never let
        // it clear or overwrite a newer recovery attempt.
        if !i.consumed || !i.recovering || i.channel_verified || i.recovery_generation != generation.0 { return None; }
        i.recovering = false;
        let recovered = match env::promise_result(0) {
            near_sdk::PromiseResult::Successful(bytes) if bytes.len() <= 4096 =>
                near_sdk::serde_json::from_slice::<Option<ChannelRecoveryView>>(&bytes).ok().flatten(),
            _ => None,
        };
        if let Some(c) = recovered {
            if c.channel_id.0 == candidate_id.0 && c.owner == env::current_account_id() && c.seller == seller_id() &&
                c.agent_pubkey == i.voucher_public_key && c.deposit.0.checked_add(c.storage_fee.0) == Some(i.amount) &&
                matches!(c.status.as_str(), "Open" | "Closing" | "Closed") {
                i.channel_id = Some(candidate_id.0);
                i.channel_verified = true;
            }
        }
        let result = if i.channel_verified { i.channel_id.map(U64) } else { None };
        self.tollgate_intents.insert(intent_id, i); result
    }

    /// Owner may start a unilateral close only after validating the channel.
    /// The provider may be upgraded and is trusted; this is not a refund proof.
    #[payable]
    pub fn start_tollgate_close(&mut self, intent_id: String) -> Promise {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        let i = self.tollgate_intents.get(&intent_id).unwrap_or_else(|| abort_with("unknown Tollgate intent"));
        require(i.channel_verified, "channel not verified; reconcile first");
        let id = i.channel_id.unwrap_or_else(|| abort_with("channel ID not recorded; reconcile externally"));
        let args = near_sdk::serde_json::json!({"channel_id": U64(id)});
        Promise::new(channel_id()).function_call("start_close", args.to_string().into_bytes(), ZERO_NEAR, GAS_CLOSE)
    }

    /// Finalization schedules a detached native transfer. It must NOT be
    /// treated as an immediately credited vault refund: inspect the linked
    /// transfer/actual balance. Owner can recover surplus with the existing
    /// 1-yocto withdraw_native_surplus path. Rolling spend remains conservative.
    #[payable]
    pub fn finalize_tollgate_close(&mut self, intent_id: String) -> Promise {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        let i = self.tollgate_intents.get(&intent_id).unwrap_or_else(|| abort_with("unknown Tollgate intent"));
        require(i.channel_verified, "channel not verified; reconcile first");
        let id = i.channel_id.unwrap_or_else(|| abort_with("channel ID not recorded; reconcile externally"));
        let args = near_sdk::serde_json::json!({"channel_id": U64(id)});
        Promise::new(channel_id()).function_call("finalize", args.to_string().into_bytes(), ZERO_NEAR, GAS_CLOSE)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::{get_created_receipts, testing_env_with_promise_results, VMContextBuilder};
    use near_sdk::{testing_env, PromiseResult, VMContext};

    const NOW: u64 = 25 * NS_PER_HOUR;
    fn id(value: &str) -> AccountId { value.parse().unwrap() }
    fn key(byte: u8) -> PublicKey { PublicKey::from_parts(CurveType::ED25519, vec![byte; 32]).unwrap() }
    fn context(predecessor: &str, signer: &str, pk: &PublicKey, deposit: u128, timestamp: u64) -> VMContext {
        let mut b = VMContextBuilder::new();
        b.current_account_id(id("vault.testnet")).predecessor_account_id(id(predecessor)).signer_account_id(id(signer))
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
        c.set_policy("data".into(), id("native"), U128(500), Some(U128(700)));
        c.grant_agent_key("data".into(), key(2));
        c.allow_payee("data".into(), channel_id());
        c.allow_payee("data".into(), seller_id());
        c.native_balance = 1_000;
        c
    }
    fn pin(c: &mut Bouncer, name: &str, voucher: PublicKey) {
        c.set_tollgate_intent(name.into(), "data".into(), U128(400), key(2), voucher,
            "a".repeat(64), expiry(), U64(600), U64(15));
    }
    fn fixture() -> Bouncer { let mut c = empty(); pin(&mut c, "one", key(3)); c }
    fn execute(c: &mut Bouncer) { drop(c.execute_tollgate_intent("one".into())); }
    fn recovery_view(seller: &str, voucher: &PublicKey) -> Vec<u8> {
        near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({"channel_id":"7", "owner":"vault.testnet",
            "seller":seller, "agent_pubkey":voucher, "deposit":"350", "storage_fee":"50", "status":"Open"})).unwrap()
    }

    #[test]
    fn one_shot_dispatch_pins_contract_seller_amount_and_voucher_key() {
        let mut c = fixture();
        assert_eq!(c.contract_version(), "bouncer-agent-v13-tollgate-native-testnet");
        assert!(c.get_tollgate_intent("one".into()).unwrap().active);
        testing_env!(agent()); execute(&mut c);
        let i = c.get_tollgate_intent("one".into()).unwrap();
        assert!(i.consumed && !i.active && !i.callback_recorded);
        assert_eq!(c.vault_balance(id("native")).0, 600); assert_eq!(c.daily_spent("data".into()).0, 400);
        let receipts = get_created_receipts();
        let r = receipts.iter().find(|r| r.receiver_id == channel_id()).expect("channel receipt");
        let (args, deposit) = r.actions.iter().find_map(|a| match a {
            MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } if method_name == b"open_channel" => Some((args, attached_deposit)),
            _ => None,
        }).expect("open_channel");
        assert_eq!(deposit.as_yoctonear(), 400);
        let args: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(args).unwrap();
        assert_eq!(args["seller"], SELLER); assert_eq!(args["agent_pubkey"], String::from(&key(3)));
        assert_eq!(args["expires_in_sec"], "600"); assert_eq!(args["dispute_window_sec"], "15");
        assert!(receipts.iter().any(|r| r.receiver_id == id("vault.testnet") && r.actions.iter().any(|a|
            matches!(a, MockAction::FunctionCallWeight { method_name, .. } if method_name == b"after_tollgate_open"))));
    }

    #[test]
    #[should_panic(expected = "Tollgate intent is unauthorized, consumed, expired or stale")]
    fn consumed_intent_cannot_open_twice() { let mut c = fixture(); testing_env!(agent()); execute(&mut c); execute(&mut c); }

    #[test]
    #[should_panic(expected = "owner-only method requires exactly 1 yoctoNEAR")]
    fn restricted_zero_deposit_cannot_pin_a_channel() { let mut c = empty(); testing_env!(agent()); pin(&mut c, "one", key(3)); }

    #[test]
    #[should_panic(expected = "caller is not owner")]
    fn another_account_cannot_pin_a_channel_even_with_one_yocto() {
        let mut c = empty(); testing_env!(context("attacker.testnet", "attacker.testnet", &key(4), 1, NOW)); pin(&mut c, "one", key(3));
    }

    #[test]
    #[should_panic(expected = "dedicated ed25519 voucher key required")]
    fn voucher_key_cannot_be_the_agent_key() { let mut c = empty(); pin(&mut c, "one", key(2)); }

    #[test]
    #[should_panic(expected = "voucher key already reserved")]
    fn voucher_key_cannot_be_reused_after_cancellation() {
        let mut c = fixture(); c.cancel_tollgate_intent("one".into()); pin(&mut c, "two", key(3));
    }

    #[test]
    #[should_panic(expected = "channel contract and seller must be allowed")]
    fn both_seller_and_channel_require_allowlisting() { let mut c = empty(); c.revoke_payee("data".into(), seller_id()); pin(&mut c, "one", key(3)); }

    #[test]
    fn policy_seller_and_agent_revisions_make_old_intents_stale() {
        let mut c = fixture();
        c.revoke_payee("data".into(), seller_id()); c.allow_payee("data".into(), seller_id());
        assert!(!c.get_tollgate_intent("one".into()).unwrap().active);
        pin(&mut c, "two", key(4)); c.revoke_agent_key("data".into(), key(2)); c.grant_agent_key("data".into(), key(2));
        assert!(!c.get_tollgate_intent("two".into()).unwrap().active);
        pin(&mut c, "three", key(5)); c.set_policy("data".into(), id("native"), U128(500), Some(U128(700)));
        assert!(!c.get_tollgate_intent("three".into()).unwrap().active);
    }

    #[allow(deprecated)]
    fn opened_and_verified() -> Bouncer {
        let mut c = fixture();
        assert!(!c.is_tollgate_voucher_authorized("missing".into()));
        assert!(!c.is_tollgate_voucher_authorized("one".into()));
        testing_env!(agent()); execute(&mut c);
        assert!(!c.is_tollgate_voucher_authorized("one".into()));
        testing_env_with_promise_results(context("vault.testnet", "owner.testnet", &key(2), 0, NOW),
            PromiseResult::Successful(b"\"7\"".to_vec()));
        c.after_tollgate_open("one".into());
        assert!(!c.is_tollgate_voucher_authorized("one".into()));
        testing_env!(owner(1)); drop(c.verify_tollgate_channel("one".into(), U64(7)));
        assert!(!c.is_tollgate_voucher_authorized("one".into()));
        testing_env_with_promise_results(context("vault.testnet", "owner.testnet", &key(2), 0, NOW),
            PromiseResult::Successful(recovery_view(SELLER, &key(3))));
        assert_eq!(c.after_tollgate_recovery("one".into(), U64(7), U64(1)).unwrap().0, 7);
        assert!(c.is_tollgate_voucher_authorized("one".into()));
        testing_env!(owner(1)); c
    }

    #[test]
    fn voucher_view_expires_after_open() {
        let c = opened_and_verified();
        testing_env!(context("owner.testnet", "owner.testnet", &key(1), 1, NOW + 61_000 * 1_000_000));
        assert!(!c.is_tollgate_voucher_authorized("one".into()));
    }

    #[test]
    fn voucher_view_rejects_changed_policy_after_open() {
        let mut c = opened_and_verified();
        c.set_policy("data".into(), id("native"), U128(500), Some(U128(700)));
        assert!(!c.is_tollgate_voucher_authorized("one".into()));
    }

    #[test]
    fn voucher_view_does_not_revive_after_seller_regrant() {
        let mut c = opened_and_verified();
        c.revoke_payee("data".into(), seller_id()); c.allow_payee("data".into(), seller_id());
        assert!(!c.is_tollgate_voucher_authorized("one".into()));
    }

    #[test]
    fn voucher_view_does_not_revive_after_contract_regrant() {
        let mut c = opened_and_verified();
        c.revoke_payee("data".into(), channel_id()); c.allow_payee("data".into(), channel_id());
        assert!(!c.is_tollgate_voucher_authorized("one".into()));
    }

    #[test]
    fn voucher_view_does_not_revive_after_agent_regrant() {
        let mut c = opened_and_verified();
        c.revoke_agent_key("data".into(), key(2)); c.grant_agent_key("data".into(), key(2));
        assert!(!c.is_tollgate_voucher_authorized("one".into()));
    }

    #[test]
    #[allow(deprecated)]
    fn voucher_view_rejects_failed_open_even_when_a_channel_is_recovered() {
        let mut c = fixture(); testing_env!(agent()); execute(&mut c);
        testing_env_with_promise_results(context("vault.testnet", "owner.testnet", &key(2), 0, NOW), PromiseResult::Failed);
        c.after_tollgate_open("one".into()); testing_env!(owner(1));
        drop(c.verify_tollgate_channel("one".into(), U64(7)));
        testing_env_with_promise_results(context("vault.testnet", "owner.testnet", &key(2), 0, NOW),
            PromiseResult::Successful(recovery_view(SELLER, &key(3))));
        c.after_tollgate_recovery("one".into(), U64(7), U64(1));
        assert!(!c.is_tollgate_voucher_authorized("one".into()));
    }

    #[test]
    #[should_panic(expected = "daily cap exceeded")]
    fn second_intent_cannot_bypass_rolling_budget() {
        let mut c = fixture(); pin(&mut c, "two", key(4)); testing_env!(agent()); execute(&mut c); drop(c.execute_tollgate_intent("two".into()));
    }

    #[test]
    #[allow(deprecated)]
    fn failed_open_retains_full_reservation_and_never_reopens_intent() {
        let mut c = fixture(); testing_env!(agent()); execute(&mut c);
        testing_env_with_promise_results(context("vault.testnet", "owner.testnet", &key(2), 0, NOW + NS_PER_HOUR), PromiseResult::Failed);
        assert!(c.after_tollgate_open("one".into()).is_none());
        assert_eq!(c.vault_balance(id("native")).0, 600); assert_eq!(c.daily_spent("data".into()).0, 400);
        let i = c.get_tollgate_intent("one".into()).unwrap(); assert!(i.consumed && i.promise_failed && i.callback_recorded && !i.active);
    }

    #[test]
    #[allow(deprecated)]
    fn failed_open_after_policy_change_keeps_old_budget_conservative() {
        let mut c = fixture(); testing_env!(agent()); execute(&mut c); testing_env!(owner(1));
        c.set_policy("data".into(), id("native"), U128(500), Some(U128(700)));
        testing_env_with_promise_results(context("vault.testnet", "owner.testnet", &key(2), 0, NOW), PromiseResult::Failed);
        c.after_tollgate_open("one".into());
        assert_eq!(c.vault_balance(id("native")).0, 600); assert_eq!(c.daily_spent("data".into()).0, 400);
    }

    #[test]
    #[allow(deprecated)]
    fn success_records_channel_and_unknown_result_never_recredits() {
        let mut c = fixture(); testing_env!(agent()); execute(&mut c);
        testing_env_with_promise_results(context("vault.testnet", "owner.testnet", &key(2), 0, NOW), PromiseResult::Successful(b"\"7\"".to_vec()));
        assert_eq!(c.after_tollgate_open("one".into()).unwrap().0, 7);
        assert_eq!(c.vault_balance(id("native")).0, 600); assert_eq!(c.daily_spent("data".into()).0, 400);
        testing_env!(owner(1)); pin(&mut c, "two", key(4)); testing_env!(agent());
        // Top up the rolling cap for this independent unknown-result case.
        testing_env!(owner(1)); c.set_policy("data".into(), id("native"), U128(500), Some(U128(1000)));
        pin(&mut c, "three", key(5)); testing_env!(agent()); drop(c.execute_tollgate_intent("three".into()));
        testing_env_with_promise_results(context("vault.testnet", "owner.testnet", &key(2), 0, NOW), PromiseResult::Successful(b"not-json".to_vec()));
        assert!(c.after_tollgate_open("three".into()).is_none());
        let i = c.get_tollgate_intent("three".into()).unwrap(); assert!(i.consumed && i.callback_recorded && !i.promise_failed && i.channel_id.is_none());
        assert_eq!(c.vault_balance(id("native")).0, 200); assert_eq!(c.daily_spent("data".into()).0, 800);
    }

    #[test]
    #[should_panic(expected = "Tollgate callback already recorded or not pending")]
    #[allow(deprecated)]
    fn callback_cannot_credit_twice() {
        let mut c = fixture(); testing_env!(agent()); execute(&mut c);
        testing_env_with_promise_results(context("vault.testnet", "owner.testnet", &key(2), 0, NOW), PromiseResult::Failed);
        c.after_tollgate_open("one".into()); c.after_tollgate_open("one".into());
    }

    #[test]
    #[allow(deprecated)]
    fn owner_close_uses_recorded_channel_and_zero_outgoing_deposit() {
        let mut c = fixture(); testing_env!(agent()); execute(&mut c);
        testing_env_with_promise_results(context("vault.testnet", "owner.testnet", &key(2), 0, NOW), PromiseResult::Successful(b"\"7\"".to_vec()));
        c.after_tollgate_open("one".into()); testing_env!(owner(1)); drop(c.verify_tollgate_channel("one".into(), U64(7)));
        testing_env_with_promise_results(context("vault.testnet", "owner.testnet", &key(2), 0, NOW),
            PromiseResult::Successful(recovery_view(SELLER, &key(3))));
        assert_eq!(c.after_tollgate_recovery("one".into(), U64(7), U64(1)).unwrap().0, 7);
        testing_env!(owner(1)); drop(c.start_tollgate_close("one".into()));
        let receipts = get_created_receipts();
        let r = receipts.iter().find(|r| r.receiver_id == channel_id()).unwrap();
        let (args, deposit) = r.actions.iter().find_map(|a| match a {
            MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } if method_name == b"start_close" => Some((args, attached_deposit)),
            _ => None,
        }).unwrap();
        assert_eq!(deposit.as_yoctonear(), 0);
        let args: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(args).unwrap();
        assert_eq!(args["channel_id"], "7");
    }

    #[test]
    #[should_panic(expected = "owner-only method requires exactly 1 yoctoNEAR")]
    fn agent_cannot_start_close_without_owner_authority() {
        let mut c = fixture(); testing_env!(agent()); drop(c.start_tollgate_close("one".into()));
    }

    #[test]
    #[should_panic(expected = "channel not verified; reconcile first")]
    #[allow(deprecated)]
    fn returned_id_alone_does_not_authorize_close() {
        let mut c = fixture(); testing_env!(agent()); execute(&mut c);
        testing_env_with_promise_results(context("vault.testnet", "owner.testnet", &key(2), 0, NOW), PromiseResult::Successful(b"\"7\"".to_vec()));
        c.after_tollgate_open("one".into()); testing_env!(owner(1)); drop(c.start_tollgate_close("one".into()));
    }

    #[test]
    #[allow(deprecated)]
    fn recovery_refuses_wrong_owner_key_budget_status_and_id() {
        let mut c = fixture(); testing_env!(agent()); execute(&mut c);
        for (field, wrong) in [("owner", near_sdk::serde_json::json!("attacker.testnet")),
            ("agent_pubkey", near_sdk::serde_json::json!(String::from(&key(4)))),
            ("deposit", near_sdk::serde_json::json!("349")), ("status", near_sdk::serde_json::json!("Unknown")),
            ("channel_id", near_sdk::serde_json::json!("8"))] {
            let mut payload: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(&recovery_view(SELLER, &key(3))).unwrap();
            payload[field] = wrong;
            testing_env!(owner(1)); drop(c.verify_tollgate_channel("one".into(), U64(7)));
            let generation = c.get_tollgate_intent("one".into()).unwrap().recovery_generation;
            testing_env_with_promise_results(context("vault.testnet", "owner.testnet", &key(2), 0, NOW),
                PromiseResult::Successful(near_sdk::serde_json::to_vec(&payload).unwrap()));
            assert!(c.after_tollgate_recovery("one".into(), U64(7), generation).is_none());
            let i = c.get_tollgate_intent("one".into()).unwrap(); assert!(!i.channel_verified && !i.recovering);
        }
    }

    #[test]
    #[allow(deprecated)]
    fn lost_recovery_can_be_reset_and_old_callback_cannot_override_new_attempt() {
        let mut c = fixture(); testing_env!(agent()); execute(&mut c);
        testing_env!(owner(1)); drop(c.verify_tollgate_channel("one".into(), U64(7)));
        c.reset_tollgate_verification("one".into());
        drop(c.verify_tollgate_channel("one".into(), U64(7)));
        testing_env_with_promise_results(context("vault.testnet", "owner.testnet", &key(2), 0, NOW),
            PromiseResult::Successful(recovery_view(SELLER, &key(3))));
        assert!(c.after_tollgate_recovery("one".into(), U64(7), U64(1)).is_none());
        assert!(c.get_tollgate_intent("one".into()).unwrap().recovering);
        assert_eq!(c.after_tollgate_recovery("one".into(), U64(7), U64(3)).unwrap().0, 7);
    }

    #[test]
    #[allow(deprecated)]
    fn owner_recovery_checks_seller_voucher_and_amount_and_handles_late_callback() {
        let mut c = fixture(); testing_env!(agent()); execute(&mut c);
        testing_env!(owner(1)); drop(c.verify_tollgate_channel("one".into(), U64(7)));
        testing_env_with_promise_results(context("vault.testnet", "owner.testnet", &key(2), 0, NOW),
            PromiseResult::Successful(recovery_view("attacker.testnet", &key(3))));
        assert!(c.after_tollgate_recovery("one".into(), U64(7), U64(1)).is_none());
        assert!(!c.get_tollgate_intent("one".into()).unwrap().channel_verified);
        testing_env!(owner(1)); drop(c.verify_tollgate_channel("one".into(), U64(7)));
        testing_env_with_promise_results(context("vault.testnet", "owner.testnet", &key(2), 0, NOW),
            PromiseResult::Successful(recovery_view(SELLER, &key(3))));
        assert_eq!(c.after_tollgate_recovery("one".into(), U64(7), U64(2)).unwrap().0, 7);
        // A late original callback cannot overwrite the verified recovery ID.
        testing_env_with_promise_results(context("vault.testnet", "owner.testnet", &key(2), 0, NOW), PromiseResult::Successful(b"\"8\"".to_vec()));
        assert_eq!(c.after_tollgate_open("one".into()).unwrap().0, 7);
        let i = c.get_tollgate_intent("one".into()).unwrap();
        assert!(i.channel_verified && i.channel_id.unwrap().0 == 7 && !i.recovering);
        assert_eq!(c.vault_balance(id("native")).0, 600); assert_eq!(c.daily_spent("data".into()).0, 400);
    }
}
