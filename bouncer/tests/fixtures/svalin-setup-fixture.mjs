/** Synthetic fixture: fake WASM, ephemeral test keys and invented receipt graphs. Never use for live chain state. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import { FileJournal } from '../../agent/procurement.mjs';
import { buildUnsignedSvalinTrialSetup } from '../../agent/svalin-setup-plan.mjs';
import { initializeSvalinSetupJournal, recordSvalinSetupSignedAttempt, reconcileSvalinSetupResult,
  inspectSvalinSetupJournal } from '../../agent/svalin-setup-journal.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../../scripts/circle-testnet-setup.mjs';

const names = ['new', 'contract_version', 'get_owner', 'get_policy', 'set_policy', 'allow_payee', 'grant_agent_key',
  'is_agent_key_allowed', 'lock_ft_policy_to_intents', 'is_exact_ft_policy_locked', 'is_exact_ft_payee_locked',
  'set_exact_ft_intent', 'get_exact_ft_intent', 'execute_exact_ft', 'after_exact_ft_transfer', 'ft_on_transfer',
  'vault_balance', 'daily_spent', 'check', 'withdraw'];
export const STAGES = ['create_keyless_vault', 'configure_locked_policy', 'install_restricted_agent_key',
  'register_vault_for_test_usdc', 'fund_vault_with_test_usdc'];
export const OWNER = 'owner.testnet', VAULT = 'trial.owner.testnet';
const MAX = '5009999';
export const hash = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n));
const enc = value => Buffer.from(JSON.stringify(value)).toString('base64');
function leb(value) { const out = []; do { let n = value & 127; value >>>= 7; if (value) n |= 128; out.push(n); } while (value); return out; }
const section = (id, bytes) => [id, ...leb(bytes.length), ...bytes];
// Synthetic empty function exports with a marker; these bytes are not Bouncer.
function stubWasm() {
  const exports = names.flatMap(name => { const b = [...Buffer.from(name)]; return [...leb(b.length), ...b, 0, 0]; });
  return Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, ...section(1, [1, 0x60, 0, 0]), ...section(3, [1, 0]),
    ...section(7, [...leb(names.length), ...exports]), ...section(10, [1, 2, 0, 0x0b]),
    ...section(0, [1, 0x78, ...Buffer.from('bouncer-agent-v11-exact-ft-testnet')])]);
}
function rpcAction(action) {
  switch (action.enum) {
    case 'createAccount': return 'CreateAccount';
    case 'transfer': return { Transfer: { deposit: action.transfer.deposit.toString() } };
    case 'deployContract': return { DeployContract: { code: crypto.createHash('sha256').update(action.deployContract.code).digest('base64') } };
    case 'functionCall': return { FunctionCall: { method_name: action.functionCall.methodName,
      args: Buffer.from(action.functionCall.args).toString('base64'), gas: Number(action.functionCall.gas), deposit: action.functionCall.deposit.toString() } };
    case 'addKey': {
      const k = action.addKey, p = k.accessKey.permission.functionCall;
      return { AddKey: { public_key: String(k.publicKey), access_key: { nonce: Number(k.accessKey.nonce),
        permission: { FunctionCall: { allowance: p.allowance.toString(), receiver_id: p.receiverId, method_names: p.methodNames } } } } };
    }
    default: throw new Error('unexpected fixture action');
  }
}
const receipt = (id, from, to, action) => ({ receipt_id: id, predecessor_id: from, receiver_id: to, receipt: { Action: action } });
const outcome = (id, executor, status, receipt_ids = [], logs = []) => ({ id, outcome: { executor_id: executor, status, receipt_ids, logs } });
const call = (method, args) => ({ FunctionCall: { method_name: method, args: enc(args), deposit: '0', gas: 70000000000000 } });
export function resultFor(f, index, txHash) {
  const batch = f.plan.batches[index], actions = batch.actions.map(rpcAction);
  const root = hash(80 + index * 4), hook = hash(81 + index * 4), resolver = hash(82 + index * 4), data = hash(83 + index * 4);
  const result = { final_execution_status: 'FINAL', status: { SuccessValue: '' },
    transaction: { hash: txHash, signer_id: OWNER, public_key: f.ownerKey, receiver_id: batch.receiverId,
      actions: structuredClone(actions), signature: 'untrusted-signature-not-for-the-journal' },
    transaction_outcome: { id: txHash, outcome: { executor_id: OWNER, receipt_ids: [root], status: { SuccessReceiptId: root } } },
    receipts: [receipt(root, OWNER, batch.receiverId, { signer_id: OWNER, signer_public_key: f.ownerKey, actions: structuredClone(actions),
      input_data_ids: [], output_data_receivers: [] })],
    receipts_outcome: [outcome(root, batch.receiverId, { SuccessValue: '' })] };
  if (index === 3) {
    const registration = enc({ total: '1250000000000000000000', available: '0' });
    result.status = { SuccessValue: registration }; result.receipts_outcome[0].outcome.status = { SuccessValue: registration };
  }
  if (index === 4) {
    result.status = { SuccessValue: enc(MAX) };
    result.receipts_outcome[0].outcome.status = { SuccessReceiptId: resolver };
    result.receipts_outcome[0].outcome.receipt_ids = [hook, resolver];
    result.receipts_outcome[0].outcome.logs = ['EVENT_JSON:' + JSON.stringify({ standard: 'nep141', version: '1.0.0', event: 'ft_transfer',
      data: [{ old_owner_id: OWNER, new_owner_id: VAULT, amount: MAX }] })];
    result.receipts.push(receipt(hook, TOKEN, VAULT, { signer_id: OWNER, signer_public_key: f.ownerKey,
      actions: [call('ft_on_transfer', { sender_id: OWNER, amount: MAX, msg: '' })], input_data_ids: [],
      output_data_receivers: [{ data_id: data, receiver_id: TOKEN }] }));
    result.receipts.push(receipt(resolver, TOKEN, TOKEN, { signer_id: OWNER, signer_public_key: f.ownerKey,
      actions: [call('ft_resolve_transfer', { sender_id: OWNER, receiver_id: VAULT, amount: MAX })], input_data_ids: [data],
      output_data_receivers: [] }));
    result.receipts_outcome.push(outcome(hook, VAULT, { SuccessValue: enc('0') }, [], ['BOUNCER deposit received']));
    result.receipts_outcome.push(outcome(resolver, TOKEN, { SuccessValue: enc(MAX) }));
  }
  return result;
}
/** Synthetic nearcore-shaped variants. They retain no live keys or receipts. */
export function addSyntheticSystemGasRefund(f, result) {
  const rootId = result.transaction_outcome.outcome.status.SuccessReceiptId;
  const root = result.receipts_outcome.find(item => item.id === rootId);
  if (!root || root.outcome.receipt_ids.length !== 0) throw new Error('unexpected synthetic root');
  const id = hash(241);
  root.outcome.receipt_ids.push(id);
  result.receipts.push(receipt(id, 'system', OWNER, { signer_id: OWNER, signer_public_key: f.ownerKey,
    gas_price: '0', input_data_ids: [], output_data_receivers: [], is_promise_yield: false,
    actions: [{ Transfer: { deposit: '12345' } }] }));
  result.receipts_outcome.push(outcome(id, OWNER, { SuccessValue: '' }));
  return result;
}
export function omitSyntheticLocalAddKeyReceipt(f, result) {
  if (result.transaction.signer_id !== result.transaction.receiver_id ||
      !result.transaction.actions?.[0]?.AddKey) throw new Error('expected synthetic local AddKey');
  const id = result.transaction_outcome.outcome.status.SuccessReceiptId;
  result.receipts = result.receipts.filter(item => item.receipt_id !== id);
  return addSyntheticSystemGasRefund(f, result);
}

