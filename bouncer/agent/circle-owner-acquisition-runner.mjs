/** Narrow one-shot testnet owner wNEAR / Ref acquisition executor. Original
 * signed bytes are public bearer items; third parties can relay them before
 * our fresh preflight. No private key or live seller is used by this module. */
import { CIRCLE_TESTNET_USDC as CIRCLE, WRAP_TESTNET as WRAP, REF_TESTNET as REF } from '../scripts/circle-testnet-setup.mjs';
import { ACQUISITION_INPUT_YOCTO as INPUT, ACQUISITION_MAX_USDC_ATOMS as MAX_OUT } from './circle-owner-acquisition-readiness.mjs';
import { inspectCircleOwnerAcquisition } from './circle-owner-acquisition-readiness.mjs';
import { verifySignedOwnerAcquisition } from './circle-owner-acquisition.mjs';
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';

const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const numeric = x => {
  if (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0) return BigInt(x);
  if (typeof x === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(x)) return BigInt(x);
  return null;
};
function matchesActions(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((a, i) => {
    const x = a?.FunctionCall, y = expected[i]?.functionCall;
    return record(a) && Object.keys(a).join(',') === 'FunctionCall' && record(x) && !!y &&
      x.method_name === y.methodName && typeof x.args === 'string' && Buffer.from(x.args, 'base64').toString('base64') === x.args &&
      Buffer.from(x.args, 'base64').equals(Buffer.from(y.args)) && numeric(x.gas) === y.gas && numeric(x.deposit) === y.deposit;
  });
}

/** Verify original transaction and its complete linked successful outcomes.
 * For swaps, require one successful Circle ft_transfer by Ref to the owner;
 * a later balance observation is still needed to confirm the credit. */
