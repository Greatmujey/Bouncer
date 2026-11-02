/** One-shot submission and original-hash verification for a fixed, locally
 * signed Circle TESTNET owner self-registration. Publishing a signed envelope
 * exposes a bearer transaction: others can relay these same fixed bytes
 * before preflight. It can never redirect or sign a different action. */
import nearApi from 'near-api-js';
import { CIRCLE_TESTNET_USDC } from '../scripts/circle-testnet-setup.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { inspectCircleOwnerRegistration, verifySignedCircleRegistration, OWNER_REGISTRATION_GAS } from './circle-owner-registration.mjs';

const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const numeric = x => {
  if (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0) return BigInt(x);
  if (typeof x === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(x)) return BigInt(x);
  return null;
};
function actionMatches(action, plan, envelope) {
  if (!record(action) || Object.keys(action).join(',') !== 'FunctionCall' || !record(action.FunctionCall)) return false;
  const c = action.FunctionCall, expected = Buffer.from(JSON.stringify({ account_id: plan.account_id, registration_only: true }));
  return c.method_name === 'storage_deposit' && typeof c.args === 'string' &&
    Buffer.from(c.args, 'base64').toString('base64') === c.args && Buffer.from(c.args, 'base64').equals(expected) &&
    numeric(c.gas) === OWNER_REGISTRATION_GAS && numeric(c.deposit) === BigInt(envelope.deposit_yocto);
}

/** Require the exact original transaction and linked FINAL receipt graph. A
 * successful receipt plus a later fresh registration is not proof that no
 * third party registered the account concurrently, nor a consensus proof. */
export function verifyCircleRegistrationReceipt(result, envelope, rawPlan) {
  const plan = validateOwnerBootstrapPlan(rawPlan); verifySignedCircleRegistration(envelope, plan);
  const t = result?.transaction, txo = result?.transaction_outcome, out = txo?.outcome;
  if (result?.final_execution_status !== 'FINAL' || typeof result.status?.SuccessValue !== 'string' ||
      t?.hash !== envelope.tx_hash || t.signer_id !== plan.account_id || t.receiver_id !== CIRCLE_TESTNET_USDC ||
      t.public_key !== plan.public_key || numeric(t.nonce) !== BigInt(envelope.nonce) || !Array.isArray(t.actions) ||
      t.actions.length !== 1 || !actionMatches(t.actions[0], plan, envelope) || txo?.id !== envelope.tx_hash ||
      out?.executor_id !== plan.account_id || !isTransactionHash(out?.status?.SuccessReceiptId) ||
      !Array.isArray(out.receipt_ids) || out.receipt_ids.length !== 1 || out.receipt_ids[0] !== out.status.SuccessReceiptId ||
      !Array.isArray(result.receipts) || !Array.isArray(result.receipts_outcome) ||
      result.receipts.length > 64 || result.receipts_outcome.length < 1 || result.receipts_outcome.length > 64) {
    throw new Error('original Circle registration transaction differs or is not FINAL');
  }
  const rootId = out.status.SuccessReceiptId, receipts = result.receipts.filter(r => r?.receipt_id === rootId),
    rootResults = result.receipts_outcome.filter(r => r?.id === rootId);
  const receipt = receipts[0], body = receipt?.receipt?.Action, root = rootResults[0]?.outcome;
  if (receipts.length !== 1 || rootResults.length !== 1 || receipt.predecessor_id !== plan.account_id ||
      receipt.receiver_id !== CIRCLE_TESTNET_USDC || !record(receipt.receipt) || Object.keys(receipt.receipt).join(',') !== 'Action' ||
      body?.signer_id !== plan.account_id || body.signer_public_key !== plan.public_key ||
      !Array.isArray(body.actions) || body.actions.length !== 1 || !actionMatches(body.actions[0], plan, envelope) ||
      root?.executor_id !== CIRCLE_TESTNET_USDC || typeof root?.status?.SuccessValue !== 'string') {
    throw new Error('original Circle registration receipt is missing or mismatched');
  }
  let returned;
  try { returned = JSON.parse(Buffer.from(root.status.SuccessValue, 'base64').toString('utf8')); } catch { throw new Error('invalid Circle registration result'); }
  if (!record(returned) || numeric(returned.total) === null || numeric(returned.total) <= 0n ||
      numeric(returned.available) === null || numeric(returned.available) > numeric(returned.total)) throw new Error('invalid Circle registration result');
  const outcomes = new Map();
  for (const item of result.receipts_outcome) {
    if (!isTransactionHash(item?.id) || outcomes.has(item.id) || !record(item.outcome?.status) ||
        !Array.isArray(item.outcome.receipt_ids) || item.outcome.receipt_ids.some(id => !isTransactionHash(id)) ||
        !(typeof item.outcome.status.SuccessValue === 'string' || isTransactionHash(item.outcome.status.SuccessReceiptId))) {
      throw new Error('Circle registration receipt graph contains a failure or malformed outcome');
    }
    outcomes.set(item.id, item.outcome);
  }
  const seen = new Set(), pending = [rootId];
  while (pending.length) {
    const id = pending.pop();
    if (seen.has(id) || !outcomes.has(id)) throw new Error('Circle registration receipt graph is incomplete or cyclic');
    seen.add(id); pending.push(...outcomes.get(id).receipt_ids);
  }
  if (seen.size !== outcomes.size) throw new Error('Circle registration receipt graph has unlinked outcomes');
  return { tx_hash: envelope.tx_hash, root_receipt_id: rootId, circle_reported_total_yocto: String(returned.total),
    linked_successful_outcomes: seen.size, trusted_rpc_not_consensus_proof: true };
}

