/**
 * Read-only setup verifier for the V14 two-copy witness. The retained original
 * hash, not a caller-supplied receipt, selects one FINAL receipt lookup. It
 * reconstructs the reviewed batches and checks cumulative public state at a
 * single fresh FINAL block before allowing the witness to record verification.
 *
 * This trusts the pinned testnet RPC; it is not a consensus proof, an audit,
 * owner consent, key custody, exclusive allowlist enumeration, or proof that
 * no other transaction is in flight. It never signs, prompts, broadcasts, or
 * authorizes an automatic retry. The live wallet/runner paths remain disabled.
 */
import {isDeepStrictEqual} from 'node:util';
import {ReadOnlyNearReceiptProvider} from './read-only-near-receipts.mjs';
import {readPinnedJsonView} from './read-only-near-rpc.mjs';
import {prepareV14PhoneAttempt,inspectV14PhoneAttempt} from './native-v14-phone-receipts.mjs';
import {verifyV14PhoneResearchPlan} from './native-v14-phone-plan.mjs';
import {deriveV14OriginalBinding} from './v14-original-witness.mjs';
import {assertFreshFinalBlock} from '../shared/fresh-final-block.mjs';
import {hasPlainOwnerProfileAt} from '../shared/plain-owner-profile.mjs';
import {pinnedAccessKeyNonce} from '../shared/pinned-access-key-nonce.mjs';
import {isTransactionHash} from '../shared/direct-payment-settlement.mjs';

