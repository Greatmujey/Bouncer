/**
 * Read-only V14 research setup completion snapshot. Requires every separately
 * retained original in order and trusted-RPC receipt evidence, then compares
 * public account, policy and key views at ONE fresh FINAL block. It is not a
 * wallet prompt fence, consent, signature, custody proof, provider-delivery
 * proof, independent allowlist enumeration, or authorization to spend.
 */
import { isDeepStrictEqual } from 'node:util';
import { verifyV14PhoneResearchPlan } from './native-v14-phone-plan.mjs';
import { inspectV14PhoneAttempt } from './native-v14-phone-receipts.mjs';
import { readPinnedJsonView } from './read-only-near-rpc.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { hasPlainOwnerProfileAt } from '../shared/plain-owner-profile.mjs';
import { pinnedAccessKeyNonce } from '../shared/pinned-access-key-nonce.mjs';

const MAX=(1n<<128n)-1n;
const record=x=>x!==null && typeof x==='object' && !Array.isArray(x);
const exact=(x,keys)=>record(x) && Object.keys(x).length===keys.length && keys.every(k=>Object.hasOwn(x,k));
const amount=x=>typeof x==='string' && /^(?:0|[1-9][0-9]{0,38})$/.test(x) && BigInt(x)<=MAX?BigInt(x):null;
const localCode=x=>record(x) && (x.global_contract_hash===undefined||x.global_contract_hash===null) &&
  (x.global_contract_account_id===undefined||x.global_contract_account_id===null) &&
  (x.state===undefined||x.state==='initialized') && (x.bootstrap_nonce===undefined||x.bootstrap_nonce===null);

