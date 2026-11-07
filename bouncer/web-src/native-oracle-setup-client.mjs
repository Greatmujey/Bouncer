/**
 * Experimental phone-side native setup transport. No UI imports this module by
 * default. A separately operated checkpoint, safe custody/recovery and a real
 * device/wallet test remain prerequisites before live use. This code cannot
 * purchase a resource or broadcast directly. `approveStage` asks the wallet
 * for one exact reviewed transaction only after authenticated one-shot claim;
 * a lost claim/result must be reconciled and must NEVER be retried.
 */
import { signReviewedNativeSetupChallenge } from './native-oracle-setup-auth.mjs';
import { prepareNativeOracleSetupWalletPrompt } from './native-oracle-setup-wallet-prompt.mjs';
import { withReadOnlyRelay } from './buffer-readiness-preview.mjs';

const OWNER='great_mujey.testnet', PREFIX='/api/native-oracle-setup/', BYTES=452_675;
const HEADERS={'x-bouncer-preview':'native-oracle-setup-v1'};
const STAGES=['create_keyless_native_vault','configure_native_oracle_policy','fund_native_vault','install_native_oracle_agent'];
const codes=new Set(['UNAUTHENTICATED','OWNER_FENCED','OWNER_ALREADY_WITNESSED','ALREADY_CLAIMED','WITNESS_NOT_CLAIMABLE',
  'WITNESS_COMMIT_UNKNOWN','WITNESS_MISMATCH','WITNESS_HEAD_CHANGED','CROSS_FLOW_WITNESSED','GLOBAL_FENCE_UNSAFE',
  'GLOBAL_FENCE_LEGACY_RECONCILIATION_REQUIRED','PREFLIGHT_UNAVAILABLE','PREFLIGHT_BLOCKED','PREFLIGHT_STALE',
  'CLAIM_COMMITTED_PREFLIGHT_STALE','WITNESSED_CLAIM_STALE','WITNESSED_POSTCHECK_UNAVAILABLE',
  'PRIOR_UNRESOLVED','RECEIPT_UNKNOWN','MISMATCH','DATABASE_UNKNOWN']);
