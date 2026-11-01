import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { buildUnsignedSvalinTrialSetup } from '../agent/svalin-setup-plan.mjs';
import { prepareSvalinSetupAttempt, verifySignedSvalinSetup, inspectSvalinSetupAttempt } from '../agent/svalin-setup-evidence.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';

const names = ['new', 'contract_version', 'get_owner', 'get_policy', 'set_policy', 'allow_payee', 'grant_agent_key',
  'is_agent_key_allowed', 'lock_ft_policy_to_intents', 'is_exact_ft_policy_locked', 'is_exact_ft_payee_locked',
  'set_exact_ft_intent', 'get_exact_ft_intent', 'execute_exact_ft', 'after_exact_ft_transfer', 'ft_on_transfer',
  'vault_balance', 'daily_spent', 'check', 'withdraw'];
function leb(value) { const out = []; do { let n = value & 127; value >>>= 7; if (value) n |= 128; out.push(n); } while (value); return out; }
const section = (id, bytes) => [id, ...leb(bytes.length), ...bytes];
// A synthetic stub with the names/marker only. It is not Bouncer code or an audit.
function stubWasm() {
  const exported = names.flatMap(name => { const b = [...Buffer.from(name)]; return [...leb(b.length), ...b, 0, 0]; });
  return Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, ...section(1, [1, 0x60, 0, 0]), ...section(3, [1, 0]),
    ...section(7, [...leb(names.length), ...exported]), ...section(10, [1, 2, 0, 0x0b]),
    ...section(0, [1, 0x78, ...Buffer.from('bouncer-agent-v11-exact-ft-testnet')])]);
}
const hash = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n));
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
const OWNER = 'owner.testnet', VAULT = 'trial.owner.testnet', MAX = '5009999';
const OWNER_PAIR = nearApi.KeyPair.fromRandom('ed25519');
const OWNER_KEY = String(OWNER_PAIR.getPublicKey());
const AGENT_KEY = String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const STAGES = ['create_keyless_vault', 'configure_locked_policy', 'install_restricted_agent_key',
  'register_vault_for_test_usdc', 'fund_vault_with_test_usdc'];
