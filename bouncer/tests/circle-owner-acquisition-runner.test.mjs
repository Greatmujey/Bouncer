import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { mockHash } from './mock-guarded-payment.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE, WRAP_TESTNET as WRAP, REF_TESTNET as REF } from '../scripts/circle-testnet-setup.mjs';
import { inspectCircleOwnerAcquisition, ACQUISITION_INPUT_YOCTO as INPUT } from '../agent/circle-owner-acquisition-readiness.mjs';
import { signOwnerAcquisition } from '../agent/circle-owner-acquisition.mjs';
import { verifyOwnerAcquisitionReceipt, broadcastOwnerAcquisitionOnce } from '../agent/circle-owner-acquisition-runner.mjs';

const NOW = Date.parse('2026-11-02T16:45:00Z'), BLOCK = mockHash('funding-block'), ROOT = mockHash('funding-root'),
  HOOK = mockHash('funding-hook'), OUTPUT = mockHash('funding-output');
const pair = nearApi.KeyPair.fromRandom('ed25519'), pub = String(pair.getPublicKey());
const plan = { version: 1, purpose: 'new-bouncer-testnet-owner', network: 'testnet',
  account_id: 'bouncer-owner-0123456789abcdef01234567.testnet', public_key: pub };
const storage = { total: '1250000000000000000000', available: '0' };
const code = account => mockHash(`test-code-${account}`);
function fake(kind, opts = {}) {
  let sent = 0, after = false, fenced = false, lookups = 0;
  const wrapAt = () => kind === 'wrap' ? (after ? INPUT : '0') : (after ? '0' : INPUT);
  const circleAt = () => kind === 'swap' && after ? (opts.wrongBalance ? '2' : '6500') : '0';
  const registered = () => kind === 'swap' || after;
  const nonce = () => (kind === 'wrap' ? 100 : 101) + (after ? 1 : opts.badNonce ? 1 : 0);
  return { kind, get sent() { return sent; }, get lookups() { return lookups; },
    get enforcesSetupBeforeSubmitGuard() { return true; },
    async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewBlock() { return { header: { hash: BLOCK, timestamp_nanosec: (BigInt(NOW) * 1_000_000n).toString() } }; },
    async query(q) {
      assert.equal(q.block_id, BLOCK);
      if (q.request_type === 'view_account') return { block_hash: BLOCK, code_hash: q.account_id === plan.account_id ?
        '11111111111111111111111111111111' : opts.badCode && q.account_id === WRAP ? mockHash('bad-code') : code(q.account_id),
        amount: '10000000000000000000000000', locked: '0' };
      const access = { nonce: nonce(), permission: 'FullAccess' };
      if (q.request_type === 'view_access_key_list') return { block_hash: BLOCK, keys: [{ public_key: pub, access_key: access }] };
      if (q.request_type === 'view_access_key') return { block_hash: BLOCK, ...access };
      throw Error('unexpected query');
    },
    async callFunctionRaw(contract, method, args) {
      let value;
      if (method === 'ft_metadata') value = contract === WRAP ? { symbol: 'wNEAR', decimals: 24 } : { symbol: 'USDC', decimals: 6 };
      else if (method === 'storage_balance_bounds') value = { min: storage.total, max: null };
      else if (method === 'storage_balance_of') value = contract === CIRCLE || args.account_id === REF || registered() ? storage : null;
      else if (method === 'ft_balance_of') value = contract === WRAP ? wrapAt() : circleAt();
      else if (method === 'get_pool') value = { pool_kind: 'SIMPLE_POOL', token_account_ids: [WRAP, CIRCLE], amounts: ['1', '1'] };
      else if (method === 'get_return') value = opts.badQuote && !after ? '1' : '6500';
      else throw Error('unexpected view');
      return { block_hash: BLOCK, result: [...Buffer.from(JSON.stringify(value))] };
    },
    async sendTransactionOnce(signed, wait, { beforeSubmit }) {
      assert.equal(wait, 'FINAL'); assert.equal(fenced, true); beforeSubmit(); sent++; after = true;
      if (opts.loseAck) throw Error('simulated lost acknowledgement');
      const digest = crypto.createHash('sha256').update(nearApi.transactions.encodeTransaction(signed.transaction)).digest();
      return { final_execution_status: 'FINAL', transaction_outcome: { id: nearApi.utils.serialize.base_encode(digest) } };
    },
    async txStatusReceipts() { lookups++; if (opts.noReceipt) throw Error('unavailable'); return receipt(this.envelope); },
    async persist(v) { assert.equal(sent, 0); assert.equal(v.tx_hash, this.envelope.tx_hash); fenced = true; return opts.fence !== false; },
  };
}
function receipt(e) {
  const signed = nearApi.transactions.SignedTransaction.decode(Buffer.from(e.signed_tx_base64, 'base64'));
  const calls = signed.transaction.actions.map(({ functionCall: c }) => ({ FunctionCall: { method_name: c.methodName,
    args: Buffer.from(c.args).toString('base64'), gas: c.gas.toString(), deposit: c.deposit.toString() } }));
  const receipts = [{ receipt_id: ROOT, predecessor_id: plan.account_id, receiver_id: WRAP,
    receipt: { Action: { signer_id: plan.account_id, signer_public_key: pub, actions: structuredClone(calls) } } }];
  const outcomes = [{ id: ROOT, outcome: { executor_id: WRAP, status: { SuccessValue: '' }, receipt_ids: e.kind === 'swap' ? [HOOK] : [] } }];
  if (e.kind === 'swap') {
    const outer = JSON.parse(Buffer.from(calls[0].FunctionCall.args, 'base64').toString('utf8'));
    receipts.push({ receipt_id: HOOK, predecessor_id: WRAP, receiver_id: REF, receipt: { Action: { actions: [{ FunctionCall: {
      method_name: 'ft_on_transfer', args: Buffer.from(JSON.stringify({ sender_id: plan.account_id, amount: INPUT, msg: outer.msg })).toString('base64'),
      gas: '150000000000000', deposit: '0' } }] } } });
    receipts.push({ receipt_id: OUTPUT, predecessor_id: REF, receiver_id: CIRCLE, receipt: { Action: { actions: [{ FunctionCall: {
      method_name: 'ft_transfer', args: Buffer.from(JSON.stringify({ receiver_id: plan.account_id, amount: '6500' })).toString('base64'),
      gas: '15000000000000', deposit: '1' } }] } } });
    const event = { standard: 'nep141', version: '1.0.0', event: 'ft_transfer',
      data: [{ old_owner_id: REF, new_owner_id: plan.account_id, amount: '6500' }] };
    outcomes.push({ id: HOOK, outcome: { executor_id: REF, status: { SuccessValue: Buffer.from('"0"').toString('base64') }, receipt_ids: [OUTPUT] } });
    outcomes.push({ id: OUTPUT, outcome: { executor_id: CIRCLE, status: { SuccessValue: '' }, logs: [`EVENT_JSON:${JSON.stringify(event)}`], receipt_ids: [] } });
  }
  return { final_execution_status: 'FINAL', status: { SuccessValue: '' },
    transaction: { hash: e.tx_hash, signer_id: plan.account_id, receiver_id: WRAP, public_key: pub, nonce: e.nonce, actions: calls },
    transaction_outcome: { id: e.tx_hash, outcome: { executor_id: plan.account_id, status: { SuccessReceiptId: ROOT }, receipt_ids: [ROOT] } },
    receipts, receipts_outcome: outcomes };
}
async function prepare(kind) {
  const p = fake(kind), s = await inspectCircleOwnerAcquisition({ plan, provider: p, now: () => NOW });
  return signOwnerAcquisition({ plan, snapshot: s, kind, keyPair: pair, nowMs: NOW });
}