const fail=code=>{const error=new Error(code);error.code=code;return error};
async function bounded(response,max) {
  const length=response.headers?.get?.('content-length');
  if(length!==null && length!==undefined && (!/^\d+$/.test(length) || Number(length)>max))throw fail('NATIVE_SETUP_UNAVAILABLE');
  if(!response.body?.getReader)throw fail('NATIVE_SETUP_UNAVAILABLE');
  const reader=response.body.getReader(),parts=[];let count=0;
  try { while(true){const {value,done}=await reader.read();if(done)break;count+=value.length;
    if(count>max){await reader.cancel();throw fail('NATIVE_SETUP_UNAVAILABLE')}parts.push(value)} }
  finally {reader.releaseLock()}
  const out=new Uint8Array(count);let offset=0;for(const part of parts){out.set(part,offset);offset+=part.length}return out;
}
export function createNativeOracleSetupClient({wallet,accountId,ownerPublicKey,deviceStore,location,crypto,
  fetch:fetchImpl=globalThis.fetch,isCurrent,isTopLevel,now=Date.now,onProgress=()=>{},relay=withReadOnlyRelay}={}) {
  if(accountId!==OWNER || !wallet || typeof wallet.signMessage!=='function' || typeof ownerPublicKey!=='string' ||
      !deviceStore || typeof deviceStore.inspect!=='function' || !location || !crypto?.subtle || typeof fetchImpl!=='function' ||
      typeof isCurrent!=='function' || isTopLevel!==true || typeof now!=='function' || typeof onProgress!=='function' || typeof relay!=='function') {
    throw fail('NATIVE_SETUP_UNAVAILABLE');
  }
  const session=()=>{if(isCurrent()!==true)throw fail('NATIVE_SETUP_SESSION_CHANGED')};
  const context=purpose=>({purpose,owner:OWNER,ownerPublicKey});
  async function request(route,data) {
    session();let response,body;
    try {
      response=await fetchImpl(`${PREFIX}${route}`,{method:'POST',credentials:'same-origin',cache:'no-store',
        headers:{...HEADERS,'content-type':'application/json'},body:JSON.stringify(data)});
      body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await bounded(response,64_000)));
    }catch{throw fail('NATIVE_SETUP_RESULT_UNKNOWN')}
    if(!response.ok)throw fail(codes.has(body?.error)?body.error:'NATIVE_SETUP_RESULT_UNKNOWN');return body;
  }
  const pump=work=>relay({fetch:fetchImpl,work,onProgress,now});
  const sign=(ctx,challenge)=>{session();return signReviewedNativeSetupChallenge({wallet,context:ctx,challenge,location,crypto,fetch:fetchImpl,now})};
  async function device(review) {
    session();if(review?.owner!==OWNER || typeof review.vault!=='string' || typeof review.agent_public_key!=='string')throw fail('NATIVE_SETUP_UNAVAILABLE');
    const result=await deviceStore.inspect({owner:OWNER,vault:review.vault,expected_public_key:review.agent_public_key});session();
    if(result?.status!=='LOCAL_DEVICE_KEY_AVAILABLE' || result.owner!==OWNER || result.vault!==review.vault || result.origin!==location.origin ||
       result.public_key!==review.agent_public_key || result.expected_public_key_matched!==true || result.private_key_exportable!==false ||
       result.local_storage_only!==true || result.signing_authorized!==false)throw fail('NATIVE_DEVICE_KEY_UNAVAILABLE');
    return result;
  }
  async function artifact() {
    session();let response;
    try{response=await fetchImpl(`${PREFIX}artifact`,{headers:HEADERS,credentials:'same-origin',cache:'no-store'})}catch{throw fail('NATIVE_SETUP_UNAVAILABLE')}
    if(!response.ok)throw fail('NATIVE_SETUP_UNAVAILABLE');const data=await bounded(response,BYTES);
    if(data.length!==BYTES)throw fail('NATIVE_SETUP_UNAVAILABLE');return data;
  }
  return Object.freeze({
    async enabled() {
      session();try{const response=await fetchImpl(`${PREFIX}config`,{headers:HEADERS,credentials:'same-origin',cache:'no-store'});
        const body=JSON.parse(new TextDecoder().decode(await bounded(response,4096)));
        return response.ok && body?.enabled===true && body.network==='testnet' && body.owner===OWNER && body.ready_for_real_spending===false;
      }catch{return false}
    },
    /** Generate only an unsigned fixed testnet review for an already retained
     * local device key. Creating a key or trusting its backup is a separate step. */
    async createReview({agentPublicKey}={}) {
      await device({owner:OWNER,vault:`native.${OWNER}`,agent_public_key:agentPublicKey});
      const result=await request('review',{agentPublicKey});
      if(!/^[a-f0-9]{32}$/.test(result?.task_id??'') || result?.review?.owner!==OWNER ||
         result.review.vault!==`native.${OWNER}` || result.review.agent_public_key!==agentPublicKey ||
         result.signing_authorized!==false || result.transaction_sent!==false)throw fail('NATIVE_SETUP_UNAVAILABLE');
      await device(result.review);return result;
    },
    async reserve({taskId,review}={}) {
      session();if(!/^[a-f0-9]{32}$/.test(taskId??''))throw fail('NATIVE_SETUP_UNAVAILABLE');
      await device(review);
      const challenge=await request('reserve-challenge',{taskId,ownerPublicKey});
      const evidence=await sign({...context('reserve_native_setup'),review},challenge);
      return pump(()=>request('reserve',{taskId,ownerPublicKey,evidence}));
    },
    /** Call only from an explicit owner action after reviewing this exact stage. */
    async approveStage({identity,review,stageId}={}) {
      session();if(!STAGES.includes(stageId) || identity?.owner_public_key!==ownerPublicKey)throw fail('NATIVE_SETUP_UNAVAILABLE');
      onProgress(stageId===STAGES[0]?'Verifying the reviewed vault code…':'Preparing the reviewed native testnet action…');
      const deviceKey=await device(review),wasmBytes=stageId===STAGES[0]?await artifact():undefined;
      const prompt=await prepareNativeOracleSetupWalletPrompt({wallet,identity,review,deviceKey,stageId,wasmBytes,location,isTopLevel,crypto,now});
      session();const challenge=await request('claim-challenge',{identity,stageId});
      const evidence=await sign({...context('claim_native_setup_stage'),identity,stageId},challenge);
      const claim=await pump(()=>request('claim',{identity,stageId,evidence}));session();
      return prompt.invoke(claim);
    },
    async recordOriginal({identity,stageId,originalHash}={}) {
      session();const challenge=await request('original-challenge',{identity,stageId,originalHash});
      const evidence=await sign({...context('record_native_setup_original'),identity,stageId,originalHash},challenge);
      return pump(()=>request('original',{identity,stageId,originalHash,evidence}));
    },
    async inspect() {
      session();const challenge=await request('inspect-challenge',{ownerPublicKey});
      const evidence=await sign(context('inspect_native_setup'),challenge);
      return pump(()=>request('inspect',{ownerPublicKey,evidence}));
    },
    async previewOriginal({stageId,originalHash}={}) {
      session();const challenge=await request('inspect-challenge',{ownerPublicKey});
      const evidence=await sign(context('inspect_native_setup'),challenge);
      return pump(()=>request('preview-original',{ownerPublicKey,stageId,originalHash,evidence}));
    },
    async verifyCompletion({identity}={}) {
      session();const challenge=await request('completion-challenge',{identity});
      const evidence=await sign({...context('verify_native_setup_completion'),identity},challenge);
      return pump(()=>request('completion',{identity,evidence}));
    },
  });
}
