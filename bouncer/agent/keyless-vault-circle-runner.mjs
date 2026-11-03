/** One-shot Circle TESTNET vault setup, with key-free original-hash recovery.
 * Public signatures are bearer transactions; another party may relay them
 * before this preflight. A truthful RPC and durable original fence are needed. */
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { inspectVaultCircleFunding } from './keyless-vault-circle-readiness.mjs';
import { verifySignedVaultCircle } from './keyless-vault-circle.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE } from '../scripts/circle-testnet-setup.mjs';
import { OUTLAYER_FAKE_USD as FAKE } from './outlayer-v11-readiness.mjs';
import { newTestnetVaultId } from './keyless-vault-bootstrap-readiness.mjs';
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const number = x => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? BigInt(x) :
  typeof x === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(x) ? BigInt(x) : null;
function json64(value, label) {
  if (typeof value !== 'string' || value.length > 16_384 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error(`invalid ${label}`);
  const b = Buffer.from(value, 'base64');
  if (b.toString('base64') !== value) throw new Error(`invalid ${label}`);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b)); } catch { throw new Error(`invalid ${label}`); }
}
function sameCall(actual, expected) {
  const x = actual?.FunctionCall, y = expected?.functionCall;
  return record(actual) && Object.keys(actual).join(',') === 'FunctionCall' && record(x) && y &&
    x.method_name === y.methodName && typeof x.args === 'string' && Buffer.from(x.args, 'base64').toString('base64') === x.args &&
    Buffer.from(x.args, 'base64').equals(Buffer.from(y.args)) && number(x.gas) === y.gas && number(x.deposit) === y.deposit;
}
function onlySystemRefund(receipt, outcome, plan) {
  const body = receipt?.receipt?.Action, transfer = body?.actions?.[0]?.Transfer;
  return receipt?.predecessor_id === 'system' && receipt.receiver_id === plan.account_id && record(receipt.receipt) &&
    Object.keys(receipt.receipt).join(',') === 'Action' && body?.signer_id === plan.account_id && body.signer_public_key === plan.public_key &&
    Array.isArray(body.actions) && body.actions.length === 1 && Object.keys(body.actions[0]).join(',') === 'Transfer' &&
    number(transfer?.deposit) !== null && number(transfer.deposit) > 0n && outcome?.executor_id === plan.account_id &&
    outcome.status?.SuccessValue === '' && Array.isArray(outcome.receipt_ids) && outcome.receipt_ids.length === 0;
}

/** Verify transaction, exact root action, bounded linked successful outcomes,
 * and (for funding) Circle event + vault hook + dependent token resolver. */
export function verifyVaultCircleReceipt(result, envelope, rawPlan) {
  const plan = validateOwnerBootstrapPlan(rawPlan), signed = verifySignedVaultCircle(envelope, plan);
  return verifyCircleVaultReceiptGraph(result, envelope, plan, signed.transaction.actions[0]);
}

/** Internal graph verifier for an already signature-validated, fixed-action
 * Circle envelope. Callers MUST first verify the signed transaction and its
 * exact source, receiver, amount, key and nonce; this function verifies only
 * the matching FINAL transaction/receipt graph, not that prior authorization. */
export function verifyCircleVaultReceiptGraph(result, envelope, plan, expected) {
  return verifyFixedFtVaultReceiptGraph(result, envelope, plan, expected, CIRCLE, false);
}

/** Only the fixed OutLayer testnet funding transaction may use the old fake
 * token's exact legacy transfer log. The caller must first verify the signed
 * fixed action and must separately pin the fake token code and balances. */
export function verifyFakeTestnetVaultReceiptGraph(result, envelope, rawPlan, expected) {
  const plan = validateOwnerBootstrapPlan(rawPlan);
  if (envelope?.kind !== 'fund' || envelope.stage !== 'fund-vault' || envelope.network !== 'testnet' ||
      envelope.owner !== plan.account_id || envelope.signer_public_key !== plan.public_key ||
      envelope.vault !== newTestnetVaultId(plan) || envelope.amount_atoms !== '10000') {
    throw new Error('invalid fixed fake-token vault funding terms');
  }
  return verifyFixedFtVaultReceiptGraph(result, envelope, plan, expected, FAKE, true);
}

