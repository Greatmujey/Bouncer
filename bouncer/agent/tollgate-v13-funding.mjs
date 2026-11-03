/** Read-only funding estimate for a fresh V13 data vault. This never signs,
 * moves funds, restores credentials, changes V12, or authorizes deployment.
 * Amounts are bounded estimates from one trusted FINAL testnet snapshot. */
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { newTestnetVaultId } from './keyless-vault-v12-readiness.mjs';
import { V12_NEAR_CODE_HASH } from './keyless-vault-v12.mjs';
import { V13_VOUCHER_CODE_HASH,CHANNEL_BUDGET_YOCTO } from './tollgate-quakes-v13.mjs';
import { CIRCLE_TESTNET_USDC } from '../scripts/circle-testnet-setup.mjs';
import { CIRCLE_TESTNET_CODE_HASH } from './keyless-vault-v12-readiness.mjs';
import { readPinnedJsonView } from './read-only-near-rpc.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { hasPlainOwnerProfileAt } from '../shared/plain-owner-profile.mjs';

export const V13_VOUCHER_BYTES=389_988;
export const V13_STATE_MARGIN_BYTES=25_000;
export const V13_FUNDING_YOCTO='5000000000000000000000000'; // 5 test NEAR, a conservative planning target
export const OWNER_FEE_RESERVE_YOCTO='200000000000000000000000'; // 0.2 test NEAR, not a fee guarantee
const VAULT_RESERVE=50_000_000_000_000_000_000_000n;
const MAX=(1n<<128n)-1n;
const uint=x=>typeof x==='string'&&/^(0|[1-9][0-9]{0,38})$/.test(x)&&BigInt(x)<=MAX;
const bytes=x=>Number.isSafeInteger(x)&&x>=0;
const nonnegative=x=>x>0n?x:0n;