export function verifyOwnerAcquisitionReceipt(result, envelope, rawPlan) {
  const plan = validateOwnerBootstrapPlan(rawPlan), signed = verifySignedOwnerAcquisition(envelope, plan);
  const t = result?.transaction, txo = result?.transaction_outcome, out = txo?.outcome, expected = signed.transaction.actions;
  if (result?.final_execution_status !== 'FINAL' || typeof result.status?.SuccessValue !== 'string' ||
      t?.hash !== envelope.tx_hash || t.signer_id !== plan.account_id || t.receiver_id !== WRAP || t.public_key !== plan.public_key ||
      numeric(t.nonce) !== BigInt(envelope.nonce) || !matchesActions(t.actions, expected) || txo?.id !== envelope.tx_hash ||
      out?.executor_id !== plan.account_id || !isTransactionHash(out?.status?.SuccessReceiptId) ||
      !Array.isArray(out.receipt_ids) || out.receipt_ids.length !== 1 || out.receipt_ids[0] !== out.status.SuccessReceiptId ||
      !Array.isArray(result.receipts) || !Array.isArray(result.receipts_outcome) || result.receipts.length > 100 ||
      result.receipts_outcome.length < 1 || result.receipts_outcome.length > 100) throw new Error('original acquisition transaction differs or is not FINAL');
  const rootId = out.status.SuccessReceiptId, roots = result.receipts.filter(r => r?.receipt_id === rootId),
    rootOutcomes = result.receipts_outcome.filter(r => r?.id === rootId), root = roots[0], action = root?.receipt?.Action;
  if (roots.length !== 1 || rootOutcomes.length !== 1 || root.predecessor_id !== plan.account_id || root.receiver_id !== WRAP ||
      !record(root.receipt) || Object.keys(root.receipt).join(',') !== 'Action' || action?.signer_id !== plan.account_id ||
      action.signer_public_key !== plan.public_key || !matchesActions(action.actions, expected) || rootOutcomes[0].outcome?.executor_id !== WRAP) {
    throw new Error('original acquisition receipt is missing or mismatched');
  }
  const outcomes = new Map();
  for (const item of result.receipts_outcome) {
    if (!isTransactionHash(item?.id) || outcomes.has(item.id) || !record(item.outcome?.status) ||
        !Array.isArray(item.outcome.receipt_ids) || item.outcome.receipt_ids.some(id => !isTransactionHash(id)) ||
        !(typeof item.outcome.status.SuccessValue === 'string' || isTransactionHash(item.outcome.status.SuccessReceiptId))) {
      throw new Error('acquisition receipt graph contains a failure or malformed outcome');
    }
    outcomes.set(item.id, item.outcome);
  }
  const seen = new Set(), pending = [rootId];
  while (pending.length) {
    const id = pending.pop();
    if (seen.has(id) || !outcomes.has(id)) throw new Error('acquisition receipt graph is incomplete or cyclic');
    seen.add(id); pending.push(...outcomes.get(id).receipt_ids);
  }
  if (seen.size !== outcomes.size) throw new Error('acquisition receipt graph has unlinked outcomes');
  let circleTransfer = null;
  if (envelope.kind === 'swap') {
    const outerArgs = JSON.parse(Buffer.from(expected[0].functionCall.args).toString('utf8'));
    const children = rootOutcomes[0].outcome.receipt_ids, hooks = result.receipts.filter(r => children.includes(r?.receipt_id) &&
      r.predecessor_id === WRAP && r.receiver_id === REF && r.receipt?.Action?.actions?.length === 1 &&
      r.receipt.Action.actions[0]?.FunctionCall?.method_name === 'ft_on_transfer');
    if (hooks.length !== 1) throw new Error('unique Ref swap hook was not verified');
    const hook = hooks[0], hookCall = hook.receipt.Action.actions[0].FunctionCall, hookOutcome = outcomes.get(hook.receipt_id);
    let hookArgs, hookReturn;
    try {
      hookArgs = JSON.parse(Buffer.from(hookCall.args, 'base64').toString('utf8'));
      hookReturn = JSON.parse(Buffer.from(hookOutcome?.status?.SuccessValue, 'base64').toString('utf8'));
    } catch { throw new Error('Ref swap hook did not return the full input as used'); }
    if (numeric(hookCall.deposit) !== 0n || hookOutcome?.executor_id !== REF || hookReturn !== '0' ||
        hookArgs?.sender_id !== plan.account_id || hookArgs.amount !== INPUT || hookArgs.msg !== outerArgs.msg) {
      throw new Error('Ref swap hook does not match the original fixed route');
    }
    const matches = [];
    for (const r of result.receipts) {
      if (r?.predecessor_id !== REF || r.receiver_id !== CIRCLE || !hookOutcome.receipt_ids.includes(r.receipt_id) ||
          !Array.isArray(r.receipt?.Action?.actions) || r.receipt.Action.actions.length !== 1) continue;
      const call = r.receipt.Action.actions[0]?.FunctionCall, outcome = outcomes.get(r.receipt_id);
      if (call?.method_name !== 'ft_transfer' || numeric(call.deposit) !== 1n || typeof call.args !== 'string' ||
          outcome?.executor_id !== CIRCLE || typeof outcome.status?.SuccessValue !== 'string') continue;
      let args; try { args = JSON.parse(Buffer.from(call.args, 'base64').toString('utf8')); } catch { continue; }
      const amount = numeric(args?.amount);
      if (args?.receiver_id !== plan.account_id || amount === null || amount < BigInt(envelope.min_output_atoms) || amount > BigInt(MAX_OUT)) continue;
      const events = (outcome.logs || []).flatMap(log => {
        if (typeof log !== 'string' || !log.startsWith('EVENT_JSON:') || log.length > 16_384) return [];
        try { const event = JSON.parse(log.slice(11)); return event.standard === 'nep141' && event.version === '1.0.0' &&
          event.event === 'ft_transfer' ? [event] : []; } catch { return []; }
      });
      if (events.length === 1 && Array.isArray(events[0].data) && events[0].data.length === 1 &&
          events[0].data[0]?.old_owner_id === REF && events[0].data[0]?.new_owner_id === plan.account_id &&
          events[0].data[0]?.amount === amount.toString()) matches.push({ receipt_id: r.receipt_id, amount_atoms: amount.toString(),
            transfer_event_verified: true });
    }
    if (matches.length !== 1) throw new Error('unique successful Ref-to-owner Circle transfer and event were not verified');
    circleTransfer = matches[0];
  }
  return { tx_hash: envelope.tx_hash, root_receipt_id: rootId, linked_successful_outcomes: seen.size,
    circle_transfer: circleTransfer, trusted_rpc_not_consensus_proof: true };
}