export const V14_SETUP_TESTNET_RPC='https://test.rpc.fastnear.com/';
const MAX=(1n<<128n)-1n;
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>record(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const amount=x=>typeof x==='string'&&/^(?:0|[1-9][0-9]{0,38})$/.test(x)&&BigInt(x)<=MAX?BigInt(x):null;
const localCode=x=>record(x)&&(x.global_contract_hash===undefined||x.global_contract_hash===null)&&
  (x.global_contract_account_id===undefined||x.global_contract_account_id===null)&&
  (x.state===undefined||x.state==='initialized')&&(x.bootstrap_nonce===undefined||x.bootstrap_nonce===null);
const success=new Set(['FINAL_RESEARCH_V14_LOADER_AND_UPGRADE_MATCH','FINAL_RESEARCH_V14_SETUP_RECEIPT_MATCH','FINAL_LOCAL_ADD_KEYS_OUTCOME_MATCH']);
const unfunded='BLOCKED: insufficient vault balance (fund first)';
const permitted='ok: within cap, payee allowed, daily ok, vault funded';
const fail=()=>new Error('V14 setup original or fresh state is unresolved; stop and reconcile the retained hash without another prompt');

/** Create the mandatory setup callback for createV14OriginalWitness. All plan
 * inputs are copied and reconstructed up front; a mutable caller cannot alter
 * the review or artifact bytes while the original is being checked. `provider`
 * must be the read-only receipt transport at the fixed testnet RPC. */
export function createV14SetupRpcVerifier({planInputs,provider,now=Date.now}={}) {
  if(!(provider instanceof ReadOnlyNearReceiptProvider)||provider.connection?.url!==V14_SETUP_TESTNET_RPC||
      typeof now!=='function'||!record(planInputs))throw fail();
  let inputs,plan;
  try { inputs=structuredClone(planInputs);plan=verifyV14PhoneResearchPlan(inputs); }
  catch {throw fail();}
  const review=plan.review;
  return async function verifySetupReceipt({binding,stageId,txHash,proof}={}) {
    if(provider.connection?.url!==V14_SETUP_TESTNET_RPC||proof!==undefined||!isTransactionHash(txHash)||typeof stageId!=='string')throw fail();
    let expected;
    try { expected=deriveV14OriginalBinding({...inputs,scopeId:binding?.scope_id}); }
    catch {throw fail();}
    if(!isDeepStrictEqual(binding,expected))throw fail();
    const index=review.stages.findIndex(stage=>stage.id===stageId);
    if(index<0)throw fail();
    try {
      if((await provider.viewNodeStatus())?.chain_id!=='testnet')throw fail();
      // This is one read of the original; no retry or caller-supplied evidence.
      const result=await provider.txStatusReceipts(txHash,review.owner,'FINAL');
      const attempt=prepareV14PhoneAttempt({...inputs,stageId,trustedOriginalHash:txHash});
      const receipt=inspectV14PhoneAttempt({...inputs,attempt,result,trustedOriginalHash:txHash});
      if(!success.has(receipt.status)||receipt.tx_hash!==txHash)throw fail();

      const started=now(),block=await provider.viewBlock({finality:'final'}),{hash}=assertFreshFinalBlock(block,started);
      if(!Number.isSafeInteger(block.header.height)||block.header.height<1)throw fail();
      const query=(request_type,account_id)=>provider.query({request_type,account_id,block_id:hash});
      const view=(method,args={})=>readPinnedJsonView(provider,hash,review.vault,method,args);
      const [owner,ownerKeys,vault,vaultKeys,protocol,version,vaultOwner,tracked]=await Promise.all([
        query('view_account',review.owner),query('view_access_key_list',review.owner),
        query('view_account',review.vault),query('view_access_key_list',review.vault),
        provider.experimental_protocolConfig({blockId:hash}),view('contract_version'),view('get_owner'),view('vault_balance',{token:'native'}),
      ]);
      const cost=amount(protocol?.runtime_config?.storage_amount_per_byte),balance=amount(vault?.amount),ledger=amount(tracked);
      if(owner?.block_hash!==hash||ownerKeys?.block_hash!==hash||vault?.block_hash!==hash||vaultKeys?.block_hash!==hash||
          !Array.isArray(ownerKeys.keys)||ownerKeys.keys.length>1000||
          !ownerKeys.keys.every(key=>record(key)&&typeof key.public_key==='string'&&record(key.access_key))||
          new Set(ownerKeys.keys.map(key=>key.public_key)).size!==ownerKeys.keys.length||
          !Array.isArray(vaultKeys.keys)||vaultKeys.keys.length!==0||
          !Number.isSafeInteger(vault.storage_usage)||vault.storage_usage<0||protocol?.chain_id!=='testnet'||
          cost===null||cost===0n||balance===null||ledger===null)throw fail();
      const ownerKey=ownerKeys.keys.find(key=>key.public_key===review.owner_public_key);
      if(!hasPlainOwnerProfileAt(owner,hash)||ownerKey?.access_key?.permission!=='FullAccess'||
          pinnedAccessKeyNonce(ownerKey?.access_key?.nonce)===null||!localCode(vault)||
          vault.code_hash!==review.artifacts.vault_code_hash||version!=='bouncer-agent-v14-native-storage-testnet'||
          vaultOwner!==review.owner)throw fail();
      const funded=index>=4;
      if(ledger!==(funded?BigInt(review.native_deposit_yocto):0n)||balance<ledger+BigInt(vault.storage_usage)*cost)throw fail();

      const compute=review.mission.goals.find(item=>['random','market'].includes(item.kind));
      const api=review.mission.goals.find(item=>item.kind==='oracle');
      const storage=review.mission.goals.find(item=>item.kind==='storage');
      const configured=[compute,api,storage].slice(0,Math.min(index,3));
      for(const {kind,goal} of configured) {
        const payee=kind==='storage'?review.vault:'outlayer.testnet';
        const routeMethod=['random','market'].includes(kind)?'get_outlayer_program':
          kind==='oracle'?'get_outlayer_native_project':'get_native_storage_route';
        const [policy,route,grant,verdict]=await Promise.all([
          view('get_policy',{policy_id:goal.policy_id}),view(routeMethod,{policy_id:goal.policy_id}),
          view('is_agent_key_allowed',{policy_id:goal.policy_id,public_key:review.agent_public_keys[goal.id]}),
          view('check',{policy_id:goal.policy_id,payee,amount:goal.amount}),
        ]);
        if(!isDeepStrictEqual(policy,{token:'native',per_tx_cap:goal.amount,daily_cap:review.rolling_caps_yocto[goal.id]})||
            !isDeepStrictEqual(route,['random','market'].includes(kind)?goal.program:goal.route)||grant!==true||
            !isDeepStrictEqual(verdict,funded?[true,permitted]:[false,unfunded]))throw fail();
      }
      for(const {kind,goal} of review.mission.goals) {
        const key=ownerKeys.keys.find(item=>item.public_key===review.agent_public_keys[goal.id]);
        if(index<5) { if(key)throw fail(); continue; }
        const permission=key?.access_key?.permission?.FunctionCall;
        const method=['random','market'].includes(kind)?'execute_outlayer':
          kind==='oracle'?'execute_outlayer_native_project':'execute_native_storage';
        if(!exact(key?.access_key?.permission,['FunctionCall'])||!exact(permission,['allowance','receiver_id','method_names'])||
            permission.receiver_id!==review.vault||!isDeepStrictEqual(permission.method_names,[method])||
            pinnedAccessKeyNonce(key?.access_key?.nonce)===null||amount(permission.allowance)!==BigInt(review.agent_gas_allowances_yocto[goal.id]))throw fail();
      }
      const finished=now();
      if(!Number.isSafeInteger(finished)||finished<started||provider.connection?.url!==V14_SETUP_TESTNET_RPC)throw fail();
      assertFreshFinalBlock(block,finished);
      return {tx_hash:txHash,final_block_hash:hash};
    } catch {throw fail();}
  };
}
