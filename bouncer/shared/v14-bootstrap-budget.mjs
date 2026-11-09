/**
 * Read-only, snapshot-based cost breakdown for the proposed two-stage V14
 * testnet bootstrap. It uses NEAR's public protocol fee schedule for exactly
 * CreateAccount + Transfer + AddKey(FullAccess), followed by self-directed
 * DeployContract + new + DeleteKey. No key or transaction is created here.
 *
 * These are estimates, not approval, a price guarantee or proof of adequate
 * storage. Gas prices and state may change before either transaction. Actual
 * execution and refunds can differ. Never use this estimate to bypass the
 * independent-original, owner-approval or fresh-receipt gates.
 */
import {V14_TESTNET_ARTIFACT} from './v14-testnet-artifact.mjs';

export const V14_EXAMPLE_VAULT_FUNDING_YOCTO='6000000000000000000000000'; // illustrative 6 test NEAR
const TGAS=1_000_000_000_000n,ONE=10n**24n,MAX=(1n<<128n)-1n;
const fail=()=>new Error('V14 bootstrap gas estimate unavailable; no transaction authorized');
function uint(value) {
  if(typeof value==='number')return Number.isSafeInteger(value)&&value>=0?BigInt(value):null;
  return typeof value==='string'&&/^(?:0|[1-9][0-9]{0,38})$/.test(value)&&BigInt(value)<=MAX?BigInt(value):null;
}
function fee(value) {
  const sir=uint(value?.send_sir),other=uint(value?.send_not_sir),execution=uint(value?.execution);
  if(sir===null||other===null||execution===null)throw fail();return {sir,other,execution};
}
const s=x=>x.toString();
/** The funding value is illustrative and never authorizes a wallet request. */
export function estimateV14BootstrapBudget({protocol,gasPrice,owner,fundingYocto=V14_EXAMPLE_VAULT_FUNDING_YOCTO}={}) {
  if(protocol?.chain_id!=='testnet'||!Number.isSafeInteger(protocol.protocol_version)||protocol.protocol_version<85||
    typeof owner!=='string'||!/^[a-z0-9]+(?:[-_.][a-z0-9]+)*\.testnet$/.test(owner)||owner.length>64)throw fail();
  const runtime=protocol.runtime_config,costs=runtime?.transaction_costs,actions=costs?.action_creation_config;
  const price=uint(gasPrice),minimum=uint(runtime?.min_gas_purchase_price),creationCharge=uint(runtime?.account_creation_charge),
    storagePrice=uint(runtime?.storage_amount_per_byte),funding=uint(fundingYocto);
  if(price===null||price===0n||minimum===null||minimum===0n||creationCharge===null||storagePrice===null||storagePrice===0n||
    funding===null||funding===0n||funding>10n*ONE)throw fail();
  const receipt=fee(costs.action_receipt_creation_config),create=fee(actions.create_account_cost),transfer=fee(actions.transfer_cost),
    add=fee(actions.add_key_cost?.full_access_cost),deploy=fee(actions.deploy_contract_cost),deployByte=fee(actions.deploy_contract_cost_per_byte),
    call=fee(actions.function_call_cost),callByte=fee(actions.function_call_cost_per_byte),remove=fee(actions.delete_key_cost);
  const byteCount=BigInt(V14_TESTNET_ARTIFACT.bytes),callBytes=BigInt(new TextEncoder().encode('new').length+
    new TextEncoder().encode(JSON.stringify({owner})).length),attachedGas=30n*TGAS,buyPrice=price>minimum?price:minimum;
  // Ed25519-signed ordinary actions have no delegated inner-action fees.
  const createSend=receipt.other+create.other+transfer.other+add.other;
  const createExec=receipt.execution+create.execution+transfer.execution+add.execution;
  const deploySend=receipt.sir+deploy.sir+byteCount*deployByte.sir+call.sir+callBytes*callByte.sir+remove.sir;
  const deployExec=receipt.execution+deploy.execution+byteCount*deployByte.execution+call.execution+callBytes*callByte.execution+remove.execution;
  const createGasUpfront=createSend*price+createExec*buyPrice;
  const deployGasUpfront=deploySend*price+(deployExec+attachedGas)*buyPrice;
  const storageEstimate=(byteCount+50_000n)*storagePrice+ONE/10n;
  for(const amount of [createGasUpfront,deployGasUpfront,storageEstimate,funding+createGasUpfront])if(amount>MAX)throw fail();
  return Object.freeze({status:'SNAPSHOT_ESTIMATE_NOT_AUTHORIZED',protocol_version:protocol.protocol_version,
    proposed_vault_funding_yocto:s(funding),storage_estimate_yocto:s(storageEstimate),storage_margin_bytes:50_000,
    storage_reserve_yocto:s(ONE/10n),gas_price_yocto_per_gas:s(price),receipt_purchase_price_yocto_per_gas:s(buyPrice),
    account_creation_charge_yocto:s(creationCharge),
    create:{payer:'owner',deposit_yocto:s(funding),send_gas:s(createSend),receipt_execution_gas:s(createExec),
      gas_upfront_estimate_yocto:s(createGasUpfront),owner_total_upfront_estimate_yocto:s(funding+createGasUpfront)},
    deployment:{payer:'vault',deposit_yocto:'0',send_gas:s(deploySend),receipt_execution_gas:s(deployExec),
      initializer_prepaid_gas:s(attachedGas),gas_upfront_estimate_yocto:s(deployGasUpfront),
      estimated_funding_after_upfront_gas_yocto:s(funding>deployGasUpfront?funding-deployGasUpfront:0n)},
    funding_covers_estimated_storage_and_deploy_upfront:funding>=storageEstimate+deployGasUpfront,
    funding_is_approved:false,transaction_authorized:false,transaction_sent:false,
    scope:'Example funding and snapshot arithmetic only. Network price, usage, state and refunds can change; the account creation target includes creation execution gas, with any remaining charge retained from a refund where applicable. Deployment gas is paid from the vault funding, not in addition to that transfer. The estimate is not a receipt, quote, backup proof or owner approval.'});
}
