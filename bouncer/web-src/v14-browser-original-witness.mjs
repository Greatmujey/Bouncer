/**
 * Browser coordinator for a reviewed V14 setup's two existing checkpoint
 * copies. It records a one-shot claim before a wallet prompt and the original
 * transaction hash afterwards. It never opens a wallet, signs, sends, or
 * declares a receipt verified by itself.
 *
 * One store must be genuinely independent from this device. The caller must
 * independently validate and retain the complete public plan and its digest;
 * accepting a digest supplied only by the same untrusted server is not that
 * validation. The receipt callback must check the exact original's FINAL
 * receipt and required fresh state. Browser or server compromise and rollback
 * of both copies remain outside this fence. No live setup currently uses it.
 */
import { inspectV14PublicHistory } from './v14-checkpoint-history.mjs';
import { isV14CheckpointAccountPair } from './v14-checkpoint-enrollment.mjs';

const GENESIS = '0'.repeat(64), HEX = /^[a-f0-9]{64}$/, SCOPE = /^[a-f0-9]{32}$/;
const MAX_EVENTS = 32, MAX_RECORD = 24_576;
const text = new TextEncoder();
const exact = (value, fields) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value,field));
const fail = () => new Error('V14 original checkpoint copies differ or are uncertain; stop and reconcile, never repeat a wallet prompt');
const copy = value => structuredClone(value);
const browserWitnesses = new WeakSet();
/** In-realm guard only; a compromised page or substituted stores remain trusted. */
export const isV14BrowserOriginalWitness = value => browserWitnesses.has(value);
async function sha(crypto, value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',text.encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
function snapshot(value) {
  if (!exact(value,['revision','head_sha256','events']) || !Number.isSafeInteger(value.revision) ||
      value.revision < 0 || value.revision > MAX_EVENTS || !HEX.test(value.head_sha256 ?? '') ||
      !Array.isArray(value.events) || value.events.length !== value.revision ||
      value.events.some(line=>typeof line!=='string' || text.encode(line).length>MAX_RECORD || /[\r\n]/.test(line))) throw fail();
  return {revision:value.revision,head_sha256:value.head_sha256,events:[...value.events]};
}

/**
 * `trustedReviewSha256` must have been retained independently of both stores.
 * This function checks the review's own digest and public history format, but
 * does not independently reconstruct its artifacts or actions. Both stores
 * must already exist; brand-new provisioning is a separate explicit operation.
 */
export async function createV14BrowserOriginalWitness({review:rawReview,trustedReviewSha256,scopeId,localStore,independentStore,
    verifySetupReceipt,crypto=globalThis.crypto} = {}) {
  if (!crypto?.subtle || !SCOPE.test(scopeId ?? '') || !HEX.test(trustedReviewSha256 ?? '') ||
      !localStore || !independentStore || localStore===independentStore ||
      ![localStore,independentStore].every(store=>typeof store.read==='function' && typeof store.append==='function')) throw fail();
  const review=copy(rawReview),owner=review?.owner,vault=review?.vault;
  if (!isV14CheckpointAccountPair(vault,owner) || review?.review_sha256!==trustedReviewSha256 ||
      !Array.isArray(review?.stages) || !Array.isArray(review?.mission?.goals)) throw fail();
  const binding={format:'bouncer-v14-original-binding-v1',scope_id:scopeId,network:'testnet',owner,vault,
    review_sha256:trustedReviewSha256,mission_sha256:review.mission_sha256,
    stages:review.stages.map(stage=>({id:stage.id,action_commitment_sha256:stage.action_commitment_sha256})),
    goals:review.mission.goals.map(({kind,goal})=>({id:goal?.id,kind})),public_review:review};
  // Validate the candidate binding and hash before either store is touched.
  const first=JSON.stringify({format:'bouncer-v14-original-event-v1',seq:1,previous_sha256:GENESIS,type:'reserve',data:binding});
  const candidate={status:'EXISTING_CHECKPOINT',scope_id:scopeId,revision:1,head_sha256:await sha(crypto,first),events:[first]};
  const verified=await inspectV14PublicHistory({snapshot:candidate,owner,vault,crypto});
  if (verified.review?.review_sha256!==trustedReviewSha256) throw fail();

  let failed=false,busy=false;
  async function readBoth() {
    if (failed) throw fail();
    try {
      const [a,b]=await Promise.all([localStore.read(),independentStore.read()]);
      const left=snapshot(a),right=snapshot(b);
      if (JSON.stringify(left)!==JSON.stringify(right)) throw fail();
      const state=await inspectV14PublicHistory({snapshot:{status:'EXISTING_CHECKPOINT',scope_id:scopeId,...left},owner,vault,crypto});
      if (left.revision>0 && (left.events[0]!==first || state.review?.review_sha256!==trustedReviewSha256)) throw fail();
      return {snapshot:left,state};
    } catch { failed=true; throw fail(); }
  }
  async function mutate(type,choose) {
    if (busy || failed) throw fail();
    busy=true;
    try {
      const prior=await readBoth(),data=await choose(copy(prior.state),prior.snapshot);
      if (data===null) return prior.state;
      if (prior.snapshot.revision>=MAX_EVENTS) throw fail();
      const record=JSON.stringify({format:'bouncer-v14-original-event-v1',seq:prior.snapshot.revision+1,
        previous_sha256:prior.snapshot.head_sha256,type,data});
      if (text.encode(record).length>MAX_RECORD) throw fail();
      const next={revision:prior.snapshot.revision+1,head_sha256:await sha(crypto,record),events:[...prior.snapshot.events,record]};
      // Validate the entire resulting history and transition before writing.
      await inspectV14PublicHistory({snapshot:{status:'EXISTING_CHECKPOINT',scope_id:scopeId,...next},owner,vault,crypto});
      const args={expected_revision:prior.snapshot.revision,expected_head_sha256:prior.snapshot.head_sha256,record};
      try {
        // Independent first. A lost acknowledgement may mean it committed; do
        // not retry either the append or the wallet prompt automatically.
        await independentStore.append(args);
        await localStore.append(args);
        const confirmed=await readBoth();
        if (JSON.stringify(confirmed.snapshot)!==JSON.stringify(next)) throw fail();
        return confirmed.state;
      } catch { failed=true; throw fail(); }
    } finally { busy=false; }
  }
  const result=Object.freeze({
    inspect:async()=> (await readBoth()).state,
    // Public event history only; no capability, journal key or agent key.
    // Matching copies do not prove that both stores are current or durable.
    history:async()=>copy((await readBoth()).snapshot),
    reserve:()=>mutate('reserve',(_state,prior)=>prior.revision===0?binding:null),
    claimWalletStage:stageId=>mutate('wallet_claim',state=>{
      const stage=binding.stages.find(item=>item.id===stageId);
      if (!state.review || state.pending || state.next_setup_stage!==stageId || !stage) throw fail();
      return {stage_id:stageId,action_commitment_sha256:stage.action_commitment_sha256};
    }),
    retainWalletOriginal:({stageId,txHash}={})=>mutate('wallet_original',state=>{
      if (state.pending?.type!=='wallet' || state.pending.stage_id!==stageId || state.pending.tx_hash!==null) throw fail();
      return {stage_id:stageId,tx_hash:txHash};
    }),
    verifyWalletOriginal:({stageId,proof}={})=>mutate('wallet_verified',async state=>{
      if (state.pending?.type!=='wallet' || state.pending.stage_id!==stageId || !state.pending.tx_hash ||
          typeof verifySetupReceipt!=='function') throw fail();
      const checked=await verifySetupReceipt({binding:copy(binding),stageId,txHash:state.pending.tx_hash,proof});
      if (!exact(checked,['tx_hash','final_block_hash']) || checked.tx_hash!==state.pending.tx_hash) throw fail();
      return {stage_id:stageId,tx_hash:checked.tx_hash,final_block_hash:checked.final_block_hash};
    }),
  });
  browserWitnesses.add(result);
  return result;
}