function plan() {
  const wasmBytes = stubWasm(), vault_code_hash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(wasmBytes).digest());
  return buildUnsignedSvalinTrialSetup({ goal: { version: 1, id: 'risk', owner: OWNER, vault: VAULT, vault_code_hash,
    policy_id: 'svalin', accept_unsigned_seller_risk: true, accept_exact_amount_matching_risk: true },
  agentPublicKey: AGENT_KEY, wasmBytes, initialVaultFundingYocto: '7000000000000000000000000',
  agentGasAllowanceYocto: '100000000000000000000000', vaultTokenStorageDepositYocto: '1250000000000000000000' });
}
function rpcAction(action) {
  switch (action.enum) {
    case 'createAccount': return 'CreateAccount';
    case 'transfer': return { Transfer: { deposit: action.transfer.deposit.toString() } };
    case 'deployContract': return { DeployContract: { code: crypto.createHash('sha256').update(action.deployContract.code).digest('base64') } };
    case 'functionCall': return { FunctionCall: { method_name: action.functionCall.methodName,
      args: Buffer.from(action.functionCall.args).toString('base64'), gas: Number(action.functionCall.gas),
      deposit: action.functionCall.deposit.toString() } };
    case 'addKey': {
      const key = action.addKey, p = key.accessKey.permission.functionCall;
      return { AddKey: { public_key: String(key.publicKey), access_key: { nonce: Number(key.accessKey.nonce),
        permission: { FunctionCall: { allowance: p.allowance.toString(), receiver_id: p.receiverId, method_names: p.methodNames } } } } };
    }
    default: throw new Error('unsupported fixture action');
  }
}
const outcome = (id, executor, status, receipt_ids = [], logs = []) => ({ id, outcome: { executor_id: executor, status, receipt_ids, logs } });
const receipt = (id, from, to, action) => ({ receipt_id: id, predecessor_id: from, receiver_id: to, receipt: { Action: action } });
const call = (method, args) => ({ FunctionCall: { method_name: method, args: encode(args), deposit: '0', gas: 70000000000000 } });
function fixture(stage = 0) {
  const p = plan(), batch = p.batches[stage], trustedReviewHash = p.review.review_sha256;
  const attempt = prepareSvalinSetupAttempt({ plan: p, trustedReviewHash, stageId: batch.id, ownerPublicKey: OWNER_KEY, txHash: hash(7) });
  const actions = batch.actions.map(rpcAction), root = hash(8), hook = hash(9), resolver = hash(10), data = hash(11);
  const result = { final_execution_status: 'FINAL', status: { SuccessValue: '' },
    transaction: { hash: hash(7), signer_id: OWNER, public_key: OWNER_KEY, receiver_id: batch.receiverId, actions: structuredClone(actions) },
    transaction_outcome: { id: hash(7), outcome: { executor_id: OWNER, receipt_ids: [root], status: { SuccessReceiptId: root } } },
    receipts: [receipt(root, OWNER, batch.receiverId, { signer_id: OWNER, signer_public_key: OWNER_KEY, actions: structuredClone(actions),
      input_data_ids: [], output_data_receivers: [] })],
    receipts_outcome: [outcome(root, batch.receiverId, { SuccessValue: '' })] };
  if (stage === 3) {
    const registration = encode({ total: '1250000000000000000000', available: '0' });
    result.status = { SuccessValue: registration }; result.receipts_outcome[0].outcome.status = { SuccessValue: registration };
  }
  if (stage === 4) {
    result.status = { SuccessValue: encode(MAX) };
    result.receipts_outcome[0].outcome.status = { SuccessReceiptId: resolver };
    result.receipts_outcome[0].outcome.receipt_ids = [hook, resolver];
    result.receipts_outcome[0].outcome.logs = ['EVENT_JSON:' + JSON.stringify({ standard: 'nep141', version: '1.0.0',
      event: 'ft_transfer', data: [{ old_owner_id: OWNER, new_owner_id: VAULT, amount: MAX }] })];
    result.receipts.push(receipt(hook, TOKEN, VAULT, { signer_id: OWNER, signer_public_key: OWNER_KEY,
      actions: [call('ft_on_transfer', { sender_id: OWNER, amount: MAX, msg: '' })], input_data_ids: [],
      output_data_receivers: [{ data_id: data, receiver_id: TOKEN }] }));
    result.receipts.push(receipt(resolver, TOKEN, TOKEN, { signer_id: OWNER, signer_public_key: OWNER_KEY,
      actions: [call('ft_resolve_transfer', { sender_id: OWNER, receiver_id: VAULT, amount: MAX })], input_data_ids: [data],
      output_data_receivers: [] }));
    result.receipts_outcome.push(outcome(hook, VAULT, { SuccessValue: encode('0') }, [], ['BOUNCER deposit received']));
    result.receipts_outcome.push(outcome(resolver, TOKEN, { SuccessValue: encode(MAX) }));
  }
  return { plan: p, trustedReviewHash, trustedOriginalHash: hash(7), trustedOwnerPublicKey: OWNER_KEY, attempt, result };
}
const inspect = f => inspectSvalinSetupAttempt(f);

test('binds original public attempt to retained review, original hash, owner key and all five exact setup batches', () => {
  for (let i = 0; i < STAGES.length; i++) {
    const f = fixture(i), proof = inspect(f);
    assert.equal(f.attempt.kind, 'svalin-setup-attempt-v1');
    assert.equal(f.attempt.status, 'pending');
    assert.equal(f.attempt.action_commitment_sha256, f.plan.review.stages[i].action_commitment_sha256);
    assert.equal(proof.status, i === 4 ? 'FINAL_FUNDING_RECEIPTS_MATCH' : 'FINAL_SETUP_RECEIPT_MATCH');
    assert.equal(proof.root_receipt, hash(8)); assert.equal(proof.tx_hash, hash(7));
    assert.equal(proof.do_not_resend, true); assert.equal(proof.current_state_verified, false);
    assert.equal(proof.deployed_code_at_execution_verified, false); assert.equal(proof.owner_approval_verified, false);
    assert.equal(proof.seller_delivery_verified, false);
    assert.equal(JSON.stringify(proof).includes('signature'), false);
    if (i === 4) assert.deepEqual(proof.funding, { token: TOKEN, amount_atoms: MAX,
      vault_callback_receipt: hash(9), token_resolver_receipt: hash(10) });
  }
});

