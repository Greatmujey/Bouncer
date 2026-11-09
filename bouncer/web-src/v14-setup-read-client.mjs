/** Fixed same-origin client for default-off, read-only V14 setup checks.
 * The browser must separately retain and validate the reviewed digest and the
 * two-copy witness. Neither server response is wallet approval or an audit. */
import {V14_ENROLLMENT_SITE,V14_ENROLLMENT_RECIPIENT} from './v14-checkpoint-enrollment.mjs';
import {v14KitSha256} from './v14-checkpoint-enrollment-kit.mjs';
import {isV14BrowserOriginalWitness} from './v14-browser-original-witness.mjs';
import {inspectV14PublicHistory} from './v14-checkpoint-history.mjs';

const fail=()=>new Error('V14 setup checks are unavailable or uncertain; preserve the original and never repeat a claimed prompt');
const exact=(x,fields)=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===fields.length&&fields.every(field=>Object.hasOwn(x,field));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function hash(value) {
  const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  if(typeof value!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))return false;
  let number=0n;for(const char of value)number=number*58n+BigInt(alphabet.indexOf(char));
  let count=0;while(number){count++;number>>=8n}for(let i=0;value[i]==='1';i++)count++;
  return count===32;
}
async function bounded(response,limit) {
  if(!response?.ok||!/^application\/json(?:\s*;|$)/i.test(response.headers?.get('content-type')??'')||!response.body?.getReader)throw fail();
  const reader=response.body.getReader(),chunks=[];let size=0;
  try {for(;;){const {done,value}=await reader.read();if(done)break;
    if(!(value instanceof Uint8Array)||(size+=value.byteLength)>limit){await reader.cancel();throw fail()}chunks.push(value)}}
  finally{reader.releaseLock()}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}

export async function createV14SetupReadClient({review,trustedReviewSha256,scopeId,location=globalThis.location,
    fetch:fetchImpl=globalThis.fetch,isCurrent=()=>true,crypto=globalThis.crypto,now=Date.now}={}) {
  if(location?.origin!==V14_ENROLLMENT_SITE||location?.host!==V14_ENROLLMENT_RECIPIENT||
      !/^[a-f0-9]{64}$/.test(trustedReviewSha256??'')||!/^[a-f0-9]{32}$/.test(scopeId??'')||
      typeof fetchImpl!=='function'||typeof isCurrent!=='function'||!crypto?.subtle||typeof now!=='function')throw fail();
  const original=structuredClone(review),unsigned={...original};delete unsigned.review_sha256;
  if(original?.review_sha256!==trustedReviewSha256||!Array.isArray(original.stages)||original.stages.length!==6||
      await v14KitSha256(crypto,JSON.stringify(unsigned))!==trustedReviewSha256)throw fail();
  const current=()=>{if(isCurrent()!==true)throw fail()};current();
  async function send(action,input) {
    current();const text=JSON.stringify(input);
    if(new TextEncoder().encode(text).length>(action==='completed-history'?48_000:24_000))throw fail();
    try {
      const response=await fetchImpl(`/api/native-mission/v14-${action}`,{method:'POST',credentials:'omit',redirect:'error',
        cache:'no-store',referrerPolicy:'no-referrer',headers:{'content-type':'application/json','x-bouncer-native-mission':'v1'},
        body:text,signal:AbortSignal.timeout(110_000)});
      current();const value=await bounded(response,4096);current();return value;
    }catch{throw fail()}
  }
  return Object.freeze({
    async preflight({review:provided,scopeId:providedScope,stageId,prior}={}) {
      current();const stage=original.stages.find(item=>item.id===stageId),index=original.stages.indexOf(stage);
      if(!same(provided,original)||providedScope!==scopeId||index<0||!Array.isArray(prior)||prior.length!==index)throw fail();
      const snapshot=structuredClone(prior),result=await send('preflight',{review:original,scopeId,stageId,prior:snapshot});
      const fields=['status','network','owner','vault','stage_id','review_sha256','action_commitment_sha256','prior_original_hashes',
        'final_block_hash','checked_at_ms','wallet_transaction_authorized','transaction_sent'],time=now();
      if(!exact(result,fields)||result.status!=='V14_SETUP_PREFLIGHT_MATCH'||result.network!=='testnet'||result.owner!==original.owner||
          result.vault!==original.vault||result.stage_id!==stageId||result.review_sha256!==trustedReviewSha256||
          result.action_commitment_sha256!==stage.action_commitment_sha256||!same(result.prior_original_hashes,snapshot.map(item=>item.tx_hash))||
          !hash(result.final_block_hash)||!Number.isSafeInteger(result.checked_at_ms)||!Number.isSafeInteger(time)||time<result.checked_at_ms||
          time-result.checked_at_ms>5_000||result.wallet_transaction_authorized!==false||result.transaction_sent!==false)throw fail();
      return result;
    },
    async verifySetupReceipt({binding,stageId,txHash,proof}={}) {
      current();
      if(proof!==undefined||binding?.scope_id!==scopeId||binding?.network!=='testnet'||binding?.owner!==original.owner||
          binding?.vault!==original.vault||binding?.review_sha256!==trustedReviewSha256||!same(binding?.public_review,original)||
          !original.stages.some(stage=>stage.id===stageId)||!hash(txHash))throw fail();
      const result=await send('receipt',{review:original,scopeId,stageId,txHash});
      if(!exact(result,['tx_hash','final_block_hash'])||result.tx_hash!==txHash||!hash(result.final_block_hash))throw fail();
      return result;
    },
    // Public history only. This cannot move keys or journals, establish an
    // independent latest head, approve a wallet action, or authorize spending.
    async verifyCompletedSetupHistory({witness}={}) {
      current();if(!isV14BrowserOriginalWitness(witness)||typeof witness.history!=='function')throw fail();
      const history=await witness.history();current();
      const state=await inspectV14PublicHistory({snapshot:{status:'EXISTING_CHECKPOINT',scope_id:scopeId,...history},
        owner:original.owner,vault:original.vault,crypto});current();
      if(history.revision!==19||state.pending!==null||state.next_setup_stage!==null||state.setup.length!==6||
          state.mission.length!==0||!same(state.review,original))throw fail();
      const result=await send('completed-history',{scopeId,history});
      const fields=['status','network','scope_id','owner','vault','review_sha256','witness_revision','witness_head_sha256',
        'original_hashes','final_block_hash','checked_at_ms','independent_freshness_proven','journal_restored','transaction_authorized'],time=now();
      if(!exact(result,fields)||result.status!=='V14_COMPLETED_SETUP_HISTORY_MATCH'||result.network!=='testnet'||
          result.scope_id!==scopeId||result.owner!==original.owner||result.vault!==original.vault||
          result.review_sha256!==trustedReviewSha256||result.witness_revision!==history.revision||
          result.witness_head_sha256!==history.head_sha256||!same(result.original_hashes,state.setup.map(item=>item.tx_hash))||
          !hash(result.final_block_hash)||!Number.isSafeInteger(result.checked_at_ms)||!Number.isSafeInteger(time)||time<result.checked_at_ms||
          time-result.checked_at_ms>5_000||result.independent_freshness_proven!==false||result.journal_restored!==false||
          result.transaction_authorized!==false||!same(await witness.history(),history))throw fail();
      current();return result;
    },
  });
}
