/** One-shot testnet V11 bootstrap and key-free original-hash reconciliation.
 * A published signature is a bearer: another party may relay the exact fixed
 * action before CI's preflight. This is not an audit or consensus proof. */
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { inspectCircleOwnerRegistration } from './circle-owner-registration.mjs';
import { inspectKeylessVaultBootstrap, newTestnetVaultId, VAULT_NATIVE_FUNDING_YOCTO, V11_EXPECTED_SHA256 } from './keyless-vault-bootstrap-readiness.mjs';
import { verifySignedVaultBootstrap, V11_NEAR_CODE_HASH } from './keyless-vault-bootstrap.mjs';
import { readPinnedJsonView } from './read-only-near-rpc.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE } from '../scripts/circle-testnet-setup.mjs';

const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const keysAre = (x, names) => record(x) && Object.keys(x).length === names.length && names.every(k => Object.hasOwn(x, k));
const numeric = x => {
  if (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0) return BigInt(x);
  if (typeof x === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(x)) return BigInt(x);
  return null;
};
const codeDigest = Buffer.from(V11_EXPECTED_SHA256, 'hex').toString('base64');

// nearcore represents a deploy action in its receipt as base64(SHA-256(WASM)),
// not the raw WASM. The separate signature verifier checks the actual code.
function matchesActions(actions, owner) {
  if (!Array.isArray(actions) || actions.length !== 4 || actions[0] !== 'CreateAccount' ||
      !keysAre(actions[1], ['Transfer']) || !keysAre(actions[1].Transfer, ['deposit']) ||
      numeric(actions[1].Transfer.deposit) !== BigInt(VAULT_NATIVE_FUNDING_YOCTO) ||
      !keysAre(actions[2], ['DeployContract']) || !keysAre(actions[2].DeployContract, ['code']) ||
      actions[2].DeployContract.code !== codeDigest || !keysAre(actions[3], ['FunctionCall'])) return false;
  const c = actions[3].FunctionCall, args = Buffer.from(JSON.stringify({ owner }));
  return keysAre(c, ['method_name', 'args', 'gas', 'deposit']) && c.method_name === 'new' &&
    typeof c.args === 'string' && Buffer.from(c.args, 'base64').toString('base64') === c.args &&
    Buffer.from(c.args, 'base64').equals(args) && numeric(c.gas) === 30n * 10n ** 12n && numeric(c.deposit) === 0n;
}
function matchesGasRefund(receipt, outcome, plan) {
  const body = receipt?.receipt?.Action, action = body?.actions?.[0], amount = numeric(action?.Transfer?.deposit);
  const fields = ['signer_id', 'signer_public_key', 'gas_price', 'input_data_ids', 'output_data_receivers', 'actions', 'is_promise_yield', 'refund_to'];
  return receipt?.predecessor_id === 'system' && receipt.receiver_id === plan.account_id && keysAre(receipt.receipt, ['Action']) &&
    record(body) && Object.keys(body).every(k => fields.includes(k)) && body.signer_id === plan.account_id &&
    body.signer_public_key === plan.public_key && numeric(body.gas_price) === 0n &&
    (body.is_promise_yield === undefined || body.is_promise_yield === false) &&
    (body.refund_to === undefined || body.refund_to === null) && Array.isArray(body.input_data_ids) && body.input_data_ids.length === 0 &&
    Array.isArray(body.output_data_receivers) && body.output_data_receivers.length === 0 && Array.isArray(body.actions) &&
    body.actions.length === 1 && keysAre(action, ['Transfer']) && keysAre(action.Transfer, ['deposit']) && amount !== null && amount > 0n &&
    amount <= (1n << 128n) - 1n && outcome?.executor_id === plan.account_id && outcome.status?.SuccessValue === '' &&
    Array.isArray(outcome.receipt_ids) && outcome.receipt_ids.length === 0;
}

/** Match the exact signed original, its action receipt and (if any) the
 * protocol gas refund. Missing root bodies, failed calls, unmatched child
 * receipts or a lost response remain unresolved and never authorize a resend. */