test('offline signed-transaction verification derives the original hash without returning signed bytes', async () => {
  const signer = new nearApi.KeyPairSigner(OWNER_PAIR);
  for (let i = 0; i < STAGES.length; i++) {
    const p = plan(), batch = p.batches[i], tx = nearApi.transactions.createTransaction(batch.signerId, OWNER_PAIR.getPublicKey(),
      batch.receiverId, 42n, batch.actions, Buffer.alloc(32, 3));
    const [expected, signed] = await signer.signTransaction(tx);
    const proof = verifySignedSvalinSetup({ plan: p, trustedReviewHash: p.review.review_sha256,
      stageId: batch.id, ownerPublicKey: OWNER_KEY, signed });
    assert.equal(proof.attempt.tx_hash, nearApi.utils.serialize.base_encode(expected));
    assert.equal(proof.attempt.stage_id, batch.id); assert.equal(proof.signature_verified, true);
    assert.equal(proof.current_key_or_nonce_verified, false); assert.equal(proof.reference_block_freshness_verified, false);
    assert.equal(proof.owner_approval_verified, false);
    assert.equal(JSON.stringify(proof).includes(Buffer.from(signed.signature.data).toString('base64')), false);
    assert.equal(JSON.stringify(proof).includes('private_key'), false);
  }
});

test('the verified original signed hash can bind a later synthetic FINAL funding receipt graph', async () => {
  const f = fixture(4), batch = f.plan.batches[4], tx = nearApi.transactions.createTransaction(batch.signerId,
    OWNER_PAIR.getPublicKey(), batch.receiverId, 17n, batch.actions, Buffer.alloc(32, 5));
  const [, signed] = await new nearApi.KeyPairSigner(OWNER_PAIR).signTransaction(tx);
  const signedProof = verifySignedSvalinSetup({ plan: f.plan, trustedReviewHash: f.trustedReviewHash,
    stageId: batch.id, ownerPublicKey: OWNER_KEY, signed });
  const original = signedProof.attempt.tx_hash;
  f.result.transaction.hash = original; f.result.transaction_outcome.id = original;
  f.attempt = signedProof.attempt; f.trustedOriginalHash = original;
  const evidence = inspect(f);
  assert.equal(evidence.tx_hash, original); assert.equal(evidence.status, 'FINAL_FUNDING_RECEIPTS_MATCH');
  assert.equal(evidence.do_not_resend, true); assert.equal(evidence.current_state_verified, false);
});

test('signed setup rejects wrong payload, nonce, block, key or signature before journal or send', async () => {
  const p = plan(), batch = p.batches[1], signer = new nearApi.KeyPairSigner(OWNER_PAIR);
  const build = () => nearApi.transactions.createTransaction(batch.signerId, OWNER_PAIR.getPublicKey(), batch.receiverId,
    42n, batch.actions, Buffer.alloc(32, 3));
  const [, signed] = await signer.signTransaction(build());
  const input = { plan: p, trustedReviewHash: p.review.review_sha256, stageId: batch.id, ownerPublicKey: OWNER_KEY, signed };
  assert.doesNotThrow(() => verifySignedSvalinSetup(input));
  const copies = [
    { ...signed, transaction: { ...signed.transaction, signerId: 'evil.testnet' } },
    { ...signed, transaction: { ...signed.transaction, receiverId: 'evil.testnet' } },
    { ...signed, transaction: { ...signed.transaction, publicKey: nearApi.utils.PublicKey.from(AGENT_KEY) } },
    { ...signed, transaction: { ...signed.transaction, nonce: 0n } },
    { ...signed, transaction: { ...signed.transaction, nonce: 43n } },
    { ...signed, transaction: { ...signed.transaction, blockHash: Buffer.alloc(32) } },
    { ...signed, transaction: { ...signed.transaction, blockHash: Buffer.alloc(32, 4) } },
    { ...signed, signature: { ...signed.signature, enum: 'secp256k1Signature' } },
    { ...signed, signature: { ...signed.signature, data: Buffer.alloc(64, 8) } },
    { ...signed, signature: { ...signed.signature, data: Buffer.alloc(63, 8) } },
    { ...signed, transaction: { ...signed.transaction, actions: p.batches[3].actions } },
  ];
  for (const altered of copies) assert.throws(() => verifySignedSvalinSetup({ ...input, signed: altered }));
  assert.throws(() => verifySignedSvalinSetup({ ...input, stageId: 'other' }));
  assert.throws(() => verifySignedSvalinSetup({ ...input, ownerPublicKey: AGENT_KEY }));
  assert.throws(() => verifySignedSvalinSetup({ ...input, trustedReviewHash: '0'.repeat(64) }));
  p.batches[0].actions[2].deployContract.code[8] ^= 1;
  assert.throws(() => verifySignedSvalinSetup(input), /differs/);
});

