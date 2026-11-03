import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { makeTollgateQuakesReview, tollgateQuakesReviewHash, CHANNEL_BUDGET_YOCTO, TOLLGATE_CHANNEL_CODE_HASH } from '../agent/tollgate-quakes-v13.mjs';
import { verifyTollgateSettlementReceipts, inspectTollgateSettlement } from '../agent/tollgate-settlement-verification.mjs';

const kp = () => nearApi.KeyPair.fromRandom('ed25519');
const pub = k => String(k.getPublicKey());
const hash = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n));
const enc = x => Buffer.from(JSON.stringify(x)).toString('base64');
function fixture() {
  const owner = kp(), agent = kp(), voucher = kp(), now = Date.now();
  const ownerPlan = { version: 1, purpose: 'new-bouncer-testnet-owner', network: 'testnet',
    account_id: 'bouncer-owner-aaaaaaaaaaaaaaaaaaaaaaaa.testnet', public_key: pub(owner) };
  const review = makeTollgateQuakesReview({ ownerPlan, intentId: 'one-quake', agentPublicKey: pub(agent),
    voucherPublicKey: pub(voucher), expiresAtMs: String(now + 120_000) });
  const txHash = hash(1), rootId = hash(2), transferId = hash(3), callBlock = hash(4), transferBlock = hash(5);
  const deposit = (BigInt(CHANNEL_BUDGET_YOCTO) - 100n).toString(), price = review.price_yocto;
  const purchase = { network: 'testnet', owner: review.owner, vault: review.vault, review_hash: tollgateQuakesReviewHash(review),
    intent_id: review.intent_id, fenced: true, channel_id: '7', price_yocto: price, channel_budget_yocto: CHANNEL_BUDGET_YOCTO,
    channel_deposit_yocto: deposit, channel_storage_fee_yocto: '100', snapshot_block_hash: hash(9) };
  const message = Buffer.from(`tollgate:v1:${review.channel_contract}:7:${price}:1`);
  const signature = Buffer.from(voucher.sign(message).signature).toString('base64');
  const args = { channel_id: '7', cumulative_amount: price, nonce: '1', signature };
  const call = { FunctionCall: { method_name: 'settle', args: enc(args), gas: 100_000_000_000_000, deposit: '0' } };
  const event = { standard: 'tollgate', version: '1.0.0', event: 'channel_settled', data: [{ channel_id: '7',
    seller: review.seller, paid: price, cumulative: price, nonce: '1', remaining: (BigInt(deposit) - BigInt(price)).toString() }] };
  const result = { final_execution_status: 'FINAL', status: { SuccessValue: enc(price) },
    transaction: { hash: txHash, signer_id: review.seller, receiver_id: review.channel_contract, actions: [structuredClone(call)] },
    transaction_outcome: { id: txHash, outcome: { executor_id: review.seller, receipt_ids: [rootId], status: { SuccessReceiptId: rootId } } },
    receipts: [
      { receipt_id: rootId, predecessor_id: review.seller, receiver_id: review.channel_contract, receipt: { Action: { actions: [structuredClone(call)] } } },
      { receipt_id: transferId, predecessor_id: review.channel_contract, receiver_id: review.seller, receipt: { Action: { actions: [{ Transfer: { deposit: price } }] } } }
    ],
    receipts_outcome: [
      { id: rootId, block_hash: callBlock, outcome: { executor_id: review.channel_contract, receipt_ids: [transferId],
        logs: [`EVENT_JSON:${JSON.stringify(event)}`], status: { SuccessValue: enc(price) } } },
      { id: transferId, block_hash: transferBlock, outcome: { executor_id: review.seller, receipt_ids: [], logs: [], status: { SuccessValue: '' } } }
    ] };
  return { review, purchase, txHash, result, callBlock, rootId, transferId, args, signature, event };
}
const verify = f => verifyTollgateSettlementReceipts(f);

