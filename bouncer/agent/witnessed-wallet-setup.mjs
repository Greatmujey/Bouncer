/**
 * Experimental two-system write-ahead coordinator. PostgreSQL provides
 * authenticated one-shot claims and receipt/preflight checks; an independent
 * acknowledged Git witness is required before a claimed prompt can be handed
 * to a cooperating client. There is still no wallet invocation, backend HTTP
 * endpoint, durable hosted database, signer, transaction, policy unlock or
 * seller order here. This wrapper alone is NOT permission to spend.
 */
import { WalletWitnessError } from './git-wallet-prompt-witness.mjs';

const STAGES = ['create_keyless_vault', 'register_vault_circle', 'fund_vault_circle'];
const fail = code => new WalletWitnessError(code,
  'wallet setup is uncertain or no longer fresh; stop and reconcile, never repeat a claimed prompt');
function identityFrom(prompt) {
  if (!prompt?.setup_snapshot || prompt.stage_id !== STAGES[0] || !Array.isArray(prompt.review?.stages) || prompt.review.stages.length !== 3 ||
      prompt.review.owner !== prompt.owner || prompt.review.review_sha256 !== prompt.review_sha256) throw fail('WITNESS_MISMATCH');
  return { owner: prompt.owner, owner_public_key: prompt.owner_public_key, operation_id: prompt.operation_id,
    review_sha256: prompt.review_sha256, stages: prompt.review.stages.map((stage, index) => {
      if (stage?.id !== STAGES[index]) throw fail('WITNESS_MISMATCH');
      return { stage_id: stage.id, action_commitment_sha256: stage.action_commitment_sha256 };
    }) };
}
function common(id, stageId, evidence) {
  const stage = id?.stages?.find(x => x.stage_id === stageId);
  if (!stage || !STAGES.includes(stageId)) throw fail('WITNESS_MISMATCH');
  return { owner: id.owner, ownerPublicKey: id.owner_public_key, operationId: id.operation_id,
    reviewSha256: id.review_sha256, stageId, actionCommitmentSha256: stage.action_commitment_sha256, evidence };
}
function freshClaim(claim, id, stageId, now) {
  const clock = now(), checked = Date.parse(claim?.preflight_checked_at);
  if (claim?.owner !== id.owner || claim.operation_id !== id.operation_id || claim.review_sha256 !== id.review_sha256 ||
      claim.stage_id !== stageId || claim.action_commitment_sha256 !== id.stages.find(s => s.stage_id === stageId)?.action_commitment_sha256 ||
      claim.status !== 'PROMPT_CLAIMED_NO_HASH' || claim.do_not_retry !== true || claim.execution_authorized !== false ||
      !Number.isSafeInteger(clock) || !Number.isSafeInteger(checked) || clock < checked || clock - checked > 5_000) throw fail('WITNESSED_CLAIM_STALE');
}

// Both namespace witnesses must share the same physical branch/CAS and,
// for live use, the same independent latest-head anchor. Matching heads alone
// cannot prove two operator-supplied backends are the same service.
async function assertOtherFlowEmpty(other, owner, expectedHead) {
  const result = await other.inspect(owner);
  if (!result || typeof result.head !== 'string' || !result.head || result.head !== expectedHead || !Object.hasOwn(result, 'state')) {
    throw fail('WITNESS_HEAD_CHANGED');
  }
  if (result.state !== null) throw fail('CROSS_FLOW_WITNESSED');
}
export function createWitnessedWalletSetup({ fence, witness, otherWitness, now = Date.now } = {}) {
  const fenceMethods = ['reserve', 'claimPrompt', 'claimSetupStage', 'recordOriginalHash', 'recordSetupStageOriginal'];
  if (!fence || fenceMethods.some(m => typeof fence[m] !== 'function') || !witness ||
      ['inspect', 'reserve', 'assertClaimable', 'claim', 'recordOriginal'].some(m => typeof witness[m] !== 'function') ||
      !otherWitness || otherWitness === witness || typeof otherWitness.inspect !== 'function' || typeof now !== 'function') {
    throw Error('authenticated PostgreSQL fence and both same-branch setup witnesses required');
  }
  return Object.freeze({
    async reserve(request) {
      const owner = request?.review?.owner;
      const existing = await witness.inspect(owner);
      if (existing.state) throw fail('OWNER_ALREADY_WITNESSED');
      await assertOtherFlowEmpty(otherWitness, owner, existing.head);
      // The DB authenticates and retains the exact reviewed snapshot first.
      // Bind the Git append to the head at which BOTH flows were empty.
      const prompt = await fence.reserve(request), id = identityFrom(prompt);
      if (id.owner !== owner) throw fail('WITNESS_MISMATCH');
      const saved = await witness.reserve(id, existing.head);
      return { identity: id, witness_head: saved.head, status: 'RESERVED_NOT_CLAIMED',
        execution_authorized: false, wallet_invocation_verified: false,
        scope: 'testnet reservation and separate public witness only; no wallet, approval or spending' };
    },
    async claim({ identity: rawId, stageId, evidence } = {}) {
      const id = structuredClone(rawId), args = common(id, stageId, evidence);
      const expected = await witness.assertClaimable(id, stageId);
      await assertOtherFlowEmpty(otherWitness, id.owner, expected.head);
      const claim = await (stageId === STAGES[0] ? fence.claimPrompt(args) : fence.claimSetupStage(args));
      // Even if PostgreSQL returned, no cooperating client sees a claim until
      // the independent append is acknowledged and re-read. Any uncertainty
      // is a permanent stop, not a prompt or a second attempt.
      const saved = await witness.claim(id, stageId, expected);
      freshClaim(claim, id, stageId, now);
      return { ...claim, witness_head: saved.head, independently_witnessed: true,
        execution_authorized: false, wallet_invocation_verified: false,
        scope: 'one claim independently witnessed, but no wallet invocation, consent, transaction or delivery established' };
    },
    async recordOriginal({ identity: rawId, stageId, originalHash, evidence } = {}) {
      const id = structuredClone(rawId), args = common(id, stageId, evidence), before = await witness.inspect(id.owner);
      if (!before.state || JSON.stringify(before.state.identity) !== JSON.stringify(id)) throw fail('WITNESS_MISMATCH');
      const last = before.state.records.at(-1);
      if (before.state.phase !== 'claimed' && !(['original', 'complete'].includes(before.state.phase) &&
          last.stage_id === stageId && last.original_hash === originalHash)) throw fail('WITNESS_MISMATCH');
      if (before.state.phase === 'claimed' && before.state.identity.stages[before.state.stage_index].stage_id !== stageId) throw fail('WITNESS_MISMATCH');
      const saved = stageId === STAGES[0]
        ? await fence.recordOriginalHash({ owner: id.owner, ownerPublicKey: id.owner_public_key,
          operationId: id.operation_id, originalHash, evidence })
        : await fence.recordSetupStageOriginal({ ...args, originalHash });
      if (saved?.original_hash !== originalHash) throw fail('WITNESS_MISMATCH');
      const checkpoint = await witness.recordOriginal(id, stageId, originalHash);
      return { owner: id.owner, operation_id: id.operation_id, stage_id: stageId, original_hash: originalHash,
        witness_head: checkpoint.head, status: 'ORIGINAL_RECORDED', do_not_retry: true, execution_authorized: false,
        scope: 'original hash retained in two systems; FINAL receipt and current state still require verification' };
    },
  });
}
