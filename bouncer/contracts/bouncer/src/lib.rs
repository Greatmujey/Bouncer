use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, ext_contract, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PublicKey};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const ZERO_NEAR: NearToken = NearToken::from_yoctonear(0);
const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_FOR_RESOLVE: Gas = Gas::from_tgas(15);
const NS_PER_DAY: u64 = 24 * 60 * 60 * 1_000_000_000;

// Preserve readable errors in optimized WASM; use a normal panic in native tests.
#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
extern "C" { fn panic_utf8(len: u64, ptr: u64) -> !; }
#[cfg(target_arch = "wasm32")]
fn abort_with(msg: &str) -> ! {
    unsafe { panic_utf8(msg.len() as u64, msg.as_ptr() as u64); }
}
#[cfg(not(target_arch = "wasm32"))]
fn abort_with(msg: &str) -> ! { panic!("{}", msg); }
fn require(cond: bool, msg: &str) { if !cond { abort_with(msg); } }

#[ext_contract(ext_ft)]
trait ExtFt {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}
#[ext_contract(ext_self)]
trait ExtSelf {
    fn after_execute(&mut self, policy_id: String, token: AccountId, amount: U128, bucket: u64);
    fn after_withdraw(&mut self, token: AccountId, amount: U128);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Bouncer {
    owner: AccountId,
    token_of: LookupMap<String, AccountId>,
    cap_of: LookupMap<String, u128>,
    daily_of: LookupMap<String, u128>,
    allow: LookupMap<String, bool>,
    allow_count: LookupMap<String, u32>,
    balances: LookupMap<AccountId, u128>,
    daily_spent: LookupMap<String, u128>,
    // The signing key is explicitly authorized per policy, not merely by account.
    agents: LookupMap<(String, PublicKey), bool>,
}

fn allow_key(pid: &str, p: &str) -> String {
    let mut s = String::with_capacity(pid.len() + 1 + p.len());
    s.push_str(pid); s.push(':'); s.push_str(p); s
}
fn daily_key(pid: &str, bucket: u64) -> String {
    let mut s = String::with_capacity(pid.len() + 22);
    s.push_str(pid); s.push('|');
    let mut b = bucket;
    let mut digits = [0u8; 20];
    let mut i = 0;
    if b == 0 { digits[i] = b'0'; i += 1; } else {
        while b > 0 { digits[i] = b'0' + (b % 10) as u8; b /= 10; i += 1; }
        digits[..i].reverse();
    }
    for d in digits.iter().take(i) { s.push(*d as char); }
    s
}

fn validate(
    s: &Bouncer, policy_id: &str, payee: &AccountId, amount: u128,
) -> Result<(AccountId, u128), String> {
    let cap = *s.cap_of.get(policy_id).ok_or("no such policy")?;
    let token = s.token_of.get(policy_id).cloned().ok_or("policy missing token")?;
    if amount == 0 { return Err("amount must be > 0".into()); }
    if amount > cap { return Err("BLOCKED: amount exceeds per-tx cap".into()); }
    // Fail closed: a policy with no allowed payees cannot spend.
    let k = allow_key(policy_id, payee.as_str());
    if s.allow.get(&k) != Some(&true) {
        return Err("BLOCKED: payee not in allowlist".into());
    }
    let daily = s.daily_of.get(policy_id).cloned().unwrap_or(0);
    if daily > 0 {
        let bucket = env::block_timestamp() / NS_PER_DAY;
        let spent = s.daily_spent.get(&daily_key(policy_id, bucket)).cloned().unwrap_or(0);
        if spent.saturating_add(amount) > daily {
            return Err("BLOCKED: daily cap exceeded for this policy".into());
        }
    }
    let bal = s.balances.get(&token).cloned().unwrap_or(0);
    if bal < amount { return Err("BLOCKED: insufficient vault balance (fund first)".into()); }
    Ok((token, bal))
}

fn require_owner(s: &Bouncer, attached: NearToken) -> Result<(), String> {
    if attached != ONE_YOCTO {
        return Err("ESCALATION BLOCKED: owner-only method requires exactly 1 yoctoNEAR".into());
    }
    if env::predecessor_account_id() != s.owner {
        return Err("ESCALATION BLOCKED: caller is not owner".into());
    }
    Ok(())
}

#[near]
impl Bouncer {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        if owner.as_str().is_empty() { abort_with("owner must not be empty"); }
        Self {
            owner,
            token_of: LookupMap::new(b"t"), cap_of: LookupMap::new(b"c"),
            daily_of: LookupMap::new(b"d"),
            allow: LookupMap::new(b"a"), allow_count: LookupMap::new(b"n"),
            balances: LookupMap::new(b"b"),
            daily_spent: LookupMap::new(b"s"),
            agents: LookupMap::new(b"k"),
        }
    }

