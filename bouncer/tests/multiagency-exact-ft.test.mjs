import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { prepareMultiAgencyExactFt, assertPreparedExactFt, assertMultiAgencyExactFtView, verifyMultiAgencyExactFtPayment } from '../agent/multiagency-exact-ft.mjs';
import { preflightExactFt } from '../agent/exact-ft-runtime.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { MULTIAGENCY_TREASURY as TREASURY } from '../agent/multiagency-readiness.mjs';
import { mockGuardedPayment, mockHash } from './mock-guarded-payment.mjs';

const nowMs = Date.parse('2026-11-01T15:00:00.000Z');
const goal = { version: 1, id: 'research', vault: 'vault.testnet', owner: 'owner.testnet', vault_code_hash: mockHash('v11-code'), policy_id: 'research',
  title: 'Independent research brief', brief: 'Produce a cited public report about safe autonomous agent purchasing.', amount: '3000000',
  accept_public_brief: true, accept_stalled_deposit_risk: true, accept_unsigned_quote_and_memo_risk: true };
const quote = { code: 'ma-0123456789', title: goal.title, status: 'awaiting_deposit', channel: 'wallet',
  expires_at: '2026-11-04T15:00:00.000Z', payment: { network: 'testnet', token: TOKEN, receiver: TREASURY, amount: goal.amount, memo: 'ma-0123456789' } };
const key = nearApi.KeyPair.fromRandom('ed25519').getPublicKey().toString();
const prepare = (options = {}) => prepareMultiAgencyExactFt({ goal, quote, agentPublicKey: key, nowMs, ...options });
const enc = x => Buffer.from(JSON.stringify(x)).toString('base64');

function fixture() {
  const prepared = prepare(), a = prepared.owner_call.args, txHash = mockHash('exact-payment');
  const view = { intent_id: a.intent_id, policy_id: a.policy_id, token: a.expected_token, payee: a.payee, amount: a.amount,
    memo: a.memo, review_hash: a.review_hash, expires_at_ms: a.expires_at_ms, agent_public_key: a.agent_public_key,
    policy_revision: 1, payee_revision: 2, agent_revision: 3, consumed: true, cancelled: false, active: false };
  const result = mockGuardedPayment({ hash: txHash, owner: goal.owner, contract: goal.vault, publicKey: key,
    args: { policy_id: a.policy_id, payee: a.payee, amount: a.amount, memo: a.memo, expected_token: a.expected_token } });
  const txBlock = mockHash('transaction-block'), executionBlock = mockHash('execution-block');
  result.transaction_outcome.block_hash = txBlock;
  result.receipts_outcome[0].block_hash = executionBlock;
  result.receipts_outcome[0].outcome.logs = ['BOUNCER exact FT intent consumed; transfer initiated'];
  result.receipts_outcome[1].outcome.logs = ['EVENT_JSON:' + JSON.stringify({ standard: 'nep141', version: '1.0.0', event: 'ft_transfer',
    data: [{ old_owner_id: goal.vault, new_owner_id: a.payee, amount: a.amount, memo: a.memo }] })];
  result.receipts_outcome[2].outcome.logs = ['BOUNCER exact FT transfer succeeded; intent stays consumed'];
  result.transaction.actions[0].FunctionCall.method_name = 'execute_exact_ft';
  result.transaction.actions[0].FunctionCall.args = enc({ intent_id: a.intent_id });
  const callback = result.receipts[1].receipt.Action.actions[0].FunctionCall;
  callback.method_name = 'after_exact_ft_transfer';
  callback.args = enc({ intent_id: a.intent_id, policy_id: a.policy_id, token: a.expected_token, amount: a.amount, bucket: 24, policy_revision: 1 });
  const vaultState = { block_hash: txBlock, code_hash: goal.vault_code_hash, keys: [],
    execution: { block_hash: executionBlock, code_hash: goal.vault_code_hash, keys: [] } };
  const intentState = { block_hash: executionBlock, view };
  return { prepared, goal, quote, publicKey: key, txHash, result, vaultState, intentState };
}

