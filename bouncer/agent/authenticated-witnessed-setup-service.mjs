/**
 * Experimental owner-authenticated orchestration for the independently
 * witnessed setup journal. This service has no wallet signer, transaction
 * broadcaster, seller order or execution authorization.
 * Trusted server dependencies provide retained reviews and an authenticating
 * PostgreSQL fence; browser input can only select a retained operation/stage.
 */
import { verifyBufferWalletSetupReview, prepareBufferWalletSetupAttempt, inspectBufferWalletSetupAttempt } from './buffer-wallet-setup-evidence.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { WalletWitnessError } from './git-wallet-prompt-witness.mjs';

const STAGES = ['create_keyless_vault', 'register_vault_circle', 'fund_vault_circle'];
const FORM = 'bouncer-wallet-prompt-auth-v1';
const fail = () => new WalletWitnessError('SETUP_UNAVAILABLE',
  'review or owner-authenticated witness is unavailable; stop and reconcile, never repeat a wallet prompt');
const prefix = (purpose, owner, owner_public_key) => ({ format: FORM, network: 'testnet', purpose, owner, owner_public_key });
function stageContext(identity, stageId) {
  const stage = identity?.stages?.find(s => s.stage_id === stageId);
  if (!stage || !STAGES.includes(stageId)) throw fail();
  return { operation_id: identity.operation_id, review_sha256: identity.review_sha256,
    stage_id: stageId, action_commitment_sha256: stage.action_commitment_sha256 };
}
function idFromPrompt(prompt) {
  if (!prompt?.setup_snapshot || prompt.stage_id !== STAGES[0] || prompt.review?.owner !== prompt.owner ||
      prompt.review.review_sha256 !== prompt.review_sha256 || !Array.isArray(prompt.review.stages) || prompt.review.stages.length !== 3) throw fail();
  return { owner: prompt.owner, owner_public_key: prompt.owner_public_key, operation_id: prompt.operation_id,
    review_sha256: prompt.review_sha256, stages: prompt.review.stages.map((s, i) => {
      if (s?.id !== STAGES[i]) throw fail();
      return { stage_id: s.id, action_commitment_sha256: s.action_commitment_sha256 };
    }) };
}