    #[payable]
    pub fn set_policy(&mut self, policy_id: String, token: AccountId, per_tx_cap: U128, daily_cap: Option<U128>) {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        if per_tx_cap.0 == 0 { abort_with("per_tx_cap must be > 0"); }
        self.token_of.insert(policy_id.clone(), token);
        self.cap_of.insert(policy_id.clone(), per_tx_cap.0);
        self.daily_of.insert(policy_id, daily_cap.map(|u| u.0).unwrap_or(0));
    }

    /// Authorize a public key belonging to the owner account for one policy.
    /// The owner must separately install it as a function-call access key scoped
    /// to execute; an entry here alone does not create a NEAR access key.
    #[payable]
    pub fn grant_agent_key(&mut self, policy_id: String, public_key: PublicKey) {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        require(self.cap_of.contains_key(&policy_id), "policy does not exist");
        self.agents.insert((policy_id, public_key), true);
    }

    #[payable]
    pub fn revoke_agent_key(&mut self, policy_id: String, public_key: PublicKey) {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        self.agents.remove(&(policy_id, public_key));
    }

    pub fn is_agent_key_allowed(&self, policy_id: String, public_key: PublicKey) -> bool {
        self.agents.get(&(policy_id, public_key)) == Some(&true)
    }

    #[payable]
    pub fn allow_payee(&mut self, policy_id: String, payee: AccountId) {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        if !self.cap_of.contains_key(&policy_id) { abort_with("policy does not exist"); }
        let k = allow_key(&policy_id, payee.as_str());
        if self.allow.get(&k).is_none() {
            let n = self.allow_count.get(&policy_id).cloned().unwrap_or(0);
            self.allow_count.insert(policy_id.clone(), n + 1);
        }
        self.allow.insert(k, true);
    }

    #[payable]
    pub fn revoke_payee(&mut self, policy_id: String, payee: AccountId) {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        let k = allow_key(&policy_id, payee.as_str());
        if self.allow.remove(&k).is_some() {
            let n = self.allow_count.get(&policy_id).cloned().unwrap_or(1);
            self.allow_count.insert(policy_id, n.saturating_sub(1));
        }
    }

    pub fn contract_version(&self) -> &'static str { "bouncer-agent-v2" }

