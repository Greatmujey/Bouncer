/**
 * Experimental one-shot Ref testnet receipt verification. Never infer output
 * from balance deltas or from a successful input transfer. Pure functions;
 * no signing, RPC calls or broadcasts. Trust the supplied FINAL RPC evidence,
 * pinned router bytecode, Bouncer, Ref and both NEP-141 tokens.
 */
import { isDeepStrictEqual } from 'node:util';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { validateFtCallGoal, verifyFtCallSettlement } from './ft-call.mjs';

export const REF_SWAP_INPUT = 'wrap.testnet';
export const REF_SWAP_OUTPUT = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
export const REF_SWAP_EXCHANGE = 'ref-finance-101.testnet';
export const REF_SWAP_INPUT_MESSAGE = '{"action":"bouncer-ref-swap-v1"}';
export const REF_SWAP_OUTPUT_MESSAGE = 'bouncer:ref-output-v1';
export const REF_SWEEP_GAS = 120n * 10n ** 12n;
const MAX_INPUT = 10n ** 22n, MAX_MIN_OUTPUT = 100_000n, MAX_U128 = (1n << 128n) - 1n;
const keys = ['version', 'id', 'contract_id', 'owner_account_id', 'router_id', 'router_code_hash', 'policy_id',
  'policy_revision', 'route_revision', 'pool_id', 'input_amount', 'min_output'];
const ownKeys = (obj, fields) => !!obj && typeof obj === 'object' && !Array.isArray(obj) &&
  Object.keys(obj).length === fields.length && fields.every(field => Object.hasOwn(obj, field));