/** persistAttempt must establish a durable original-hash fence. At most one
 * send is made. Any unknown result is reconciled from the original hash only. */
export async function broadcastCircleOwnerRegistrationOnce({ plan: raw, envelope, provider, persistAttempt,
  now = Date.now } = {}) {
  const plan = validateOwnerBootstrapPlan(raw), signed = verifySignedCircleRegistration(envelope, plan);
  if (!provider || provider.enforcesSetupBeforeSubmitGuard !== true ||
      ['viewNodeStatus', 'viewBlock', 'query', 'callFunctionRaw', 'sendTransactionOnce', 'txStatusReceipts']
        .some(k => typeof provider[k] !== 'function') || typeof persistAttempt !== 'function' || typeof now !== 'function') {
    throw new Error('one-shot guarded testnet provider and durable fence are required');
  }
  const before = await inspectCircleOwnerRegistration({ plan, provider, now });
  if (before.circle_registration !== 'NOT_REGISTERED_AT_VIEW' || before.owner_key_nonce !== (BigInt(envelope.nonce) - 1n).toString() ||
      before.circle_storage_min_yocto !== envelope.deposit_yocto || before.circle_code_hash !== envelope.expected_circle_code_hash) {
    throw new Error(`original Circle registration ${envelope.tx_hash} no longer matches fresh preflight; inspect it, do not resend`);
  }
  if (await persistAttempt({ tx_hash: envelope.tx_hash, owner: plan.account_id, token: CIRCLE_TESTNET_USDC,
    preflight_block_hash: before.block_hash }) !== true) throw new Error('original Circle registration fence was not established');
  try {
    const submission = await provider.sendTransactionOnce(signed, 'FINAL', { beforeSubmit: () => {
      verifySignedCircleRegistration(envelope, plan);
      assertFreshFinalBlock({ header: { hash: before.block_hash, timestamp_nanosec: before.block_timestamp_nanosec } }, now());
    } });
    if (submission?.transaction_outcome?.id !== envelope.tx_hash || submission.final_execution_status !== 'FINAL') {
      throw new Error('submission response did not identify the original FINAL hash');
    }
    const receipt = verifyCircleRegistrationReceipt(await provider.txStatusReceipts(envelope.tx_hash, plan.account_id, 'FINAL'), envelope, plan);
    const after = await inspectCircleOwnerRegistration({ plan, provider, now });
    if (after.circle_registration !== 'REGISTERED_AT_VIEW' || BigInt(after.owner_key_nonce) < BigInt(envelope.nonce)) {
      throw new Error('fresh Circle registration or advanced owner nonce is not verified');
    }
    return { status: 'CIRCLE_OWNER_REGISTERED_AT_FINAL', network: 'testnet', owner: plan.account_id, token: CIRCLE_TESTNET_USDC,
      tx_hash: envelope.tx_hash, receipt, registration_block_hash: after.block_hash,
      storage_registration: after.circle_registration, owner_circle_balance_atoms: after.circle_balance_atoms,
      usdc_funding_verified: false, vault_deployed: false, seller_contacted: false, do_not_resend: true,
      scope: 'matching original FINAL transaction/receipt and fresh trusted-RPC registration view; not consensus proof or USDC funding' };
  } catch (error) {
    throw new Error(`original Circle registration ${envelope.tx_hash} is not safely confirmed; retain the hash and reconcile, never resend: ${error?.message ?? 'unknown error'}`);
  }
}