test('verifies the seller transaction, exact voucher, event and linked detached payout without exposing signature', () => {
  const f = fixture(), proof = verify(f);
  assert.equal(proof.tx_hash, f.txHash); assert.equal(proof.channel_id, '7');
  assert.equal(proof.amount_yocto, f.review.price_yocto); assert.equal(proof.payout_receipt_id, f.transferId);
  assert(!JSON.stringify(proof).includes(f.signature)); assert(!JSON.stringify(proof).includes('signature'));
  assert.match(proof.scope, /caller-supplied/);
});

test('rejects optimistic execution, forged identity, wrong voucher and unlinked action', () => {
  const cases = [
    f => { f.result.final_execution_status = 'EXECUTED_OPTIMISTIC'; },
    f => { f.result.transaction.signer_id = f.review.owner; },
    f => { f.result.transaction.receiver_id = f.review.vault; },
    f => { f.result.transaction.hash = hash(8); },
    f => { f.result.transaction.actions[0].FunctionCall.method_name = 'cooperative_close'; },
    f => { f.result.transaction.actions[0].FunctionCall.deposit = '1'; },
    f => { const a = { ...f.args, nonce: '2' }; f.result.transaction.actions[0].FunctionCall.args = enc(a); },
    f => { const a = { ...f.args, cumulative_amount: '1' }; f.result.transaction.actions[0].FunctionCall.args = enc(a); },
    f => { const a = { ...f.args, signature: Buffer.alloc(64).toString('base64') }; f.result.transaction.actions[0].FunctionCall.args = enc(a); },
    f => { f.result.transaction_outcome.outcome.receipt_ids = [hash(8)]; },
    f => { f.result.receipts[0].receipt.Action.actions[0].FunctionCall.gas = 123; },
    f => { f.purchase.channel_deposit_yocto = '1'; },
    f => { f.purchase.fenced = false; },
  ];
  for (const mutate of cases) { const f = fixture(); mutate(f); assert.throws(() => verify(f)); }
});

test('rejects wrong events, borrowed or failed detached transfer and duplicate receipt IDs', () => {
  const cases = [
    f => { f.event.data[0].seller = f.review.owner; f.result.receipts_outcome[0].outcome.logs = [`EVENT_JSON:${JSON.stringify(f.event)}`]; },
    f => { f.event.data[0].remaining = '0'; f.result.receipts_outcome[0].outcome.logs = [`EVENT_JSON:${JSON.stringify(f.event)}`]; },
    f => { f.result.receipts_outcome[0].outcome.receipt_ids = [hash(8)]; },
    f => { f.result.receipts[1].receipt.Action.actions[0].Transfer.deposit = '1'; },
    f => { f.result.receipts[1].predecessor_id = f.review.owner; },
    f => { f.result.receipts_outcome[1].outcome.status = { Failure: { ActionError: {} } }; },
    f => { f.result.receipts_outcome.pop(); },
    f => { f.result.receipts.push(structuredClone(f.result.receipts[1])); },
    f => { f.result.receipts_outcome[0].outcome.logs.push(f.result.receipts_outcome[0].outcome.logs[0]); },
  ];
  for (const mutate of cases) { const f = fixture(); mutate(f); assert.throws(() => verify(f)); }
});

test('RPC verifier requires testnet, FINAL, reviewed signer and pinned code at the settlement block', async () => {
  const f = fixture(); let query;
  const provider = { async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async txStatusReceipts(h, signer, until) { assert.equal(h, f.txHash); assert.equal(signer, f.review.seller); assert.equal(until, 'FINAL'); return f.result; },
    async query(q) { query = q; return { block_hash: f.callBlock, code_hash: TOLLGATE_CHANNEL_CODE_HASH }; } };
  const proof = await inspectTollgateSettlement({ ...f, provider });
  assert.equal(proof.settlement_verified, true); assert.equal(proof.paid_response_delivery_verified, false);
  assert.deepEqual(query, { request_type: 'view_account', account_id: f.review.channel_contract, block_id: f.callBlock });
  assert(!JSON.stringify(proof).includes(f.signature));
  await assert.rejects(inspectTollgateSettlement({ ...f, provider: { ...provider, viewNodeStatus: async () => ({ chain_id: 'mainnet' }) } }), /testnet/);
  await assert.rejects(inspectTollgateSettlement({ ...f, provider: { ...provider, query: async () => ({ block_hash: f.callBlock, code_hash: hash(6) }) } }), /code/);
  await assert.rejects(inspectTollgateSettlement({ ...f, provider: { ...provider, query: async () => ({ block_hash: hash(6), code_hash: TOLLGATE_CHANNEL_CODE_HASH }) } }), /code/);
});

