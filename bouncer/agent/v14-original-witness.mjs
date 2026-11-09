/**
 * Research-only two-copy fence for a reviewed V14 setup and native mission.
 *
 * This module does not prompt, sign, broadcast, authenticate a wallet, or verify
 * a receipt by itself. Both stores must already exist. One must be retained on
 * a genuinely independent system: different adapter names do not establish
 * independence. Every claim/original is written to the independent store
 * first, then to the encrypted local store, and both are read back. An error
 * or mismatch is an unresolved operation, not permission to retry a wallet
 * prompt or transaction. A privileged operator able to roll back both stores
 * can still defeat this fence. No live path uses it until separately wired.
 */
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { isDirectTestnetChild } from './native-oracle-wallet-plan.mjs';
import { V14_PHONE_RESEARCH_STAGE_IDS, verifyV14PhoneResearchPlan } from './native-v14-phone-plan.mjs';

export const V14_WITNESS_GENESIS = '0'.repeat(64);
const HEX = /^[a-f0-9]{64}$/;
const SCOPE = /^[a-f0-9]{32}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_EVENTS = 32; // 1 reservation + 6 x 3 setup records + 3 x 2 mission records
const MAX_RECORD_BYTES = 24_576;
const MAX_REVIEW_BYTES = 20_000;
const KINDS = new Set(['random','market','oracle','storage']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const digest = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const uncertain = () => new Error('V14 original checkpoint is uncertain or copies differ; stop and reconcile the original, never retry a prompt or send');
const copy = value => structuredClone(value);

function containsSecretField(value,depth=0) {
  if (depth>32) return true;
  if (!value || typeof value!=='object') return false;
  return Object.entries(value).some(([key,child]) => /private|secret|seed|mnemonic|signature|capability|password|bearer|recovery/i.test(key) ||
    containsSecretField(child,depth+1));
}
function validPublicReview(review,binding) {
  const fields=['format','status','network','owner','owner_public_key','vault','mission','mission_sha256','agent_public_keys',
    'agent_gas_allowances_yocto','rolling_caps_yocto','vault_storage_funding_yocto','native_deposit_yocto','artifacts','stages',
    'limitations','signing_authorized','transaction_sent','review_sha256'];
  if (!exact(review,fields) || review.format!=='bouncer-research-v14-phone-plan-v1' || review.status!=='UNSIGNED_OFFLINE_PLAN_ONLY' ||
      review.network!=='testnet' || review.signing_authorized!==false || review.transaction_sent!==false || review.owner!==binding.owner ||
      review.vault!==binding.vault || review.review_sha256!==binding.review_sha256 || review.mission_sha256!==binding.mission_sha256 ||
      !plain(review.mission) || !Array.isArray(review.mission.goals) || !Array.isArray(review.stages) ||
      Buffer.byteLength(JSON.stringify(review),'utf8')>MAX_REVIEW_BYTES || containsSecretField(review)) return false;
  const unsigned={...review}; delete unsigned.review_sha256;
  if (digest(JSON.stringify(unsigned))!==review.review_sha256 || digest(JSON.stringify(review.mission))!==review.mission_sha256 ||
      !isDeepStrictEqual(review.stages.map(stage=>({id:stage.id,action_commitment_sha256:stage.action_commitment_sha256})),binding.stages) ||
      !isDeepStrictEqual(review.mission.goals.map(({kind,goal})=>({id:goal?.id,kind})),binding.goals)) return false;
  // Query strings can contain API credentials. The independently retained
  // review is public metadata, so require query-free program URLs here.
  try {
    for (const {goal} of review.mission.goals) if (goal?.program?.url && new URL(goal.program.url).search) return false;
  } catch { return false; }
  return true;
}
function validBinding(binding) {
  if (!exact(binding, ['format','scope_id','network','owner','vault','review_sha256','mission_sha256','stages','goals','public_review']) ||
      binding.format !== 'bouncer-v14-original-binding-v1' || !SCOPE.test(binding.scope_id ?? '') || binding.network !== 'testnet' ||
      !isDirectTestnetChild(binding.vault,binding.owner) || !HEX.test(binding.review_sha256 ?? '') || !HEX.test(binding.mission_sha256 ?? '') ||
      !Array.isArray(binding.stages) || binding.stages.length !== V14_PHONE_RESEARCH_STAGE_IDS.length ||
      !binding.stages.every((stage,i) => exact(stage,['id','action_commitment_sha256']) &&
        stage.id === V14_PHONE_RESEARCH_STAGE_IDS[i] && HEX.test(stage.action_commitment_sha256 ?? '')) ||
      !Array.isArray(binding.goals) || binding.goals.length !== 3 ||
      !binding.goals.every(goal => exact(goal,['id','kind']) && ID.test(goal.id ?? '') && KINDS.has(goal.kind)) ||
      new Set(binding.goals.map(goal => goal.id)).size !== binding.goals.length ||
      !['random,oracle,storage','oracle,market,storage'].includes(binding.goals.map(goal => goal.kind).join(','))) {
    throw new Error('invalid reviewed V14 checkpoint binding');
  }
  let verified=false;
  try { verified=validPublicReview(binding.public_review,binding); } catch { /* malformed public review */ }
  if (!verified) throw new Error('invalid or potentially secret-bearing V14 public review');
  return copy(binding);
}

/**
 * Derive the public-only binding by rebuilding the complete offline plan from
 * caller-supplied pinned artifacts and an independently retained review hash.
 * This establishes no current-chain state, owner consent or loader safety.
 * Do not put wallet keys, agent keys, bearer tokens or signed transactions in
 * this public checkpoint. The independently retained public review is not a
 * backup of the encrypted journal, its encryption key, or restricted agent keys.
 */
export function deriveV14OriginalBinding({ scopeId, ...planInputs } = {}) {
  if (!SCOPE.test(scopeId ?? '')) throw new Error('a separately provisioned random V14 scope is required');
  const { review } = verifyV14PhoneResearchPlan(planInputs);
  return validBinding({ format:'bouncer-v14-original-binding-v1',scope_id:scopeId,network:'testnet',
    owner:review.owner,vault:review.vault,review_sha256:review.review_sha256,mission_sha256:review.mission_sha256,
    stages:review.stages.map(stage => ({id:stage.id,action_commitment_sha256:stage.action_commitment_sha256})),
    goals:review.mission.goals.map(({kind,goal}) => ({id:goal.id,kind})),public_review:review });
}

function checkSnapshot(snapshot) {
  if (!exact(snapshot,['revision','head_sha256','events']) || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 ||
      snapshot.revision > MAX_EVENTS || !HEX.test(snapshot.head_sha256 ?? '') || !Array.isArray(snapshot.events) ||
      snapshot.events.length !== snapshot.revision || snapshot.events.some(line => typeof line !== 'string' ||
        Buffer.byteLength(line,'utf8') > MAX_RECORD_BYTES || line.includes('\n') || line.includes('\r'))) throw uncertain();
  return copy(snapshot);
}

/** Validate every byte, hash link, binding and state transition before use. */
export function inspectV14OriginalSnapshot(input, expectedBinding) {
  const binding = validBinding(expectedBinding), snapshot = checkSnapshot(input);
  let head=V14_WITNESS_GENESIS, setupIndex=0, missionIndex=0, pending=null, reserved=false;
  const setup=[], mission=[];
  for (let i=0;i<snapshot.events.length;i++) {
    const line=snapshot.events[i]; let event;
    try { event=JSON.parse(line); } catch { throw uncertain(); }
    if (!exact(event,['format','seq','previous_sha256','type','data']) || JSON.stringify(event)!==line ||
        event.format!=='bouncer-v14-original-event-v1' || event.seq!==i+1 || event.previous_sha256!==head) throw uncertain();
    const d=event.data;
    if (event.type==='reserve') {
      if (i!==0 || reserved || !isDeepStrictEqual(d,binding)) throw uncertain();
      reserved=true;
    } else if (!reserved) throw uncertain();
    else if (event.type==='wallet_claim') {
      const stage=binding.stages[setupIndex];
      if (pending || missionIndex!==0 || !stage || !exact(d,['stage_id','action_commitment_sha256']) ||
          d.stage_id!==stage.id || d.action_commitment_sha256!==stage.action_commitment_sha256) throw uncertain();
      pending={type:'wallet',stage_id:stage.id,tx_hash:null};
    } else if (event.type==='wallet_original') {
      if (!pending || pending.type!=='wallet' || pending.tx_hash!==null || !exact(d,['stage_id','tx_hash']) ||
          d.stage_id!==pending.stage_id || !isTransactionHash(d.tx_hash) || setup.some(previous => previous.tx_hash===d.tx_hash)) throw uncertain();
      pending.tx_hash=d.tx_hash;
    } else if (event.type==='wallet_verified') {
      if (!pending || pending.type!=='wallet' || !pending.tx_hash || !exact(d,['stage_id','tx_hash','final_block_hash']) ||
          d.stage_id!==pending.stage_id || d.tx_hash!==pending.tx_hash || !isTransactionHash(d.final_block_hash)) throw uncertain();
      setup.push({stage_id:d.stage_id,tx_hash:d.tx_hash,final_block_hash:d.final_block_hash});
      setupIndex++; pending=null;
    } else if (event.type==='mission_original') {
      const goal=binding.goals[missionIndex];
      if (pending || setupIndex!==binding.stages.length || !goal || !exact(d,['goal_id','kind','tx_hash','fingerprint']) ||
          d.goal_id!==goal.id || d.kind!==goal.kind || !isTransactionHash(d.tx_hash) || !HEX.test(d.fingerprint ?? '') ||
          [...setup,...mission].some(previous => previous.tx_hash===d.tx_hash)) throw uncertain();
      pending={type:'mission',goal_id:d.goal_id,kind:d.kind,tx_hash:d.tx_hash,fingerprint:d.fingerprint};
    } else if (event.type==='mission_verified') {
      if (!pending || pending.type!=='mission' || !exact(d,['goal_id','tx_hash','final_block_hash']) ||
          d.goal_id!==pending.goal_id || d.tx_hash!==pending.tx_hash || !isTransactionHash(d.final_block_hash)) throw uncertain();
      mission.push({goal_id:d.goal_id,kind:pending.kind,tx_hash:d.tx_hash,fingerprint:pending.fingerprint,final_block_hash:d.final_block_hash});
      missionIndex++; pending=null;
    } else throw uncertain();
    head=digest(line);
  }
  if (snapshot.head_sha256!==head || (snapshot.revision===0 && snapshot.head_sha256!==V14_WITNESS_GENESIS)) throw uncertain();
  return { reserved,setup,mission,pending,next_setup_stage:binding.stages[setupIndex]?.id ?? null,
    next_mission_goal:binding.goals[missionIndex]?.id ?? null,revision:snapshot.revision,head_sha256:head };
}

/**
 * Each adapter provides async read() and append({expected_revision,
 * expected_head_sha256,record}) methods. append is an atomic compare-and-set;
 * it never overwrites or deletes a prior record. An acknowledged append must
 * be durable, not an in-memory queue. Adapters are explicitly provisioned;
 * this function never silently initializes missing originals.
 *
 * Verification callbacks must check the exact original against FINAL receipts
 * AND required fresh state before returning {tx_hash,final_block_hash}. They
 * are intentionally mandatory only when confirming a record, and their mere
 * presence does not make them independent or trustworthy.
 */
export function createV14OriginalWitness({ binding:rawBinding,localStore,independentStore,verifySetupReceipt,verifyMissionReceipt } = {}) {
  const binding=validBinding(rawBinding);
  if (!localStore || !independentStore || localStore===independentStore ||
      ![localStore,independentStore].every(store=>typeof store.read==='function' && typeof store.append==='function')) {
    throw new Error('two separately provisioned original checkpoint stores are required');
  }
  let failed=false, busy=false;
  async function readBoth() {
    if (failed) throw uncertain();
    try {
      const [left,right]=await Promise.all([localStore.read(),independentStore.read()]);
      const local=checkSnapshot(left), independent=checkSnapshot(right);
      if (!isDeepStrictEqual(local,independent)) throw uncertain();
      return {snapshot:local,state:inspectV14OriginalSnapshot(local,binding)};
    } catch (error) { failed=true; throw uncertain(); }
  }
  async function mutate(type, choose) {
    if (busy || failed) throw uncertain();
    busy=true;
    try {
      const {snapshot,state}=await readBoth();
      const data=await choose(copy(state));
      if (data===null) return state; // read-only idempotence, never a second claim
      if (snapshot.revision>=MAX_EVENTS) throw uncertain();
      const event={format:'bouncer-v14-original-event-v1',seq:snapshot.revision+1,
        previous_sha256:snapshot.head_sha256,type,data};
      const record=JSON.stringify(event), next={revision:event.seq,head_sha256:digest(record),events:[...snapshot.events,record]};
      if (Buffer.byteLength(record,'utf8')>MAX_RECORD_BYTES) throw uncertain();
      inspectV14OriginalSnapshot(next,binding); // no malformed event is sent to either store
      const args={expected_revision:snapshot.revision,expected_head_sha256:snapshot.head_sha256,record};
      try {
        // A lost acknowledgement may mean the record was committed. Never
        // repeat the action; a subsequent read/reconciliation is required.
        await independentStore.append(args);
        await localStore.append(args);
        const confirmed=await readBoth();
        if (!isDeepStrictEqual(confirmed.snapshot,next)) throw uncertain();
        return confirmed.state;
      } catch { failed=true; throw uncertain(); }
    } finally { busy=false; }
  }
  const requireReserved = state => { if (!state.reserved) throw new Error('reviewed setup has not been reserved in both stores'); };
  return Object.freeze({
    inspect:async () => (await readBoth()).state,
    reserve:() => mutate('reserve', state => {
      if (state.reserved) return null;
      if (state.revision!==0) throw uncertain();
      return binding;
    }),
    claimWalletStage:stageId => mutate('wallet_claim', state => {
      requireReserved(state);
      if (state.pending || state.next_setup_stage!==stageId) throw new Error('wallet stage already claimed or not next; recover the original, never prompt again');
      const stage=binding.stages.find(item=>item.id===stageId);
      return {stage_id:stageId,action_commitment_sha256:stage.action_commitment_sha256};
    }),
    retainWalletOriginal:({stageId,txHash} = {}) => mutate('wallet_original', state => {
      requireReserved(state);
      if (state.pending?.type!=='wallet' || state.pending.stage_id!==stageId || state.pending.tx_hash!==null || !isTransactionHash(txHash)) {
        throw new Error('wallet original is missing, already retained or differs; recover without another prompt');
      }
      return {stage_id:stageId,tx_hash:txHash};
    }),
    verifyWalletOriginal:({stageId,proof} = {}) => mutate('wallet_verified', async state => {
      requireReserved(state);
      if (state.pending?.type!=='wallet' || state.pending.stage_id!==stageId || !state.pending.tx_hash || typeof verifySetupReceipt!=='function') {
        throw new Error('the retained wallet original and a real receipt/state verifier are required');
      }
      const result=await verifySetupReceipt({binding:copy(binding),stageId,txHash:state.pending.tx_hash,proof});
      if (!exact(result,['tx_hash','final_block_hash']) || result.tx_hash!==state.pending.tx_hash || !isTransactionHash(result.final_block_hash)) {
        throw new Error('wallet original receipt or current state was not verified');
      }
      return {stage_id:stageId,tx_hash:result.tx_hash,final_block_hash:result.final_block_hash};
    }),
    retainMissionOriginal:({goalId,kind,txHash,fingerprint} = {}) => mutate('mission_original', state => {
      requireReserved(state);
      if (state.pending || state.next_setup_stage!==null || state.next_mission_goal!==goalId ||
          binding.goals.find(goal=>goal.id===goalId)?.kind!==kind || !isTransactionHash(txHash) || !HEX.test(fingerprint ?? '')) {
        throw new Error('mission original is already retained or is not the next reviewed goal; never send a replacement');
      }
      return {goal_id:goalId,kind,tx_hash:txHash,fingerprint};
    }),
    verifyMissionOriginal:({goalId,proof} = {}) => mutate('mission_verified', async state => {
      requireReserved(state);
      if (state.pending?.type!=='mission' || state.pending.goal_id!==goalId || typeof verifyMissionReceipt!=='function') {
        throw new Error('the retained mission original and a real receipt/state verifier are required');
      }
      const result=await verifyMissionReceipt({binding:copy(binding),goalId,kind:state.pending.kind,txHash:state.pending.tx_hash,proof});
      if (!exact(result,['tx_hash','final_block_hash']) || result.tx_hash!==state.pending.tx_hash || !isTransactionHash(result.final_block_hash)) {
        throw new Error('mission original receipt or current state was not verified');
      }
      return {goal_id:goalId,tx_hash:result.tx_hash,final_block_hash:result.final_block_hash};
    }),
  });
}
