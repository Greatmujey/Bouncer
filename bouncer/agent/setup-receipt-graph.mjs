/**
 * Internal receipt-graph helpers. The caller MUST independently validate the
 * constrained plan, original hash, signer and token before invoking these
 * routines. They trust supplied RPC results and do not authorize a wallet,
 * prove current state, or permit retrying an unresolved transaction.
 */
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysAre = (value, names) => record(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const equal = isDeepStrictEqual;
const digest = value => crypto.createHash('sha256').update(value).digest();

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
  if (expected.enum === 'deleteKey') return keysAre(actual, ['DeleteKey']) &&
    keysAre(actual.DeleteKey, ['public_key']) && actual.DeleteKey.public_key === String(expected.deleteKey.publicKey);
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
export function statusKind(status) {
  if (!record(status) || Object.keys(status).length !== 1) return null;
  if (typeof status.SuccessValue === 'string') return 'value';
  if (isTransactionHash(status.SuccessReceiptId)) return 'receipt';
  if (record(status.Failure)) return 'failure';
  return null;
}
export function decodeJson(encoded, label) {
  if (typeof encoded !== 'string' || encoded.length > 16_384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error(`invalid ${label}`);
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new Error(`invalid ${label}`);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error(`invalid ${label}`); }
}
export function graph(result, allowEmptyReceipts = false) {
  if (!Array.isArray(result.receipts) || !Array.isArray(result.receipts_outcome) ||
      (!allowEmptyReceipts && result.receipts.length < 1) || result.receipts.length > 256 ||
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
export function rootOf(result, batch, attempt, g) {
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
  if (!outcome || outcome.executor_id !== attempt.receiver_id) {
    throw new Error('original action receipt outcome is missing or has the wrong executor');
  }
  // nearcore does not include the local root receipt body in tx_status when
  // signer and receiver are the same. Accept ONLY this planner's self-directed
  // single reviewed AddKey or DeleteKey stage without the body: the original trusted hash, exact
  // transaction actions, root link and root outcome were checked above. This
  // remains trusted-RPC evidence, not an independently verified receipt body.
  const permittedLocalAction = (['install_restricted_agent_key', 'install_native_oracle_agent'].includes(attempt.stage_id) && batch.actions[0]?.enum === 'addKey') ||
    (attempt.stage_id === 'remove_native_oracle_access_key' && batch.actions[0]?.enum === 'deleteKey');
  if (!receipt && permittedLocalAction && attempt.signer_id === attempt.receiver_id &&
      txOutcome.receipt_ids.length === 1 && txOutcome.receipt_ids[0] === id && batch.actions.length === 1) {
    return { id, receipt: null, outcome, localReceiptOmitted: true };
  }
  const action = receipt?.receipt?.Action;
  if (!receipt || receipt.predecessor_id !== attempt.signer_id || receipt.receiver_id !== attempt.receiver_id ||
      !record(action) || action.signer_id !== attempt.signer_id || action.signer_public_key !== attempt.signer_public_key ||
      !actionsMatch(batch.actions, action.actions)) {
    throw new Error('original action receipt is missing or differs from the reviewed batch');
  }
  return { id, receipt, outcome, localReceiptOmitted: false };
}
// A successful action can generate a nearcore gas-refund receipt even when the
// contract created no promise. Do not mistake that for a storage-deposit refund
// from the token. Match only the protocol's system transfer to this original
// signer and key; any unknown/missing child or contract-origin transfer blocks.
export function protocolGasRefund(receipt, outcome, attempt) {
  const action = receipt?.receipt?.Action, actions = action?.actions, transfer = actions?.[0]?.Transfer;
  const deposit = numericString(transfer?.deposit);
  const knownActionFields = ['signer_id', 'signer_public_key', 'gas_price', 'input_data_ids', 'output_data_receivers',
    'actions', 'is_promise_yield', 'refund_to'];
  return receipt?.predecessor_id === 'system' && receipt?.receiver_id === attempt.signer_id &&
    keysAre(receipt?.receipt, ['Action']) && record(action) && Object.keys(action).every(key => knownActionFields.includes(key)) &&
    action.signer_id === attempt.signer_id &&
    action.signer_public_key === attempt.signer_public_key && numericString(action.gas_price) === '0' &&
    (action.is_promise_yield === undefined || action.is_promise_yield === false) &&
    (action.refund_to === undefined || action.refund_to === null) &&
    Array.isArray(action.input_data_ids) && action.input_data_ids.length === 0 &&
    Array.isArray(action.output_data_receivers) && action.output_data_receivers.length === 0 &&
    Array.isArray(actions) && actions.length === 1 && keysAre(actions[0], ['Transfer']) &&
    keysAre(transfer, ['deposit']) && deposit !== null && BigInt(deposit) > 0n &&
    BigInt(deposit) <= (1n << 128n) - 1n && outcome?.executor_id === attempt.signer_id &&
    statusKind(outcome?.status) === 'value' && outcome.status.SuccessValue === '' &&
    Array.isArray(outcome.receipt_ids) && outcome.receipt_ids.length === 0;
}
export function onlyProtocolGasRefund(rootOutcome, g, attempt, localRootOmitted = false) {
  const childCount = rootOutcome.receipt_ids.length;
  // For these simple stages, the complete graph consists only of the root
  // and optionally one gas refund. Reject unlinked or otherwise unknown data.
  if (childCount > 1 || g.outcomes.size !== 1 + childCount ||
      g.receipts.size !== (localRootOmitted ? 0 : 1) + childCount) return false;
  if (childCount === 0) return true;
  const id = rootOutcome.receipt_ids[0];
  return protocolGasRefund(g.receipts.get(id), g.outcomes.get(id), attempt);
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
function exactTransferEvent(root, owner, vault, amount) {
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
      events[0].data[0]?.amount !== amount) throw new Error('matching Circle token transfer event is missing');
}
export function fundingEvidence(result, root, g, { owner, vault, token, amount, signerPublicKey }) {
  const out = root.outcome;
  if (statusKind(out.status) !== 'receipt' || !Array.isArray(result.transaction_outcome?.outcome?.receipt_ids) ||
      result.transaction_outcome.outcome.receipt_ids.length !== 1 || result.transaction_outcome.outcome.receipt_ids[0] !== root.id) {
    throw new Error('funding token resolver is not linked from the original transfer');
  }
  const hook = childCall(g, out, token, vault, 'ft_on_transfer');
  const resolver = childCall(g, out, token, token, 'ft_resolve_transfer');
  // The resolver must consume THIS hook's output, not merely be another
  // successful sibling receipt with matching-looking arguments.
  const outputs = hook.receipt.receipt.Action.output_data_receivers;
  const inputs = resolver.receipt.receipt.Action.input_data_ids;
  if (!Array.isArray(outputs) || outputs.length !== 1 || outputs[0]?.receiver_id !== token ||
      !isTransactionHash(outputs[0]?.data_id) || !Array.isArray(inputs) || inputs.length !== 1 || inputs[0] !== outputs[0].data_id ||
      ![hook, resolver].every(child => keysAre(child.receipt.receipt, ['Action']) &&
        child.receipt.receipt.Action.signer_id === owner && child.receipt.receipt.Action.signer_public_key === signerPublicKey) ||
      out.status.SuccessReceiptId !== resolver.id || numericString(hook.call.deposit) !== '0' ||
      !equal(decodeJson(hook.call.args, 'funding receiver arguments'), { sender_id: owner, amount: amount, msg: '' }) ||
      numericString(resolver.call.deposit) !== '0' ||
      !equal(decodeJson(resolver.call.args, 'funding resolver arguments'), { sender_id: owner, receiver_id: vault, amount: amount }) ||
      statusKind(hook.outcome.status) !== 'value' || decodeJson(hook.outcome.status.SuccessValue, 'vault unused amount') !== '0' ||
      !Array.isArray(hook.outcome.logs) || !hook.outcome.logs.includes('BOUNCER deposit received') ||
      statusKind(resolver.outcome.status) !== 'value' ||
      decodeJson(resolver.outcome.status.SuccessValue, 'token resolved amount') !== amount ||
      result.status.SuccessValue !== resolver.outcome.status.SuccessValue) {
    throw new Error('funding callback or resolver does not establish the reviewed full deposit');
  }
  exactTransferEvent(out, owner, vault, amount);
  // Close the entire action-receipt graph. A successful-looking hook and
  // resolver must not hide a second transfer, an unlinked outcome or an
  // unknown descendant. nearcore may emit a system gas refund from each
  // action receipt; accept only that bounded, signer-directed transfer.
  const known = new Set([root.id, hook.id, resolver.id]);
  const checkChildren = (outcome, required) => {
    if (!Array.isArray(outcome.receipt_ids) || required.some(id => !outcome.receipt_ids.includes(id))) throw new Error('incomplete funding graph');
    const remaining = outcome.receipt_ids.filter(id => !required.includes(id));
    if (remaining.length > 1) throw new Error('unexpected funding descendant');
    for (const id of remaining) {
      if (known.has(id) || !protocolGasRefund(g.receipts.get(id), g.outcomes.get(id),
        { signer_id: owner, signer_public_key: signerPublicKey })) throw new Error('unexpected funding descendant');
      known.add(id);
    }
  };
  checkChildren(out, [hook.id, resolver.id]);
  checkChildren(hook.outcome, []);
  checkChildren(resolver.outcome, []);
  if (g.receipts.size !== known.size || g.outcomes.size !== known.size ||
      [...g.receipts.keys()].some(id => !known.has(id)) || [...g.outcomes.keys()].some(id => !known.has(id))) {
    throw new Error('unlinked or unexpected funding receipts');
  }
  return { token: token, amount_atoms: amount,
    vault_callback_receipt: hook.id, token_resolver_receipt: resolver.id };
}
