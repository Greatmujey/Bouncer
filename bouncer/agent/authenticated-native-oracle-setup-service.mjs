/**
 * Opt-in service composition for the native setup path, not a live deployment.
 * It binds one-use NEP-413 challenges to a fixed owner and an exactly
 * reconstructed, pinned V9 plan; the coordinator remains responsible for the
 * database hold, both same-branch witnesses and fresh stage preflights.
 *
 * No private key, wallet call, transaction broadcast, provider purchase or
 * spend authorization is handled here. Host only after deploying an independent
 * latest-head anchor, safe recovery/release and real-device testing. Lost or
 * ambiguous claims and wallet results are reconciliation-only, never retry.
 */
import { isDeepStrictEqual } from 'node:util';
import { nativeSetupAuthAction } from '../web-src/native-oracle-setup-auth.mjs';
import { verifyNativeOracleWalletReview, prepareNativeOracleWalletAttempt, inspectNativeOracleWalletAttempt } from './native-oracle-wallet-evidence.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { V3_OWNER } from './v3-faucet-github-fence.mjs';
import { WalletWitnessError } from './git-wallet-prompt-witness.mjs';

const STAGES = ['create_keyless_native_vault','configure_native_oracle_policy','fund_native_vault','install_native_oracle_agent'];
const fail = () => new WalletWitnessError('NATIVE_SETUP_UNAVAILABLE',
  'native setup review or authenticated witness is unavailable; stop and reconcile, never repeat a wallet prompt');
const same = (a,b) => isDeepStrictEqual(a,b);
function idFromPlan(plan) {
  if (!plan || plan.review?.owner !== plan.owner || plan.review.review_sha256 !== plan.review_sha256 ||
      !Array.isArray(plan.review.stages) || plan.review.stages.length !== STAGES.length ||
      !Array.isArray(plan.stages) || plan.stages.length !== STAGES.length) throw fail();
  return { owner:plan.owner, owner_public_key:plan.owner_public_key, operation_id:plan.operation_id, review_sha256:plan.review_sha256,
    stages:plan.review.stages.map((s,i)=> {
      if (s?.id !== STAGES[i] || plan.stages[i]?.stage_id !== s.id ||
          plan.stages[i]?.action_commitment_sha256 !== s.action_commitment_sha256) throw fail();
      return {stage_id:s.id,action_commitment_sha256:s.action_commitment_sha256};
    }) };
}
function journalsMatch(plan,state) {
  if (!state || !same(idFromPlan(plan),state.identity)) return false;
  return plan.stages.every(stage => {
    const claim = state.records.find(r=>r.event==='claim' && r.stage_id===stage.stage_id);
    const original = state.records.find(r=>r.event==='original' && r.stage_id===stage.stage_id);
    return stage.claimed === !!claim && stage.original_hash === (original?.original_hash ?? null);
  });
}
async function checkPeer(other, owner, head) {
  const peer = await other.inspect(owner);
  if (!peer || peer.head !== head || !Object.hasOwn(peer,'state')) throw fail();
  if (peer.state !== null) throw new WalletWitnessError('CROSS_FLOW_WITNESSED',
    'another wallet setup is already witnessed; stop and reconcile');
}