export async function inspectTollgateV13Funding({ownerPlan:raw,provider,now=Date.now}={}){
 const owner=validateOwnerBootstrapPlan(raw),v12=newTestnetVaultId(owner),v13=`data.${owner.account_id}`;
 if(v13.length>64||!provider||['viewNodeStatus','viewBlock','query','viewTestnetAccountPresenceAt','experimental_protocolConfig','callFunctionRaw']
  .some(k=>typeof provider[k]!=='function')||typeof now!=='function')throw Error('pinned read-only testnet provider required');
 if((await provider.viewNodeStatus())?.chain_id!=='testnet')throw Error('testnet RPC required');
 const started=now(),block=await provider.viewBlock({finality:'final'}),fresh=assertFreshFinalBlock(block,started),h=fresh.hash;
 const query=(type,id)=>provider.query({request_type:type,account_id:id,block_id:h});
 const view=(id,method,args={})=>readPinnedJsonView(provider,h,id,method,args);
 const [ownerAccount,ownerKeys,presence,protocol,v12Account,v12Keys,v12Owner,v12Native,tokenAccount,v12Circle,actualCircle]=await Promise.all([
  query('view_account',owner.account_id),query('view_access_key_list',owner.account_id),provider.viewTestnetAccountPresenceAt(v13,h),
  provider.experimental_protocolConfig({blockId:h}),query('view_account',v12),query('view_access_key_list',v12),
  view(v12,'get_owner'),view(v12,'vault_balance',{token:'native'}),query('view_account',CIRCLE_TESTNET_USDC),
  view(v12,'vault_balance',{token:CIRCLE_TESTNET_USDC}),view(CIRCLE_TESTNET_USDC,'ft_balance_of',{account_id:v12})
 ]);
 const key=ownerKeys?.keys?.[0],cost=protocol?.runtime_config?.storage_amount_per_byte;
 if(!hasPlainOwnerProfileAt(ownerAccount,h)||!uint(ownerAccount.amount)||ownerAccount.locked!=='0'||!bytes(ownerAccount.storage_usage)||
  ownerKeys?.block_hash!==h||!Array.isArray(ownerKeys.keys)||ownerKeys.keys.length!==1||key?.public_key!==owner.public_key||
  key?.access_key?.permission!=='FullAccess')throw Error('owner profile or sole expected key differs');
 if(presence?.block_hash!==h||typeof presence.exists!=='boolean'||protocol?.chain_id!=='testnet'||!uint(cost)||cost==='0')throw Error('child presence or testnet storage cost is unknown');
 if(v12Account?.block_hash!==h||v12Account.code_hash!==V12_NEAR_CODE_HASH||!uint(v12Account.amount)||!bytes(v12Account.storage_usage)||
  v12Keys?.block_hash!==h||!Array.isArray(v12Keys.keys)||v12Keys.keys.length!==0||v12Owner!==owner.account_id||!uint(v12Native))throw Error('existing keyless V12 profile differs');
 if(tokenAccount?.block_hash!==h||tokenAccount.code_hash!==CIRCLE_TESTNET_CODE_HASH||!uint(v12Circle)||!uint(actualCircle)||v12Circle!==actualCircle)throw Error('existing V12 Circle identity or ledger differs');
 const storageCost=BigInt(cost),ownerStorage=BigInt(ownerAccount.storage_usage)*storageCost,
  ownerLiquid=nonnegative(BigInt(ownerAccount.amount)-ownerStorage),
  v12Storage=BigInt(v12Account.storage_usage)*storageCost,
  v12Surplus=nonnegative(BigInt(v12Account.amount)-v12Storage-BigInt(v12Native)-VAULT_RESERVE),
  target=BigInt(V13_FUNDING_YOCTO),ownerReserve=BigInt(OWNER_FEE_RESERVE_YOCTO),
  minVault=(BigInt(V13_VOUCHER_BYTES)+BigInt(V13_STATE_MARGIN_BYTES))*storageCost+VAULT_RESERVE+BigInt(CHANNEL_BUDGET_YOCTO),
  short=nonnegative(target+ownerReserve-ownerLiquid),shortIfSurplus=nonnegative(target+ownerReserve-ownerLiquid-v12Surplus);
 const finished=now();if(!Number.isSafeInteger(finished)||finished<started)throw Error('clock moved backwards');assertFreshFinalBlock(block,finished);
 return {version:1,network:'testnet',owner:owner.account_id,existing_v12:v12,proposed_v13:v13,block_hash:h,
  block_timestamp_nanosec:block.header.timestamp_nanosec,proposed_child_absent_at_view:presence.exists===false,
  v13_code_hash:V13_VOUCHER_CODE_HASH,v13_code_bytes:V13_VOUCHER_BYTES,storage_price_per_byte_yocto:cost,
  state_margin_bytes:V13_STATE_MARGIN_BYTES,v13_estimated_minimum_yocto:minVault.toString(),v13_planning_fund_yocto:target.toString(),
  planning_fund_covers_minimum:target>=minVault,owner_fee_reserve_yocto:ownerReserve.toString(),
  owner_account_balance_yocto:ownerAccount.amount,owner_storage_stake_estimate_yocto:ownerStorage.toString(),
  owner_liquid_estimate_yocto:ownerLiquid.toString(),owner_liquid_shortfall_yocto:short.toString(),
  v12_native_balance_yocto:v12Account.amount,v12_tracked_native_yocto:v12Native,
  v12_surplus_upper_bound_yocto:v12Surplus.toString(),shortfall_even_if_full_v12_surplus_recovered_yocto:shortIfSurplus.toString(),
  v12_circle_actual_atoms:actualCircle,v12_circle_tracked_atoms:v12Circle,
  private_key_checked:false,backup_checked:false,owner_transaction_authorized:false,signed:false,sent:false,
  scope:'single trusted-RPC FINAL estimate; V12 surplus is only an upper bound, not a withdrawal authorization, and future storage/gas can differ'};
}
