/**
 * Read-only, single-FINAL-block snapshot for the backed-up V12 vault and one
 * independently operated OutLayer testnet diagnostic. No account creation,
 * credential, signing, transaction, seller endpoint or funding. The RPC and
 * provider views are trusted, not cryptographic proofs; diagnostic execution
 * is not a commercial resource or Circle-USDC fulfillment.
 */
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { newTestnetVaultId } from './keyless-vault-v12-readiness.mjs';
import { V12_NEAR_CODE_HASH } from './keyless-vault-v12.mjs';
import { readPinnedJsonView } from './read-only-near-rpc.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

export const OUTLAYER_TESTNET='outlayer.testnet';
export const OUTLAYER_FAKE_USD='usdc.fakes.testnet';
export const OUTLAYER_PROBE='connectors.outlayer.testnet/connector-probe';
const REF='ref-finance-101.testnet', WRAP='wrap.testnet', POOL=54;
const limits={max_instructions:1_000_000_000,max_memory_mb:256,max_execution_seconds:60};
const burnInput=JSON.stringify({operation:'burn',rounds:50});
const amounts=['100000000000000','1000000000000000','10000000000000000'];
const isObject=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const amount=x=>typeof x==='string'&&/^(0|[1-9][0-9]{0,38})$/.test(x);

/** Each optional observation is tagged; a failed view is UNKNOWN, never zero
 * or evidence of absence. The V12 identity and vault-key checks fail closed. */
