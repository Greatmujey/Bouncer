/**
 * Offline review and read-only original-receipt verification for a shorter
 * native-NEAR setup. The existing nine create/configure/fund actions share one
 * vault receipt; installing the restricted agent key is a separate transaction
 * to the owner account. Neither this module nor its review signs, sends,
 * opens a wallet, proves current chain state or authorizes spending.
 *
 * Atomicity and zero-allowance hash markers have been exercised on isolated
 * nearcore, not on the user's phone. A separately retained one-shot claim,
 * original hashes, fresh FINAL state and recovery are still mandatory. An
 * absent marker or an unknown wallet result is never permission to resend.
 */
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import nearApi from 'near-api-js';
import { buildNativeOracleWalletPlan } from './native-oracle-wallet-plan.mjs';
import { validateNativeOracleOwnerPublicKey } from './native-oracle-wallet-evidence.mjs';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { graph, rootOf, statusKind, onlyProtocolGasRefund } from './setup-receipt-graph.mjs';

const CREATE = 'create_configure_fund_native_vault';
// Reuse the reviewed single-AddKey stage name so the receipt verifier handles
// nearcore's omitted local receipt body under exactly its existing restriction.
const INSTALL = 'install_native_oracle_agent';
const STAGES = [CREATE, INSTALL];
const DOMAIN = Buffer.from('bouncer-atomic-native-setup-batch-v1\0');
const DUMMY_KEY = nearApi.utils.PublicKey.from('ed25519:11111111111111111111111111111111');
const STAGE_FIELDS = ['id', 'signer_id', 'receiver_id', 'actions', 'action_commitment_sha256'];
const ATTEMPT_FIELDS = ['kind', 'status', 'network', 'review_sha256', 'stage_id', 'action_commitment_sha256',
  'tx_hash', 'signer_id', 'signer_public_key', 'receiver_id'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, fields) => record(value) && Object.keys(value).length === fields.length && fields.every(k => Object.hasOwn(value, k));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

/** Offline review commitment only. A dummy nonce, key and block hash mean
 * this is NOT the original transaction hash and cannot be submitted. */
export function atomicNativeBatchCommitment(batch) {
  if (!record(batch) || !STAGES.includes(batch.id) || !isTestnetAccount(batch.signerId) ||
      !isTestnetAccount(batch.receiverId) || !Array.isArray(batch.actions) ||
      batch.actions.length !== (batch.id === CREATE ? 9 : 1) ||
      (batch.id === CREATE ? batch.receiverId === batch.signerId : batch.receiverId !== batch.signerId)) {
    throw new Error('invalid atomic native setup batch');
  }
  try {
    const tx = nearApi.transactions.createTransaction(batch.signerId, DUMMY_KEY, batch.receiverId,
      1n, batch.actions, Buffer.alloc(32));
    return crypto.createHash('sha256').update(DOMAIN).update(nearApi.transactions.encodeTransaction(tx)).digest('hex');
  } catch { throw new Error('cannot encode atomic native setup batch'); }
}

/** Check the SDK actions again against the separately retained public stage. */
export function assertAtomicNativeBatchMatchesReview(batch, stage) {
  if (!exact(stage, STAGE_FIELDS) || !record(batch) || batch.id !== stage.id ||
      batch.signerId !== stage.signer_id || batch.receiverId !== stage.receiver_id ||
      !Array.isArray(stage.actions) || stage.actions.length !== batch.actions?.length ||
      !/^[a-f0-9]{64}$/.test(stage.action_commitment_sha256 ?? '') ||
      atomicNativeBatchCommitment(batch) !== stage.action_commitment_sha256) {
    throw new Error('atomic native actions do not match the retained review');
  }
  return true;
}