export function verifyVaultBootstrapReceipt(result, envelope, rawPlan) {
  const plan = validateOwnerBootstrapPlan(rawPlan); verifySignedVaultBootstrap(envelope, plan);
  const tx = result?.transaction, t = result?.transaction_outcome, rootId = t?.outcome?.status?.SuccessReceiptId;
  if (result?.final_execution_status !== 'FINAL' || result.status?.SuccessValue !== '' || tx?.hash !== envelope.tx_hash ||
      tx.signer_id !== plan.account_id || tx.public_key !== plan.public_key || tx.receiver_id !== envelope.vault ||
      numeric(tx.nonce) !== BigInt(envelope.nonce) || !matchesActions(tx.actions, plan.account_id) ||
      t?.id !== envelope.tx_hash || t.outcome?.executor_id !== plan.account_id || !isTransactionHash(rootId) ||
      !Array.isArray(t.outcome.receipt_ids) || t.outcome.receipt_ids.length !== 1 || t.outcome.receipt_ids[0] !== rootId ||
      !Array.isArray(result.receipts) || !Array.isArray(result.receipts_outcome) ||
      result.receipts.length < 1 || result.receipts.length > 2 || result.receipts_outcome.length < 1 || result.receipts_outcome.length > 2) {
    throw new Error('original V11 transaction identity, actions or FINAL status differs');
  }
  const receipts = new Map(), outcomes = new Map();
  for (const r of result.receipts) {
    if (!isTransactionHash(r?.receipt_id) || receipts.has(r.receipt_id)) throw new Error('duplicate or invalid bootstrap receipt');
    receipts.set(r.receipt_id, r);
  }
  for (const r of result.receipts_outcome) {
    if (!isTransactionHash(r?.id) || outcomes.has(r.id) || !record(r.outcome) || !record(r.outcome.status) ||
        !Array.isArray(r.outcome.receipt_ids) || r.outcome.receipt_ids.some(id => !isTransactionHash(id)) ||
        new Set(r.outcome.receipt_ids).size !== r.outcome.receipt_ids.length) throw new Error('invalid bootstrap receipt outcome');
    outcomes.set(r.id, r.outcome);
  }
  const root = receipts.get(rootId), body = root?.receipt?.Action, outcome = outcomes.get(rootId);
  if (root?.predecessor_id !== plan.account_id || root.receiver_id !== envelope.vault || !keysAre(root.receipt, ['Action']) ||
      body?.signer_id !== plan.account_id || body.signer_public_key !== plan.public_key || !matchesActions(body.actions, plan.account_id) ||
      outcome?.executor_id !== envelope.vault || outcome.status?.SuccessValue !== '' || outcome.receipt_ids.length > 1 ||
      receipts.size !== 1 + outcome.receipt_ids.length || outcomes.size !== receipts.size) {
    throw new Error('original V11 action receipt or successful result was not verified');
  }
  if (outcome.receipt_ids.length === 1) {
    const id = outcome.receipt_ids[0];
    if (!matchesGasRefund(receipts.get(id), outcomes.get(id), plan)) throw new Error('unexpected bootstrap child receipt or refund');
  }
  return { tx_hash: envelope.tx_hash, root_receipt_id: rootId, code_hash: V11_NEAR_CODE_HASH,
    protocol_gas_refund_receipts: outcome.receipt_ids.length, trusted_rpc_not_consensus_proof: true };
}

/** Pin post-creation owner, bytecode, absence of vault access keys, and V11
 * owner/version to one fresh FINAL block. This has no signer or send method. */
export async function inspectDeployedKeylessVault({ plan: raw, provider, now = Date.now } = {}) {
  const plan = validateOwnerBootstrapPlan(raw), vault = newTestnetVaultId(plan);
  if (!provider || ['viewNodeStatus', 'viewBlock', 'query', 'callFunctionRaw'].some(k => typeof provider[k] !== 'function') ||
      typeof now !== 'function') throw new Error('pinned read-only testnet provider required');
  const base = await inspectCircleOwnerRegistration({ plan, provider, now }), hash = base.block_hash;
  const query = request => provider.query({ ...request, block_id: hash });
  const view = (account, method, args) => readPinnedJsonView(provider, hash, account, method, args);
  const [account, keys, owner, version, registration, tracked] = await Promise.all([
    query({ request_type: 'view_account', account_id: vault }), query({ request_type: 'view_access_key_list', account_id: vault }),
    view(vault, 'get_owner', {}), view(vault, 'contract_version', {}), view(CIRCLE, 'storage_balance_of', { account_id: vault }),
    view(vault, 'vault_balance', { token: CIRCLE }),
  ]);
  const finish = now();
  if (!Number.isSafeInteger(finish) || finish < Date.parse(base.observed_at)) throw new Error('local clock moved backwards');
  assertFreshFinalBlock({ header: { hash, timestamp_nanosec: base.block_timestamp_nanosec } }, finish);
  if (account?.block_hash !== hash || account.code_hash !== V11_NEAR_CODE_HASH || numeric(account.amount) === null ||
      numeric(account.amount) <= 0n || keys?.block_hash !== hash || !Array.isArray(keys.keys) || keys.keys.length !== 0 ||
      owner !== plan.account_id || version !== 'bouncer-agent-v11-exact-ft-testnet' || tracked !== '0') {
    throw new Error('fresh V11 code, owner, keyless profile or initial tracked balance differs');
  }
  return { status: 'KEYLESS_V11_VAULT_AT_FINAL', network: 'testnet', owner: plan.account_id, vault, code_hash: account.code_hash,
    block_hash: hash, owner_key_nonce: base.owner_key_nonce, owner_circle_balance_atoms: base.circle_balance_atoms,
    circle_code_hash: base.circle_code_hash,
    vault_native_balance_yocto: account.amount, vault_key_count: keys.keys.length, vault_circle_registration: registration,
    vault_tracked_circle_atoms: tracked, seller_contacted: false, independently_audited: false, backup_export_verified: false,
    scope: 'fresh trusted-RPC state for a newly deployed vault; not consensus proof, audit or independent delivery' };
}