export function createAuthenticatedWitnessedSetupService({ auth, fence, witness, coordinator, getRetainedReview, setupWasmBytes, setupReceiptProvider, owner } = {}) {
  if (!auth || typeof auth.issue !== 'function' || !fence || typeof fence.inspect !== 'function' ||
      !witness || typeof witness.inspect !== 'function' || typeof witness.assertClaimable !== 'function' ||
      !coordinator || ['reserve', 'claim', 'recordOriginal'].some(k => typeof coordinator[k] !== 'function') ||
      typeof getRetainedReview !== 'function' || !(setupWasmBytes instanceof Uint8Array) || typeof owner !== 'string') {
    throw Error('fixed owner, authenticated fence, separate witness and server-retained review required');
  }
  const wasm = Buffer.from(setupWasmBytes);
  async function retained(taskId, publicKey) {
    if (typeof taskId !== 'string' || !/^[a-f0-9]{32}$/.test(taskId)) throw fail();
    const value = await getRetainedReview(taskId);
    if (!value || value.review?.owner !== owner || value.snapshot?.owner !== owner) throw fail();
    const review = structuredClone(value.review), snapshot = structuredClone(value.snapshot);
    verifyBufferWalletSetupReview({ review, snapshot, wasmBytes: wasm, trustedReviewHash: review.review_sha256,
      trustedOwnerPublicKey: publicKey });
    return { review, snapshot };
  }
  async function witnessedIdentity(raw) {
    const identity = structuredClone(raw);
    if (identity?.owner !== owner) throw fail();
    const snapshot = await witness.inspect(owner);
    if (!snapshot.state || JSON.stringify(snapshot.state.identity) !== JSON.stringify(identity)) throw fail();
    return { identity, state: snapshot.state };
  }
  function witnessedOriginal(state, stageId, originalHash) {
    return isTransactionHash(originalHash) && STAGES.includes(stageId) && state.records.some(r =>
      r.event === 'original' && r.stage_id === stageId && r.original_hash === originalHash);
  }
  return Object.freeze({
    async issueReservation({ taskId, ownerPublicKey } = {}) {
      const { review } = await retained(taskId, ownerPublicKey);
      const snapshot = await witness.inspect(owner);
      if (snapshot.state) throw fail();
      return auth.issue({ ...prefix('reserve', owner, ownerPublicKey), review_sha256: review.review_sha256,
        stage_id: STAGES[0], action_commitment_sha256: review.stages[0].action_commitment_sha256 });
    },
    async reserve({ taskId, ownerPublicKey, evidence } = {}) {
      const { review, snapshot } = await retained(taskId, ownerPublicKey);
      return coordinator.reserve({ review, setupSnapshot: snapshot, trustedReviewHash: review.review_sha256,
        trustedOwnerPublicKey: ownerPublicKey, stageId: STAGES[0], evidence });
    },
    async issueClaim({ identity: raw, stageId } = {}) {
      const { identity } = await witnessedIdentity(raw);
      await witness.assertClaimable(identity, stageId);
      return auth.issue({ ...prefix(stageId === STAGES[0] ? 'claim_prompt' : 'claim_setup_stage', owner, identity.owner_public_key),
        ...stageContext(identity, stageId) });
    },
    async claim({ identity: raw, stageId, evidence } = {}) {
      const { identity } = await witnessedIdentity(raw);
      return coordinator.claim({ identity, stageId, evidence });
    },
    async issueOriginal({ identity: raw, stageId, originalHash } = {}) {
      const { identity, state } = await witnessedIdentity(raw), last = state.records.at(-1);
      if (!isTransactionHash(originalHash) || !(state.phase === 'claimed' && state.identity.stages[state.stage_index].stage_id === stageId) &&
          !(['original','complete'].includes(state.phase) && last.stage_id === stageId && last.original_hash === originalHash)) throw fail();
      const operation = stageContext(identity, stageId);
      return auth.issue(stageId === STAGES[0]
        ? { ...prefix('record_original_hash', owner, identity.owner_public_key), operation_id: identity.operation_id, original_hash: originalHash }
        : { ...prefix('record_setup_stage_original', owner, identity.owner_public_key), ...operation, original_hash: originalHash });
    },
    async recordOriginal({ identity: raw, stageId, originalHash, evidence } = {}) {
      const { identity } = await witnessedIdentity(raw);
      return coordinator.recordOriginal({ identity, stageId, originalHash, evidence });
    },
    async issueReconcile({ identity: raw, stageId, originalHash } = {}) {
      const { identity, state } = await witnessedIdentity(raw);
      if (!witnessedOriginal(state, stageId, originalHash)) throw fail();
      return auth.issue({ ...prefix(stageId === STAGES[0] ? 'reconcile_setup_original' : 'reconcile_setup_stage',
        owner, identity.owner_public_key), ...stageContext(identity, stageId), original_hash: originalHash });
    },
    async reconcile({ identity: raw, stageId, originalHash, evidence } = {}) {
      const { identity, state } = await witnessedIdentity(raw);
      if (!witnessedOriginal(state, stageId, originalHash)) throw fail();
      const args = { owner, ownerPublicKey: identity.owner_public_key, operationId: identity.operation_id,
        reviewSha256: identity.review_sha256, stageId,
        actionCommitmentSha256: stageContext(identity, stageId).action_commitment_sha256, originalHash, evidence };
      const method = stageId === STAGES[0] ? 'reconcileSetupOriginal' : 'reconcileSetupStage';
      if (typeof fence[method] !== 'function') throw fail();
      return fence[method](args);
    },
    async issueVerifyFunded({ identity: raw } = {}) {
      const { identity, state } = await witnessedIdentity(raw);
      if (state.phase !== 'complete') throw fail();
      return auth.issue({ ...prefix('verify_setup_funded', owner, identity.owner_public_key),
        operation_id: identity.operation_id, review_sha256: identity.review_sha256 });
    },
    async verifyFunded({ identity: raw, evidence } = {}) {
      const { identity, state } = await witnessedIdentity(raw);
      if (state.phase !== 'complete' || typeof fence.verifySetupFunded !== 'function') throw fail();
      return fence.verifySetupFunded({ owner, ownerPublicKey: identity.owner_public_key,
        operationId: identity.operation_id, reviewSha256: identity.review_sha256, evidence });
    },
    async issueInspect({ ownerPublicKey } = {}) { return auth.issue(prefix('inspect', owner, ownerPublicKey)); },
    /** Verify an owner-provided original BEFORE recording its immutable hash.
     * This is read-only; an unavailable or mismatched receipt never permits a
     * retry and is not evidence that the wallet transaction was absent. */
    async previewOriginal({ ownerPublicKey, stageId, originalHash, evidence } = {}) {
      if (!STAGES.includes(stageId) || !isTransactionHash(originalHash) || !setupReceiptProvider ||
          typeof setupReceiptProvider.viewNodeStatus !== 'function' || typeof setupReceiptProvider.txStatusReceipts !== 'function') throw fail();
      const prompt = await fence.inspect({ owner, ownerPublicKey, evidence });
      const remote = await witness.inspect(owner), state = remote.state;
      if (!prompt || !state || JSON.stringify(idFromPrompt(prompt)) !== JSON.stringify(state.identity) ||
          state.phase !== 'claimed' || STAGES[state.stage_index] !== stageId) throw fail();
      try {
        if ((await setupReceiptProvider.viewNodeStatus())?.chain_id !== 'testnet') throw Error();
        const args = { review:prompt.review, snapshot:prompt.setup_snapshot, wasmBytes:wasm,
          trustedReviewHash:prompt.review_sha256, trustedOwnerPublicKey:ownerPublicKey,
          stageId, trustedOriginalHash:originalHash };
        const attempt = prepareBufferWalletSetupAttempt(args);
        const result = structuredClone(await setupReceiptProvider.txStatusReceipts(originalHash, owner, 'FINAL'));
        const proof = inspectBufferWalletSetupAttempt({ ...args, attempt, result });
        return { ...proof, execution_authorized:false, original_recorded:false,
          scope:'Read-only matching against a trusted testnet RPC; no wallet prompt, recording, purchase or delivery.' };
      } catch { throw new WalletWitnessError('RECEIPT_UNKNOWN',
        'original receipt is unavailable or mismatched; keep the hash and never resend the transaction'); }
    },
    async inspect({ ownerPublicKey, evidence } = {}) {
      const prompt = await fence.inspect({ owner, ownerPublicKey, evidence });
      const remote = await witness.inspect(owner);
      if (!prompt && !remote.state) return { status: 'NO_LOCAL_RECORD', execution_authorized: false,
        scope: 'No record in these two systems is not proof that no wallet prompt or original exists elsewhere.' };
      if (!prompt && remote.state) return { status: 'RECOVERY_REQUIRED', identity: remote.state.identity,
        witnessed_records: remote.state.records, execution_authorized: false,
        scope: 'Database missing but public witness remains; do not recreate or retry a prompt.' };
      if (!remote.state || JSON.stringify(idFromPrompt(prompt)) !== JSON.stringify(remote.state.identity)) throw fail();
      return { status: 'WITNESSED', identity: remote.state.identity, witnessed_records: remote.state.records,
        review: structuredClone(prompt.review), snapshot: structuredClone(prompt.setup_snapshot),
        claim_status: prompt.claim_status, execution_authorized: false,
        scope: 'Owner-authenticated journal state; wallet invocation, consent, FINAL execution and delivery are not established.' };
    },
  });
}