test('deploy action compares the RPC base64 SHA-256, never raw WASM or a different digest', () => {
  const f = fixture(0);
  assert.equal(inspect(f).status, 'FINAL_SETUP_RECEIPT_MATCH');
  const encodedBytes = Buffer.from(f.plan.batches[0].actions[2].deployContract.code).toString('base64');
  for (const code of [encodedBytes, Buffer.alloc(32, 7).toString('base64'), '']) {
    const r = structuredClone(f.result); r.transaction.actions[2].DeployContract.code = code;
    r.receipts[0].receipt.Action.actions[2].DeployContract.code = code;
    assert.throws(() => inspect({ ...f, result: r }), /mismatch|differs/);
  }
});

test('rejects altered plans, missing independent trust anchors, invalid original hashes and owner/agent key reuse', () => {
  const f = fixture();
  for (const bad of [null, {}, 'abc', '0'.repeat(64)]) {
    assert.throws(() => inspect({ ...f, trustedReviewHash: bad }));
  }
  for (const bad of [undefined, hash(33), 'not-a-hash']) {
    assert.throws(() => inspect({ ...f, trustedOriginalHash: bad }), /original hash/);
  }
  assert.throws(() => inspect({ ...f, trustedOwnerPublicKey: AGENT_KEY }), /owner key/);
  assert.throws(() => prepareSvalinSetupAttempt({ plan: f.plan, trustedReviewHash: f.trustedReviewHash,
    stageId: STAGES[0], ownerPublicKey: AGENT_KEY, txHash: hash(7) }), /differ/);
  assert.throws(() => prepareSvalinSetupAttempt({ plan: f.plan, trustedReviewHash: f.trustedReviewHash,
    stageId: 'unreviewed', ownerPublicKey: OWNER_KEY, txHash: hash(7) }), /known stage/);
  for (const patch of [a => { a.tx_hash = hash(33); }, a => { a.receiver_id = 'evil.testnet'; },
    a => { a.action_commitment_sha256 = '0'.repeat(64); }, a => { a.stage_id = STAGES[1]; },
    a => { a.signer_id = 'evil.testnet'; }, a => { a.status = 'success'; }, a => { a.private_key = 'not-a-real-key'; }]) {
    const a = structuredClone(f.attempt); patch(a);
    assert.throws(() => inspect({ ...f, attempt: a }));
  }
  const changed = plan(); changed.batches[1].actions[0].functionCall.deposit = 0n;
  assert.throws(() => prepareSvalinSetupAttempt({ plan: changed, trustedReviewHash: changed.review.review_sha256,
    stageId: STAGES[0], ownerPublicKey: OWNER_KEY, txHash: hash(7) }), /differs/);
  const replaced = plan(); replaced.review.stages[1].actions[0].args.daily_cap = '9999999';
  assert.throws(() => prepareSvalinSetupAttempt({ plan: replaced, trustedReviewHash: replaced.review.review_sha256,
    stageId: STAGES[0], ownerPublicKey: OWNER_KEY, txHash: hash(7) }), /differs/);
});

