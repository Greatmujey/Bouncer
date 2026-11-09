/**
 * Default-off, read-only V14 setup service. Uses bundled public research
 * artifacts and a fixed testnet read-only RPC; receives no wallet keys,
 * passphrases, signatures, bearer capabilities or signed transactions.
 *
 * A request's review hash is only a consistency check: the browser must bind
 * its own separately retained digest, the signed enrollment and both witness
 * copies. This service cannot authorize prompts or prove the loader safe.
 * It is not mounted in the live website or Railway standby.
 */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {isDeepStrictEqual} from 'node:util';
import {V14_PHONE_RESEARCH_ARTIFACTS as pins,V14_PHONE_RESEARCH_SIZES as sizes} from '../shared/v14-phone-research-artifacts.mjs';
import {V14_TESTNET_ARTIFACT} from '../shared/v14-testnet-artifact.mjs';
import {ReadOnlyNearReceiptProvider} from './read-only-near-receipts.mjs';
import {V14_SETUP_TESTNET_RPC,createV14SetupRpcVerifier} from './v14-setup-rpc-verifier.mjs';
import {createV14SetupStagePreflight,createV14CompletedSetupHistoryVerifier} from './v14-setup-stage-preflight.mjs';
import {verifyV14PhoneResearchPlan} from './native-v14-phone-plan.mjs';
import {deriveV14OriginalBinding} from './v14-original-witness.mjs';

const exact=(x,fields)=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&
  Object.keys(x).length===fields.length&&fields.every(field=>Object.hasOwn(x,field));
const sha=value=>createHash('sha256').update(value).digest('hex');
const fail=()=>new Error('V14 read-only setup verification unavailable; preserve originals and do not retry a claimed prompt');
function checkedArtifacts() {
  try {
    const loader=readFileSync(new URL('../web/artifacts/v14-research-loader.wasm',import.meta.url));
    const compressed=readFileSync(new URL('../web/artifacts/v14-research.deflate',import.meta.url));
    const expanded=inflateRawSync(compressed,{maxOutputLength:sizes.vault,info:true}),vault=expanded.buffer;
    if(loader.length!==sizes.loader||compressed.length!==sizes.compressed||vault.length!==sizes.vault||
        expanded.engine.bytesWritten!==compressed.length||sha(loader)!==pins.loader_sha256||sha(compressed)!==pins.compressed_sha256||
        sha(vault)!==pins.vault_sha256||pins.vault_sha256!==V14_TESTNET_ARTIFACT.sha256||sizes.vault!==V14_TESTNET_ARTIFACT.bytes)throw fail();
    return {loader,compressed,vault};
  }catch{throw fail()}
}

/** Binds no port and sends no transaction. */
export function createV14SetupReadService({provider,now=Date.now}={}) {
  if(!(provider instanceof ReadOnlyNearReceiptProvider)||provider.connection?.url!==V14_SETUP_TESTNET_RPC||typeof now!=='function')throw fail();
  const artifacts=checkedArtifacts();
  function planFor(rawReview,scopeId) {
    let review;
    try {review=structuredClone(rawReview);}catch{throw fail()}
    if(!review||typeof review!=='object'||Array.isArray(review)||Buffer.byteLength(JSON.stringify(review),'utf8')>20_000||
        !/^[a-f0-9]{32}$/.test(scopeId??''))throw fail();
    const inputs={mission:review.mission,ownerPublicKey:review.owner_public_key,agentPublicKeys:review.agent_public_keys,
      gasAllowances:review.agent_gas_allowances_yocto,dailyCaps:review.rolling_caps_yocto,
      vaultStorageFundingYocto:review.vault_storage_funding_yocto,nativeDepositYocto:review.native_deposit_yocto,
      vaultWasm:artifacts.vault,loaderWasm:artifacts.loader,compressed:artifacts.compressed,
      trustedArtifacts:{vault_sha256:pins.vault_sha256,loader_sha256:pins.loader_sha256},
      review,trustedReviewSha256:review.review_sha256};
    const checked=verifyV14PhoneResearchPlan(inputs),binding=deriveV14OriginalBinding({...inputs,scopeId});
    if(!isDeepStrictEqual(checked.review,review)||!isDeepStrictEqual(binding.public_review,review))throw fail();
    return {inputs,binding,review};
  }
  return Object.freeze({
    async preflight(request) {
      try {
        if(!exact(request,['review','scopeId','stageId','prior']))throw fail();
        const {inputs,review}=planFor(request.review,request.scopeId);
        const verify=createV14SetupStagePreflight({planInputs:inputs,provider,now});
        return await verify({review,scopeId:request.scopeId,stageId:request.stageId,prior:structuredClone(request.prior)});
      }catch{throw fail()}
    },
    async receipt(request) {
      try {
        if(!exact(request,['review','scopeId','stageId','txHash']))throw fail();
        const {inputs,binding}=planFor(request.review,request.scopeId);
        const verify=createV14SetupRpcVerifier({planInputs:inputs,provider,now});
        return await verify({binding,stageId:request.stageId,txHash:request.txHash});
      }catch{throw fail()}
    },
    // The only input is public checkpoint history. Its embedded review is
    // reconstructed against the pinned artifacts but is NOT treated as an
    // independently trusted latest head or as owner authorization.
    async completedHistory(request) {
      try {
        if(!exact(request,['scopeId','history']))throw fail();
        const history=structuredClone(request.history);
        if(!history||typeof history!=='object'||Array.isArray(history)||
            Buffer.byteLength(JSON.stringify(history),'utf8')>45_000||!Array.isArray(history.events)||
            typeof history.events[0]!=='string')throw fail();
        const first=JSON.parse(history.events[0]);
        if(first?.type!=='reserve')throw fail();
        const {inputs}=planFor(first?.data?.public_review,request.scopeId);
        const verify=createV14CompletedSetupHistoryVerifier({planInputs:inputs,provider,now});
        return await verify({scopeId:request.scopeId,history,trustedRevision:history.revision,trustedHeadSha256:history.head_sha256});
      }catch{throw fail()}
    },
  });
}