function verifyFixedFtVaultReceiptGraph(result, envelope, plan, expected, token, allowLegacy) {
  const t = result?.transaction, txo = result?.transaction_outcome, top = txo?.outcome;
  if (result?.final_execution_status !== 'FINAL' || !record(result.status) || Object.keys(result.status).join(',') !== 'SuccessValue' ||
      typeof result.status.SuccessValue !== 'string' ||
      t?.hash !== envelope.tx_hash || t.signer_id !== plan.account_id || t.public_key !== plan.public_key || t.receiver_id !== token ||
      number(t.nonce) !== BigInt(envelope.nonce) || !Array.isArray(t.actions) || t.actions.length !== 1 || !sameCall(t.actions[0], expected) ||
      txo?.id !== envelope.tx_hash || top?.executor_id !== plan.account_id || !isTransactionHash(top?.status?.SuccessReceiptId) ||
      !Array.isArray(top.receipt_ids) || top.receipt_ids.length !== 1 || top.receipt_ids[0] !== top.status.SuccessReceiptId ||
      !Array.isArray(result.receipts) || !Array.isArray(result.receipts_outcome) || result.receipts.length > 128 ||
      result.receipts_outcome.length < 1 || result.receipts_outcome.length > 128) throw new Error('original FT vault transaction is not matching FINAL');
  const receipts = new Map(), outcomes = new Map();
  for (const r of result.receipts) {
    if (!isTransactionHash(r?.receipt_id) || receipts.has(r.receipt_id)) throw new Error('missing or duplicate vault receipt');
    receipts.set(r.receipt_id, r);
  }
  for (const item of result.receipts_outcome) {
    const o = item?.outcome;
    if (!isTransactionHash(item?.id) || outcomes.has(item.id) || !record(o?.status) || Object.keys(o.status).length !== 1 ||
        !(typeof o.status.SuccessValue === 'string' || isTransactionHash(o.status.SuccessReceiptId)) ||
        !Array.isArray(o.receipt_ids) || new Set(o.receipt_ids).size !== o.receipt_ids.length ||
        o.receipt_ids.some(id => !isTransactionHash(id))) throw new Error('vault receipt graph has a failure or malformed outcome');
    outcomes.set(item.id, o);
  }
  const rootId = top.status.SuccessReceiptId, root = receipts.get(rootId), body = root?.receipt?.Action, rootOutcome = outcomes.get(rootId);
  if (root?.predecessor_id !== plan.account_id || root.receiver_id !== token || !record(root.receipt) ||
      Object.keys(root.receipt).join(',') !== 'Action' || body?.signer_id !== plan.account_id || body.signer_public_key !== plan.public_key ||
      !Array.isArray(body.actions) || body.actions.length !== 1 || !sameCall(body.actions[0], expected) || rootOutcome?.executor_id !== token) {
    throw new Error('original FT vault root receipt is missing or mismatched');
  }
  const seen = new Set(), pending = [rootId];
  while (pending.length) {
    const id = pending.pop(), outcome = outcomes.get(id), receipt = receipts.get(id);
    if (seen.has(id) || !outcome || !receipt || outcome.executor_id !== receipt.receiver_id) throw new Error('vault receipt graph is incomplete or cyclic');
    seen.add(id); pending.push(...outcome.receipt_ids);
  }
  if (seen.size !== outcomes.size || seen.size !== receipts.size) throw new Error('vault receipt graph has unlinked outcomes');
  let funding = null;
  if (envelope.kind === 'register') {
    const total = json64(rootOutcome.status?.SuccessValue, 'vault registration result');
    if (!record(total) || Object.keys(total).sort().join(',') !== 'available,total' || total.total !== envelope.storage_min_yocto ||
        total.available !== '0' || result.status.SuccessValue !== rootOutcome.status.SuccessValue || rootOutcome.receipt_ids.length > 1 ||
        rootOutcome.receipt_ids.some(id => !onlySystemRefund(receipts.get(id), outcomes.get(id), plan))) {
      throw new Error('fresh FT vault registration result or refund differs');
    }
  } else {
    const childCall = (receiver, method) => rootOutcome.receipt_ids.flatMap(id => {
      const r = receipts.get(id), a = r?.receipt?.Action?.actions, c = a?.[0]?.FunctionCall, o = outcomes.get(id);
      return r?.predecessor_id === token && r.receiver_id === receiver && Array.isArray(a) && a.length === 1 &&
        record(a[0]) && Object.keys(a[0]).join(',') === 'FunctionCall' && c?.method_name === method && o?.executor_id === receiver ?
        [{ id, receipt: r, call: c, outcome: o }] : [];
    });
    const hooks = childCall(envelope.vault, 'ft_on_transfer'), resolvers = childCall(token, 'ft_resolve_transfer');
    if (hooks.length !== 1 || resolvers.length !== 1) throw new Error('unique FT vault hook/resolver not found');
    const hook = hooks[0], resolver = resolvers[0], outputs = hook.receipt.receipt.Action.output_data_receivers,
      inputs = resolver.receipt.receipt.Action.input_data_ids;
    const hookArgs = json64(hook.call.args, 'vault hook arguments'), resolverArgs = json64(resolver.call.args, 'token resolver arguments');
    if (number(hook.call.deposit) !== 0n || number(resolver.call.deposit) !== 0n ||
        !record(hookArgs) || Object.keys(hookArgs).sort().join(',') !== 'amount,msg,sender_id' ||
        hookArgs.sender_id !== plan.account_id || hookArgs.amount !== envelope.amount_atoms || hookArgs.msg !== '' ||
        !record(resolverArgs) || Object.keys(resolverArgs).sort().join(',') !== 'amount,receiver_id,sender_id' ||
        resolverArgs.sender_id !== plan.account_id || resolverArgs.receiver_id !== envelope.vault || resolverArgs.amount !== envelope.amount_atoms ||
        !Array.isArray(outputs) || outputs.length !== 1 || outputs[0]?.receiver_id !== token || !isTransactionHash(outputs[0]?.data_id) ||
        !Array.isArray(inputs) || inputs.length !== 1 || inputs[0] !== outputs[0].data_id ||
        rootOutcome.status?.SuccessReceiptId !== resolver.id || json64(hook.outcome.status?.SuccessValue, 'vault unused amount') !== '0' ||
        !Array.isArray(hook.outcome.logs) || !hook.outcome.logs.includes('BOUNCER deposit received') ||
        json64(resolver.outcome.status?.SuccessValue, 'token resolved amount') !== envelope.amount_atoms ||
        result.status.SuccessValue !== resolver.outcome.status.SuccessValue) throw new Error('FT vault funding callback or dependent resolver differs');
    const events = (rootOutcome.logs || []).flatMap(log => {
      if (typeof log !== 'string' || log.length > 16_384 || !log.startsWith('EVENT_JSON:')) return [];
      try { const e = JSON.parse(log.slice(11)); return e.standard === 'nep141' && e.version === '1.0.0' && e.event === 'ft_transfer' ? [e] : []; }
      catch { return []; }
    });
    const nep141 = events.length === 1 && Array.isArray(events[0].data) && events[0].data.length === 1 &&
        events[0].data[0]?.old_owner_id === plan.account_id && events[0].data[0]?.new_owner_id === envelope.vault &&
        events[0].data[0]?.amount === envelope.amount_atoms;
    const legacyLogs = (rootOutcome.logs || []).filter(log => typeof log === 'string' && log.startsWith('Transfer '));
    const legacy = allowLegacy && !(rootOutcome.logs || []).some(log => typeof log === 'string' && log.startsWith('EVENT_JSON:')) &&
        legacyLogs.length === 1 && legacyLogs[0] === `Transfer ${envelope.amount_atoms} from ${plan.account_id} to ${envelope.vault}`;
    if (!nep141 && !legacy) throw new Error('matching owner-to-vault FT transfer log is missing');
    funding = { amount_atoms: envelope.amount_atoms, vault_hook_receipt: hook.id, token_resolver_receipt: resolver.id,
      transfer_event_verified: nep141, ...(allowLegacy ? { legacy_transfer_log_verified: legacy } : {}), full_amount_accepted: true };
  }
  return { tx_hash: envelope.tx_hash, root_receipt_id: rootId, linked_successful_outcomes: seen.size, funding,
    trusted_rpc_not_consensus_proof: true };
}

