/**
 * Offline original-hash evidence checks for the unsigned Svalin testnet setup.
 * There is intentionally no signer, RPC client, journal, sender or retry here.
 * A matching result trusts the supplied RPC and deployed token/vault code; it
 * is not a light-client proof, a fresh-state check or owner consent.
 */
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import nearApi from 'near-api-js';
import { buildUnsignedSvalinTrialSetup, assertSvalinBatchMatchesReview } from './svalin-setup-plan.mjs';
import { CIRCLE_TESTNET_USDC } from '../scripts/circle-testnet-setup.mjs';
import { SVALIN_TRIAL_MAX_ATOMS } from './svalin-pro-preflight.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { statusKind, decodeJson, graph, rootOf, onlyProtocolGasRefund, fundingEvidence } from './setup-receipt-graph.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysAre = (value, names) => record(value) && Object.keys(value).length === names.length &&
  names.every(name => Object.hasOwn(value, name));
const equal = isDeepStrictEqual;
const STAGES = ['create_keyless_vault', 'configure_locked_policy', 'install_restricted_agent_key',
  'register_vault_for_test_usdc', 'fund_vault_with_test_usdc'];
const ATTEMPT_FIELDS = ['kind', 'status', 'network', 'review_sha256', 'stage_id', 'action_commitment_sha256',
  'tx_hash', 'signer_id', 'signer_public_key', 'receiver_id'];
const digest = value => crypto.createHash('sha256').update(value).digest();

function publicKey(value) {
  if (typeof value !== 'string') throw new Error('a canonical owner public key is required');
  let key;
  try { key = nearApi.utils.PublicKey.from(value); } catch { throw new Error('invalid owner public key'); }
  if (key.keyType !== 0 || String(key) !== value) throw new Error('a canonical owner Ed25519 public key is required');
  return value;
}

// Rebuild the entire constrained plan, not just the requested batch. Both the
// review and the digest must come from a trusted retained copy; a hash alone
// is neither a signature nor proof that the owner approved anything.
function canonicalPlan(plan, trustedReviewHash) {
  if (!record(plan) || !record(plan.review) || !Array.isArray(plan.batches) || plan.batches.length !== STAGES.length ||
      typeof trustedReviewHash !== 'string' || !/^[0-9a-f]{64}$/.test(trustedReviewHash) ||
      plan.review.review_sha256 !== trustedReviewHash || !Array.isArray(plan.review.stages) || plan.review.stages.length !== STAGES.length) {
    throw new Error('the original retained setup plan and review digest are required');
  }
  let rebuilt;
  try {
    rebuilt = buildUnsignedSvalinTrialSetup({ goal: plan.review.goal, agentPublicKey: plan.review.agent_public_key,
      wasmBytes: plan.batches[0].actions[2].deployContract.code,
      initialVaultFundingYocto: plan.batches[0].actions[1].transfer.deposit.toString(),
      agentGasAllowanceYocto: plan.batches[2].actions[0].addKey.accessKey.permission.functionCall.allowance.toString(),
      vaultTokenStorageDepositYocto: plan.batches[3].actions[0].functionCall.deposit.toString() });
    if (!equal(rebuilt.review, plan.review)) throw new Error('review differs');
    for (let i = 0; i < STAGES.length; i++) {
      if (plan.batches[i].id !== STAGES[i] || plan.review.stages[i].id !== STAGES[i]) throw new Error('stage differs');
      assertSvalinBatchMatchesReview(plan.batches[i], plan.review.stages[i]);
      assertSvalinBatchMatchesReview(rebuilt.batches[i], plan.review.stages[i]);
    }
  } catch { throw new Error('setup plan differs from its constrained retained review'); }
  return rebuilt;
}

/** Rebuild the bounded public plan before retaining its review in a journal.
 * A matching digest and key do not prove owner consent, account permissions or
 * the artifact's behavior. No secret, signed transaction or bytes are returned. */
export function verifySvalinSetupPlan({ plan, trustedReviewHash, ownerPublicKey }) {
  const canonical = canonicalPlan(plan, trustedReviewHash), key = publicKey(ownerPublicKey);
  if (key === canonical.review.agent_public_key) throw new Error('owner setup key must differ from the restricted agent key');
  return { review_sha256: trustedReviewHash, owner: canonical.review.goal.owner, vault: canonical.review.goal.vault,
    owner_public_key: key, agent_public_key: canonical.review.agent_public_key };
}

