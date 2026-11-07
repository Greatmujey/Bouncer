/**
 * Experimental two-system coordinator for the four native wallet stages.
 * PostgreSQL authenticates the exact owner action and verifies all prior
 * original receipt graphs plus a fresh same-block preflight. An independently
 * retained Git CAS witness must acknowledge and re-read the matching claim;
 * then the same claimed stage and prior receipts are checked again at a fresh
 * FINAL block before the coordinator returns. No wallet or chain action occurs.
 *
 * An unknown DB/Git acknowledgment, failed postcheck or missing original is a
 * permanent stop for that stage, not a reason to open another wallet prompt.
 * The independent latest Git head still requires outside retention/monitoring;
 * administrators, simultaneous rollback, bypassing clients, provider lies,
 * XSS and compromised wallet/host are not defeated. This is not a live UI or
 * spending authorization. Real owner approval is still a separate boundary.
 */
import { WalletWitnessError } from './git-wallet-prompt-witness.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

const STAGES = ['create_keyless_native_vault', 'configure_native_oracle_policy', 'fund_native_vault', 'install_native_oracle_agent'];
const fail = code => new WalletWitnessError(code, 'native wallet setup is uncertain or no longer fresh; stop and reconcile, never repeat a claimed prompt');
function identityFrom(prompt) {
  if (!prompt || prompt.status !== 'RESERVED_NOT_CLAIMED' || prompt.execution_authorized !== false ||
      prompt.review?.owner !== prompt.owner || prompt.review?.review_sha256 !== prompt.review_sha256 ||
      !Array.isArray(prompt.review?.stages) || prompt.review.stages.length !== STAGES.length ||
      !Array.isArray(prompt.stages) || prompt.stages.length !== STAGES.length) throw fail('WITNESS_MISMATCH');
  return { owner: prompt.owner, owner_public_key: prompt.owner_public_key, operation_id: prompt.operation_id,
    review_sha256: prompt.review_sha256, stages: prompt.review.stages.map((stage, index) => {
      if (stage?.id !== STAGES[index] || prompt.stages[index]?.stage_id !== stage.id || prompt.stages[index]?.claimed !== false ||
          prompt.stages[index]?.original_hash !== null || prompt.stages[index]?.action_commitment_sha256 !== stage.action_commitment_sha256) {
        throw fail('WITNESS_MISMATCH');
      }
      return { stage_id: stage.id, action_commitment_sha256: stage.action_commitment_sha256 };
    }) };
}
function common(identity, stageId, evidence) {
  const stage = identity?.stages?.find(s => s.stage_id === stageId);
  if (!stage || !STAGES.includes(stageId)) throw fail('WITNESS_MISMATCH');
  return { owner: identity.owner, ownerPublicKey: identity.owner_public_key, operationId: identity.operation_id,
    reviewSha256: identity.review_sha256, stageId, actionCommitmentSha256: stage.action_commitment_sha256, evidence };
}
function checkFresh(claim, id, stageId, now) {
  const clock = now(), checked = Date.parse(claim?.preflight_checked_at);
  if (claim?.owner !== id.owner || claim.operation_id !== id.operation_id || claim.review_sha256 !== id.review_sha256 ||
      claim.stage_id !== stageId || claim.action_commitment_sha256 !== id.stages.find(s => s.stage_id === stageId)?.action_commitment_sha256 ||
      claim.status !== 'PROMPT_CLAIMED_NO_HASH' || claim.do_not_retry !== true || claim.execution_authorized !== false ||
      !isTransactionHash(claim.preflight_block_hash) || !Number.isSafeInteger(clock) || !Number.isSafeInteger(checked) ||
      clock < checked || clock - checked > 5000) throw fail('WITNESSED_CLAIM_STALE');
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
export function createWitnessedNativeOracleSetup({ fence, witness, otherWitness, now = Date.now } = {}) {
  if (!fence || ['reserve','inspect','claim','recheckClaimBeforePrompt','recordOriginal','verifyCompletion'].some(m => typeof fence[m] !== 'function') || !witness ||
      ['inspect','reserve','assertClaimable','claim','recordOriginal'].some(m => typeof witness[m] !== 'function') ||
      !otherWitness || otherWitness === witness || typeof otherWitness.inspect !== 'function' || typeof now !== 'function') {
    throw Error('authenticated native PostgreSQL fence and both same-branch setup witnesses required');
  }
  return Object.freeze({
    async reserve(request = {}) {
      const owner = request?.review?.owner, existing = await witness.inspect(owner);
      if (existing.state) throw fail('OWNER_ALREADY_WITNESSED');
      await assertOtherFlowEmpty(otherWitness, owner, existing.head);
      // The witness CAS is tied to the head at which BOTH namespaces were
      // checked, even if a different flow or database races this reservation.
      const reservation = await fence.reserve(request), identity = identityFrom(reservation);
      if (identity.owner !== owner) throw fail('WITNESS_MISMATCH');
      const saved = await witness.reserve(identity, existing.head);
      return { identity, review: reservation.review, witness_head: saved.head, status: 'RESERVED_NOT_CLAIMED',
        execution_authorized: false, wallet_invocation_verified: false,
        scope: 'native testnet reservation and public independent witness only; no approval, wallet, transaction or provider work' };
    },
    async claim({ identity: raw, stageId, evidence } = {}) {
      const identity = structuredClone(raw), args = common(identity, stageId, evidence);
      const checkpoint = await witness.assertClaimable(identity, stageId);
      await assertOtherFlowEmpty(otherWitness, identity.owner, checkpoint.head);
      const claim = await fence.claim(args);
      // If this write or acknowledgement fails, the database claim may already
      // exist. No prompt is returned; never try to claim the same stage again.
      const saved = await witness.claim(identity, stageId, checkpoint);
      // Git and checkpoint round trips can consume the original five-second
      // window. Recheck the SAME already-claimed stage after acknowledgement;
      // never claim again, extend a stale snapshot, or retry a wallet prompt.
      let recheck;
      try { recheck = await fence.recheckClaimBeforePrompt(args); }
      catch { throw fail('WITNESSED_POSTCHECK_UNAVAILABLE'); }
      if (recheck?.status !== 'CLAIM_PREFLIGHT_RECHECKED_NOT_AUTHORIZED' || recheck.owner !== identity.owner ||
          recheck.operation_id !== identity.operation_id || recheck.review_sha256 !== identity.review_sha256 ||
          recheck.stage_id !== stageId || recheck.action_commitment_sha256 !== args.actionCommitmentSha256 ||
          recheck.do_not_retry !== true || recheck.execution_authorized !== false || !isTransactionHash(recheck.preflight_block_hash)) {
        throw fail('WITNESSED_POSTCHECK_UNAVAILABLE');
      }
      const currentClaim = { ...claim, preflight_block_hash:recheck.preflight_block_hash, preflight_checked_at:recheck.preflight_checked_at };
      checkFresh(currentClaim, identity, stageId, now);
      return { ...currentClaim, witness_head: saved.head, independently_witnessed: true,
        execution_authorized: false, wallet_invocation_verified: false,
        scope: 'independently witnessed native stage claim with a post-witness FINAL recheck; not owner consent, a wallet invocation, transaction or delivery' };
    },
    /** A complete witness means originals are retained, not that they are
     * successful. Recheck every receipt and exact installed state before
     * reporting any completion evidence, and compare both retained histories. */
    async verifyCompletion({ identity: raw, evidence } = {}) {
      const identity = structuredClone(raw), checkpoint = await witness.inspect(identity?.owner), state = checkpoint.state;
      if (!state || !['complete','trial_claimed'].includes(state.phase) || JSON.stringify(state.identity) !== JSON.stringify(identity)) throw fail('WITNESS_MISMATCH');
      const originals = state.records.filter(r => r.event === 'original').map(r => r.original_hash);
      if (originals.length !== STAGES.length) throw fail('WITNESS_MISMATCH');
      const result = await fence.verifyCompletion({ owner: identity.owner, ownerPublicKey: identity.owner_public_key,
        operationId: identity.operation_id, reviewSha256: identity.review_sha256, evidence });
      if (!Array.isArray(result?.prior_original_hashes) || JSON.stringify(result.prior_original_hashes) !== JSON.stringify(originals)) throw fail('WITNESS_MISMATCH');
      const after = await witness.inspect(identity.owner);
      if (after.head !== checkpoint.head || JSON.stringify(after.state) !== JSON.stringify(state)) throw fail('WITNESS_MISMATCH');
      return { ...result, independently_witnessed: true, witness_head: checkpoint.head, execution_authorized: false,
        scope: 'four original receipt graphs and current setup at one trusted-RPC FINAL block; not local custody, provider execution, spending approval or a state reservation' };
    },
    async recordOriginal({ identity: raw, stageId, originalHash, evidence } = {}) {
      const identity = structuredClone(raw), args = common(identity, stageId, evidence), before = await witness.inspect(identity.owner);
      if (!before.state || JSON.stringify(before.state.identity) !== JSON.stringify(identity)) throw fail('WITNESS_MISMATCH');
      const last = before.state.records.at(-1);
      if (before.state.phase !== 'claimed' && !(['original','complete'].includes(before.state.phase) &&
          last.stage_id === stageId && last.original_hash === originalHash)) throw fail('WITNESS_MISMATCH');
      if (before.state.phase === 'claimed' && before.state.identity.stages[before.state.stage_index].stage_id !== stageId) throw fail('WITNESS_MISMATCH');
      const saved = await fence.recordOriginal({ ...args, originalHash });
      if (saved?.original_hash !== originalHash) throw fail('WITNESS_MISMATCH');
      const checkpoint = await witness.recordOriginal(identity, stageId, originalHash);
      return { owner: identity.owner, operation_id: identity.operation_id, stage_id: stageId, original_hash: originalHash,
        witness_head: checkpoint.head, status: 'ORIGINAL_RECORDED', do_not_retry: true, execution_authorized: false,
        scope: 'original hash retained in two systems; FINAL receipt and current state still require verification' };
    },
  });
}
