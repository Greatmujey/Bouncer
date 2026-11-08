/**
 * Opt-in service composition for the native setup path, not a live deployment.
 * It binds one-use NEP-413 challenges to a fixed owner and an exactly
 * reconstructed, pinned V9 plan; the coordinator remains responsible for the
 * database hold, both same-branch witnesses and fresh stage preflights.
 *
 * No private key, wallet call, transaction broadcast or spend authorization is
 * handled here. The trial preview verifies receipts only. Host only after deploying an independent
 * latest-head anchor, safe recovery/release and real-device testing. Lost or
 * ambiguous claims and wallet results are reconciliation-only, never retry.
 */
import { isDeepStrictEqual } from 'node:util';
import { nativeSetupAuthAction } from '../web-src/native-oracle-setup-auth.mjs';
import { verifyNativeOracleWalletReview, prepareNativeOracleWalletAttempt, inspectNativeOracleWalletAttempt } from './native-oracle-wallet-evidence.mjs';
import { verifyAtomicNativeOracleWalletReview, prepareAtomicNativeOracleWalletAttempt,
  inspectAtomicNativeOracleWalletAttempt } from './native-oracle-atomic-wallet.mjs';
import { verifyResearchPhoneReview, prepareResearchPhoneAttempt, inspectResearchPhoneAttempt,
  NATIVE_PHONE_LOADER_BYTES, NATIVE_PHONE_LOADER_SHA256, NATIVE_PHONE_COMPRESSED_BYTES, NATIVE_PHONE_COMPRESSED_SHA256 } from './native-phone-loader-research.mjs';
import crypto from 'node:crypto';
import { createAuthenticatedNativeOracleTrialClaim } from './authenticated-native-oracle-trial-claim.mjs';
import { validateWitnessedNativeOracleTrial, assertWitnessedNativeOracleTrial } from './native-oracle-phone-signer.mjs';
import { verifyOracleResult } from './oracle-outlayer.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { V3_OWNER } from './v3-faucet-github-fence.mjs';
import { WalletWitnessError } from './git-wallet-prompt-witness.mjs';

const STAGES = ['create_keyless_native_vault','configure_native_oracle_policy','fund_native_vault','install_native_oracle_agent'];
const ATOMIC_STAGES = ['create_configure_fund_native_vault','install_native_oracle_agent'];
const COMPRESSED_STAGES = ['create_compressed_native_vault','configure_fund_native_oracle','install_native_oracle_agent'];
const fail = () => new WalletWitnessError('NATIVE_SETUP_UNAVAILABLE',
  'native setup review or authenticated witness is unavailable; stop and reconcile, never repeat a wallet prompt');