/** Create PUBLIC metadata for a future journal entry. It writes nothing: an
 * executor must verify a reviewed signed transaction, fsync the exact hash to
 * the original durable journal BEFORE one send, and reconcile that same hash.
 * This helper cannot prove that a journal, signature or approval exists. */
export function prepareSvalinSetupAttempt({ plan, trustedReviewHash, stageId, ownerPublicKey, txHash }) {
  const canonical = canonicalPlan(plan, trustedReviewHash), index = STAGES.indexOf(stageId);
  if (index < 0 || !isTransactionHash(txHash)) throw new Error('a known stage and original transaction hash are required');
  const key = publicKey(ownerPublicKey);
  if (key === canonical.review.agent_public_key) throw new Error('owner setup key must differ from the restricted agent key');
  const stage = canonical.review.stages[index];
  return { kind: 'svalin-setup-attempt-v1', status: 'pending', network: 'testnet', review_sha256: trustedReviewHash,
    stage_id: stageId, action_commitment_sha256: stage.action_commitment_sha256, tx_hash: txHash,
    signer_id: stage.signer_id, signer_public_key: key, receiver_id: stage.receiver_id };
}

/** Verify an already-signed SDK transaction against the independently retained
 * setup review, derive its actual NEAR transaction hash, and return only public
 * pending metadata. This does not sign, send, persist, check chain/key state or
 * prove owner consent. Signed bytes are broadcastable capabilities: the caller
 * must protect them and revalidate the exact bytes immediately before any
 * separately approved one-shot send. */
export function verifySignedSvalinSetup({ plan, trustedReviewHash, stageId, ownerPublicKey, signed }) {
  const canonical = canonicalPlan(plan, trustedReviewHash), index = STAGES.indexOf(stageId);
  const keyString = publicKey(ownerPublicKey);
  if (index < 0 || keyString === canonical.review.agent_public_key) throw new Error('invalid reviewed stage or owner setup key');
  const key = nearApi.utils.PublicKey.from(keyString), tx = signed?.transaction, signature = signed?.signature;
  if (!record(tx) || typeof tx.nonce !== 'bigint' || tx.nonce < 1n || tx.nonce > (1n << 64n) - 1n ||
      !(tx.blockHash instanceof Uint8Array) || tx.blockHash.length !== 32 || !tx.blockHash.some(byte => byte !== 0) ||
      signature?.enum !== 'ed25519Signature' || !(signature.data instanceof Uint8Array) || signature.data.length !== 64) {
    throw new Error('invalid signed setup transaction, nonce, block or signature');
  }
  const reviewed = canonical.batches[index], block = Buffer.from(tx.blockHash), nonce = tx.nonce;
  let bytes, expected, validSignature = false;
  try {
    bytes = Buffer.from(nearApi.transactions.encodeTransaction(tx));
    expected = Buffer.from(nearApi.transactions.encodeTransaction(nearApi.transactions.createTransaction(
      reviewed.signerId, key, reviewed.receiverId, nonce, reviewed.actions, block)));
    validSignature = key.verify(digest(bytes), signature.data);
  } catch { /* malformed SDK objects and signatures fail closed */ }
  if (!bytes || !expected || !bytes.equals(expected) || !validSignature) {
    throw new Error('signed setup transaction does not match the reviewed batch or owner key');
  }
  const txHash = nearApi.utils.serialize.base_encode(digest(bytes));
  const attempt = prepareSvalinSetupAttempt({ plan: canonical, trustedReviewHash, stageId, ownerPublicKey: keyString, txHash });
  return { attempt, signature_verified: true, current_key_or_nonce_verified: false,
    reference_block_freshness_verified: false, owner_approval_verified: false,
    scope: 'offline signature and reviewed transaction bytes only; no journal write, chain query or broadcast' };
}

/** Check only the ORIGINAL recorded hash and its reviewed actions. An unknown,
 * malformed, incomplete or unavailable outcome throws and remains unresolved;
 * it is never permission to sign or submit a replacement. */
