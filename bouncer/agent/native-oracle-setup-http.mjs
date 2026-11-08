/**
 * Experimental, opt-in same-origin bridge for authenticated native setup.
 * It does not expose a signer, broadcaster or provider purchase. The operator
 * must supply an exactly checked review, both witnessed coordinators and a
 * separately operated latest-head anchor. This handler is not mounted by
 * default and must not be treated as ready for real wallet spending.
 */
import crypto from 'node:crypto';
import { NATIVE_ORACLE_V9_BYTES, NATIVE_ORACLE_V9_SHA256 } from './native-oracle-wallet-plan.mjs';
import { NATIVE_PHONE_LOADER_BYTES, NATIVE_PHONE_LOADER_SHA256, NATIVE_PHONE_COMPRESSED_BYTES,
  NATIVE_PHONE_COMPRESSED_SHA256 } from './native-phone-loader-research.mjs';

const MAX=24_576, PREFIX='/api/native-oracle-setup/';
const specs=Object.freeze({
  review:['createReview',['agentPublicKey']],
  'reserve-challenge':['issueReservation',['taskId','ownerPublicKey','agentPublicKey']], reserve:['reserve',['taskId','ownerPublicKey','agentPublicKey','evidence']],
  'claim-challenge':['issueClaim',['identity','stageId']], claim:['claim',['identity','stageId','evidence']],
  'original-challenge':['issueOriginal',['identity','stageId','originalHash']], original:['recordOriginal',['identity','stageId','originalHash','evidence']],
  'completion-challenge':['issueCompletion',['identity']], completion:['verifyCompletion',['identity','evidence']],
  'trial-challenge':['issueTrial',['identity','goal','trial','expectedWitnessHead']],
  trial:['claimTrial',['identity','goal','trial','expectedWitnessHead','evidence','completionEvidence']],
  'inspect-challenge':['issueInspect',['ownerPublicKey']], inspect:['inspect',['ownerPublicKey','evidence']],
  'preview-original':['previewOriginal',['ownerPublicKey','stageId','originalHash','evidence']],
  'preview-trial':['previewTrial',['ownerPublicKey','evidence']],
});
const codes=new Set(['UNAUTHENTICATED','OWNER_FENCED','OWNER_ALREADY_WITNESSED','ALREADY_CLAIMED','WITNESS_NOT_CLAIMABLE',
  'WITNESS_COMMIT_UNKNOWN','WITNESS_MISMATCH','WITNESS_HEAD_CHANGED','CROSS_FLOW_WITNESSED','GLOBAL_FENCE_UNSAFE',
  'GLOBAL_FENCE_LEGACY_RECONCILIATION_REQUIRED','PREFLIGHT_UNAVAILABLE','PREFLIGHT_BLOCKED','PREFLIGHT_STALE',
  'CLAIM_COMMITTED_PREFLIGHT_STALE','WITNESSED_CLAIM_STALE','WITNESSED_POSTCHECK_UNAVAILABLE',
  'PRIOR_UNRESOLVED','RECEIPT_UNKNOWN','MISMATCH','DATABASE_UNKNOWN']);