/** Fixed testnet terms, pinned V9 bytes, and a PUBLIC owner key only. */
export function buildAtomicNativeOracleWalletPlan({ terms, wasmBytes, trustedOwnerPublicKey } = {}) {
  const base = buildNativeOracleWalletPlan({ terms, wasmBytes });
  const identity = { owner: base.review.owner, vault: base.review.vault, agent_public_key: base.review.agent_public_key,
    owner_public_key: validateNativeOracleOwnerPublicKey(trustedOwnerPublicKey, base.review.agent_public_key) };
  const first = base.batches.slice(0, 3);
  if (!first.every(batch => batch.signerId === identity.owner && batch.receiverId === identity.vault)) {
    throw new Error('native vault actions do not share the same receiver');
  }
  const batches = [
    { id: CREATE, signerId: identity.owner, receiverId: identity.vault, actions: first.flatMap(batch => batch.actions) },
    { ...base.batches[3], actions: [...base.batches[3].actions] },
  ];
  const summaries = [base.review.stages.slice(0, 3).flatMap(stage => structuredClone(stage.actions)),
    structuredClone(base.review.stages[3].actions)];
  const stages = batches.map((batch, index) => ({ id: batch.id, signer_id: batch.signerId, receiver_id: batch.receiverId,
    actions: summaries[index], action_commitment_sha256: atomicNativeBatchCommitment(batch) }));
  batches.forEach((batch, index) => assertAtomicNativeBatchMatchesReview(batch, stages[index]));
  const review = { format: 'bouncer-atomic-native-oracle-wallet-review-v1', status: 'UNSIGNED_OFFLINE_PLAN_ONLY', network: 'testnet',
    owner: identity.owner, owner_public_key: identity.owner_public_key, vault: identity.vault,
    policy_id: base.review.policy_id, agent_public_key: identity.agent_public_key, asset: 'native',
    payee: base.review.payee, project: structuredClone(base.review.project), artifact: structuredClone(base.review.artifact),
    per_tx_cap_yocto: base.review.per_tx_cap_yocto, daily_cap_yocto: base.review.daily_cap_yocto,
    vault_deposit_yocto: base.review.vault_deposit_yocto, agent_gas_allowance_yocto: base.review.agent_gas_allowance_yocto,
    vault_storage_funding_yocto: base.review.vault_storage_funding_yocto, base_review_sha256: base.review.review_sha256, stages,
    limitations: [
      'Offline testnet review only: it does not establish wallet control, user approval, a live purchase or provider delivery.',
      'The first wallet transaction creates, configures and funds the vault; the second separately installs the one-method agent key. Wallet support for the nine actions is unverified.',
      'The keyless vault storage funding may be locked. Native provider funding and gas are additional; verify actual testnet balance and protocol costs first.',
      'A separately retained one-shot claim and original hash are required for each wallet prompt. An unknown, rejected or failed original must never be automatically resent.',
      'Before each prompt, verify the exact original receipt graph and fresh FINAL state, including code, owner, caps, route, balance and key scope.',
      'Atomic create/configure/fund prevents a successful duplicate vault creation, not all cross-device, rollback or bypassing-client risks.',
      'The restricted key can call only the fixed native-project method and cannot attach the 1 yocto needed for owner policy changes.',
      'OutLayer receives the maximum; a verified unused refund returns to the owner, not the vault. The full maximum remains in the rolling budget.',
      'The reviewed trial is one OutLayer price-data task, not independent storage, FT delivery, attestation or proof of price accuracy.',
    ], signing_authorized: false, transaction_sent: false, agent_key_installed: false, independent_delivery_verified: false };
  return { review: { ...review, review_sha256: sha(JSON.stringify(review)) }, batches };
}

function canonical({ review, wasmBytes, trustedReviewHash, trustedOwnerPublicKey } = {}) {
  if (!record(review) || typeof trustedReviewHash !== 'string' || !/^[a-f0-9]{64}$/.test(trustedReviewHash) ||
      review.review_sha256 !== trustedReviewHash || review.owner_public_key !== trustedOwnerPublicKey) {
    throw new Error('separately retained atomic review and owner key required');
  }
  try {
    const plan = buildAtomicNativeOracleWalletPlan({ wasmBytes, trustedOwnerPublicKey, terms: {
      owner: review.owner, vault: review.vault, policy_id: review.policy_id, agent_public_key: review.agent_public_key,
      per_tx_cap_yocto: review.per_tx_cap_yocto, daily_cap_yocto: review.daily_cap_yocto,
      vault_deposit_yocto: review.vault_deposit_yocto, agent_gas_allowance_yocto: review.agent_gas_allowance_yocto,
    } });
    if (!isDeepStrictEqual(plan.review, review)) throw Error();
    return plan;
  } catch { throw new Error('atomic review differs from its constrained canonical plan'); }
}