/** Every argument is public; original hashes and review digest require independent retention. */
export async function inspectV14PhoneSetupCompletion({prior=[],provider,now=Date.now,...inputs}={}) {
  const plan=verifyV14PhoneResearchPlan(inputs),review=plan.review,stages=review.stages;
  if(!Array.isArray(prior) || prior.length!==stages.length)throw new Error('every earlier V14 original is required');
  const hashes=new Set();
  for(let i=0;i<stages.length;i++) {
    const item=prior[i];
    if(!exact(item,['attempt','trustedOriginalHash','result']) || item.attempt?.stage_id!==stages[i].id ||
        !isTransactionHash(item.trustedOriginalHash) || hashes.has(item.trustedOriginalHash))throw new Error('earlier original is missing, repeated or out of order');
    hashes.add(item.trustedOriginalHash);
    const proof=inspectV14PhoneAttempt({...inputs,...item});
    if(!['FINAL_RESEARCH_V14_LOADER_AND_UPGRADE_MATCH','FINAL_RESEARCH_V14_SETUP_RECEIPT_MATCH','FINAL_LOCAL_ADD_KEYS_OUTCOME_MATCH'].includes(proof.status)) {
      throw new Error('an earlier V14 original failed or is unresolved; reconcile without resending');
    }
  }
  if(typeof now!=='function' || !provider || ['viewNodeStatus','viewBlock','query','callFunctionRaw','experimental_protocolConfig']
      .some(name=>typeof provider[name]!=='function'))throw new Error('read-only testnet provider required');
  if((await provider.viewNodeStatus())?.chain_id!=='testnet')throw new Error('RPC must report testnet');
  const started=now(),block=await provider.viewBlock({finality:'final'}),{hash}=assertFreshFinalBlock(block,started);
  if(!Number.isSafeInteger(block.header.height) || block.header.height<1)throw new Error('invalid FINAL block height');
  const query=(request_type,account_id)=>provider.query({request_type,account_id,block_id:hash});
  const view=(method,args={})=>readPinnedJsonView(provider,hash,review.vault,method,args);
  const [owner,ownerKeys,vault,vaultKeys,protocol,version,vaultOwner,tracked]=await Promise.all([
    query('view_account',review.owner),query('view_access_key_list',review.owner),query('view_account',review.vault),
    query('view_access_key_list',review.vault),provider.experimental_protocolConfig({blockId:hash}),
    view('contract_version'),view('get_owner'),view('vault_balance',{token:'native'})]);
  const cost=amount(protocol?.runtime_config?.storage_amount_per_byte),balance=amount(vault?.amount),ledger=amount(tracked);
  if(owner?.block_hash!==hash || ownerKeys?.block_hash!==hash || vault?.block_hash!==hash || vaultKeys?.block_hash!==hash ||
      !Array.isArray(ownerKeys.keys) || ownerKeys.keys.length>1000 ||
      !ownerKeys.keys.every(k=>record(k)&&typeof k.public_key==='string'&&record(k.access_key)) ||
      new Set(ownerKeys.keys.map(k=>k.public_key)).size!==ownerKeys.keys.length ||
      !Array.isArray(vaultKeys.keys) || vaultKeys.keys.length>1000 || !Number.isSafeInteger(vault.storage_usage) || vault.storage_usage<0 ||
      protocol?.chain_id!=='testnet' || cost===null || cost===0n || balance===null || ledger===null) {
    throw new Error('malformed or mixed-block V14 completion views');
  }
  const ownerKey=ownerKeys.keys.find(k=>k.public_key===review.owner_public_key),ownerNonce=pinnedAccessKeyNonce(ownerKey?.access_key?.nonce);
  const checks={plain_owner:hasPlainOwnerProfileAt(owner,hash),owner_full_access:ownerKey?.access_key?.permission==='FullAccess' && ownerNonce!==null,
    exact_keyless_vault:localCode(vault) && vault.code_hash===review.artifacts.vault_code_hash && vaultKeys.keys.length===0 &&
      version==='bouncer-agent-v14-native-storage-testnet' && vaultOwner===review.owner,
    deposited_and_storage_backed:ledger===BigInt(review.native_deposit_yocto) && balance>=ledger+BigInt(vault.storage_usage)*cost};
  const perGoal=await Promise.all(review.mission.goals.map(async({kind,goal})=>{
    const id=goal.id,policyId=goal.policy_id,publicKey=review.agent_public_keys[id];
    const method=kind==='random'?'execute_outlayer':kind==='oracle'?'execute_outlayer_native_project':'execute_native_storage';
    const payee=kind==='storage'?review.vault:'outlayer.testnet';
    const routeMethod=kind==='random'?'get_outlayer_program':kind==='oracle'?'get_outlayer_native_project':'get_native_storage_route';
    const [policy,route,grant,verdict]=await Promise.all([view('get_policy',{policy_id:policyId}),view(routeMethod,{policy_id:policyId}),
      view('is_agent_key_allowed',{policy_id:policyId,public_key:publicKey}),view('check',{policy_id:policyId,payee,amount:goal.amount})]);
    const agent=ownerKeys.keys.find(k=>k.public_key===publicKey),permission=agent?.access_key?.permission?.FunctionCall;
    const allowance=amount(permission?.allowance),nonce=pinnedAccessKeyNonce(agent?.access_key?.nonce);
    return {id,policy:isDeepStrictEqual(policy,{token:'native',per_tx_cap:goal.amount,daily_cap:review.rolling_caps_yocto[id]}),
      route:isDeepStrictEqual(route,kind==='random'?goal.program:goal.route),grant:grant===true,
      allowed:Array.isArray(verdict)&&verdict.length===2&&verdict[0]===true,
      agent_key:exact(agent?.access_key?.permission,['FunctionCall']) && exact(permission,['allowance','receiver_id','method_names']) &&
        permission.receiver_id===review.vault && isDeepStrictEqual(permission.method_names,[method]) && nonce!==null &&
        allowance!==null && allowance===BigInt(review.agent_gas_allowances_yocto[id])};
  }));
  for(const goal of perGoal) for(const [name,ok] of Object.entries(goal))if(name!=='id')checks[`${goal.id}_${name}`]=ok;
  const finished=now();
  if(!Number.isSafeInteger(finished)||finished<started)throw new Error('local clock moved backwards');
  assertFreshFinalBlock(block,finished);
  const blockers=Object.keys(checks).filter(k=>checks[k]!==true);
  return {status:blockers.length?'BLOCKED_OR_UNKNOWN':'ORIGINALS_AND_SETUP_SNAPSHOT_MATCH_NOT_AUTHORIZED',network:'testnet',
    owner:review.owner,vault:review.vault,review_sha256:review.review_sha256,prior_original_hashes:[...hashes],
    block_hash:hash,block_height:block.header.height,observed_at:new Date(finished).toISOString(),checks,blockers,
    owner_approval_obtained:false,wallet_prompt_authorized:false,signing_authorized:false,transaction_sent:false,
    independent_delivery_verified:false,local_key_custody_verified:false,no_inflight_request_proven:false,
    scope:'trusted-RPC single FINAL snapshot and supplied originals; no exclusive payee/agent enumeration, custody, consent, prompt fence, reservation, provider fulfillment or code audit'};
}