export async function reconcileVaultCircle({ plan: raw, envelope, provider, now = Date.now } = {}) {
  const plan = validateOwnerBootstrapPlan(raw); verifySignedVaultCircle(envelope, plan);
  if (!provider || typeof provider.txStatusReceipts !== 'function') throw new Error('read-only original-hash receipt lookup required');
  const receipt = verifyVaultCircleReceipt(await provider.txStatusReceipts(envelope.tx_hash, plan.account_id, 'FINAL'), envelope, plan);
  const state = await inspectVaultCircleFunding({ plan, provider, now });
  if (BigInt(state.owner_key_nonce) < BigInt(envelope.nonce) || state.circle_code_hash !== envelope.expected_circle_code_hash ||
      state.vault_circle_registration !== 'REGISTERED_AT_VIEW') throw new Error('post-action Circle/keyless state differs');
  if (envelope.kind === 'register') {
    if (state.owner_circle_atoms !== envelope.expected_owner_atoms || state.vault_actual_circle_atoms !== '0' || state.vault_tracked_circle_atoms !== '0') {
      throw new Error('post-registration owner or vault balances differ');
    }
  } else if (state.owner_circle_atoms !== (BigInt(envelope.expected_owner_atoms) - BigInt(envelope.amount_atoms)).toString() ||
      state.vault_actual_circle_atoms !== envelope.amount_atoms || state.vault_tracked_circle_atoms !== envelope.amount_atoms) {
    throw new Error('post-funding owner, actual vault and tracked vault balances differ');
  }
  return { status: envelope.kind === 'register' ? 'VAULT_CIRCLE_REGISTERED_AT_FINAL' : 'VAULT_FUNDED_CIRCLE_TEST_USDC_AT_FINAL',
    kind: envelope.kind, network: 'testnet', owner: plan.account_id, vault: envelope.vault, tx_hash: envelope.tx_hash,
    receipt, state, circle_funding_verified: envelope.kind === 'fund', seller_contacted: false, do_not_resend: true,
    scope: 'matching original FINAL receipt graph plus fresh trusted-RPC balances; not an audit or provider delivery' };
}
export async function broadcastVaultCircleOnce({ plan: raw, envelope, provider, persistAttempt, now = Date.now } = {}) {
  const plan = validateOwnerBootstrapPlan(raw), signed = verifySignedVaultCircle(envelope, plan);
  if (!provider || provider.enforcesSetupBeforeSubmitGuard !== true ||
      ['viewNodeStatus','viewBlock','query','callFunctionRaw','experimental_protocolConfig','sendTransactionOnce','txStatusReceipts']
        .some(k => typeof provider[k] !== 'function') || typeof persistAttempt !== 'function') throw new Error('guarded one-shot provider and fence required');
  const before = await inspectVaultCircleFunding({ plan, provider, now });
  if ((envelope.kind === 'register' ? !before.register_eligible : !before.fund_eligible) ||
      before.owner_key_nonce !== (BigInt(envelope.nonce) - 1n).toString() || before.circle_code_hash !== envelope.expected_circle_code_hash ||
      before.circle_storage_min_yocto !== envelope.storage_min_yocto || before.owner_circle_atoms !== envelope.expected_owner_atoms ||
      before.vault_actual_circle_atoms !== envelope.expected_vault_atoms || before.vault_tracked_circle_atoms !== envelope.expected_tracked_atoms ||
      before.vault_circle_registration !== envelope.expected_registration) {
    throw new Error(`original vault ${envelope.kind} ${envelope.tx_hash} no longer matches fresh preflight; inspect it, do not resend`);
  }
  if (await persistAttempt({ kind: envelope.kind, tx_hash: envelope.tx_hash, owner: plan.account_id,
    vault: envelope.vault, preflight_block_hash: before.block_hash }) !== true) throw new Error('original Circle vault fence was not established');
  try {
    const sent = await provider.sendTransactionOnce(signed, 'FINAL', { beforeSubmit: () => {
      verifySignedVaultCircle(envelope, plan);
      assertFreshFinalBlock({ header: { hash: before.block_hash, timestamp_nanosec: before.block_timestamp_nanosec } }, now());
    } });
    if (sent?.transaction_outcome?.id !== envelope.tx_hash || sent.final_execution_status !== 'FINAL') throw new Error('submission response did not identify original FINAL hash');
    return await reconcileVaultCircle({ plan, envelope, provider, now });
  } catch (error) {
    throw new Error(`original vault ${envelope.kind} ${envelope.tx_hash} is not safely confirmed; retain the hash and reconcile, never resend: ${error?.message ?? 'unknown error'}`);
  }
}