export function verifyAtomicNativeOracleWalletReview(options = {}) {
  const { review } = canonical(options);
  return { review_sha256: review.review_sha256, owner: review.owner, owner_public_key: review.owner_public_key,
    vault: review.vault, agent_public_key: review.agent_public_key };
}

/** Build an attempt only from the original wallet-returned hash. This is
 * recovery evidence, not a claim that the wallet was prompted or consented. */
function attemptForPlan(plan, stageId, trustedOriginalHash) {
  const index = STAGES.indexOf(stageId);
  if (index < 0 || !isTransactionHash(trustedOriginalHash)) throw new Error('reviewed atomic stage and original hash required');
  const r = plan.review, stage = r.stages[index];
  return { kind: 'atomic-native-oracle-wallet-attempt-v1', status: 'pending', network: 'testnet',
    review_sha256: r.review_sha256, stage_id: stage.id, action_commitment_sha256: stage.action_commitment_sha256,
    tx_hash: trustedOriginalHash, signer_id: stage.signer_id, signer_public_key: r.owner_public_key,
    receiver_id: stage.receiver_id };
}
export function prepareAtomicNativeOracleWalletAttempt(options = {}) {
  return attemptForPlan(canonical(options), options.stageId, options.trustedOriginalHash);
}

/** Exact original transaction and bounded FINAL receipt graph only. It never
 * permits the next prompt and never infers success from current state alone. */
export function inspectAtomicNativeOracleWalletAttempt(options = {}) {
  const { attempt, result } = options;
  if (!exact(attempt, ATTEMPT_FIELDS)) throw new Error('separately retained atomic attempt required');
  const plan = canonical(options), expected = attemptForPlan(plan, attempt.stage_id, options.trustedOriginalHash);
  if (!isDeepStrictEqual(attempt, expected)) throw new Error('atomic attempt differs from its retained original');
  const index = STAGES.indexOf(attempt.stage_id), batch = plan.batches[index];
  if (!record(result) || result.final_execution_status !== 'FINAL' || !['value', 'failure'].includes(statusKind(result.status))) {
    throw new Error('original atomic transaction is not terminal FINAL; preserve it and do not resend');
  }
  const g = graph(result, attempt.stage_id === INSTALL), root = rootOf(result, batch, attempt, g);
  if (!root.localReceiptOmitted) {
    const action = root.receipt.receipt?.Action;
    if (!exact(root.receipt.receipt, ['Action']) || !Array.isArray(action?.input_data_ids) || action.input_data_ids.length ||
        !Array.isArray(action?.output_data_receivers) || action.output_data_receivers.length ||
        (action.is_promise_yield !== undefined && action.is_promise_yield !== false)) throw new Error('unexpected atomic action receipt metadata');
  }
  if (statusKind(result.status) === 'failure' || [...g.outcomes.values()].some(out => statusKind(out.status) === 'failure')) {
    return { stage_id: attempt.stage_id, tx_hash: options.trustedOriginalHash, status: 'FINAL_FAILURE_NEEDS_STATE_REVIEW',
      do_not_resend: true, current_state_verified: false, independent_delivery_verified: false };
  }
  if (!isDeepStrictEqual(result.status, { SuccessValue: '' }) || !isDeepStrictEqual(root.outcome.status, result.status) ||
      result.transaction_outcome.outcome.receipt_ids.length !== 1 || result.transaction_outcome.outcome.receipt_ids[0] !== root.id ||
      !onlyProtocolGasRefund(root.outcome, g, attempt, root.localReceiptOmitted) ||
      (attempt.stage_id === CREATE && (!Array.isArray(root.outcome.logs) || !root.outcome.logs.includes('BOUNCER native deposit received')))) {
    throw new Error('unexpected, incomplete or nonterminal atomic native receipt graph');
  }
  return { stage_id: attempt.stage_id, tx_hash: options.trustedOriginalHash, root_receipt: root.id,
    status: root.localReceiptOmitted ? 'FINAL_LOCAL_ADD_KEY_OUTCOME_MATCH' : 'FINAL_ATOMIC_NATIVE_SETUP_RECEIPT_MATCH',
    local_receipt_body_omitted: root.localReceiptOmitted, do_not_resend: true, current_state_verified: false,
    owner_approval_verified: false, independent_delivery_verified: false,
    scope: 'trusted-RPC original action/outcome match only; fresh state and an independent prompt fence remain required' };
}
