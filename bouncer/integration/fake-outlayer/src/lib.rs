//! Fabricated local provider used ONLY by an isolated nearcore integration.
//! It does not execute WASM or call an API; outputs and registry are invented.
//! It is not OutLayer, an independent worker, or a security/availability proof.
use near_sdk::{env, near, AccountId, NearToken, Promise};
use near_sdk::serde_json::{json, Value};

const PROJECT: &str = "zavodil2.testnet/price-oracle";
const UUID: &str = "p0000000000000007";
const HASH: &str = "3585b3890f49748713b43ccb9b0ef4148f317d62f4d598db80fdaffc3f3185a0";
const MARKET_HASH: &str = "0016209450769d4a03ee802e4dcbca854f14ca54f9185bed03333924e31b5ef6";

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
        let input: Value = near_sdk::serde_json::from_str(&input_data).expect("synthetic JSON input");
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
        } else if input.get("price_usd_micros").is_some() {
            // Synthetic arithmetic only; this fake does not download or execute WASM.
            assert_eq!(source["WasmUrl"]["hash"], MARKET_HASH);
            let price = input["price_usd_micros"].as_u64().expect("price");
            let quantity = input["quantity"].as_u64().expect("quantity");
            assert!(price > 0 && price <= 1_000_000_000_000 && quantity > 0 && quantity <= 1000);
            assert!(input["oracle_tx_hash"].as_str().is_some());
            json!({"value_usd_micros":price * quantity})
        } else { json!({"random_number":48}) };
        event("execution_completed", json!({"success":true, "sender_id":payer_account_id.clone(), "code_source":resolved,
            "payment_charged":charged.to_string(), "payment_refunded":refund.to_string()}));
        // The refund is a real sandbox transfer, not provider behavior evidence.
        drop(Promise::new(payer_account_id).transfer(NearToken::from_yoctonear(refund)));
        output
    }
}
