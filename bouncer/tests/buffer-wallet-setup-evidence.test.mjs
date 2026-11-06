import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import nearApi from 'near-api-js';
import { buildBufferWalletSetup } from '../agent/buffer-wallet-setup-plan.mjs';
import { prepareBufferWalletSetupAttempt, verifyBufferWalletSetupReview,
  inspectBufferWalletSetupAttempt } from '../agent/buffer-wallet-setup-evidence.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { BUFFER_TESTNET_CONTRACT as SELLER } from '../experiments/buffer-forwarder/build.mjs';
import { CIRCLE_TESTNET_CODE_HASH, VAULT_NATIVE_FUNDING_YOCTO } from '../agent/keyless-vault-v12-readiness.mjs';

const wasmPath = process.env.BOUNCER_V12_WASM_PATH;
const wasm = wasmPath && fs.existsSync(wasmPath) ? fs.readFileSync(wasmPath) : null;
const artifactTest = (name, fn) => test(name, { skip: !wasm && 'reviewed V12 fixture not supplied' }, fn);
const OWNER = 'buyer.testnet', VAULT = 'vault.buyer.testnet', AMOUNT = '20000000', NOW = 1_800_000_000_000;
const KEY = String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const OTHER_KEY = String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const hash = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n));
const encode = x => Buffer.from(JSON.stringify(x)).toString('base64');
const checks = ['named_owner_has_no_local_or_global_code', 'owner_has_full_access_key', 'owner_circle_registered',
  'reviewed_circle_code_and_metadata', 'new_direct_child_absent', 'child_not_already_circle_registered',
  'circle_registration_cost_bounded', 'protocol_and_selected_features', 'owner_native_estimate', 'vault_native_estimate',
  'buffer_accepts_circle_and_is_registered', 'fixed_product_active', 'owner_balance_covers_fixed_price'];
