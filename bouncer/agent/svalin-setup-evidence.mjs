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

function numericString(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(value) ? value : null;
}
function callMatches(expected, actual) {
  return keysAre(actual, ['method_name', 'args', 'gas', 'deposit']) && actual.method_name === expected.methodName &&
    actual.args === Buffer.from(expected.args).toString('base64') && numericString(actual.gas) === expected.gas.toString() &&
    numericString(actual.deposit) === expected.deposit.toString();
}
// nearcore's ActionView for DeployContract exposes base64(SHA-256(code)),
// not raw WASM. Comparing the review code bytes directly to that field would
// either fail real receipts or create a dangerously misleading fallback.
function actionMatches(expected, actual) {
  if (expected.enum === 'createAccount') return actual === 'CreateAccount';
  if (expected.enum === 'transfer') return keysAre(actual, ['Transfer']) && keysAre(actual.Transfer, ['deposit']) &&
    numericString(actual.Transfer.deposit) === expected.transfer.deposit.toString();
  if (expected.enum === 'deployContract') return keysAre(actual, ['DeployContract']) && keysAre(actual.DeployContract, ['code']) &&
    actual.DeployContract.code === digest(Buffer.from(expected.deployContract.code)).toString('base64');
  if (expected.enum === 'functionCall') return keysAre(actual, ['FunctionCall']) && callMatches(expected.functionCall, actual.FunctionCall);
  if (expected.enum === 'addKey') {
    if (!keysAre(actual, ['AddKey']) || !keysAre(actual.AddKey, ['public_key', 'access_key'])) return false;
    const key = actual.AddKey, access = key.access_key, expectedAccess = expected.addKey.accessKey;
    const permission = access?.permission?.FunctionCall, expectedPermission = expectedAccess.permission.functionCall;
    return key.public_key === String(expected.addKey.publicKey) && keysAre(access, ['nonce', 'permission']) &&
      numericString(access.nonce) === expectedAccess.nonce.toString() && keysAre(access.permission, ['FunctionCall']) &&
      keysAre(permission, ['allowance', 'receiver_id', 'method_names']) &&
      numericString(permission.allowance) === expectedPermission.allowance.toString() &&
      permission.receiver_id === expectedPermission.receiverId && equal(permission.method_names, expectedPermission.methodNames);
  }
  return false;
}
function actionsMatch(expected, actual) {
  return Array.isArray(actual) && actual.length === expected.length &&
    expected.every((action, index) => actionMatches(action, actual[index]));
}
function statusKind(status) {
  if (!record(status) || Object.keys(status).length !== 1) return null;
  if (typeof status.SuccessValue === 'string') return 'value';
  if (isTransactionHash(status.SuccessReceiptId)) return 'receipt';
  if (record(status.Failure)) return 'failure';
  return null;
}
function decodeJson(encoded, label) {
  if (typeof encoded !== 'string' || encoded.length > 16_384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error(`invalid ${label}`);
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new Error(`invalid ${label}`);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error(`invalid ${label}`); }
}
function graph(result) {
  if (!Array.isArray(result.receipts) || !Array.isArray(result.receipts_outcome) ||
      result.receipts.length < 1 || result.receipts.length > 256 ||
      result.receipts_outcome.length < 1 || result.receipts_outcome.length > 256) {
    throw new Error('bounded receipt-inclusive FINAL outcome is required');
  }
  const receipts = new Map(), outcomes = new Map();
  for (const receipt of result.receipts) {
    if (!isTransactionHash(receipt?.receipt_id) || receipts.has(receipt.receipt_id)) throw new Error('missing or duplicate receipt ID');
    receipts.set(receipt.receipt_id, receipt);
  }
  for (const item of result.receipts_outcome) {
    if (!isTransactionHash(item?.id) || outcomes.has(item.id) || !record(item.outcome) ||
        !statusKind(item.outcome.status) || !Array.isArray(item.outcome.receipt_ids) ||
        item.outcome.receipt_ids.some(id => !isTransactionHash(id)) ||
        new Set(item.outcome.receipt_ids).size !== item.outcome.receipt_ids.length) {
      throw new Error('missing, duplicate or incomplete receipt outcome');
    }
    outcomes.set(item.id, item.outcome);
  }
  return { receipts, outcomes };
}
function rootOf(result, batch, attempt, g) {
  const tx = result.transaction, txOutcome = result.transaction_outcome?.outcome;
  if (!record(tx) || tx.hash !== attempt.tx_hash || tx.signer_id !== attempt.signer_id ||
      tx.public_key !== attempt.signer_public_key || tx.receiver_id !== attempt.receiver_id ||
      !actionsMatch(batch.actions, tx.actions) || result.transaction_outcome?.id !== attempt.tx_hash ||
      !record(txOutcome) || txOutcome.executor_id !== attempt.signer_id || !Array.isArray(txOutcome.receipt_ids) ||
      txOutcome.receipt_ids.some(id => !isTransactionHash(id)) ||
      new Set(txOutcome.receipt_ids).size !== txOutcome.receipt_ids.length ||
      statusKind(txOutcome.status) !== 'receipt' || !txOutcome.receipt_ids.includes(txOutcome.status.SuccessReceiptId)) {
    throw new Error('original transaction identity, actions or root receipt mismatch');
  }
  const id = txOutcome.status.SuccessReceiptId, receipt = g.receipts.get(id), outcome = g.outcomes.get(id);
  const action = receipt?.receipt?.Action;
  if (!receipt || receipt.predecessor_id !== attempt.signer_id || receipt.receiver_id !== attempt.receiver_id ||
      !record(action) || action.signer_id !== attempt.signer_id || action.signer_public_key !== attempt.signer_public_key ||
      !actionsMatch(batch.actions, action.actions) || !outcome || outcome.executor_id !== attempt.receiver_id) {
    throw new Error('original action receipt is missing or differs from the reviewed batch');
  }
  return { id, receipt, outcome };
}
function childCall(g, root, predecessor, receiver, method) {
  const matches = root.receipt_ids.flatMap(id => {
    const receipt = g.receipts.get(id), actions = receipt?.receipt?.Action?.actions;
    if (receipt?.predecessor_id !== predecessor || receipt?.receiver_id !== receiver || !Array.isArray(actions) ||
        actions.length !== 1 || !keysAre(actions[0], ['FunctionCall']) || actions[0].FunctionCall?.method_name !== method) return [];
    return [{ id, receipt, call: actions[0].FunctionCall, outcome: g.outcomes.get(id) }];
  });
  if (matches.length !== 1 || !matches[0].outcome || matches[0].outcome.executor_id !== receiver) {
    throw new Error(`missing unique linked ${method} receipt`);
  }
  return matches[0];
}
function exactTransferEvent(root, owner, vault) {
  if (!Array.isArray(root.logs) || root.logs.length > 256) throw new Error('missing bounded token logs');
  const events = [];
  for (const log of root.logs) {
    if (typeof log !== 'string' || log.length > 16_384 || !log.startsWith('EVENT_JSON:')) continue;
    try {
      const event = JSON.parse(log.slice(11));
      if (event.standard === 'nep141' && event.version === '1.0.0' && event.event === 'ft_transfer') events.push(event);
    } catch { /* malformed or unrelated logs are not evidence */ }
  }
  if (events.length !== 1 || !Array.isArray(events[0].data) || events[0].data.length !== 1 ||
      events[0].data[0]?.old_owner_id !== owner || events[0].data[0]?.new_owner_id !== vault ||
      events[0].data[0]?.amount !== SVALIN_TRIAL_MAX_ATOMS) throw new Error('matching Circle token transfer event is missing');
}
function fundingEvidence(result, root, g, review) {
  const owner = review.goal.owner, vault = review.goal.vault, out = root.outcome;
  if (statusKind(out.status) !== 'receipt') throw new Error('funding token resolver is not linked from the original transfer');
  const hook = childCall(g, out, CIRCLE_TESTNET_USDC, vault, 'ft_on_transfer');
  const resolver = childCall(g, out, CIRCLE_TESTNET_USDC, CIRCLE_TESTNET_USDC, 'ft_resolve_transfer');
  // The resolver must consume THIS hook's output, not merely be another
  // successful sibling receipt with matching-looking arguments.
  const outputs = hook.receipt.receipt.Action.output_data_receivers;
  const inputs = resolver.receipt.receipt.Action.input_data_ids;
  if (!Array.isArray(outputs) || outputs.length !== 1 || outputs[0]?.receiver_id !== CIRCLE_TESTNET_USDC ||
      !isTransactionHash(outputs[0]?.data_id) || !Array.isArray(inputs) || inputs.length !== 1 || inputs[0] !== outputs[0].data_id ||
      out.status.SuccessReceiptId !== resolver.id || numericString(hook.call.deposit) !== '0' ||
      !equal(decodeJson(hook.call.args, 'funding receiver arguments'), { sender_id: owner, amount: SVALIN_TRIAL_MAX_ATOMS, msg: '' }) ||
      numericString(resolver.call.deposit) !== '0' ||
      !equal(decodeJson(resolver.call.args, 'funding resolver arguments'), { sender_id: owner, receiver_id: vault, amount: SVALIN_TRIAL_MAX_ATOMS }) ||
      statusKind(hook.outcome.status) !== 'value' || decodeJson(hook.outcome.status.SuccessValue, 'vault unused amount') !== '0' ||
      !Array.isArray(hook.outcome.logs) || !hook.outcome.logs.includes('BOUNCER deposit received') ||
      statusKind(resolver.outcome.status) !== 'value' ||
      decodeJson(resolver.outcome.status.SuccessValue, 'token resolved amount') !== SVALIN_TRIAL_MAX_ATOMS ||
      result.status.SuccessValue !== resolver.outcome.status.SuccessValue) {
    throw new Error('funding callback or resolver does not establish the reviewed full deposit');
  }
  exactTransferEvent(out, owner, vault);
  return { token: CIRCLE_TESTNET_USDC, amount_atoms: SVALIN_TRIAL_MAX_ATOMS,
    vault_callback_receipt: hook.id, token_resolver_receipt: resolver.id };
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
  const index = STAGES.indexOf(attempt.stage_id), batch = plan.batches[index], g = graph(result);
  const root = rootOf(result, batch, attempt, g);
  const failure = statusKind(result.status) === 'failure' ||
    [...g.outcomes.values()].some(outcome => statusKind(outcome.status) === 'failure');
  if (failure) return { stage_id: attempt.stage_id, tx_hash: attempt.tx_hash,
    status: 'FINAL_FAILURE_NEEDS_RECONCILIATION', do_not_resend: true, current_state_verified: false,
    scope: 'trusted-RPC failure indication only; inspect all effects before any separately approved action' };
  let funding = null;
  if (attempt.stage_id === 'fund_vault_with_test_usdc') funding = fundingEvidence(result, root, g, plan.review);
  else if (statusKind(root.outcome.status) !== 'value' || root.outcome.status.SuccessValue !== result.status.SuccessValue) {
    throw new Error('the original setup action receipt is not terminal and successful');
  } else if (attempt.stage_id === 'register_vault_for_test_usdc') {
    // Circle's pinned source returns the exact minimum with zero available for
    // a newly registered account. A refund child means the account was already
    // registered or the price changed; treat either as unresolved, not a
    // registration proof. Deployed code and fresh state still need verification.
    const balance = decodeJson(root.outcome.status.SuccessValue, 'token registration result');
    const reviewedDeposit = batch.actions[0].functionCall.deposit.toString();
    if (!keysAre(balance, ['total', 'available']) || balance.total !== reviewedDeposit || balance.available !== '0' ||
        root.outcome.receipt_ids.length !== 0) {
      throw new Error('token registration result does not match the reviewed fresh registration');
    }
  }
  return { stage_id: attempt.stage_id, tx_hash: attempt.tx_hash,
    status: funding ? 'FINAL_FUNDING_RECEIPTS_MATCH' : 'FINAL_SETUP_RECEIPT_MATCH',
    root_receipt: root.id, funding, do_not_resend: true, current_state_verified: false,
    deployed_code_at_execution_verified: false, owner_approval_verified: false, seller_delivery_verified: false,
    scope: 'trusted-RPC original-hash action and receipt matching only; verify deployed code and fresh state separately' };
}
