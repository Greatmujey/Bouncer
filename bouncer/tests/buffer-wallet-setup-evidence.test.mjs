import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareBufferWalletSetupAttempt, verifyBufferWalletSetupReview,
  inspectBufferWalletSetupAttempt } from '../agent/buffer-wallet-setup-evidence.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { wasm, OWNER, VAULT, AMOUNT, KEY, OTHER_KEY, hash, encode, fixture } from './buffer-wallet-setup-fixture.mjs';

const artifactTest = (name, fn) => test(name, { skip: !wasm && 'reviewed V12 fixture not supplied' }, fn);
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