export function inspectSvalinSetupAttempt({ plan, trustedReviewHash, trustedOriginalHash, trustedOwnerPublicKey, attempt, result }) {
  if (!keysAre(attempt, ATTEMPT_FIELDS) || !isTransactionHash(trustedOriginalHash) ||
      attempt.tx_hash !== trustedOriginalHash || publicKey(trustedOwnerPublicKey) !== attempt.signer_public_key) {
    throw new Error('the independently retained original hash and owner key are required');
  }
  const expected = prepareSvalinSetupAttempt({ plan, trustedReviewHash, stageId: attempt.stage_id,
    ownerPublicKey: attempt.signer_public_key, txHash: attempt.tx_hash });
  if (!equal(attempt, expected)) throw new Error('setup attempt differs from the retained original');
  if (!record(result) || result.final_execution_status !== 'FINAL' || !['value', 'failure'].includes(statusKind(result.status))) {
    throw new Error('original transaction is not terminal FINAL; preserve it and do not resend');
  }
  const index = STAGES.indexOf(attempt.stage_id), batch = plan.batches[index];
  const mayOmitLocalReceipt = attempt.stage_id === 'install_restricted_agent_key' && attempt.signer_id === attempt.receiver_id;
  const g = graph(result, mayOmitLocalReceipt);
  const root = rootOf(result, batch, attempt, g);
  const failure = statusKind(result.status) === 'failure' ||
    [...g.outcomes.values()].some(outcome => statusKind(outcome.status) === 'failure');
  if (failure) return { stage_id: attempt.stage_id, tx_hash: attempt.tx_hash,
    status: 'FINAL_FAILURE_NEEDS_RECONCILIATION', do_not_resend: true, current_state_verified: false,
    scope: 'trusted-RPC failure indication only; inspect all effects before any separately approved action' };
  let funding = null;
  if (attempt.stage_id === 'fund_vault_with_test_usdc') funding = fundingEvidence(result, root, g, { owner: plan.review.goal.owner,
    vault: plan.review.goal.vault, token: CIRCLE_TESTNET_USDC, amount: SVALIN_TRIAL_MAX_ATOMS });
  else if (statusKind(root.outcome.status) !== 'value' || root.outcome.status.SuccessValue !== result.status.SuccessValue) {
    throw new Error('the original setup action receipt is not terminal and successful');
  } else if (attempt.stage_id === 'register_vault_for_test_usdc') {
    // A freshly registered account returns the reviewed minimum with zero
    // available. A token-origin refund means prior registration or a changed
    // price and remains unresolved; distinguish it from a protocol gas refund.
    // Deployed code and fresh state still need independent verification.
    const balance = decodeJson(root.outcome.status.SuccessValue, 'token registration result');
    const reviewedDeposit = batch.actions[0].functionCall.deposit.toString();
    if (!keysAre(balance, ['total', 'available']) || balance.total !== reviewedDeposit || balance.available !== '0' ||
        result.transaction_outcome.outcome.receipt_ids.length !== 1 || !onlyProtocolGasRefund(root.outcome, g, attempt)) {
      throw new Error('token registration result does not match the reviewed fresh registration');
    }
  }
  if (root.localReceiptOmitted && (root.outcome.status.SuccessValue !== '' ||
      !onlyProtocolGasRefund(root.outcome, g, attempt, true))) {
    throw new Error('local AddKey outcome or its child receipts are unexpected or incomplete');
  }
  return { stage_id: attempt.stage_id, tx_hash: attempt.tx_hash,
    status: funding ? 'FINAL_FUNDING_RECEIPTS_MATCH' : root.localReceiptOmitted ?
      'FINAL_LOCAL_ADD_KEY_OUTCOME_MATCH' : 'FINAL_SETUP_RECEIPT_MATCH',
    root_receipt: root.id, funding, do_not_resend: true, current_state_verified: false,
    deployed_code_at_execution_verified: false, owner_approval_verified: false, seller_delivery_verified: false,
    scope: root.localReceiptOmitted ?
      'trusted-RPC original transaction and local outcome matched; root receipt body was omitted; verify deployed code and fresh state separately' :
      'trusted-RPC original-hash action and receipt matching only; verify deployed code and fresh state separately' };
}