test('wrap and swap original receipts pin every action and the linked Circle payout', async () => {
  for (const kind of ['wrap', 'swap']) {
    const e = await prepare(kind), r = receipt(e), p = verifyOwnerAcquisitionReceipt(r, e, plan);
    assert.equal(p.tx_hash, e.tx_hash); assert.equal(p.root_receipt_id, ROOT);
    assert.equal(p.circle_transfer?.amount_atoms ?? null, kind === 'swap' ? '6500' : null);
    for (const change of [x => { x.transaction.hash = mockHash('wrong'); },
      x => { x.transaction.actions[0].FunctionCall.deposit = '999'; },
      x => { x.receipts[0].receiver_id = 'attacker.testnet'; },
      x => { x.receipts_outcome[0].outcome.status = { Failure: {} }; }]) {
      const altered = structuredClone(r); change(altered); assert.throws(() => verifyOwnerAcquisitionReceipt(altered, e, plan));
    }
    if (kind === 'swap') {
      for (const change of [x => { x.receipts[2].predecessor_id = 'other.testnet'; },
        x => { x.receipts_outcome[0].outcome.receipt_ids = []; },
        x => { x.receipts[2].receipt.Action.actions[0].FunctionCall.args = Buffer.from('{"receiver_id":"other.testnet","amount":"6500"}').toString('base64'); },
        x => { x.receipts_outcome[2].outcome.status = { Failure: {} }; },
        x => { x.receipts_outcome[1].outcome.status = { SuccessValue: Buffer.from('"1"').toString('base64') }; },
        x => { x.receipts_outcome[2].outcome.logs = []; }]) {
        const altered = structuredClone(r); change(altered); assert.throws(() => verifyOwnerAcquisitionReceipt(altered, e, plan));
      }
    }
  }
});

test('wrap and swap each fence and send exactly once, verify original receipt, and recheck balances', async () => {
  for (const kind of ['wrap', 'swap']) {
    const envelope = await prepare(kind), p = fake(kind); p.envelope = envelope;
    const result = await broadcastOwnerAcquisitionOnce({ plan, envelope, provider: p, now: () => NOW, persistAttempt: record => p.persist(record) });
    assert.equal(p.sent, 1); assert.equal(p.lookups, 1); assert.equal(result.tx_hash, envelope.tx_hash);
    assert.equal(result.owner_wrap_balance_yocto, kind === 'wrap' ? INPUT : '0');
    assert.equal(result.owner_circle_balance_atoms, kind === 'swap' ? '6500' : '0');
    assert.equal(result.circle_funding_verified, kind === 'swap'); assert.equal(result.vault_deployed, false); assert.equal(result.do_not_resend, true);
  }
});

test('nonce, quote, code and fence drift stop before send; uncertain original transactions are never retried', async () => {
  const envelope = await prepare('wrap');
  for (const opts of [{ badNonce: true }, { badQuote: true }, { badCode: true }, { fence: false }]) {
    const p = fake('wrap', opts); p.envelope = envelope;
    await assert.rejects(broadcastOwnerAcquisitionOnce({ plan, envelope, provider: p, now: () => NOW, persistAttempt: x => p.persist(x) }));
    assert.equal(p.sent, 0);
  }
  for (const opts of [{ loseAck: true }, { noReceipt: true }, { wrongBalance: true }]) {
    const swap = opts.wrongBalance, e = swap ? await prepare('swap') : envelope, p = fake(swap ? 'swap' : 'wrap', opts); p.envelope = e;
    await assert.rejects(broadcastOwnerAcquisitionOnce({ plan, envelope: e, provider: p, now: () => NOW, persistAttempt: x => p.persist(x) }),
      /original .*never resend/); assert.equal(p.sent, 1);
  }
});
