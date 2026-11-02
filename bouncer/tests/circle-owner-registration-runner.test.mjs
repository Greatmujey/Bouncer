import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { mockHash } from './mock-guarded-payment.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { inspectCircleOwnerRegistration, signCircleOwnerRegistration } from '../agent/circle-owner-registration.mjs';
import { verifyCircleRegistrationReceipt, broadcastCircleOwnerRegistrationOnce } from '../agent/circle-owner-registration-runner.mjs';

const NOW = Date.parse('2026-11-02T16:15:00Z'), BLOCK = mockHash('registration-run-final'), CODE = mockHash('registration-run-code');
const ROOT = mockHash('registration-root'), CHILD = mockHash('registration-child');
const pair = nearApi.KeyPair.fromRandom('ed25519'), publicKey = String(pair.getPublicKey());
const plan = { version: 1, purpose: 'new-bouncer-testnet-owner', network: 'testnet',
  account_id: 'bouncer-owner-0123456789abcdef01234567.testnet', public_key: publicKey };
const deposit = '1250000000000000000000';
function provider(options = {}) {
  let sent = 0, lookup = 0, fenced = false, after = false;
  return { get sent() { return sent; }, get lookup() { return lookup; },
    get enforcesSetupBeforeSubmitGuard() { return true; },
    async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewBlock() { return { header: { hash: BLOCK, timestamp_nanosec: (BigInt(NOW) * 1_000_000n).toString() } }; },
    async query(q) {
      const nonce = after ? 101 : options.currentNonce ?? 100;
      if (q.request_type === 'view_account') return { block_hash: BLOCK,
        code_hash: q.account_id === TOKEN ? (options.otherCode ? mockHash('different-code') : CODE) : '11111111111111111111111111111111',
        amount: '10000000000000000000000000', locked: '0' };
      if (q.request_type === 'view_access_key_list') return { block_hash: BLOCK, keys: [{ public_key: publicKey,
        access_key: { nonce, permission: 'FullAccess' } }] };
      if (q.request_type === 'view_access_key') return { block_hash: BLOCK, nonce, permission: 'FullAccess' };
      throw new Error('not a view');
    },
    async callFunctionRaw(token, method, args, ref) {
      assert.equal(token, TOKEN); assert.deepEqual(ref, { blockId: BLOCK });
      const values = { storage_balance_bounds: { min: options.otherMin ? '2' : deposit, max: null },
        storage_balance_of: after || options.alreadyRegistered ? { total: deposit, available: '0' } : null,
        ft_metadata: { symbol: 'USDC', decimals: 6 }, ft_balance_of: '0' };
      return { block_hash: BLOCK, result: [...Buffer.from(JSON.stringify(values[method]))] };
    },
    async sendTransactionOnce(signed, wait, { beforeSubmit }) {
      assert.equal(wait, 'FINAL'); assert.equal(fenced, true); beforeSubmit(); sent++; after = true;
      if (options.loseAck) throw new Error('synthetic lost acknowledgement');
      const hash = nearApi.utils.serialize.base_encode(requireDigest(signed.transaction));
      return { final_execution_status: 'FINAL', transaction_outcome: { id: hash } };
    },
    async txStatusReceipts(hash, owner, wait) { lookup++; assert.equal(owner, plan.account_id); assert.equal(wait, 'FINAL');
      if (options.failLookup) throw new Error('unavailable');
      return receipt(this.envelope); },
    async persist(record) { assert.equal(sent, 0); assert.equal(record.tx_hash, this.envelope.tx_hash); fenced = true; return options.fence !== false; },
  };
}
import crypto from 'node:crypto';
function requireDigest(transaction) { return crypto.createHash('sha256').update(nearApi.transactions.encodeTransaction(transaction)).digest(); }
function receipt(e) {
  const call = { FunctionCall: { method_name: 'storage_deposit', args: Buffer.from(JSON.stringify({ account_id: plan.account_id,
    registration_only: true })).toString('base64'), gas: '50000000000000', deposit: e.deposit_yocto } };
  return { final_execution_status: 'FINAL', status: { SuccessValue: '' },
    transaction: { hash: e.tx_hash, signer_id: plan.account_id, receiver_id: TOKEN, public_key: publicKey, nonce: e.nonce, actions: [call] },
    transaction_outcome: { id: e.tx_hash, outcome: { executor_id: plan.account_id, status: { SuccessReceiptId: ROOT }, receipt_ids: [ROOT] } },
    receipts: [{ receipt_id: ROOT, predecessor_id: plan.account_id, receiver_id: TOKEN,
      receipt: { Action: { signer_id: plan.account_id, signer_public_key: publicKey, actions: [structuredClone(call)] } } }],
    receipts_outcome: [{ id: ROOT, outcome: { executor_id: TOKEN, status: { SuccessValue: Buffer.from(JSON.stringify({ total: deposit, available: '0' })).toString('base64') }, receipt_ids: [CHILD] } },
      { id: CHILD, outcome: { executor_id: plan.account_id, status: { SuccessValue: '' }, receipt_ids: [] } }] };
}
async function prepare() {
  const p = provider(), snapshot = await inspectCircleOwnerRegistration({ plan, provider: p, now: () => NOW });
  return signCircleOwnerRegistration({ plan, snapshot, keyPair: pair, nowMs: NOW });
}

