//! Fabricated local provider used ONLY by an isolated nearcore integration.
//! It does not execute WASM or call an API; outputs and registry are invented.
//! It is not OutLayer, an independent worker, or a security/availability proof.
use near_sdk::{env, near, AccountId, NearToken, Promise};
use near_sdk::serde_json::{json, Value};

const PROJECT: &str = "zavodil2.testnet/price-oracle";
const UUID: &str = "p0000000000000007";
const HASH: &str = "3585b3890f49748713b43ccb9b0ef4148f317d62f4d598db80fdaffc3f3185a0";

fn oracle_source() -> Value {
    json!({"WasmUrl": {"url": format!("https://wasmhub.testnet.fastfs.io/fastfs.testnet/{}.wasm", HASH),
        "hash": HASH, "build_target": "wasm32-wasip2"}})
}
fn event(name: &str, data: Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({"standard":"near-outlayer", "version":"1.0.0", "event":name, "data":[data]})));
}

#[near(contract_state)]
#[derive(Default)]
pub struct FakeOutlayer {}

#[near]
impl FakeOutlayer {
    #[init]
    pub fn new() -> Self { Self {} }

    pub fn get_project(&self, project_id: String) -> Value {
        assert_eq!(project_id, PROJECT);
        json!({"project_id":PROJECT, "uuid":UUID, "owner":"zavodil2.testnet"})
    }
    pub fn get_version(&self, project_id: String, version_key: String) -> Value {
        assert_eq!(project_id, PROJECT); assert_eq!(version_key, HASH);
        json!({"wasm_hash":HASH, "source":oracle_source()})
    }
    pub fn get_project_pricing(&self, project_id: String) -> Option<Value> {
        assert_eq!(project_id, PROJECT); None
    }

    #[payable]
    pub fn request_execution(&mut self, source: Value, resource_limits: Value, input_data: String,
        secrets_ref: Option<Value>, response_format: String, payer_account_id: AccountId, params: Option<Value>) -> Value {
        assert!(resource_limits.is_object()); assert!(secrets_ref.is_none()); assert!(params.is_none());
        assert_eq!(response_format, "Json");
        let amount = env::attached_deposit().as_yoctonear(); assert!(amount >= 10);
        let project = source.get("Project").is_some();
        let resolved = if project {
            assert_eq!(source["Project"]["project_id"], PROJECT); assert_eq!(source["Project"]["version_key"], HASH);
            oracle_source()
        } else {
            assert!(source.get("WasmUrl").is_some()); source.clone()
        };
        let mut request = json!({"sender_id":payer_account_id.clone(), "predecessor_id":env::predecessor_account_id(),
            "payment":amount.to_string(), "input_data":input_data, "code_source":resolved.clone()});
        if project {
            request["project_id"] = json!(PROJECT); request["project_uuid"] = json!(UUID); request["attached_usd"] = json!("0");
        }
        event("execution_requested", json!({"request_data":request.to_string()}));
        let refund = amount / 10; let charged = amount - refund;
        let output = if project {
            json!({"success":true, "token_id":"near", "source":"custom", "price_usd":2.75,
                "timestamp":env::block_timestamp() / 1_000_000_000})
        } else { json!({"random_number":48}) };
        event("execution_completed", json!({"success":true, "sender_id":payer_account_id.clone(), "code_source":resolved,
            "payment_charged":charged.to_string(), "payment_refunded":refund.to_string()}));
        // The refund is a real sandbox transfer, not provider behavior evidence.
        drop(Promise::new(payer_account_id).transfer(NearToken::from_yoctonear(refund)));
        output
    }
}