test('preparation binds the complete public goal, quote, key and cutoff without any signing or sending', () => {
  const result = prepare(), a = result.owner_call.args;
  assert.match(result.review_hash, /^[a-f0-9]{64}$/);
  assert.match(result.intent_id, /^ma-[a-f0-9]{60}$/);
  assert.equal(result.owner_call.attached_yocto, '1');
  assert.equal(result.agent_call.attached_yocto, '0');
  assert.deepEqual(result.agent_call.args, { intent_id: result.intent_id });
  assert.equal(a.expected_token, TOKEN); assert.equal(a.payee, TREASURY); assert.equal(a.memo, quote.code);
  assert.equal(a.amount, '3000000'); assert.equal(a.agent_public_key, key);
  assert.equal(a.expires_at_ms, String(Date.parse(quote.expires_at) - 5 * 60_000));
  assert.match(result.scope, /no owner signature.*payment or delivery/);
  const reorderedQuote = { payment: { memo: quote.payment.memo, amount: quote.payment.amount, receiver: TREASURY, token: TOKEN, network: 'testnet' },
    expires_at: quote.expires_at, channel: quote.channel, status: quote.status, title: quote.title, code: quote.code };
  assert.deepEqual(prepare({ quote: reorderedQuote }), result);
  assert.notEqual(prepare({ goal: { ...goal, brief: `${goal.brief} Add an appendix.` } }).review_hash, result.review_hash);
  assert.notEqual(prepare({ agentPublicKey: nearApi.KeyPair.fromRandom('ed25519').getPublicKey().toString() }).review_hash, result.review_hash);
});

test('invalid goal, unsigned-quote changes, key and a nearly expired quote fail before owner-call preparation', () => {
  assert.throws(() => prepare({ goal: { ...goal, accept_unsigned_quote_and_memo_risk: false } }), /invalid or unacknowledged/);
  assert.throws(() => prepare({ quote: { ...quote, payment: { ...quote.payment, amount: '3000001' } } }), /quote differs/);
  assert.throws(() => prepare({ agentPublicKey: 'ed25519:invalid' }), /public key/);
  assert.throws(() => prepare({ nowMs: Date.parse(quote.expires_at) - 5 * 60_000 }), /too close/);
  assert.doesNotThrow(() => prepare({ nowMs: Date.parse(quote.expires_at) + 1, allowExpired: true }));
});

test('shared verifier rejects malformed and non-Circle-testnet prepared intents even if their review hashes are recomputed', () => {
  assert.doesNotThrow(() => assertPreparedExactFt(prepare()));
  const changes = [
    p => { p.owner_call.args.expected_token = 'other.testnet'; },
    p => { p.owner_call.args.payee = 'seller.near'; },
    p => { p.owner_call.args.amount = ((1n << 128n)).toString(); },
    p => { p.owner_call.args.amount = '03'; },
    p => { p.owner_call.args.intent_id = ''; p.intent_id = ''; p.agent_call.args.intent_id = ''; },
    p => { p.owner_call.args.policy_id = 'bad policy'; p.review.goal.policy_id = 'bad policy'; },
    p => { p.owner_call.args.memo = 'bouncer:withdraw'; },
    p => { p.owner_call.args.memo = 'bad\nlog'; },
    p => { p.owner_call.args.expires_at_ms = '18446744073709551616'; p.review.expires_at_ms = p.owner_call.args.expires_at_ms; },
    p => { p.owner_call.args.agent_public_key = 'ed25519:invalid'; p.review.agent_public_key = 'ed25519:invalid'; },
    p => { p.owner_call.args.extra = 'unexpected'; },
  ];
  for (const change of changes) {
    const p = prepare(); change(p); p.review_hash = crypto.createHash('sha256').update(JSON.stringify(p.review)).digest('hex');
    p.owner_call.args.review_hash = p.review_hash; assert.throws(() => assertPreparedExactFt(p));
  }
});

test('MultiAgency review cannot describe different transfer terms, even after a self-consistent rehash', async () => {
  const changes = [
    p => { p.owner_call.args.payee = 'attacker.testnet'; },
    p => { p.owner_call.args.amount = '3000001'; },
    p => { p.owner_call.args.memo = 'ma-ffffffffff'; },
    p => { p.review.quote.payment.receiver = 'attacker.testnet'; },
    p => { p.review.quote.payment.amount = '3000001'; p.owner_call.args.amount = '3000001'; },
    p => { p.review.goal.accept_unsigned_quote_and_memo_risk = false; },
    p => { p.review.quote.extra = 'unreviewed'; },
    p => { p.review.expires_at_ms = '1900000000000'; p.owner_call.args.expires_at_ms = '1900000000000'; },
    p => { p.review.protocol = 'unknown'; },
  ];
  for (const change of changes) {
    const p = prepare(); change(p);
    // Give the modified public review a matching hash and derived ID. This
    // specifically tests the binding to calldata, not just hash integrity.
    p.review_hash = crypto.createHash('sha256').update(JSON.stringify(p.review)).digest('hex');
    p.intent_id = `ma-${p.review_hash.slice(0, 60)}`;
    p.owner_call.args.review_hash = p.review_hash; p.owner_call.args.intent_id = p.intent_id;
    p.agent_call.args.intent_id = p.intent_id;
    assert.throws(() => assertPreparedExactFt(p), /reviewed provider terms/);
    let rpcTouched = false;
    const provider = { async viewNodeStatus() { rpcTouched = true; throw Error('unexpected RPC'); } };
    await assert.rejects(preflightExactFt({ prepared: p, publicKey: key, provider }), /reviewed provider terms/);
    assert.equal(rpcTouched, false);
  }
  // A wholly consistent new review is not proof it was approved. The caller
  // must compare it with the retained original owner-controlled commitment.
  const original = prepare(), changed = prepare({ goal: { ...goal, brief: `${goal.brief} Add an appendix.` } });
  assert.doesNotThrow(() => assertPreparedExactFt(changed));
  assert.notEqual(changed.review_hash, original.review_hash);
});

