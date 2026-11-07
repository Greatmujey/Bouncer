/**
 * Experimental owner-authenticated orchestration for the independently
 * witnessed setup journal. No HTTP routes, wallet adapter, signer, transaction
 * payload, broadcast, seller order or execution authorization are exposed.
 * Trusted server dependencies provide retained reviews and an authenticating
 * PostgreSQL fence; browser input can only select a retained operation/stage.
 */
import { verifyBufferWalletSetupReview } from './buffer-wallet-setup-evidence.mjs';
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

export function createAuthenticatedWitnessedSetupService({ auth, fence, witness, coordinator, getRetainedReview, setupWasmBytes, owner } = {}) {
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
    async issueInspect({ ownerPublicKey } = {}) { return auth.issue(prefix('inspect', owner, ownerPublicKey)); },
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
        claim_status: prompt.claim_status, execution_authorized: false,
        scope: 'Owner-authenticated journal state; wallet invocation, consent, FINAL execution and delivery are not established.' };
    },
  });
}