test('a missing, unknown, non-FINAL, incomplete or mismatched result cannot become success or a retry signal', () => {
  const f = fixture(1);
  const changes = [
    r => { r.final_execution_status = 'EXECUTED_OPTIMISTIC'; }, r => { r.status = 'Unknown'; },
    r => { delete r.receipts; }, r => { r.receipts_outcome = []; },
    r => { r.transaction.hash = hash(12); }, r => { r.transaction.signer_id = 'evil.testnet'; },
    r => { r.transaction.receiver_id = 'evil.testnet'; }, r => { r.transaction.public_key = AGENT_KEY; },
    r => { r.transaction.actions[0].FunctionCall.deposit = '0'; },
    r => { r.transaction.actions[1].FunctionCall.args = encode({ payee: 'evil.testnet' }); },
    r => { r.transaction.actions[2].FunctionCall.gas = 30000000000001; },
    r => { r.transaction_outcome.id = hash(12); }, r => { r.transaction_outcome.outcome.executor_id = 'evil.testnet'; },
    r => { r.transaction_outcome.outcome.status.SuccessReceiptId = hash(12); },
    r => { r.receipts[0].predecessor_id = 'evil.testnet'; }, r => { r.receipts[0].receipt.Action.signer_public_key = AGENT_KEY; },
    r => { r.receipts[0].receipt.Action.actions[3].FunctionCall.deposit = '0'; },
    r => { r.receipts.push(structuredClone(r.receipts[0])); }, r => { r.receipts_outcome.push(structuredClone(r.receipts_outcome[0])); },
    r => { r.receipts_outcome[0].outcome.executor_id = 'evil.testnet'; },
    r => { r.receipts_outcome[0].outcome.status = { SuccessReceiptId: hash(12) }; },
    r => { r.receipts_outcome[0].outcome.receipt_ids = [hash(12), hash(12)]; },
    r => { r.status.SuccessValue = 'bnVsbA=='; },
  ];
  for (const change of changes) { const r = structuredClone(f.result); change(r); assert.throws(() => inspect({ ...f, result: r })); }
  assert.throws(() => inspect({ ...f, result: null }), /not terminal FINAL/);
});

test('restricted key RPC action must retain the exact vault, method, allowance and nonce', () => {
  const f = fixture(2);
  const changes = [
    a => { a.public_key = OWNER_KEY; }, a => { a.access_key.nonce = 1; },
    a => { a.access_key.permission.FunctionCall.receiver_id = 'evil.testnet'; },
    a => { a.access_key.permission.FunctionCall.method_names.push('set_policy'); },
    a => { a.access_key.permission.FunctionCall.allowance = null; },
    a => { a.access_key.permission = 'FullAccess'; },
  ];
  for (const change of changes) {
    const r = structuredClone(f.result); change(r.transaction.actions[0].AddKey);
    assert.throws(() => inspect({ ...f, result: r }), /mismatch/);
  }
});

test('a FINAL failure is only a reconciliation warning and does not authorize replacement', () => {
  for (const index of [0, 3]) {
    const f = fixture(index), r = structuredClone(f.result);
    r.status = { Failure: { ActionError: { index: 0 } } };
    r.receipts_outcome[0].outcome.status = { Failure: { ActionError: { index: 0 } } };
    const proof = inspect({ ...f, result: r });
    assert.equal(proof.status, 'FINAL_FAILURE_NEEDS_RECONCILIATION');
    assert.equal(proof.do_not_resend, true); assert.equal(proof.current_state_verified, false);
    assert.equal(Object.hasOwn(proof, 'funding'), false);
  }
  const f = fixture(4); f.result.receipts_outcome[1].outcome.status = { Failure: { ActionError: {} } };
  assert.equal(inspect(f).status, 'FINAL_FAILURE_NEEDS_RECONCILIATION');
});