function snapshot() {
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
function fixture(index = 0) {
  const snap = snapshot(), plan = buildBufferWalletSetup({ snapshot: snap, wasmBytes: wasm, nowMs: NOW }), batch = plan.batches[index];
  const anchors = { review: plan.review, snapshot: snap, wasmBytes: wasm, trustedReviewHash: plan.review.review_sha256,
    trustedOriginalHash: hash(7), trustedOwnerPublicKey: KEY };
  const attempt = prepareBufferWalletSetupAttempt({ ...anchors, stageId: batch.id });
  const actions = batch.actions.map(rpcAction), root = hash(8), hook = hash(9), resolver = hash(10), data = hash(11);
  const result = { final_execution_status: 'FINAL', status: { SuccessValue: '' },
    transaction: { hash: hash(7), signer_id: OWNER, public_key: KEY, receiver_id: batch.receiverId, actions: structuredClone(actions) },
    transaction_outcome: { id: hash(7), outcome: { executor_id: OWNER, receipt_ids: [root], status: { SuccessReceiptId: root } } },
    receipts: [receipt(root, OWNER, batch.receiverId, { signer_id: OWNER, signer_public_key: KEY, actions: structuredClone(actions),
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
      event: 'ft_transfer', data: [{ old_owner_id: OWNER, new_owner_id: VAULT, amount: AMOUNT }] })];
    result.receipts.push(receipt(hook, TOKEN, VAULT, { signer_id: OWNER, signer_public_key: KEY,
      actions: [call('ft_on_transfer', { sender_id: OWNER, amount: AMOUNT, msg: '' })], input_data_ids: [],
      output_data_receivers: [{ data_id: data, receiver_id: TOKEN }] }));
    result.receipts.push(receipt(resolver, TOKEN, TOKEN, { signer_id: OWNER, signer_public_key: KEY,
      actions: [call('ft_resolve_transfer', { sender_id: OWNER, receiver_id: VAULT, amount: AMOUNT })], input_data_ids: [data],
      output_data_receivers: [] }));
    result.receipts_outcome.push(outcome(hook, VAULT, { SuccessValue: encode('0') }, [], ['BOUNCER deposit received']));
    result.receipts_outcome.push(outcome(resolver, TOKEN, { SuccessValue: encode(AMOUNT) }));
  }
  return { ...anchors, attempt, result };
}
const inspect = f => inspectBufferWalletSetupAttempt(f);

artifactTest('matches the original reviewed vault creation, registration and full funding receipt graphs', () => {
  for (let i = 0; i < 3; i++) {
    const f = fixture(i), proof = inspect(f);
    const identity = verifyBufferWalletSetupReview(f);
    assert.equal(identity.owner, OWNER); assert.equal(identity.vault, VAULT); assert.equal(identity.owner_public_key, KEY);
    assert.match(f.trustedReviewHash, /^[a-f0-9]{64}$/);
    assert.equal(proof.status, i === 2 ? 'FINAL_FUNDING_RECEIPTS_MATCH' : 'FINAL_SETUP_RECEIPT_MATCH');
    assert.equal(proof.tx_hash, hash(7)); assert.equal(proof.root_receipt, hash(8));
    for (const key of ['current_state_verified', 'deployed_code_at_execution_verified', 'owner_approval_verified',
      'seller_payment_verified', 'seller_delivery_verified']) assert.equal(proof[key], false);
    assert.equal(proof.do_not_resend, true);
    if (i === 2) assert.deepEqual(proof.funding, { token: TOKEN, amount_atoms: AMOUNT,
      vault_callback_receipt: hash(9), token_resolver_receipt: hash(10) });
    assert(!JSON.stringify(proof).includes('private_key'));
  }
});

artifactTest('requires separately retained review, original hash, key, snapshot and exact V12 bytes', () => {
  const f = fixture();
  for (const bad of [undefined, '0'.repeat(64), 'invalid']) assert.throws(() => inspect({ ...f, trustedReviewHash: bad }));
  for (const bad of [undefined, hash(12), 'invalid']) assert.throws(() => inspect({ ...f, trustedOriginalHash: bad }));
  for (const bad of [undefined, OTHER_KEY, 'invalid']) assert.throws(() => inspect({ ...f, trustedOwnerPublicKey: bad }));
  for (const change of [x => { x.network = 'mainnet'; }, x => { x.block_hash = hash(5); },
    x => { x.checks.new_direct_child_absent = false; }, x => { x.circle_registration_min_yocto = '2'; },
    x => { x.block_timestamp_nanosec = 'invalid'; }]) {
    const snap = structuredClone(f.snapshot); change(snap); assert.throws(() => inspect({ ...f, snapshot: snap }));
  }
  const altered = Buffer.from(wasm); altered[100] ^= 1;
  assert.throws(() => inspect({ ...f, wasmBytes: altered }));
  const review = structuredClone(f.review); review.stages[2].actions[0].args.amount = '1';
  assert.throws(() => inspect({ ...f, review }));
  assert.throws(() => prepareBufferWalletSetupAttempt({ ...f, stageId: 'unreviewed' }));
  for (const change of [a => { a.tx_hash = hash(12); }, a => { a.receiver_id = 'evil.testnet'; },
    a => { a.stage_id = 'fund_vault_circle'; }, a => { a.action_commitment_sha256 = '0'.repeat(64); },
    a => { a.status = 'success'; }, a => { a.extra = true; }]) {
    const attempt = structuredClone(f.attempt); change(attempt); assert.throws(() => inspect({ ...f, attempt }));
  }
});

artifactTest('rejects non-FINAL, incomplete and changed original transactions or receipt graphs', () => {
  const f = fixture(0), changes = [
    r => { r.final_execution_status = 'EXECUTED'; }, r => { r.status = 'Unknown'; },
    r => { delete r.receipts; }, r => { r.receipts_outcome = []; }, r => { r.transaction.hash = hash(12); },
    r => { r.transaction.signer_id = 'evil.testnet'; }, r => { r.transaction.public_key = OTHER_KEY; },
    r => { r.transaction.receiver_id = 'evil.testnet'; }, r => { r.transaction.actions[1].Transfer.deposit = '1'; },
    r => { r.transaction.actions[2].DeployContract.code = Buffer.from(wasm).toString('base64'); },
    r => { r.transaction.actions[3].FunctionCall.args = encode({ owner: 'evil.testnet' }); },
    r => { r.transaction_outcome.id = hash(12); }, r => { r.transaction_outcome.outcome.status.SuccessReceiptId = hash(12); },
    r => { r.receipts[0].predecessor_id = 'evil.testnet'; }, r => { r.receipts[0].receipt.Action.signer_public_key = OTHER_KEY; },
    r => { r.receipts[0].receipt.Action.actions[1].Transfer.deposit = '1'; },
    r => { r.receipts.push(structuredClone(r.receipts[0])); }, r => { r.receipts_outcome.push(structuredClone(r.receipts_outcome[0])); },
    r => { r.receipts_outcome[0].outcome.executor_id = 'evil.testnet'; },
    r => { r.receipts_outcome[0].outcome.receipt_ids = [hash(12)]; },
    r => { r.status.SuccessValue = encode(null); r.receipts_outcome[0].outcome.status.SuccessValue = encode(null); },
  ];
  for (const change of changes) { const result = structuredClone(f.result); change(result); assert.throws(() => inspect({ ...f, result })); }
});

artifactTest('fresh Circle registration must return the reviewed minimum without unexpected refunds', () => {
  const f = fixture(1);
  for (const value of [{ total: '1', available: '0' }, { total: f.snapshot.circle_registration_min_yocto, available: '1' },
    { total: 1250, available: '0' }, {}, null]) {
    const result = structuredClone(f.result); result.status.SuccessValue = encode(value);
    result.receipts_outcome[0].outcome.status.SuccessValue = encode(value);
    assert.throws(() => inspect({ ...f, result }));
  }
  const result = structuredClone(f.result); result.receipts_outcome[0].outcome.receipt_ids = [hash(12)];
  assert.throws(() => inspect({ ...f, result }));
});

artifactTest('full funding requires matching event, callback, resolver, promise data and exact amount', () => {
  const f = fixture(2), changes = [
    r => { r.receipts_outcome[0].outcome.receipt_ids = [hash(9)]; },
    r => { r.receipts_outcome[0].outcome.status.SuccessReceiptId = hash(9); },
    r => { r.receipts[1].predecessor_id = 'evil.testnet'; }, r => { r.receipts[1].receiver_id = 'evil.testnet'; },
    r => { r.receipts[1].receipt.Action.actions[0].FunctionCall.args = encode({ sender_id: OWNER, amount: '1', msg: '' }); },
    r => { r.receipts[1].receipt.Action.actions[0].FunctionCall.args = encode({ sender_id: OWNER, amount: AMOUNT, msg: 'other' }); },
    r => { r.receipts[1].receipt.Action.output_data_receivers[0].receiver_id = 'evil.testnet'; },
    r => { r.receipts[2].receipt.Action.input_data_ids = [hash(12)]; },
    r => { r.receipts[2].receipt.Action.actions[0].FunctionCall.args = encode({ sender_id: OWNER, receiver_id: 'evil.testnet', amount: AMOUNT }); },
    r => { r.receipts_outcome[0].outcome.logs = []; }, r => { r.receipts_outcome[0].outcome.logs.push(r.receipts_outcome[0].outcome.logs[0]); },
    r => { r.receipts_outcome[1].outcome.logs = []; }, r => { r.receipts_outcome[1].outcome.status.SuccessValue = encode('1'); },
    r => { r.receipts_outcome[2].outcome.status.SuccessValue = encode('0'); }, r => { r.status.SuccessValue = encode('0'); },
  ];
  for (const change of changes) { const result = structuredClone(f.result); change(result); assert.throws(() => inspect({ ...f, result })); }
});

artifactTest('FINAL failures never permit a resend or claim funding', () => {
  for (let i = 0; i < 3; i++) {
    const f = fixture(i), result = structuredClone(f.result);
    result.status = { Failure: { ActionError: { index: 0 } } };
    result.receipts_outcome[0].outcome.status = { Failure: { ActionError: { index: 0 } } };
    const proof = inspect({ ...f, result });
    assert.equal(proof.status, 'FINAL_FAILURE_NEEDS_RECONCILIATION'); assert.equal(proof.do_not_resend, true);
    assert.equal(proof.current_state_verified, false); assert(!Object.hasOwn(proof, 'funding'));
  }
});