function cooperativeFixture() {
  const f = fixture(), remaining = (BigInt(f.purchase.channel_deposit_yocto) - BigInt(f.review.price_yocto)).toString();
  const call = f.result.transaction.actions[0].FunctionCall;
  call.method_name = 'cooperative_close'; f.result.receipts[0].receipt.Action.actions[0].FunctionCall.method_name = 'cooperative_close';
  f.result.status.SuccessValue = enc(remaining); f.result.receipts_outcome[0].outcome.status.SuccessValue = enc(remaining);
  const close = { standard: 'tollgate', version: '1.0.0', event: 'channel_closed', data: [{ channel_id: '7',
    how: 'cooperative', settled: f.review.price_yocto, refunded: remaining, owner: f.review.vault }] };
  f.result.receipts_outcome[0].outcome.logs.push(`EVENT_JSON:${JSON.stringify(close)}`);
  const refundId = hash(10), refundBlock = hash(11);
  f.result.receipts_outcome[0].outcome.receipt_ids.push(refundId);
  f.result.receipts.push({ receipt_id: refundId, predecessor_id: f.review.channel_contract, receiver_id: f.review.vault,
    receipt: { Action: { actions: [{ Transfer: { deposit: remaining } }] } } });
  f.result.receipts_outcome.push({ id: refundId, block_hash: refundBlock, outcome: { executor_id: f.review.vault,
    receipt_ids: [], logs: [], status: { SuccessValue: '' } } });
  return { ...f, close, refundId, remaining };
}

test('cooperative settlement verifies seller payout and separately linked refund without crediting the rolling budget', () => {
  const f = cooperativeFixture(), proof = verify(f);
  assert.equal(proof.method, 'cooperative_close'); assert.equal(proof.detached_refund_verified, true);
  assert.equal(proof.refund_amount_yocto, f.remaining); assert.equal(proof.refund_receipt_id, f.refundId);
  assert.equal(proof.rolling_budget_refund_verified, false); assert(!JSON.stringify(proof).includes(f.signature));
});

test('a failed or borrowed detached refund never becomes a verified refund; a missing voucher cannot be a paid settlement', () => {
  for (const mutate of [
    f => { f.result.receipts_outcome[2].outcome.status = { Failure: { ActionError: {} } }; },
    f => { f.result.receipts_outcome[0].outcome.receipt_ids = [f.transferId]; },
    f => { f.result.receipts[2].receiver_id = f.review.owner; },
    f => { f.result.receipts[2].receipt.Action.actions[0].Transfer.deposit = '1'; },
    f => { f.result.receipts_outcome.pop(); },
  ]) {
    const f = cooperativeFixture(); mutate(f); const proof = verify(f);
    assert.equal(proof.detached_refund_verified, false); assert.equal(proof.refund_receipt_id, null);
    assert.equal(proof.payout_receipt_id, f.transferId);
  }
  const noVoucher = cooperativeFixture();
  noVoucher.result.transaction.actions[0].FunctionCall.args = enc({ channel_id: '7', cumulative_amount: null, nonce: null, signature: null });
  assert.throws(() => verify(noVoucher));
  const wrongOwner = cooperativeFixture(); wrongOwner.close.data[0].owner = wrongOwner.review.owner;
  wrongOwner.result.receipts_outcome[0].outcome.logs[1] = `EVENT_JSON:${JSON.stringify(wrongOwner.close)}`;
  assert.throws(() => verify(wrongOwner), /cooperative-close event/);
});