function amount(value, max, label) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,38}$/.test(value) || BigInt(value) > max) throw new Error(`invalid ${label}`);
  return BigInt(value);
}
export function validateRefSwapGoal(goal) {
  if (!ownKeys(goal, keys) || goal.version !== 1 || typeof goal.id !== 'string' || !/^[A-Za-z0-9_-]{1,50}$/.test(goal.id) ||
      !isTestnetAccount(goal.contract_id) || !isTestnetAccount(goal.owner_account_id) || !isTestnetAccount(goal.router_id) ||
      new Set([goal.contract_id, goal.owner_account_id, goal.router_id]).size !== 3 ||
      !isTransactionHash(goal.router_code_hash) || ![1845, 2206].includes(goal.pool_id)) throw new Error('invalid bounded testnet Ref swap goal');
  amount(goal.input_amount, MAX_INPUT, 'testnet swap input'); amount(goal.min_output, MAX_MIN_OUTPUT, 'testnet minimum output');
  const result = structuredClone(goal);
  validateFtCallGoal({ id: `${result.id}-input`, contract_id: result.contract_id, owner_account_id: result.owner_account_id,
    policy_id: result.policy_id, payee: result.router_id, token: REF_SWAP_INPUT, amount: result.input_amount,
    msg: REF_SWAP_INPUT_MESSAGE, policy_revision: result.policy_revision, route_revision: result.route_revision });
  return result;
}
export function refSwapFtGoal(rawGoal) {
  const goal = validateRefSwapGoal(rawGoal);
  return validateFtCallGoal({ id: `${goal.id}-input`, contract_id: goal.contract_id, owner_account_id: goal.owner_account_id,
    policy_id: goal.policy_id, payee: goal.router_id, token: REF_SWAP_INPUT, amount: goal.input_amount,
    msg: REF_SWAP_INPUT_MESSAGE, policy_revision: goal.policy_revision, route_revision: goal.route_revision });
}
function decode(encoded, label) {
  if (typeof encoded !== 'string' || encoded.length > 16_384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error(`invalid ${label}`);
  }
  try { return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')); }
  catch { throw new Error(`invalid ${label}`); }
}
function success(status) {
  return !!status && typeof status === 'object' && !Array.isArray(status) && status.Failure === undefined &&
    ((typeof status.SuccessValue === 'string' && status.SuccessReceiptId === undefined) ||
     (typeof status.SuccessReceiptId === 'string' && status.SuccessValue === undefined));
}
function terminal(status, expected, label) {
  if (!success(status) || typeof status.SuccessValue !== 'string' || !isDeepStrictEqual(decode(status.SuccessValue, label), expected)) {
    throw new Error(`invalid ${label}`);
  }
}
function graph(result) {
  if (!Array.isArray(result?.receipts) || !Array.isArray(result?.receipts_outcome) ||
      result.receipts.length === 0 || result.receipts.length > 512 || result.receipts_outcome.length === 0 || result.receipts_outcome.length > 512) {
    throw new Error('missing or oversized finalized receipt graph');
  }
  const receipts = new Map(), outcomes = new Map();
  for (const r of result.receipts) {
    if (typeof r?.receipt_id !== 'string' || !r.receipt_id || receipts.has(r.receipt_id)) throw new Error('invalid or duplicate receipt');
    receipts.set(r.receipt_id, r);
  }
  for (const o of result.receipts_outcome) {
    if (typeof o?.id !== 'string' || !o.id || outcomes.has(o.id)) throw new Error('invalid or duplicate receipt outcome');
    outcomes.set(o.id, o);
  }
  return { receipts, outcomes };
}
function outcomeFor(g, id, executor, label) {
  const entry = g.outcomes.get(id);
  if (!entry || entry.outcome?.executor_id !== executor || !success(entry.outcome.status) ||
      !Array.isArray(entry.outcome.receipt_ids)) throw new Error(`missing successful ${label} outcome`);
  return entry.outcome;
}
function childCall(g, parent, predecessor, receiver, method, label) {
  if (!Array.isArray(parent.receipt_ids) || new Set(parent.receipt_ids).size !== parent.receipt_ids.length) throw new Error(`invalid ${label} parent`);
  const found = parent.receipt_ids.flatMap(id => {
    const r = g.receipts.get(id), actions = r?.receipt?.Action?.actions;
    if (r?.predecessor_id !== predecessor || r?.receiver_id !== receiver || !Array.isArray(actions) || actions.length !== 1 ||
        actions[0]?.FunctionCall?.method_name !== method) return [];
    return [{ receipt: r, call: actions[0].FunctionCall }];
  });
  if (found.length !== 1) throw new Error(`missing unique ${label} receipt`);
  return found[0];
}
function assertTransferEvent(outcome, oldOwner, newOwner, units, label) {
  const events = [];
  for (const log of outcome.logs || []) {
    if (typeof log !== 'string' || !log.startsWith('EVENT_JSON:') || log.length > 16_384) continue;
    try {
      const event = JSON.parse(log.slice('EVENT_JSON:'.length));
      if (event.standard === 'nep141' && event.version === '1.0.0' && event.event === 'ft_transfer') events.push(event);
    } catch { /* malformed or unrelated logs are never evidence */ }
  }
  if (events.length !== 1 || !Array.isArray(events[0].data) || events[0].data.length !== 1 ||
      events[0].data[0]?.old_owner_id !== oldOwner || events[0].data[0]?.new_owner_id !== newOwner ||
      events[0].data[0]?.amount !== units) throw new Error(`missing exact ${label} NEP-141 transfer event`);
}
function initialOutcome(g, result, executor, log, label) {
  const children = result?.transaction_outcome?.outcome?.receipt_ids;
  if (!Array.isArray(children) || new Set(children).size !== children.length) throw new Error(`invalid ${label} transaction children`);
  const matches = children.flatMap(id => {
    const out = g.outcomes.get(id)?.outcome;
    return out?.executor_id === executor && success(out.status) && (!log || out.logs?.includes(log)) ? [{ id, out }] : [];
  });
  if (matches.length !== 1) throw new Error(`missing unique ${label} initiation`);
  return matches[0];
}

/** Prove Ref transferred the bounded output to this exact one-shot router. */
export function verifyRefSwapOutput(rawGoal, result, publicKey) {
  const goal = validateRefSwapGoal(rawGoal), ftGoal = refSwapFtGoal(goal);
  const settlement = verifyFtCallSettlement(ftGoal, result, publicKey);
  if (settlement.used !== goal.input_amount || settlement.unused !== '0') throw new Error('Ref input was not fully used; output is not established');
  const g = graph(result), start = initialOutcome(g, result, goal.contract_id,
    'BOUNCER guarded ft_transfer_call initiated; full amount reserved', 'swap');
  const outer = childCall(g, start.out, goal.contract_id, REF_SWAP_INPUT, 'ft_transfer_call', 'vault input');
  const outerOutcome = outcomeFor(g, outer.receipt.receipt_id, REF_SWAP_INPUT, 'vault input');
  const hook = childCall(g, outerOutcome, REF_SWAP_INPUT, goal.router_id, 'ft_on_transfer', 'router input');
  if (String(hook.call.deposit) !== '0' || !isDeepStrictEqual(decode(hook.call.args, 'router input arguments'),
      { sender_id: goal.contract_id, amount: goal.input_amount, msg: REF_SWAP_INPUT_MESSAGE })) throw new Error('router input differs from the reviewed vault order');
  const hookOutcome = outcomeFor(g, hook.receipt.receipt_id, goal.router_id, 'router input');
  const inner = childCall(g, hookOutcome, goal.router_id, REF_SWAP_INPUT, 'ft_transfer_call', 'Ref input');
  const callback = childCall(g, hookOutcome, goal.router_id, goal.router_id, 'after_ref_input', 'router input callback');
  // near-sdk emits zero bytes for a private callback with no arguments. Do not
  // JSON-decode them as `{}`: real FINAL testnet receipts contain base64 ''.
  if (hookOutcome.status.SuccessReceiptId !== callback.receipt.receipt_id || String(callback.call.deposit) !== '0' ||
      callback.call.args !== '') throw new Error('router callback is not bound to this input');
  const callbackOutcome = outcomeFor(g, callback.receipt.receipt_id, goal.router_id, 'router input callback');
  terminal(callbackOutcome.status, '0', 'router unused input');
  if (!callbackOutcome.logs?.includes(`BOUNCER ref-router inner input settled; used=${goal.input_amount}; output unverified`)) {
    throw new Error('router did not record the exact consumed input');
  }
  if (String(inner.call.deposit) !== '1') throw new Error('invalid Ref input deposit');
  const innerArgs = decode(inner.call.args, 'Ref input arguments');
  if (!ownKeys(innerArgs, ['receiver_id', 'amount', 'memo', 'msg']) || innerArgs.receiver_id !== REF_SWAP_EXCHANGE ||
      innerArgs.amount !== goal.input_amount || innerArgs.memo !== 'bouncer:ref-router-v1' || typeof innerArgs.msg !== 'string') {
    throw new Error('Ref input differs from the pinned route');
  }
  let innerMessage;
  try { innerMessage = JSON.parse(innerArgs.msg); } catch { throw new Error('invalid Ref swap message'); }
  if (!isDeepStrictEqual(innerMessage, { force: 0, actions: [{ pool_id: goal.pool_id, token_in: REF_SWAP_INPUT,
      token_out: REF_SWAP_OUTPUT, amount_in: goal.input_amount, min_amount_out: goal.min_output }] })) throw new Error('Ref swap message differs from the pinned route');
  const innerOutcome = outcomeFor(g, inner.receipt.receipt_id, REF_SWAP_INPUT, 'Ref input');
  const refHook = childCall(g, innerOutcome, REF_SWAP_INPUT, REF_SWAP_EXCHANGE, 'ft_on_transfer', 'Ref receiver');
  if (String(refHook.call.deposit) !== '0' || !isDeepStrictEqual(decode(refHook.call.args, 'Ref receiver arguments'),
      { sender_id: goal.router_id, amount: goal.input_amount, msg: innerArgs.msg })) throw new Error('Ref receiver differs from the router order');
  const refOutcome = outcomeFor(g, refHook.receipt.receipt_id, REF_SWAP_EXCHANGE, 'Ref receiver');
  terminal(refOutcome.status, '0', 'Ref unused input');
  const out = childCall(g, refOutcome, REF_SWAP_EXCHANGE, REF_SWAP_OUTPUT, 'ft_transfer', 'Ref output');
  if (String(out.call.deposit) !== '1') throw new Error('invalid Ref output deposit');
  const outArgs = decode(out.call.args, 'Ref output arguments');
  if (!ownKeys(outArgs, ['receiver_id', 'amount', 'memo']) || outArgs.receiver_id !== goal.router_id || outArgs.memo !== null) {
    throw new Error('Ref output is not addressed to the reviewed router');
  }
  const output = amount(outArgs.amount, MAX_U128, 'Ref output');
  if (output < BigInt(goal.min_output)) throw new Error('Ref output is below the owner-pinned minimum');
  const outOutcome = outcomeFor(g, out.receipt.receipt_id, REF_SWAP_OUTPUT, 'Ref output');
  if (typeof outOutcome.status.SuccessValue !== 'string' || !['', 'bnVsbA=='].includes(outOutcome.status.SuccessValue)) {
    throw new Error('Ref output transfer did not finish synchronously');
  }
  assertTransferEvent(outOutcome, REF_SWAP_EXCHANGE, goal.router_id, output.toString(), 'Ref output');
  return { tx_hash: settlement.tx_hash, router: goal.router_id, token_in: REF_SWAP_INPUT, input_amount: goal.input_amount,
    token_out: REF_SWAP_OUTPUT, output_amount: output.toString(), output_receipt_id: out.receipt.receipt_id,
    verification: 'linked FINAL Ref output transfer to the one-shot router; vault credit is not yet established' };
}

/** Verify the separately signed sweep and the actual Bouncer deposit hook. */
export function verifyRefSweep(rawGoal, expectedOutput, result, publicKey) {
  const goal = validateRefSwapGoal(rawGoal); amount(expectedOutput, MAX_U128, 'reviewed sweep amount');
  if (BigInt(expectedOutput) < BigInt(goal.min_output)) throw new Error('sweep amount is below the reviewed minimum');
  const hash = result?.transaction_outcome?.id, tx = result?.transaction;
  if (result?.final_execution_status !== 'FINAL' || !isTransactionHash(hash) || !tx || tx.hash !== hash ||
      tx.signer_id !== goal.owner_account_id || tx.receiver_id !== goal.router_id ||
      (publicKey !== undefined && tx.public_key !== String(publicKey)) || !Array.isArray(tx.actions) || tx.actions.length !== 1) {
    throw new Error('sweep transaction identity or finality mismatch');
  }
  const signed = tx.actions[0]?.FunctionCall;
  if (!signed || signed.method_name !== 'sweep_output' || String(signed.deposit) !== '0' || String(signed.gas) !== REF_SWEEP_GAS.toString() ||
      !isDeepStrictEqual(decode(signed.args, 'signed sweep arguments'), { amount: expectedOutput })) throw new Error('signed sweep differs from the reviewed output');
  terminal(result.status, expectedOutput, 'sweep used amount');
  const g = graph(result), start = initialOutcome(g, result, goal.router_id, null, 'sweep');
  const send = childCall(g, start.out, goal.router_id, REF_SWAP_OUTPUT, 'ft_transfer_call', 'router sweep');
  if (start.out.status.SuccessReceiptId !== send.receipt.receipt_id || String(send.call.deposit) !== '1' ||
      !isDeepStrictEqual(decode(send.call.args, 'router sweep arguments'), { receiver_id: goal.contract_id, amount: expectedOutput,
        memo: 'bouncer:ref-sweep', msg: REF_SWAP_OUTPUT_MESSAGE })) throw new Error('router sweep did not target the original vault');
  const sendOutcome = outcomeFor(g, send.receipt.receipt_id, REF_SWAP_OUTPUT, 'router sweep');
  assertTransferEvent(sendOutcome, goal.router_id, goal.contract_id, expectedOutput, 'vault sweep');
  const hook = childCall(g, sendOutcome, REF_SWAP_OUTPUT, goal.contract_id, 'ft_on_transfer', 'vault output deposit');
  if (String(hook.call.deposit) !== '0' || !isDeepStrictEqual(decode(hook.call.args, 'vault deposit arguments'),
      { sender_id: goal.router_id, amount: expectedOutput, msg: REF_SWAP_OUTPUT_MESSAGE })) throw new Error('vault deposit is not the reviewed sweep');
  const hookOutcome = outcomeFor(g, hook.receipt.receipt_id, goal.contract_id, 'vault output deposit');
  terminal(hookOutcome.status, '0', 'vault unused output');
  if (!hookOutcome.logs?.includes('BOUNCER deposit received')) throw new Error('missing vault deposit accounting log');
  return { tx_hash: hash, router: goal.router_id, vault: goal.contract_id, token: REF_SWAP_OUTPUT, credited: expectedOutput,
    deposit_receipt_id: hook.receipt.receipt_id,
    verification: 'linked FINAL NEP-141 transfer-call and vault deposit hook; assumes trusted FT and Bouncer implementations' };
}

/** The output amount is derived from the linked swap receipt, not caller data. */
export function verifyCompleteRefSwap({ goal, swapResult, swapPublicKey, sweepResult, sweepPublicKey }) {
  const output = verifyRefSwapOutput(goal, swapResult, swapPublicKey);
  const credit = verifyRefSweep(goal, output.output_amount, sweepResult, sweepPublicKey);
  return { swap: output, vault_credit: credit };
}