/** Key-free read-only reconciliation of exactly the recorded original hash. */
export async function reconcileVaultBootstrap({ plan: raw, envelope, provider, now = Date.now } = {}) {
  const plan = validateOwnerBootstrapPlan(raw); verifySignedVaultBootstrap(envelope, plan);
  if (!provider || typeof provider.txStatusReceipts !== 'function') throw new Error('original-hash receipt lookup required');
  const receipt = verifyVaultBootstrapReceipt(await provider.txStatusReceipts(envelope.tx_hash, plan.account_id, 'FINAL'), envelope, plan);
  const state = await inspectDeployedKeylessVault({ plan, provider, now });
  if (BigInt(state.owner_key_nonce) < BigInt(envelope.nonce) || state.owner_circle_balance_atoms !== envelope.expected_owner_circle_atoms ||
      state.circle_code_hash !== envelope.expected_circle_code_hash || state.vault_circle_registration !== null) {
    throw new Error('post-creation nonce or Circle state does not match the original deployment');
  }
  return { status: 'ORIGINAL_VAULT_FINAL_VERIFIED', network: 'testnet', owner: plan.account_id, vault: envelope.vault,
    tx_hash: envelope.tx_hash, receipt, state, vault_deployed: true, circle_funding_verified: false,
    seller_contacted: false, do_not_resend: true,
    scope: 'matching original FINAL receipt plus fresh trusted-RPC code and keyless state; not audit or independent provider delivery' };
}

/** Make one guarded send after the caller has durably fenced the exact
 * original hash. Uncertain outcomes must only use reconcileVaultBootstrap. */
export async function broadcastVaultBootstrapOnce({ plan: raw, envelope, provider, persistAttempt, now = Date.now } = {}) {
  const plan = validateOwnerBootstrapPlan(raw), signed = verifySignedVaultBootstrap(envelope, plan);
  if (!provider || provider.enforcesSetupBeforeSubmitGuard !== true ||
      ['viewNodeStatus', 'viewBlock', 'query', 'callFunctionRaw', 'viewTestnetAccountPresenceAt', 'experimental_protocolConfig',
        'sendTransactionOnce', 'txStatusReceipts'].some(k => typeof provider[k] !== 'function') ||
      typeof persistAttempt !== 'function' || typeof now !== 'function') throw new Error('guarded one-shot provider and durable fence required');
  const before = await inspectKeylessVaultBootstrap({ plan, provider, now });
  if (before.status !== 'READ_ONLY_BOOTSTRAP_INDICATED' || before.vault !== envelope.vault ||
      before.owner_key_nonce !== (BigInt(envelope.nonce) - 1n).toString() || before.circle_code_hash !== envelope.expected_circle_code_hash ||
      before.owner_test_usdc_atoms !== envelope.expected_owner_circle_atoms) {
    throw new Error(`original vault deployment ${envelope.tx_hash} no longer matches fresh preflight; inspect it, do not resend`);
  }
  if (await persistAttempt({ tx_hash: envelope.tx_hash, owner: plan.account_id, vault: envelope.vault,
    preflight_block_hash: before.block_hash }) !== true) throw new Error('original vault deployment fence was not established');
  try {
    const submitted = await provider.sendTransactionOnce(signed, 'FINAL', { beforeSubmit: () => {
      verifySignedVaultBootstrap(envelope, plan);
      assertFreshFinalBlock({ header: { hash: before.block_hash, timestamp_nanosec: before.block_timestamp_nanosec } }, now());
    } });
    if (submitted?.transaction_outcome?.id !== envelope.tx_hash || submitted.final_execution_status !== 'FINAL') {
      throw new Error('submission response did not identify the original FINAL hash');
    }
    return await reconcileVaultBootstrap({ plan, envelope, provider, now });
  } catch (error) {
    throw new Error(`original vault deployment ${envelope.tx_hash} is not safely confirmed; retain the hash and reconcile, never resend: ${error?.message ?? 'unknown error'}`);
  }
}