export async function broadcastOwnerAcquisitionOnce({ plan: raw, envelope, provider, persistAttempt, now = Date.now } = {}) {
  const plan = validateOwnerBootstrapPlan(raw), signed = verifySignedOwnerAcquisition(envelope, plan);
  if (!provider || provider.enforcesSetupBeforeSubmitGuard !== true ||
      ['viewNodeStatus', 'viewBlock', 'query', 'callFunctionRaw', 'sendTransactionOnce', 'txStatusReceipts'].some(k => typeof provider[k] !== 'function') ||
      typeof persistAttempt !== 'function' || typeof now !== 'function') throw new Error('one-shot guarded testnet provider and fence required');
  const before = await inspectCircleOwnerAcquisition({ plan, provider, now });
  const quote = before.candidates.find(c => c.pool_id === envelope.pool_id);
  if (before.owner_key_nonce !== (BigInt(envelope.nonce) - 1n).toString() || before.wrap_code_hash !== envelope.expected_wrap_code_hash ||
      before.circle_code_hash !== envelope.expected_circle_code_hash || before.owner_wrap_registration !== envelope.expected_wrap_registration ||
      before.wrap_storage_min_yocto !== envelope.wrap_storage_min_yocto || before.owner_wrap_balance_yocto !== envelope.expected_wrap_before ||
      before.circle_balance_atoms !== envelope.expected_circle_before || !quote || BigInt(quote.quote_atoms) < BigInt(envelope.min_output_atoms)) {
    throw new Error(`original ${envelope.kind} ${envelope.tx_hash} no longer matches fresh preflight; inspect it, do not resend`);
  }
  if (await persistAttempt({ kind: envelope.kind, tx_hash: envelope.tx_hash, owner: plan.account_id,
    preflight_block_hash: before.block_hash }) !== true) throw new Error('original acquisition fence was not established');
  try {
    const submitted = await provider.sendTransactionOnce(signed, 'FINAL', { beforeSubmit: () => {
      verifySignedOwnerAcquisition(envelope, plan);
      assertFreshFinalBlock({ header: { hash: before.block_hash, timestamp_nanosec: before.block_timestamp_nanosec } }, now());
    } });
    if (submitted?.transaction_outcome?.id !== envelope.tx_hash || submitted.final_execution_status !== 'FINAL') {
      throw new Error('submission response did not identify original FINAL hash');
    }
    const proof = verifyOwnerAcquisitionReceipt(await provider.txStatusReceipts(envelope.tx_hash, plan.account_id, 'FINAL'), envelope, plan);
    const after = await inspectCircleOwnerAcquisition({ plan, provider, now });
    if (BigInt(after.owner_key_nonce) < BigInt(envelope.nonce) || after.owner_wrap_registration !== 'REGISTERED_AT_VIEW') {
      throw new Error('post-action owner nonce or wNEAR registration is not verified');
    }
    if (envelope.kind === 'wrap') {
      if (BigInt(after.owner_wrap_balance_yocto) !== BigInt(envelope.expected_wrap_before) + BigInt(INPUT) ||
          after.circle_balance_atoms !== envelope.expected_circle_before) throw new Error('wrapped test NEAR balance is not verified');
    } else if (BigInt(after.owner_wrap_balance_yocto) !== BigInt(envelope.expected_wrap_before) - BigInt(INPUT) ||
        BigInt(after.circle_balance_atoms) !== BigInt(envelope.expected_circle_before) + BigInt(proof.circle_transfer.amount_atoms)) {
      throw new Error('post-swap Circle/wNEAR balances do not match the original output receipt');
    }
    return { status: envelope.kind === 'wrap' ? 'OWNER_WRAPPED_TEST_NEAR_AT_FINAL' : 'OWNER_FUNDED_CIRCLE_TEST_USDC_AT_FINAL',
      kind: envelope.kind, network: 'testnet', owner: plan.account_id, tx_hash: envelope.tx_hash, receipt: proof,
      after_block_hash: after.block_hash, owner_wrap_balance_yocto: after.owner_wrap_balance_yocto,
      owner_circle_balance_atoms: after.circle_balance_atoms, circle_funding_verified: envelope.kind === 'swap',
      vault_deployed: false, seller_contacted: false, do_not_resend: true,
      scope: 'matching original FINAL transaction/receipt and fresh trusted-RPC balances, not consensus proof or independent provider delivery' };
  } catch (error) {
    throw new Error(`original ${envelope.kind} ${envelope.tx_hash} is not safely confirmed; retain the hash and reconcile, never resend: ${error?.message ?? 'unknown error'}`);
  }
}