    pub fn vault_balance(&self, token: AccountId) -> U128 {
        U128(self.balances.get(&token).cloned().unwrap_or(0))
    }

    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        let token = env::predecessor_account_id();
        let bal = self.balances.get(&token).cloned().unwrap_or(0);
        let updated = bal.checked_add(amount.0).unwrap_or_else(|| abort_with("vault balance overflow"));
        self.balances.insert(token.clone(), updated);
        env::log_str("BOUNCER deposit received");
        let _ = (sender_id, msg);
        U128(0)
    }

    #[payable]
    pub fn withdraw(&mut self, token: AccountId, amount: U128) -> Promise {
        require_owner(self, env::attached_deposit()).unwrap_or_else(|m| abort_with(&m));
        let bal = self.balances.get(&token).cloned().unwrap_or(0);
        if amount.0 > bal { abort_with("insufficient vault balance"); }
        self.balances.insert(token.clone(), bal - amount.0);
        ext_ft::ext(token.clone())
            .with_attached_deposit(ONE_YOCTO).with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(self.owner.clone(), amount, Some("bouncer:withdraw".into()))
            .then(ext_self::ext(env::current_account_id()).with_static_gas(GAS_FOR_RESOLVE).after_withdraw(token, amount))
    }

    #[payable]
    pub fn execute(&mut self, policy_id: String, payee: AccountId, amount: U128, memo: Option<String>) -> Promise {
        // Only direct transactions signed by the owner account may invoke execute.
        // The signing key must also be explicitly granted for this policy.
        require(env::attached_deposit() == ZERO_NEAR, "BLOCKED: execute requires zero deposit");
        require(env::predecessor_account_id() == self.owner && env::signer_account_id() == self.owner,
            "BLOCKED: caller is not the owner account");
        let signing_key = env::signer_account_pk();
        require(self.agents.get(&(policy_id.clone(), signing_key)) == Some(&true),
            "BLOCKED: signing key is not authorized for this policy");
        let (token, bal) = validate(self, &policy_id, &payee, amount.0).unwrap_or_else(|m| abort_with(&m));
        let bucket = env::block_timestamp() / NS_PER_DAY;
        let dk = daily_key(&policy_id, bucket);
        let spent = self.daily_spent.get(&dk).cloned().unwrap_or(0);
        let next_spent = spent.checked_add(amount.0).unwrap_or_else(|| abort_with("daily spend overflow"));
        self.balances.insert(token.clone(), bal - amount.0);
        self.daily_spent.insert(dk, next_spent);
        env::log_str("BOUNCER payment initiated");
        // The contract, not the function-call key, pays the required 1 yoctoNEAR.
        ext_ft::ext(token.clone())
            .with_attached_deposit(ONE_YOCTO).with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(payee, amount, memo)
            .then(ext_self::ext(env::current_account_id()).with_static_gas(GAS_FOR_RESOLVE).after_execute(policy_id, token, amount, bucket))
    }

    #[private]
    pub fn after_execute(&mut self, policy_id: String, token: AccountId, amount: U128, bucket: u64) {
        if !matches!(env::promise_result(0), near_sdk::PromiseResult::Successful(_)) {
            let bal = self.balances.get(&token).cloned().unwrap_or(0);
            let updated = bal.checked_add(amount.0).unwrap_or_else(|| abort_with("refund balance overflow"));
            self.balances.insert(token.clone(), updated);
            // Use the original execution bucket even if the callback crosses midnight.
            let dk = daily_key(&policy_id, bucket);
            if let Some(s) = self.daily_spent.get(&dk).cloned() {
                self.daily_spent.insert(dk, s.saturating_sub(amount.0));
            }
            env::log_str("BOUNCER ft_transfer failed; vault refunded");
        }
    }
    #[private]
    pub fn after_withdraw(&mut self, token: AccountId, amount: U128) {
        if !matches!(env::promise_result(0), near_sdk::PromiseResult::Successful(_)) {
            let bal = self.balances.get(&token).cloned().unwrap_or(0);
            let updated = bal.checked_add(amount.0).unwrap_or_else(|| abort_with("refund balance overflow"));
            self.balances.insert(token, updated);
        }
    }

    pub fn check(&self, policy_id: String, payee: AccountId, amount: U128) -> (bool, String) {
        match validate(self, &policy_id, &payee, amount.0) {
            Ok(_) => (true, "ok: within cap, payee allowed, daily ok, vault funded".into()),
            Err(e) => (false, e),
        }
    }
    pub fn try_execute(&self, policy_id: String, payee: AccountId, amount: U128) -> (bool, String) {
        match validate(self, &policy_id, &payee, amount.0) {
            Ok(_) => (true, "policy satisfied; caller authorization not checked".into()),
            Err(e) => (false, e),
        }
    }
    pub fn try_set_policy(&self, attached_yoctos: U128, predecessor: AccountId, per_tx_cap: U128) -> (bool, String) {
        let deposit = NearToken::from_yoctonear(attached_yoctos.0);
        if deposit != ONE_YOCTO {
            return (false, "BLOCKED: requires exactly 1 yoctoNEAR (owner-only guard)".into());
        }
        if predecessor != self.owner {
            return (false, "BLOCKED: caller is not owner".into());
        }
        if per_tx_cap.0 == 0 { return (false, "per_tx_cap must be > 0".into()); }
        (true, "set_policy would succeed".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{testing_env_with_promise_results, VMContext, VMContextBuilder};
    use near_sdk::{testing_env, CurveType, PromiseResult};

    fn id(value: &str) -> AccountId { value.parse().unwrap() }
    fn key(byte: u8) -> PublicKey {
        PublicKey::from_parts(CurveType::ED25519, vec![byte; 32]).unwrap()
    }
    fn context(predecessor: &str, signer: &str, pk: &PublicKey, deposit: u128, timestamp: u64) -> VMContext {
        let mut b = VMContextBuilder::new();
        b.current_account_id(id("bouncer.testnet"))
            .predecessor_account_id(id(predecessor))
            .signer_account_id(id(signer))
            .signer_account_pk(pk.clone())
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(timestamp)
            .prepaid_gas(Gas::from_tgas(300));
        b.build()
    }
    fn owner_context(pk: &PublicKey, deposit: u128, timestamp: u64) -> VMContext {
        context("bouncer.testnet", "bouncer.testnet", pk, deposit, timestamp)
    }
    fn fixture() -> (Bouncer, PublicKey) {
        let owner_key = key(1);
        let agent_key = key(2);
        testing_env!(owner_context(&owner_key, 1, NS_PER_DAY));
        let mut contract = Bouncer::new(id("bouncer.testnet"));
        contract.set_policy("compute".into(), id("token.testnet"), U128(200), Some(U128(300)));
        contract.grant_agent_key("compute".into(), agent_key.clone());
        contract.allow_payee("compute".into(), id("vendor.testnet"));
        contract.balances.insert(id("token.testnet"), 1_000);
        (contract, agent_key)
    }

    #[test]
    fn authorized_agent_can_execute_without_deposit() {
        let (mut contract, agent) = fixture();
        testing_env!(owner_context(&agent, 0, NS_PER_DAY));
        drop(contract.execute("compute".into(), id("vendor.testnet"), U128(100), None));
        assert_eq!(contract.vault_balance(id("token.testnet")).0, 900);
        assert_eq!(*contract.daily_spent.get(&daily_key("compute", 1)).unwrap(), 100);
    }

    #[test]
    #[should_panic(expected = "BLOCKED: caller is not the owner account")]
    fn unrelated_account_cannot_execute() {
        let (mut contract, agent) = fixture();
        testing_env!(context("attacker.testnet", "attacker.testnet", &agent, 0, NS_PER_DAY));
        drop(contract.execute("compute".into(), id("vendor.testnet"), U128(100), None));
    }

    #[test]
    #[should_panic(expected = "BLOCKED: signing key is not authorized for this policy")]
    fn another_key_on_owner_account_is_not_automatically_authorized() {
        let (mut contract, _) = fixture();
        testing_env!(owner_context(&key(3), 0, NS_PER_DAY));
        drop(contract.execute("compute".into(), id("vendor.testnet"), U128(100), None));
    }

    #[test]
    #[should_panic(expected = "BLOCKED: signing key is not authorized for this policy")]
    fn agent_key_cannot_spend_under_another_policy() {
        let (mut contract, agent) = fixture();
        testing_env!(owner_context(&key(1), 1, NS_PER_DAY));
        contract.set_policy("storage".into(), id("token.testnet"), U128(200), Some(U128(300)));
        contract.allow_payee("storage".into(), id("vendor.testnet"));
        testing_env!(owner_context(&agent, 0, NS_PER_DAY));
        drop(contract.execute("storage".into(), id("vendor.testnet"), U128(100), None));
    }

    #[test]
    #[should_panic(expected = "BLOCKED: execute requires zero deposit")]
    fn execute_refuses_a_deposit() {
        let (mut contract, agent) = fixture();
        testing_env!(owner_context(&agent, 1, NS_PER_DAY));
        drop(contract.execute("compute".into(), id("vendor.testnet"), U128(100), None));
    }

    #[test]
    #[should_panic(expected = "owner-only method requires exactly 1 yoctoNEAR")]
    fn agent_cannot_grant_itself_another_policy_without_deposit() {
        let (mut contract, agent) = fixture();
        testing_env!(owner_context(&agent, 0, NS_PER_DAY));
        contract.grant_agent_key("compute".into(), agent);
    }

    #[test]
    #[should_panic(expected = "ESCALATION BLOCKED: caller is not owner")]
    fn non_owner_cannot_grant_even_with_one_yocto() {
        let (mut contract, agent) = fixture();
        testing_env!(context("attacker.testnet", "attacker.testnet", &agent, 1, NS_PER_DAY));
        contract.grant_agent_key("compute".into(), agent);
    }

    #[test]
    #[should_panic(expected = "BLOCKED: signing key is not authorized for this policy")]
    fn revoked_agent_key_cannot_execute() {
        let (mut contract, agent) = fixture();
        testing_env!(owner_context(&key(1), 1, NS_PER_DAY));
        contract.revoke_agent_key("compute".into(), agent.clone());
        assert!(!contract.is_agent_key_allowed("compute".into(), agent.clone()));
        testing_env!(owner_context(&agent, 0, NS_PER_DAY));
        drop(contract.execute("compute".into(), id("vendor.testnet"), U128(100), None));
    }

    #[test]
    fn an_empty_allowlist_fails_closed_after_revocation() {
        let (mut contract, agent) = fixture();
        testing_env!(owner_context(&key(1), 1, NS_PER_DAY));
        contract.revoke_payee("compute".into(), id("vendor.testnet"));
        testing_env!(owner_context(&agent, 0, NS_PER_DAY));
        let (ok, reason) = contract.check("compute".into(), id("vendor.testnet"), U128(100));
        assert!(!ok);
        assert_eq!(reason, "BLOCKED: payee not in allowlist");
    }

    #[test]
    fn limits_and_balance_are_checked_for_each_policy() {
        let (mut contract, agent) = fixture();
        testing_env!(owner_context(&agent, 0, NS_PER_DAY));
        assert!(contract.check("compute".into(), id("vendor.testnet"), U128(200)).0);
        assert_eq!(contract.check("compute".into(), id("vendor.testnet"), U128(201)).1,
            "BLOCKED: amount exceeds per-tx cap");
        drop(contract.execute("compute".into(), id("vendor.testnet"), U128(200), None));
        assert_eq!(contract.check("compute".into(), id("vendor.testnet"), U128(101)).1,
            "BLOCKED: daily cap exceeded for this policy");
    }

    #[test]
    #[allow(deprecated)]
    fn failed_transfer_refunds_original_bucket_even_across_midnight() {
        let (mut contract, agent) = fixture();
        testing_env!(owner_context(&agent, 0, NS_PER_DAY));
        drop(contract.execute("compute".into(), id("vendor.testnet"), U128(100), None));
        contract.daily_spent.insert(daily_key("compute", 2), 75);
        let callback_context = context("bouncer.testnet", "bouncer.testnet", &agent, 0, 2 * NS_PER_DAY);
        testing_env_with_promise_results(callback_context, PromiseResult::Failed);
        contract.after_execute("compute".into(), id("token.testnet"), U128(100), 1);
        assert_eq!(contract.vault_balance(id("token.testnet")).0, 1_000);
        assert_eq!(*contract.daily_spent.get(&daily_key("compute", 1)).unwrap(), 0);
        assert_eq!(*contract.daily_spent.get(&daily_key("compute", 2)).unwrap(), 75);
    }
}