export async function inspectOutlayerV12Readiness({ownerPlan,provider,now=Date.now}={}) {
  const owner=validateOwnerBootstrapPlan(ownerPlan), vault=newTestnetVaultId(owner);
  if(!provider||['viewNodeStatus','viewBlock','query','callFunctionRaw'].some(k=>typeof provider[k]!=='function')||typeof now!=='function'){
    throw new Error('read-only pinned testnet provider required');
  }
  if((await provider.viewNodeStatus())?.chain_id!=='testnet')throw new Error('testnet RPC required');
  const start=now(),block=await provider.viewBlock({finality:'final'}),hash=assertFreshFinalBlock(block,start).hash;
  const view=(id,method,args={})=>readPinnedJsonView(provider,hash,id,method,args);
  const query=(request_type,account_id)=>provider.query({request_type,account_id,block_id:hash});
  const [vaultAccount,vaultKeys,vaultOwner,vaultVersion]=await Promise.all([
    query('view_account',vault),query('view_access_key_list',vault),view(vault,'get_owner'),view(vault,'contract_version'),
  ]);
  if(vaultAccount?.block_hash!==hash||vaultAccount.code_hash!==V12_NEAR_CODE_HASH||
     vaultKeys?.block_hash!==hash||!Array.isArray(vaultKeys.keys)||vaultKeys.keys.length!==0||vaultOwner!==owner.account_id||
     vaultVersion!=='bouncer-agent-v12-exact-ft-testnet'){
    throw new Error('backed-up V12 vault identity or keyless state differs');
  }
  async function observe(f){try{return {status:'OBSERVED',value:await f()}}catch{return {status:'UNKNOWN'}}}
  const account=async id=>{
    const [a,k]=await Promise.all([query('view_account',id),query('view_access_key_list',id)]);
    if(a?.block_hash!==hash||!isTransactionHash(a.code_hash)||k?.block_hash!==hash||!Array.isArray(k.keys)||k.keys.length>1000)throw Error('invalid account view');
    return {code_hash:a.code_hash,key_count:k.keys.length,full_access_keys:k.keys.filter(x=>x?.access_key?.permission==='FullAccess').length};
  };
  const names=['provider_account','fake_token_account','configured_token','fake_token_metadata','fake_storage_bounds',
    'owner_fake_registration','vault_fake_registration','outlayer_fake_registration','owner_fake_balance','vault_fake_balance',
    'vault_tracked_fake','vault_tracked_native','vault_prepaid_allowance','provider_vault_credit','project','pricing','native_estimate','pool',...amounts.map((_,i)=>`quote_${i}`)];
  const tasks=[()=>account(OUTLAYER_TESTNET),()=>account(OUTLAYER_FAKE_USD),
    ()=>view(OUTLAYER_TESTNET,'get_payment_token_contract'),()=>view(OUTLAYER_FAKE_USD,'ft_metadata'),
    ()=>view(OUTLAYER_FAKE_USD,'storage_balance_bounds'),
    ...[owner.account_id,vault,OUTLAYER_TESTNET].map(account_id=>()=>view(OUTLAYER_FAKE_USD,'storage_balance_of',{account_id})),
    ...[owner.account_id,vault].map(account_id=>()=>view(OUTLAYER_FAKE_USD,'ft_balance_of',{account_id})),
    ()=>view(vault,'vault_balance',{token:OUTLAYER_FAKE_USD}),()=>view(vault,'vault_balance',{token:'native'}),
    ()=>view(vault,'outlayer_prepaid_balance',{token:OUTLAYER_FAKE_USD}),
    ()=>view(OUTLAYER_TESTNET,'get_user_stablecoin_balance',{account_id:vault}),
    ()=>view(OUTLAYER_TESTNET,'get_project',{project_id:OUTLAYER_PROBE}),
    ()=>view(OUTLAYER_TESTNET,'get_project_pricing',{project_id:OUTLAYER_PROBE}),
    ()=>view(OUTLAYER_TESTNET,'estimate_execution_cost',{resource_limits:limits,input_len:Buffer.byteLength(burnInput)}),
    ()=>view(REF,'get_pool',{pool_id:POOL}),
    ...amounts.map(amount_in=>()=>view(REF,'get_return',{pool_id:POOL,token_in:WRAP,amount_in,token_out:OUTLAYER_FAKE_USD}))];
  const values=await Promise.all(tasks.map(observe));
  const observations=Object.fromEntries(names.map((n,i)=>[n,values[i]]));
  const active=observations.project.value?.active_version;
  observations.project_version=typeof active==='string'&&/^[a-f0-9]{64}$/.test(active)
    ?await observe(()=>view(OUTLAYER_TESTNET,'get_version',{project_id:OUTLAYER_PROBE,version_key:active})):{status:'UNKNOWN'};
  // Extract only bounded public fields. Never interpret a symbol/label as a
  // Circle contract identity or a quote as an executable guaranteed trade.
  const meta=observations.fake_token_metadata;
  if(meta.status==='OBSERVED')meta.value=isObject(meta.value)?{name:meta.value.name,symbol:meta.value.symbol,decimals:meta.value.decimals}:null;
  const price=observations.pricing;
  if(price.status==='OBSERVED')price.value=isObject(price.value)?{author_account_id:price.value.author_account_id,
    operation:Array.isArray(price.value.operations)?price.value.operations.find(x=>x?.operation==='burn')??null:null}:null;
  const quote=amounts.map((amount_in,i)=>({wnear_input_yocto:amount_in,...observations[`quote_${i}`]}));
  for(let i=0;i<amounts.length;i++)delete observations[`quote_${i}`];
  observations.quotes=quote;
  const check=observations.configured_token.status==='OBSERVED'&&observations.configured_token.value===OUTLAYER_FAKE_USD&&
    meta.status==='OBSERVED'&&meta.value?.decimals===6&&price.status==='OBSERVED'&&amount(price.value?.operation?.price_usd)&&
    amount(observations.native_estimate.value);
  const end=now();if(!Number.isSafeInteger(end)||end<start)throw new Error('local clock moved backwards');assertFreshFinalBlock(block,end);
  return {version:1,chain:'testnet',block_hash:hash,block_timestamp_nanosec:block.header.timestamp_nanosec,
    observed_at:new Date(end).toISOString(),owner:owner.account_id,vault,project_id:OUTLAYER_PROBE,
    diagnostic_input:burnInput,resource_limits:limits,provider_terms_recognized:check,
    observations,signed:false,sent:false,seller_contacted:false,independent_fulfillment_verified:false,
    scope:'single trusted-RPC FINAL snapshot only; USDC.e is fake, quotes can change, refund recovery and deployed source are unverified; burn is a diagnostic, not a commercial service'};
}