export function fixture({ wasmBytes = stubWasm() } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svalin-setup-journal-'));
  const file = path.join(dir, 'journal.json'), key = crypto.randomBytes(32);
  const ownerPair = nearApi.KeyPair.fromRandom('ed25519'), agentPair = nearApi.KeyPair.fromRandom('ed25519');
  const ownerKey = String(ownerPair.getPublicKey()), agentPublicKey = String(agentPair.getPublicKey());
  const goal = { version: 1, id: 'trial', owner: OWNER, vault: VAULT, policy_id: 'svalin',
    vault_code_hash: nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(wasmBytes).digest()),
    accept_unsigned_seller_risk: true, accept_exact_amount_matching_risk: true };
  const inputs = { goal, agentPublicKey, wasmBytes, initialVaultFundingYocto: '7000000000000000000000000',
    agentGasAllowanceYocto: '100000000000000000000000', vaultTokenStorageDepositYocto: '1250000000000000000000' };
  const p = buildUnsignedSvalinTrialSetup(inputs), trustedReviewHash = p.review.review_sha256;
  let journal = new FileJournal(file, VAULT, OWNER, { encryptionKey: key });
  const f = { dir, file, key, ownerPair, ownerKey, inputs, plan: p, trustedReviewHash,
    get journal() { return journal; },
    base() { return { plan: p, trustedReviewHash, ownerPublicKey: ownerKey, journal }; },
    init(extra = {}) { return initializeSvalinSetupJournal({ ...this.base(), confirmNew: true, ...extra }); },
    async signed(index, nonce = 1n) {
      const batch = p.batches[index], tx = nearApi.transactions.createTransaction(OWNER, ownerPair.getPublicKey(), batch.receiverId,
        nonce, batch.actions, Buffer.alloc(32, 7));
      const [txHash, signed] = await new nearApi.KeyPairSigner(ownerPair).signTransaction(tx);
      return { txHash: nearApi.utils.serialize.base_encode(txHash), signed };
    },
    record(index, signed, extra = {}) { return recordSvalinSetupSignedAttempt({ ...this.base(), stageId: STAGES[index],
      signed, acknowledgeRecovery: true, ...extra }); },
    reconcile(index, result, extra = {}) { return reconcileSvalinSetupResult({ ...this.base(), stageId: STAGES[index], result, ...extra }); },
    status() { return inspectSvalinSetupJournal(this.base()); },
    reopen() { journal.close(); journal = new FileJournal(file, VAULT, OWNER, { encryptionKey: key, requireExisting: true }); },
    close() { journal.close(); key.fill(0); fs.rmSync(dir, { recursive: true, force: true }); },
  };
  return f;
}