export function createAuthenticatedNativeOracleSetupService({ auth, fence, witness, otherWitness, coordinator,
  getRetainedReview, wasmBytes, receiptProvider, owner } = {}) {
  if (!isTestnetAccount(owner) || !owner.endsWith('.testnet') || owner === V3_OWNER ||
      !auth || typeof auth.issue !== 'function' || !fence || typeof fence.inspect !== 'function' ||
      !witness || ['inspect','assertClaimable'].some(k=>typeof witness[k]!=='function') ||
      !otherWitness || otherWitness === witness || typeof otherWitness.inspect !== 'function' ||
      !coordinator || ['reserve','claim','recordOriginal','verifyCompletion'].some(k=>typeof coordinator[k]!=='function') ||
      typeof getRetainedReview !== 'function' || !(wasmBytes instanceof Uint8Array) ||
      !receiptProvider || ['viewNodeStatus','txStatusReceipts'].some(k=>typeof receiptProvider[k]!=='function')) {
    throw Error('fixed named testnet owner, authenticated fence, both setup witnesses and retained native review required');
  }
  const wasm = Buffer.from(wasmBytes);
  async function retained(taskId, ownerPublicKey, agentPublicKey) {
    if (typeof taskId !== 'string' || !/^[a-f0-9]{64}$/.test(taskId) || typeof agentPublicKey !== 'string' ||
        !/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(agentPublicKey)) throw fail();
    const value = await getRetainedReview(taskId,agentPublicKey);
    if (!value?.review || value.review.owner !== owner || value.review.agent_public_key !== agentPublicKey ||
        value.review.review_sha256 !== taskId) throw fail();
    const review = structuredClone(value.review);
    try { verifyNativeOracleWalletReview({ review, wasmBytes:wasm, trustedReviewHash:review.review_sha256, trustedOwnerPublicKey:ownerPublicKey }); }
    catch { throw fail(); }
    return review;
  }
  async function witnessed(raw) {
    const identity = structuredClone(raw);
    if (identity?.owner !== owner) throw fail();
    const snapshot = await witness.inspect(owner);
    if (!snapshot.state || !same(snapshot.state.identity,identity)) throw fail();
    return {identity,state:snapshot.state,head:snapshot.head};
  }
  const action = (purpose, ownerPublicKey, extra={}) => nativeSetupAuthAction({ purpose, owner, ownerPublicKey, ...extra });
  return Object.freeze({
    async issueReservation({ taskId, ownerPublicKey, agentPublicKey } = {}) {
      const review = await retained(taskId,ownerPublicKey,agentPublicKey), snapshot = await witness.inspect(owner);
      if (snapshot.state) throw fail();
      await checkPeer(otherWitness,owner,snapshot.head);
      return auth.issue(action('reserve_native_setup',ownerPublicKey,{review}));
    },
    async reserve({ taskId, ownerPublicKey, agentPublicKey, evidence } = {}) {
      const review = await retained(taskId,ownerPublicKey,agentPublicKey);
      return coordinator.reserve({review,trustedReviewHash:review.review_sha256,trustedOwnerPublicKey:ownerPublicKey,evidence});
    },
    async issueClaim({ identity:raw, stageId } = {}) {
      const {identity} = await witnessed(raw), checkpoint = await witness.assertClaimable(identity,stageId);
      await checkPeer(otherWitness,owner,checkpoint.head);
      return auth.issue(action('claim_native_setup_stage',identity.owner_public_key,{identity,stageId}));
    },
    async claim({ identity:raw, stageId, evidence } = {}) {
      const {identity} = await witnessed(raw);
      return coordinator.claim({identity,stageId,evidence});
    },
    async issueOriginal({ identity:raw, stageId, originalHash } = {}) {
      const {identity,state} = await witnessed(raw), last = state.records.at(-1);
      if (!isTransactionHash(originalHash) || !(state.phase==='claimed' && state.identity.stages[state.stage_index].stage_id===stageId) &&
          !(['original','complete'].includes(state.phase) && last.stage_id===stageId && last.original_hash===originalHash)) throw fail();
      return auth.issue(action('record_native_setup_original',identity.owner_public_key,{identity,stageId,originalHash}));
    },
    async recordOriginal({ identity:raw, stageId, originalHash, evidence } = {}) {
      const {identity} = await witnessed(raw);
      return coordinator.recordOriginal({identity,stageId,originalHash,evidence});
    },
    async issueCompletion({ identity:raw } = {}) {
      const {identity,state} = await witnessed(raw); if (state.phase!=='complete') throw fail();
      return auth.issue(action('verify_native_setup_completion',identity.owner_public_key,{identity}));
    },
    async verifyCompletion({ identity:raw, evidence } = {}) {
      const {identity,state} = await witnessed(raw); if (state.phase!=='complete') throw fail();
      return coordinator.verifyCompletion({identity,evidence});
    },
    async issueInspect({ ownerPublicKey } = {}) { return auth.issue(action('inspect_native_setup',ownerPublicKey)); },
    /** Verify an owner-supplied original hash before immutably recording it.
     * A missing receipt is unknown, not permission to retry a wallet prompt. */
    async previewOriginal({ ownerPublicKey, stageId, originalHash, evidence } = {}) {
      if (!STAGES.includes(stageId) || !isTransactionHash(originalHash)) throw fail();
      const plan = await fence.inspect({owner,ownerPublicKey,evidence}), remote = await witness.inspect(owner), state = remote.state;
      if (!journalsMatch(plan,state) || state.phase!=='claimed' || state.identity.stages[state.stage_index].stage_id!==stageId) throw fail();
      try {
        if ((await receiptProvider.viewNodeStatus())?.chain_id!=='testnet') throw Error();
        const args = { review:plan.review, wasmBytes:wasm, trustedReviewHash:plan.review_sha256,
          trustedOwnerPublicKey:ownerPublicKey, stageId, trustedOriginalHash:originalHash };
        const attempt = prepareNativeOracleWalletAttempt(args);
        const result = structuredClone(await receiptProvider.txStatusReceipts(originalHash,owner,'FINAL'));
        return { ...inspectNativeOracleWalletAttempt({...args,attempt,result}), execution_authorized:false, original_recorded:false,
          scope:'Trusted-RPC original receipt preview only; not a prompt, current state, delivery or authorization.' };
      } catch { throw new WalletWitnessError('RECEIPT_UNKNOWN','original receipt unavailable or mismatched; retain the hash and never resend'); }
    },
    async inspect({ ownerPublicKey, evidence } = {}) {
      let plan;
      try { plan = await fence.inspect({owner,ownerPublicKey,evidence}); }
      catch (error) { if (error?.code !== 'OWNER_FENCED') throw error; }
      const remote = await witness.inspect(owner), state = remote.state, peer = await otherWitness.inspect(owner);
      const recovery = scope => ({status:'RECOVERY_REQUIRED',execution_authorized:false,
        identity:state?.identity ?? (plan ? idFromPlan(plan) : null), witnessed_records:state?.records ?? [],
        database_stages:plan?.stages ?? [], witness_head:remote.head,scope});
      if (!peer || !Object.hasOwn(peer,'state') || peer.head!==remote.head) return recovery(
        'Witness heads differ or are unavailable; preserve originals and never open another prompt.');
      if (peer.state!==null) return recovery('A different setup flow is witnessed; reconcile it before any native prompt.');
      if (!plan && !state) return {status:'NO_LOCAL_RECORD',execution_authorized:false,
        scope:'No record in these systems is not proof that no wallet prompt or original exists elsewhere.'};
      if (!plan || !state || !journalsMatch(plan,state)) return recovery(
        'Independent journals disagree or one is missing; preserve originals and never open another prompt.');
      return {status:'WITNESSED',identity:state.identity,witnessed_records:state.records,review:structuredClone(plan.review),
        database_stages:structuredClone(plan.stages),witness_head:remote.head,execution_authorized:false,
        scope:'Authenticated retained state only; no wallet invocation, consent, FINAL execution or delivery established.'};
    },
  });
}