const same = (a,b) => isDeepStrictEqual(a,b);
function reviewOps(review, enableAtomic, compact) {
  if (review?.format === 'bouncer-native-oracle-wallet-review-v1') return {stages:STAGES,verify:verifyNativeOracleWalletReview,
    prepare:prepareNativeOracleWalletAttempt,inspect:inspectNativeOracleWalletAttempt};
  if (enableAtomic && review?.format === 'bouncer-atomic-native-oracle-wallet-review-v1') return {stages:ATOMIC_STAGES,
    verify:verifyAtomicNativeOracleWalletReview,prepare:prepareAtomicNativeOracleWalletAttempt,inspect:inspectAtomicNativeOracleWalletAttempt};
  if (compact && review?.format === 'bouncer-research-compressed-native-oracle-wallet-review-v1') {
    const withArtifacts=fn=>args=>fn({...args,...compact});
    return {stages:COMPRESSED_STAGES,verify:withArtifacts(verifyResearchPhoneReview),
      prepare:withArtifacts(prepareResearchPhoneAttempt),inspect:withArtifacts(inspectResearchPhoneAttempt)};
  }
  throw fail();
}
function idFromPlan(plan, enableAtomic, compact) {
  const expected = reviewOps(plan?.review, enableAtomic, compact).stages;
  if (!plan || plan.review?.owner !== plan.owner || plan.review.review_sha256 !== plan.review_sha256 ||
      !Array.isArray(plan.review.stages) || plan.review.stages.length !== expected.length ||
      !Array.isArray(plan.stages) || plan.stages.length !== expected.length) throw fail();
  return { owner:plan.owner, owner_public_key:plan.owner_public_key, operation_id:plan.operation_id, review_sha256:plan.review_sha256,
    stages:plan.review.stages.map((s,i)=> {
      if (s?.id !== expected[i] || plan.stages[i]?.stage_id !== s.id ||
          plan.stages[i]?.action_commitment_sha256 !== s.action_commitment_sha256) throw fail();
      return {stage_id:s.id,action_commitment_sha256:s.action_commitment_sha256};
    }) };
}
function journalsMatch(plan,state,enableAtomic,compact) {
  if (!state || !same(idFromPlan(plan,enableAtomic,compact),state.identity)) return false;
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
  getRetainedReview, wasmBytes, loaderBytes, compressedBytes, receiptProvider, owner, enableAtomic = false, enableCompressed = false } = {}) {
  if (typeof enableAtomic !== 'boolean' || typeof enableCompressed !== 'boolean' ||
      (enableCompressed && (!(loaderBytes instanceof Uint8Array) || loaderBytes.length!==NATIVE_PHONE_LOADER_BYTES ||
        crypto.createHash('sha256').update(loaderBytes).digest('hex')!==NATIVE_PHONE_LOADER_SHA256 ||
        !(compressedBytes instanceof Uint8Array) || compressedBytes.length!==NATIVE_PHONE_COMPRESSED_BYTES ||
        crypto.createHash('sha256').update(compressedBytes).digest('hex')!==NATIVE_PHONE_COMPRESSED_SHA256)) ||
      !isTestnetAccount(owner) || !owner.endsWith('.testnet') || owner === V3_OWNER ||
      !auth || typeof auth.issue !== 'function' || !fence || typeof fence.inspect !== 'function' ||
      !witness || ['inspect','assertClaimable'].some(k=>typeof witness[k]!=='function') ||
      !otherWitness || otherWitness === witness || typeof otherWitness.inspect !== 'function' ||
      !coordinator || ['reserve','claim','recordOriginal','verifyCompletion'].some(k=>typeof coordinator[k]!=='function') ||
      typeof getRetainedReview !== 'function' || !(wasmBytes instanceof Uint8Array) ||
      !receiptProvider || ['viewNodeStatus','txStatusReceipts'].some(k=>typeof receiptProvider[k]!=='function')) {
    throw Error('fixed named testnet owner, authenticated fence, both setup witnesses and retained native review required');
  }
  const wasm = Buffer.from(wasmBytes), compact=enableCompressed ? Object.freeze({loaderBytes:Buffer.from(loaderBytes),
    compressedBytes:Buffer.from(compressedBytes)}) : null;
  async function retained(taskId, ownerPublicKey, agentPublicKey) {
    if (typeof taskId !== 'string' || !/^[a-f0-9]{64}$/.test(taskId) || typeof agentPublicKey !== 'string' ||
        !/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(agentPublicKey)) throw fail();
    const value = await getRetainedReview(taskId,agentPublicKey,ownerPublicKey);
    if (!value?.review || value.review.owner !== owner || value.review.agent_public_key !== agentPublicKey ||
        value.review.review_sha256 !== taskId) throw fail();
    const review = structuredClone(value.review);
    try { reviewOps(review,enableAtomic,compact).verify({ review, wasmBytes:wasm, trustedReviewHash:review.review_sha256, trustedOwnerPublicKey:ownerPublicKey }); }
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
  async function trialService(rawIdentity, rawGoal, rawTrial, getFreshCompletion) {
    const {identity} = await witnessed(rawIdentity), goal = structuredClone(rawGoal), trial = structuredClone(rawTrial);
    if (!trial || typeof auth.authenticate !== 'function' || typeof witness.claimTrial !== 'function') throw fail();
    const review = await retained(identity.review_sha256,identity.owner_public_key,trial.agent_public_key);
    return {identity,trial,service:createAuthenticatedNativeOracleTrialClaim({goal,review,identity,wasmBytes:wasm,...(compact??{}),
      trustedReviewHash:identity.review_sha256,trustedOwnerPublicKey:identity.owner_public_key,auth,witness,otherWitness,getFreshCompletion})};
  }
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
      const {identity,state} = await witnessed(raw); if (!['complete','trial_claimed'].includes(state.phase)) throw fail();
      return auth.issue(action('verify_native_setup_completion',identity.owner_public_key,{identity}));
    },
    async verifyCompletion({ identity:raw, evidence } = {}) {
      const {identity,state} = await witnessed(raw); if (!['complete','trial_claimed'].includes(state.phase)) throw fail();
      return coordinator.verifyCompletion({identity,evidence});
    },
    /** Challenge binds the exact transaction hash, goal, key and current
     * witness head. This only authenticates the owner, not spend consent. */
    async issueTrial({ identity, goal, trial, expectedWitnessHead } = {}) {
      const prepared=await trialService(identity,goal,trial,async()=>{throw fail()});
      return prepared.service.issue({trial:prepared.trial,expectedWitnessHead});
    },
    /** Consume both one-use owner challenges, recheck setup, and retain the
     * hash before returning any proof. No signer or broadcaster is exposed. */
    async claimTrial({ identity, goal, trial, expectedWitnessHead, evidence, completionEvidence } = {}) {
      const ownerIdentity=structuredClone(identity), completionAuth=structuredClone(completionEvidence), trialAuth=structuredClone(evidence);
      const prepared=await trialService(ownerIdentity,goal,trial,()=>coordinator.verifyCompletion({identity:ownerIdentity,evidence:completionAuth}));
      const saved=await prepared.service.claim({trial:prepared.trial,expectedWitnessHead,evidence:trialAuth});
      return {status:'TRIAL_ORIGINAL_WITNESSED',owner:prepared.identity.owner,operation_id:prepared.identity.operation_id,
        review_sha256:prepared.identity.review_sha256,...saved.state.trial,witness_head:saved.head,independently_witnessed:true,
        do_not_retry:true,execution_authorized:false,transaction_sent:false};
    },
    async issueInspect({ ownerPublicKey } = {}) { return auth.issue(action('inspect_native_setup',ownerPublicKey)); },
    /** Verify an owner-supplied original hash before immutably recording it.
     * A missing receipt is unknown, not permission to retry a wallet prompt. */
    async previewOriginal({ ownerPublicKey, stageId, originalHash, evidence } = {}) {
      if (!isTransactionHash(originalHash)) throw fail();
      const plan = await fence.inspect({owner,ownerPublicKey,evidence}), remote = await witness.inspect(owner), state = remote.state;
      const ops = reviewOps(plan?.review,enableAtomic,compact);
      if (!ops.stages.includes(stageId) || !journalsMatch(plan,state,enableAtomic,compact)) throw fail();
      await checkPeer(otherWitness,owner,remote.head);
      const last=state.records.at(-1), claimed=state.phase==='claimed' && state.identity.stages[state.stage_index].stage_id===stageId;
      const recorded=['original','complete'].includes(state.phase) && last?.event==='original' &&
        last.stage_id===stageId && last.original_hash===originalHash;
      if (!claimed && !recorded) throw fail();
      try {
        if ((await receiptProvider.viewNodeStatus())?.chain_id!=='testnet') throw Error();
        const args = { review:plan.review, wasmBytes:wasm, trustedReviewHash:plan.review_sha256,
          trustedOwnerPublicKey:ownerPublicKey, stageId, trustedOriginalHash:originalHash };
        const attempt = ops.prepare(args);
        const result = structuredClone(await receiptProvider.txStatusReceipts(originalHash,owner,'FINAL'));
        return { ...ops.inspect({...args,attempt,result}), execution_authorized:false, original_recorded:recorded,
          scope:'Trusted-RPC original receipt preview only; this read does not record a hash, prompt a wallet, prove current state, delivery or authorization.' };
      } catch { throw new WalletWitnessError('RECEIPT_UNKNOWN','original receipt unavailable or mismatched; retain the hash and never resend'); }
    },
    /** Read the one witnessed trial's FINAL receipts. This never broadcasts,
     * changes the witness or treats a missing receipt as non-execution. */
    async previewTrial({ ownerPublicKey, evidence } = {}) {
      const plan = await fence.inspect({owner,ownerPublicKey,evidence});
      const snapshot = await witness.inspect(owner), state = snapshot.state, trial = state?.trial;
      if (!plan || !state || state.phase !== 'trial_claimed' || !trial || !journalsMatch(plan,state,enableAtomic,compact) ||
          state.identity.owner_public_key !== ownerPublicKey || typeof receiptProvider.block !== 'function') throw fail();
      await checkPeer(otherWitness,owner,snapshot.head);
      try {
        const review = structuredClone(plan.review), identity = structuredClone(state.identity);
        const goal = {id:trial.goal_id,contract_id:review.vault,owner_account_id:review.owner,policy_id:review.policy_id,
          amount:review.per_tx_cap_yocto,route:{project:review.project,route_revision:1,policy_revision:1,payee_revision:1,active:true},
          max_age_seconds:300};
        const checked = validateWitnessedNativeOracleTrial({goal,review,identity,wasmBytes:wasm,...(compact??{}),
          trustedReviewHash:identity.review_sha256,trustedOwnerPublicKey:ownerPublicKey});
        if (checked.goalSha256 !== trial.goal_sha256 || checked.agentPublicKey !== trial.agent_public_key) throw Error();
        assertWitnessedNativeOracleTrial(snapshot,identity,trial);
        if ((await receiptProvider.viewNodeStatus())?.chain_id !== 'testnet') throw Error();
        const chain = await receiptProvider.txStatusReceipts(trial.original_hash,owner,'FINAL');
        const delivery = await verifyOracleResult(checked.goal,chain,trial.agent_public_key,receiptProvider);
        if (delivery.tx_hash !== trial.original_hash) throw Error();
        const after = await witness.inspect(owner);
        assertWitnessedNativeOracleTrial(after,identity,trial);
        if (after.head !== snapshot.head || !same(after.state,snapshot.state)) throw Error();
        await checkPeer(otherWitness,owner,snapshot.head);
        return {status:'FINAL_NATIVE_ORACLE_DELIVERY_MATCH',owner,original_hash:trial.original_hash,delivery,
          do_not_retry:true,execution_authorized:false,provider_delivery_verified:true,
          scope:'Trusted testnet RPC and OutLayer receipts; single-source output, no TEE or market-data accuracy proof.'};
      } catch { throw new WalletWitnessError('RECEIPT_UNKNOWN','trial receipt unavailable or mismatched; retain the original and never resend'); }
    },
    async inspect({ ownerPublicKey, evidence } = {}) {
      let plan;
      try { plan = await fence.inspect({owner,ownerPublicKey,evidence}); }
      catch (error) { if (error?.code !== 'OWNER_FENCED') throw error; }
      const remote = await witness.inspect(owner), state = remote.state, peer = await otherWitness.inspect(owner);
      const recovery = scope => ({status:'RECOVERY_REQUIRED',execution_authorized:false,
        identity:state?.identity ?? (plan ? idFromPlan(plan,enableAtomic,compact) : null), witnessed_records:state?.records ?? [],
        database_stages:plan?.stages ?? [], witness_head:remote.head,scope});
      if (!peer || !Object.hasOwn(peer,'state') || peer.head!==remote.head) return recovery(
        'Witness heads differ or are unavailable; preserve originals and never open another prompt.');
      if (peer.state!==null) return recovery('A different setup flow is witnessed; reconcile it before any native prompt.');
      if (!plan && !state) return {status:'NO_LOCAL_RECORD',execution_authorized:false,
        scope:'No record in these systems is not proof that no wallet prompt or original exists elsewhere.'};
      if (!plan || !state || !journalsMatch(plan,state,enableAtomic,compact)) return recovery(
        'Independent journals disagree or one is missing; preserve originals and never open another prompt.');
      return {status:'WITNESSED',identity:state.identity,witnessed_records:state.records,review:structuredClone(plan.review),
        database_stages:structuredClone(plan.stages),witness_head:remote.head,execution_authorized:false,
        scope:'Authenticated retained state only; no wallet invocation, consent, FINAL execution or delivery established.'};
    },
  });
}
