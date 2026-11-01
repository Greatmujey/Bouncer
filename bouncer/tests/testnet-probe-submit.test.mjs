import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { submitTestnetProbeSetupOnce, verifyTestnetProbeSetupResult } from '../agent/testnet-probe-submit.mjs';

const { KeyPair, KeyPairSigner, transactions, utils } = nearApi;
const owner = 'owner.fixture.testnet', vault = 'vault.fixture.testnet', receiver = 'token.fixture.testnet';
function fixture() {
  const pair = KeyPair.fromRandom('ed25519'), entries = new Map(), intents = [], receipts = [];
  let sends = 0, reads = 0;
  const journal = { data: { owner_account_id: owner, contract_id: vault }, get: id => entries.get(id),
    put(id, entry) { entries.set(id, structuredClone(entry)); } };
  const account = { accountId: owner, signer: new KeyPairSigner(pair), async createTransaction(target, actions, key) {
    return transactions.createTransaction(owner, key, target, 7n, actions, Buffer.alloc(32, 9));
  } };
  const provider = { async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async sendTransactionOnce(signed, finality) {
      sends++; assert.equal(finality, 'FINAL');
      const digest = crypto.createHash('sha256').update(transactions.encodeTransaction(signed.transaction)).digest();
      const hash = utils.serialize.base_encode(digest);
      assert.equal(journal.get('setup').status, 'pending'); assert.equal(journal.get('setup').tx_hash, hash);
      assert.equal(intents.length, 1); assert.equal(intents[0].tx_hash, hash);
      return { transaction_outcome: { id: hash } };
    },
    async txStatusReceipts(hash, signer, finality) {
      reads++; assert.equal(signer, owner); assert.equal(finality, 'FINAL');
      return { final_execution_status: 'FINAL', status: { SuccessValue: '' },
        transaction: { hash, signer_id: owner, receiver_id: receiver, public_key: pair.getPublicKey().toString(),
          signature: 'sensitive', nonce: 7, block_hash: 'sensitive' },
        transaction_outcome: { id: hash, outcome: { status: { SuccessReceiptId: 'receipt' } } },
        receipts_outcome: [{ outcome: { status: { SuccessValue: '' } } }] };
    } };
  const review = { action: 'storage registration', amount: '1' };
  const base = { id: 'setup', account, publicKey: pair.getPublicKey(), receiverId: receiver,
    actions: [transactions.functionCall('storage_deposit', {}, 10n ** 12n, 1n)], review, provider, journal,
    persistIntent(intent) { intents.push(structuredClone(intent)); }, saveReceipt(receipt) { receipts.push(structuredClone(receipt)); } };
  return { base, account, pair, provider, journal, intents, receipts, entries,
    get sends() { return sends; }, get reads() { return reads; } };
}

test('setup records the signed hash before one send, redacts the saved receipt and refuses replay', async () => {
  const f = fixture(), proof = await submitTestnetProbeSetupOnce(f.base);
  assert.equal(f.sends, 1); assert.equal(f.reads, 1); assert.equal(proof.tx_hash, f.intents[0].tx_hash);
  assert.equal(f.journal.get('setup').status, 'completed');
  assert.equal(f.receipts[0].transaction.signature, undefined); assert.equal(f.receipts[0].transaction.nonce, undefined);
  assert.equal(f.receipts[0].transaction.block_hash, undefined);
  await assert.rejects(submitTestnetProbeSetupOnce(f.base), /already exists.*never resend/);
  assert.equal(f.sends, 1);
});

test('a lost setup response is resolved only by the original hash without another broadcast', async () => {
  const f = fixture();
  let attempts = 0; f.provider.sendTransactionOnce = async () => { attempts++; throw new Error('lost'); };
  const proof = await submitTestnetProbeSetupOnce(f.base);
  assert.equal(attempts, 1); assert.equal(f.reads, 1); assert.equal(proof.tx_hash, f.journal.get('setup').tx_hash);
});

test('unavailable original hash stays pending and a rerun does not resend', async () => {
  const f = fixture(); let sends = 0;
  f.provider.sendTransactionOnce = async () => { sends++; throw new Error('lost'); };
  f.provider.txStatusReceipts = async () => { throw new Error('not found'); };
  await assert.rejects(submitTestnetProbeSetupOnce(f.base), /unresolved original hash .*without resending/);
  assert.equal(f.journal.get('setup').status, 'pending'); assert.equal(sends, 1);
  await assert.rejects(submitTestnetProbeSetupOnce(f.base), /already exists.*never resend/);
  assert.equal(sends, 1);
});

test('a failed journal or public intent write prevents a broadcast', async () => {
  for (const which of ['journal', 'intent']) {
    const f = fixture();
    if (which === 'journal') f.journal.put = () => { throw new Error('disk unavailable'); };
    else f.base.persistIntent = () => { throw new Error('intent unavailable'); };
    await assert.rejects(submitTestnetProbeSetupOnce(f.base), /unavailable/);
    assert.equal(f.sends, 0); assert.equal(f.reads, 0);
  }
});

test('setup rejects wrong network, failed or mismatched receipts and concurrent sends', async () => {
  const f = fixture();
  const wrong = { ...f.provider, async viewNodeStatus() { return { chain_id: 'mainnet' }; } };
  await assert.rejects(submitTestnetProbeSetupOnce({ ...f.base, provider: wrong }), /requires testnet/);
  assert.equal(f.sends, 0);
  let enter, release;
  const started = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const original = f.provider.viewNodeStatus;
  f.provider.viewNodeStatus = async () => { enter(); await gate; return original(); };
  const first = submitTestnetProbeSetupOnce(f.base); await started;
  await assert.rejects(submitTestnetProbeSetupOnce(f.base), /another payment operation.*journal/);
  release(); await first; assert.equal(f.sends, 1);
  const result = f.receipts[0], hash = f.intents[0].tx_hash;
  for (const mutate of [r => { r.transaction.signer_id = 'other.testnet'; }, r => { r.final_execution_status = 'EXECUTED'; },
    r => { r.receipts_outcome[0].outcome.status = { Failure: {} }; }, r => { r.transaction_outcome.id = 'wrong'; }]) {
    const changed = structuredClone(result); mutate(changed);
    assert.throws(() => verifyTestnetProbeSetupResult({ result: changed, txHash: hash, signerId: owner,
      receiverId: receiver, publicKey: f.pair.getPublicKey() }), /matching successful FINAL/);
  }
});

test('setup waits for a durable asynchronous intent before sending', async () => {
  const f = fixture(); let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const persist = f.base.persistIntent;
  f.base.persistIntent = async intent => { entered(); await gate; persist(intent); };
  const run = submitTestnetProbeSetupOnce(f.base); await started;
  assert.equal(f.sends, 0); assert.equal(f.journal.get('setup').status, 'pending');
  release(); await run; assert.equal(f.sends, 1);
});

test('a provider cannot mutate setup actions during the initial network check', async () => {
  const f = fixture(), action = f.base.actions[0];
  f.provider.viewNodeStatus = async () => { action.functionCall.deposit = 2n; return { chain_id: 'testnet' }; };
  await assert.rejects(submitTestnetProbeSetupOnce(f.base), /setup actions changed since review/);
  assert.equal(f.sends, 0); assert.equal(f.journal.get('setup'), undefined);
});