test('registration requires the reviewed Circle deposit, returned balance and no refund receipt', () => {
  const f = fixture(3);
  assert.equal(inspect(f).status, 'FINAL_SETUP_RECEIPT_MATCH');
  for (const value of [
    { total: '1250000000000000000001', available: '0' },
    { total: '1250000000000000000000', available: '1' },
    { total: 1250, available: '0' }, null, {},
  ]) {
    const result = structuredClone(f.result), encoded = encode(value);
    result.status.SuccessValue = encoded; result.receipts_outcome[0].outcome.status.SuccessValue = encoded;
    assert.throws(() => inspect({ ...f, result }), /registration/);
  }
  let result = structuredClone(f.result);
  result.receipts_outcome[0].outcome.receipt_ids = [hash(91)]; // already-registered/changed-price refund
  assert.throws(() => inspect({ ...f, result }), /registration/);
  result = structuredClone(f.result);
  result.transaction.actions[0].FunctionCall.deposit = '1';
  result.receipts[0].receipt.Action.actions[0].FunctionCall.deposit = '1';
  assert.throws(() => inspect({ ...f, result }), /mismatch|differs/);
  result = structuredClone(f.result);
  result.transaction.actions[0].FunctionCall.args = encode({ account_id: 'other.testnet', registration_only: true });
  result.receipts[0].receipt.Action.actions[0].FunctionCall.args = result.transaction.actions[0].FunctionCall.args;
  assert.throws(() => inspect({ ...f, result }), /mismatch|differs/);
});

test('funding requires the exact Circle event, vault callback, resolver and promise-data dependency', () => {
  const f = fixture(4), changes = [
    r => { delete r.receipts[0]; r.receipts.shift(); },
    r => { r.receipts_outcome[0].outcome.receipt_ids = [hash(9)]; },
    r => { r.receipts_outcome[0].outcome.status.SuccessReceiptId = hash(9); },
    r => { r.receipts[1].predecessor_id = 'evil.testnet'; },
    r => { r.receipts[1].receiver_id = 'evil.testnet'; },
    r => { r.receipts[1].receipt.Action.actions[0].FunctionCall.args = encode({ sender_id: 'evil.testnet', amount: MAX, msg: '' }); },
    r => { r.receipts[1].receipt.Action.actions[0].FunctionCall.args = encode({ sender_id: OWNER, amount: '1', msg: '' }); },
    r => { r.receipts[1].receipt.Action.actions[0].FunctionCall.args = encode({ sender_id: OWNER, amount: MAX, msg: 'other' }); },
    r => { r.receipts[1].receipt.Action.actions[0].FunctionCall.deposit = '1'; },
    r => { r.receipts[1].receipt.Action.output_data_receivers[0].receiver_id = 'evil.testnet'; },
    r => { r.receipts[2].receipt.Action.input_data_ids = [hash(21)]; },
    r => { r.receipts[2].receipt.Action.input_data_ids = []; },
    r => { r.receipts[2].receipt.Action.actions[0].FunctionCall.args = encode({ sender_id: OWNER, receiver_id: 'evil.testnet', amount: MAX }); },
    r => { r.receipts[2].receipt.Action.actions[0].FunctionCall.deposit = '1'; },
    r => { r.receipts_outcome[0].outcome.logs = []; },
    r => { r.receipts_outcome[0].outcome.logs.push(r.receipts_outcome[0].outcome.logs[0]); },
    r => { r.receipts_outcome[1].outcome.logs = []; },
    r => { r.receipts_outcome[1].outcome.status.SuccessValue = encode('1'); },
    r => { r.receipts_outcome[1].outcome.status.SuccessValue = '!!!'; },
    r => { r.receipts_outcome[1].outcome.executor_id = 'evil.testnet'; },
    r => { r.receipts_outcome[2].outcome.status.SuccessValue = encode('0'); },
    r => { r.receipts_outcome[2].outcome.executor_id = 'evil.testnet'; },
    r => { r.status.SuccessValue = encode('0'); },
  ];
  for (const change of changes) {
    const r = structuredClone(f.result); change(r);
    assert.throws(() => inspect({ ...f, result: r }), undefined, String(change));
  }
});
