// All fixture data and keys are synthetic. The optional exact V12 bytes are
// read from a caller-supplied public artifact path; no wallet or chain is used.
import crypto from 'node:crypto';
import fs from 'node:fs';
import nearApi from 'near-api-js';
import { buildBufferWalletSetup } from '../agent/buffer-wallet-setup-plan.mjs';
import { prepareBufferWalletSetupAttempt } from '../agent/buffer-wallet-setup-evidence.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { BUFFER_TESTNET_CONTRACT as SELLER } from '../experiments/buffer-forwarder/build.mjs';
import { CIRCLE_TESTNET_CODE_HASH, VAULT_NATIVE_FUNDING_YOCTO } from '../agent/keyless-vault-v12-readiness.mjs';

const wasmPath = process.env.BOUNCER_V12_WASM_PATH;
export const wasm = wasmPath && fs.existsSync(wasmPath) ? fs.readFileSync(wasmPath) : null;
export const OWNER = 'buyer.testnet', VAULT = 'vault.buyer.testnet', AMOUNT = '20000000', NOW = 1_800_000_000_000;
export const KEY = String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
export const OTHER_KEY = String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
export const hash = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n));
export const encode = x => Buffer.from(JSON.stringify(x)).toString('base64');
const checks = ['named_owner_has_no_local_or_global_code', 'owner_has_full_access_key', 'owner_circle_registered',
  'reviewed_circle_code_and_metadata', 'new_direct_child_absent', 'child_not_already_circle_registered',
  'circle_registration_cost_bounded', 'protocol_and_selected_features', 'owner_native_estimate', 'vault_native_estimate',
  'buffer_accepts_circle_and_is_registered', 'fixed_product_active', 'owner_balance_covers_fixed_price'];
export function snapshot() {
  return { version: 1, network: 'testnet', owner: OWNER, candidate_vault: VAULT,
    block_hash: hash(4), block_timestamp_nanosec: String(BigInt(NOW) * 1_000_000n), circle_token: TOKEN,
    circle_code_hash: CIRCLE_TESTNET_CODE_HASH, owner_circle_atoms: AMOUNT, circle_registration_min_yocto: '1250000000000000000000',
    planned_vault_native_yocto: VAULT_NATIVE_FUNDING_YOCTO, checks: Object.fromEntries(checks.map(k => [k, true])), blockers: [],
    wallet_control_proven: false, wallet_approval_obtained: false, signer_present: false, signed: false, sent: false,
    vault_deployed: false, seller_contacted: false, quote_or_order_created: false, independently_fulfilled: false,
    seller: { account_id: SELLER, token: TOKEN, paused: false, circle_registered: true, code_hash: hash(5),
      fixed_products: [{ sku: 'weekly-market-brief', active: true, price_atoms: AMOUNT }] } };
}
function rpcAction(action) {
  switch (action.enum) {
    case 'createAccount': return 'CreateAccount';
    case 'transfer': return { Transfer: { deposit: action.transfer.deposit.toString() } };
    case 'deployContract': return { DeployContract: { code: crypto.createHash('sha256').update(action.deployContract.code).digest('base64') } };
    case 'functionCall': return { FunctionCall: { method_name: action.functionCall.methodName,
      args: Buffer.from(action.functionCall.args).toString('base64'), gas: Number(action.functionCall.gas),
      deposit: action.functionCall.deposit.toString() } };
    default: throw new Error('unexpected fixture action');
  }
}
const outcome = (id, executor, status, receipt_ids = [], logs = []) => ({ id, outcome: { executor_id: executor, status, receipt_ids, logs } });
const receipt = (id, from, to, action) => ({ receipt_id: id, predecessor_id: from, receiver_id: to, receipt: { Action: action } });
const call = (method, args) => ({ FunctionCall: { method_name: method, args: encode(args), deposit: '0', gas: 70000000000000 } });
export function fixture(index = 0, originalByte = 7, { owner = OWNER, ownerKey = KEY } = {}) {
  const snap = snapshot(); snap.owner = owner; snap.candidate_vault = `vault.${owner}`;
  const vault = snap.candidate_vault, plan = buildBufferWalletSetup({ snapshot: snap, wasmBytes: wasm, nowMs: NOW }), batch = plan.batches[index];
  const anchors = { review: plan.review, snapshot: snap, wasmBytes: wasm, trustedReviewHash: plan.review.review_sha256,
    trustedOriginalHash: hash(originalByte), trustedOwnerPublicKey: ownerKey };
  const attempt = prepareBufferWalletSetupAttempt({ ...anchors, stageId: batch.id });
  const actions = batch.actions.map(rpcAction), root = hash(8), hook = hash(9), resolver = hash(10), data = hash(11);
  const result = { final_execution_status: 'FINAL', status: { SuccessValue: '' },
    transaction: { hash: hash(originalByte), signer_id: owner, public_key: ownerKey, receiver_id: batch.receiverId, actions: structuredClone(actions) },
    transaction_outcome: { id: hash(originalByte), outcome: { executor_id: owner, receipt_ids: [root], status: { SuccessReceiptId: root } } },
    receipts: [receipt(root, owner, batch.receiverId, { signer_id: owner, signer_public_key: ownerKey, actions: structuredClone(actions),
      input_data_ids: [], output_data_receivers: [] })],
    receipts_outcome: [outcome(root, batch.receiverId, { SuccessValue: '' })] };
  if (index === 1) {
    const value = encode({ total: snap.circle_registration_min_yocto, available: '0' });
    result.status.SuccessValue = value; result.receipts_outcome[0].outcome.status.SuccessValue = value;
  }
  if (index === 2) {
    result.status.SuccessValue = encode(AMOUNT);
    result.receipts_outcome[0].outcome.status = { SuccessReceiptId: resolver };
    result.receipts_outcome[0].outcome.receipt_ids = [hook, resolver];
    result.receipts_outcome[0].outcome.logs = ['EVENT_JSON:' + JSON.stringify({ standard: 'nep141', version: '1.0.0',
      event: 'ft_transfer', data: [{ old_owner_id: owner, new_owner_id: vault, amount: AMOUNT }] })];
    result.receipts.push(receipt(hook, TOKEN, vault, { signer_id: owner, signer_public_key: ownerKey,
      actions: [call('ft_on_transfer', { sender_id: owner, amount: AMOUNT, msg: '' })], input_data_ids: [],
      output_data_receivers: [{ data_id: data, receiver_id: TOKEN }] }));
    result.receipts.push(receipt(resolver, TOKEN, TOKEN, { signer_id: owner, signer_public_key: ownerKey,
      actions: [call('ft_resolve_transfer', { sender_id: owner, receiver_id: vault, amount: AMOUNT })], input_data_ids: [data],
      output_data_receivers: [] }));
    result.receipts_outcome.push(outcome(hook, vault, { SuccessValue: encode('0') }, [], ['BOUNCER deposit received']));
    result.receipts_outcome.push(outcome(resolver, TOKEN, { SuccessValue: encode(AMOUNT) }));
  }
  return { ...anchors, attempt, result };
}