test('the owner-pinned on-chain view must match every reviewed immutable field and authority revision', () => {
  const { prepared, intentState } = fixture(), active = { ...intentState.view, consumed: false, active: true };
  assert.deepEqual(assertMultiAgencyExactFtView(prepared, active), active);
  for (const [field, replacement] of Object.entries({ intent_id: 'other', policy_id: 'other', token: 'wrong.testnet',
    payee: 'wrong.testnet', amount: '3000001', memo: 'ma-deadbeef00', review_hash: 'b'.repeat(64), expires_at_ms: '1',
    agent_public_key: nearApi.KeyPair.fromRandom('ed25519').getPublicKey().toString(), policy_revision: 0, payee_revision: 0,
    agent_revision: 0, consumed: true, cancelled: true, active: false })) {
    assert.throws(() => assertMultiAgencyExactFtView(prepared, { ...active, [field]: replacement }), /differs/, field);
  }
  assert.throws(() => assertMultiAgencyExactFtView(prepared, { ...active, extra: true }), /differs/);
  assert.throws(() => assertMultiAgencyExactFtView(prepared, intentState.view), /differs/);
  assert.doesNotThrow(() => assertMultiAgencyExactFtView(prepared, intentState.view, { consumed: true }));
});

test('FINAL exact payment proof joins the signed intent, pinned vault, original transfer event and callback, not fulfillment', () => {
  const f = fixture(), result = verifyMultiAgencyExactFtPayment(f);
  assert.equal(result.tx_hash, f.txHash); assert.equal(result.intent_id, f.prepared.intent_id);
  assert.equal(result.amount, '3000000'); assert.match(result.scope, /delivery not established/);
});

test('any substituted payment term, historical vault, event or receipt graph fails closed', () => {
  const changes = [
    f => { f.result.final_execution_status = 'EXECUTED'; },
    f => { f.result.transaction.hash = mockHash('other'); },
    f => { f.result.transaction.public_key = nearApi.KeyPair.fromRandom('ed25519').getPublicKey().toString(); },
    f => { f.result.transaction.actions[0].FunctionCall.method_name = 'execute'; },
    f => { f.result.transaction.actions[0].FunctionCall.deposit = '1'; },
    f => { f.result.transaction.actions[0].FunctionCall.gas = '1'; },
    f => { f.result.transaction.actions[0].FunctionCall.args = enc({ intent_id: 'other' }); },
    f => { f.vaultState.code_hash = mockHash('malicious-code'); },
    f => { f.vaultState.execution.keys = [{ public_key: key }]; },
    f => { f.intentState.block_hash = mockHash('wrong-block'); },
    f => { f.intentState.view.memo = 'ma-ffffffffee'; },
    f => { f.intentState.view.consumed = false; },
    f => { f.result.receipts[0].receipt.Action.actions[0].FunctionCall.deposit = '0'; },
    f => { f.result.receipts[0].receipt.Action.actions[0].FunctionCall.args = enc({ receiver_id: TREASURY, amount: '1', memo: quote.code }); },
    f => { f.result.receipts_outcome[1].outcome.logs = []; },
    f => { f.result.receipts_outcome[1].outcome.logs.push(f.result.receipts_outcome[1].outcome.logs[0]); },
    f => { f.result.receipts_outcome[1].outcome.status = { Failure: {} }; },
    f => { f.result.receipts[1].receipt.Action.actions[0].FunctionCall.method_name = 'after_execute'; },
    f => { f.result.receipts_outcome[2].outcome.logs = []; },
    f => { f.result.receipts_outcome[0].outcome.receipt_ids = ['callback']; },
    f => { f.result.receipts_outcome[0].outcome.status = { SuccessValue: '' }; },
    f => { f.result.transaction_outcome.outcome.receipt_ids = []; },
    f => { f.result.receipts_outcome.push(structuredClone(f.result.receipts_outcome[1])); },
  ];
  for (const [i, change] of changes.entries()) {
    const f = fixture(); change(f);
    assert.throws(() => verifyMultiAgencyExactFtPayment(f), undefined, `mutation ${i} should fail`);
  }
});