test('original FINAL receipt must match the fixed registration and linked success graph', async () => {
  const e = await prepare(), r = receipt(e), proof = verifyCircleRegistrationReceipt(r, e, plan);
  assert.equal(proof.tx_hash, e.tx_hash); assert.equal(proof.root_receipt_id, ROOT); assert.equal(proof.linked_successful_outcomes, 2);
  for (const modify of [
    x => { x.transaction.hash = mockHash('different'); },
    x => { x.transaction.actions[0].FunctionCall.deposit = '1'; },
    x => { x.receipts[0].receipt.Action.signer_id = 'other.testnet'; },
    x => { x.receipts_outcome[0].outcome.status = { Failure: {} }; },
    x => { x.receipts_outcome[1].outcome.status = { Failure: {} }; },
    x => { x.receipts_outcome[0].outcome.receipt_ids = []; },
    x => { x.receipts_outcome[1].outcome.receipt_ids = [ROOT]; },
    x => { x.receipts_outcome[0].outcome.status.SuccessValue = Buffer.from('{}').toString('base64'); },
  ]) { const changed = structuredClone(r); modify(changed); assert.throws(() => verifyCircleRegistrationReceipt(changed, e, plan)); }
});

test('one original registration is fenced, sent once, receipt-checked, and re-viewed as registered', async () => {
  const envelope = await prepare(), p = provider(); p.envelope = envelope;
  const result = await broadcastCircleOwnerRegistrationOnce({ plan, envelope, provider: p, now: () => NOW,
    persistAttempt: record => p.persist(record) });
  assert.equal(p.sent, 1); assert.equal(p.lookup, 1); assert.equal(result.tx_hash, envelope.tx_hash);
  assert.equal(result.storage_registration, 'REGISTERED_AT_VIEW'); assert.equal(result.usdc_funding_verified, false);
  assert.equal(result.vault_deployed, false); assert.equal(result.do_not_resend, true);
});

test('drift and missing fence prevent any submission; uncertain send/receipt never cause an automatic retry', async () => {
  const envelope = await prepare();
  for (const opts of [{ currentNonce: 101 }, { otherCode: true }, { otherMin: true }, { alreadyRegistered: true }, { fence: false }]) {
    const p = provider(opts); p.envelope = envelope;
    await assert.rejects(broadcastCircleOwnerRegistrationOnce({ plan, envelope, provider: p, now: () => NOW,
      persistAttempt: record => p.persist(record) })); assert.equal(p.sent, 0);
  }
  for (const opts of [{ loseAck: true }, { failLookup: true }]) {
    const p = provider(opts); p.envelope = envelope;
    await assert.rejects(broadcastCircleOwnerRegistrationOnce({ plan, envelope, provider: p, now: () => NOW,
      persistAttempt: record => p.persist(record) }), /original Circle registration.*never resend/);
    assert.equal(p.sent, 1);
  }
});