const plain=x=>x!==null && typeof x==='object' && !Array.isArray(x) && Object.getPrototypeOf(x)===Object.prototype;
function reply(res,status,body) {
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',
    'x-content-type-options':'nosniff','referrer-policy':'no-referrer'}); res.end(JSON.stringify(body));
}
async function read(req) {
  if (req.headers['content-length'] && (!/^\d+$/.test(req.headers['content-length']) || Number(req.headers['content-length'])>MAX)) throw Error();
  let total=0;const chunks=[];for await (const chunk of req) { total+=chunk.length;if(total>MAX)throw Error();chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks,total).toString('utf8'));
}
export function createNativeOracleSetupHttpHandler({service,siteOrigin,wasmBytes,loaderBytes,compressedBytes,owner,createReview,enableTrialSubmission=false,
  enableAtomic=false,enableCompressed=false,now=Date.now,bodyTimeoutMs=10_000}={}) {
  let site;try{site=new URL(siteOrigin)}catch{throw Error('fixed native setup origin required')}
  if(site.protocol!=='https:' || site.origin!==siteOrigin || site.username || site.password || site.pathname!=='/' || site.search || site.hash ||
      site.hostname==='github.io' || site.hostname.endsWith('.github.io') || site.hostname==='madethis.website' || site.hostname.endsWith('.madethis.website') ||
      !service || Object.values(specs).some(([method])=>method!=='createReview' && typeof service[method]!=='function') ||
      (createReview!==undefined && typeof createReview!=='function') || typeof enableTrialSubmission!=='boolean' ||
      typeof enableAtomic!=='boolean' || typeof enableCompressed!=='boolean' ||
      (enableCompressed && (!(loaderBytes instanceof Uint8Array) || loaderBytes.length!==NATIVE_PHONE_LOADER_BYTES ||
        crypto.createHash('sha256').update(loaderBytes).digest('hex')!==NATIVE_PHONE_LOADER_SHA256 ||
        !(compressedBytes instanceof Uint8Array) || compressedBytes.length!==NATIVE_PHONE_COMPRESSED_BYTES ||
        crypto.createHash('sha256').update(compressedBytes).digest('hex')!==NATIVE_PHONE_COMPRESSED_SHA256)) || typeof now!=='function' ||
      !Number.isSafeInteger(bodyTimeoutMs) || bodyTimeoutMs<10 || bodyTimeoutMs>10_000 || owner!=='great_mujey.testnet' ||
      !(wasmBytes instanceof Uint8Array) || wasmBytes.length!==NATIVE_ORACLE_V9_BYTES ||
      crypto.createHash('sha256').update(wasmBytes).digest('hex')!==NATIVE_ORACLE_V9_SHA256) {
    throw Error('fixed testnet owner, origin, pinned V9 artifact and authenticated native setup service required');
  }
  const wasm=Buffer.from(wasmBytes),loader=enableCompressed?Buffer.from(loaderBytes):null,
    compressed=enableCompressed?Buffer.from(compressedBytes):null;let pending=0,requests=0,windowStart=now();
  return async function handle(req,res,pathname) {
    if(req.headers['x-bouncer-preview']!=='native-oracle-setup-v1' || (req.headers.origin && req.headers.origin!==siteOrigin)) {
      return reply(res,403,{error:'unavailable'});
    }
    if(pathname===`${PREFIX}config` && req.method==='GET') return reply(res,200,{enabled:true,network:'testnet',owner,
      ready_for_real_spending:false,review_available:typeof createReview==='function',trial_submission_enabled:enableTrialSubmission,
      atomic_review_enabled:enableAtomic,compressed_review_enabled:enableCompressed,
      scope:'Experimental testnet transport; receipt verification is separate. No production-spending readiness is claimed.'});
    if(pathname===`${PREFIX}artifact` && req.method==='GET') {
      res.writeHead(200,{'content-type':'application/wasm','content-length':String(wasm.length),'cache-control':'no-store',
        'x-content-type-options':'nosniff','referrer-policy':'no-referrer'});return res.end(wasm);
    }
    if(enableCompressed && req.method==='GET' && (pathname===`${PREFIX}loader` || pathname===`${PREFIX}compressed`)) {
      const data=pathname===`${PREFIX}loader`?loader:compressed;
      res.writeHead(200,{'content-type':'application/octet-stream','content-length':String(data.length),'cache-control':'no-store',
        'x-content-type-options':'nosniff','referrer-policy':'no-referrer'});return res.end(data);
    }
    const match=/^\/api\/native-oracle-setup\/([a-z-]+)$/.exec(pathname),spec=match && specs[match[1]];
    if(!spec || req.method!=='POST' || (spec[0]==='createReview' && !createReview))return reply(res,404,{error:'unavailable'});
    if(req.headers.origin!==siteOrigin || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??'')) return reply(res,403,{error:'unavailable'});
    const clock=now();if(!Number.isSafeInteger(clock) || clock<windowStart)return reply(res,503,{error:'unavailable'});
    if(clock-windowStart>=120_000){windowStart=clock;requests=0}if(pending>=4 || requests>=80)return reply(res,429,{error:'unavailable'});
    pending++;requests++;
    try {
      const timer=setTimeout(()=>req.destroy(),bodyTimeoutMs);timer.unref?.();let input;
      try{input=await read(req)}finally{clearTimeout(timer)}
      const [method,baseFields]=spec, fields=method==='createReview' && (enableAtomic || enableCompressed) ? ['agentPublicKey','ownerPublicKey'] : baseFields;
      if(!plain(input) || Object.keys(input).length!==fields.length || fields.some(k=>!Object.hasOwn(input,k)))return reply(res,400,{error:'invalid request'});
      return reply(res,200,await (method==='createReview'?createReview(input):service[method](input)));
    } catch(error) {
      return reply(res,409,{error:codes.has(error?.code)?error.code:'NATIVE_SETUP_UNAVAILABLE',do_not_retry_wallet_prompt:true,
        message:'Stop and reconcile any existing original before another wallet prompt.'});
    } finally { pending--; }
  };
}
