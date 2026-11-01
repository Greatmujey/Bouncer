import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import { FileJournal } from '../agent/procurement.mjs';
import { submitOwnerSetupOnce } from '../agent/testnet-owner-setup.mjs';

const owner = 'owner.fixture.testnet', contract = 'vault.fixture.testnet', token = 'wrap.testnet';
const gas = 200n * 10n ** 12n;

async function withFixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-setup-test-'));
  const file = path.join(dir, 'setup-journal.json'), pair = nearApi.KeyPair.fromRandom('ed25519');
  let journal = new FileJournal(file, contract, owner), sends = 0, preparations = 0, nonce = 1n;
  const account = { accountId: owner, signer: new nearApi.KeyPairSigner(pair), async createTransaction(receiver, actions, key) {
    preparations++;
    return nearApi.transactions.createTransaction(owner, key, receiver, nonce++, actions, Buffer.alloc(32, 5));
  } };
  const args = { receiver_id: 'ref.testnet', amount: '1000', msg: '{"min_out":"5"}' };
  const provider = { async viewNodeStatus() { return { chain_id: 'testnet' }; }, async sendTransactionUntil(signed, wait) {
    sends++;
    assert.equal(wait, 'FINAL');
    const hash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(
      nearApi.transactions.encodeTransaction(signed.transaction)).digest());
    assert.equal(journal.get('swap').status, 'pending');
    assert.equal(journal.get('swap').tx_hash, hash, 'the exact hash must be durable before send');
    return { transaction_outcome: { id: hash }, final_execution_status: 'FINAL', status: { SuccessValue: '' },
      receipts_outcome: [{ outcome: { status: { SuccessValue: '' } } }] };
  } };
  const fixture = { dir, file, pair, account, args, provider,
    get journal() { return journal; }, get sends() { return sends; }, get preparations() { return preparations; },
    reopen() { journal.close(); journal = new FileJournal(file, contract, owner); },
    submit(overrides = {}) { return submitOwnerSetupOnce({ id: 'swap', account, publicKey: pair.getPublicKey(),
      token, args, gas, provider, journal, ...overrides }); } };
  try { await fn(fixture); }
  finally { journal.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('owner setup writes the reviewed one-yocto hash before one send and cannot replay it', () => withFixture(async f => {
  const result = await f.submit();
  assert.equal(f.sends, 1); assert.equal(f.journal.get('swap').status, 'completed');
  assert.equal(f.journal.get('swap').tx_hash, result.transaction_outcome.id);
  const saved = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.equal(saved.entries[0].call.deposit, '1'); assert.equal(saved.entries[0].call.token, token);
  assert.equal(saved.entries[0].call.args.receiver_id, 'ref.testnet');
  assert.ok(!fs.readFileSync(f.file, 'utf8').includes(f.pair.toString()), 'private key is not written');
  f.reopen();
  await assert.rejects(f.submit(), /already recorded.*never submit again/);
  assert.equal(f.sends, 1);
}));

test('lost setup response leaves the original hash pending, and restart refuses a second send', () => withFixture(async f => {
  let sends = 0;
  const provider = { ...f.provider, async sendTransactionUntil() { sends++; throw new Error('injected lost response'); } };
  await assert.rejects(f.submit({ provider }), /setup transaction .*retain the journal.*never retry/);
  const first = f.journal.get('swap');
  assert.equal(first.status, 'pending'); assert.match(first.tx_hash, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  f.reopen();
  await assert.rejects(f.submit({ provider }), /already recorded.*reconcile/);
  assert.equal(sends, 1); assert.deepEqual(f.journal.get('swap'), first);
}));

test('wrong network, mismatched response and journal write failure never cause an automatic retry', () => withFixture(async f => {
  const wrongNetwork = { ...f.provider, async viewNodeStatus() { return { chain_id: 'mainnet' }; } };
  await assert.rejects(f.submit({ provider: wrongNetwork }), /must report testnet/);
  assert.equal(f.preparations, 0); assert.equal(f.sends, 0);
  const failedJournal = { data: f.journal.data, get() {}, put() { throw new Error('disk failure'); } };
  await assert.rejects(f.submit({ journal: failedJournal }), /disk failure/);
  assert.equal(f.sends, 0);
  let sends = 0;
  const badResponse = { ...f.provider, async sendTransactionUntil() {
    sends++; return { transaction_outcome: { id: 'wrong' }, final_execution_status: 'FINAL', status: { SuccessValue: '' }, receipts_outcome: [] };
  } };
  await assert.rejects(f.submit({ provider: badResponse }), /missing matching FINAL/);
  assert.equal(f.journal.get('swap').status, 'pending');
  await assert.rejects(f.submit({ provider: badResponse }), /already recorded/);
  assert.equal(sends, 1);
}));

test('owner setup rejects action substitution and non-testnet routes before broadcasting', () => withFixture(async f => {
  const account = { ...f.account, async createTransaction(receiver, actions, key) {
    actions[0].functionCall.deposit = 0n;
    return nearApi.transactions.createTransaction(owner, key, receiver, 1n, actions, Buffer.alloc(32, 5));
  } };
  await assert.rejects(f.submit({ account }), /prepared transaction does not match/);
  assert.equal(f.journal.get('swap'), undefined); assert.equal(f.sends, 0);
  for (const overrides of [{ token: 'wrap.near' }, { args: { ...f.args, receiver_id: 'other.near' } },
    { args: { ...f.args, amount: '01' } }, { gas: 301n * 10n ** 12n }]) {
    await assert.rejects(f.submit(overrides), /invalid owner testnet setup call/);
  }
  assert.equal(f.sends, 0);
}));

test('reviewed owner call snapshots its arguments before asynchronous work', () => withFixture(async f => {
  const provider = { ...f.provider, async viewNodeStatus() {
    f.args.receiver_id = 'attacker.testnet'; f.args.amount = '999999'; f.args.msg = 'changed';
    return { chain_id: 'testnet' };
  } };
  await f.submit({ provider });
  assert.deepEqual(f.journal.get('swap').call.args,
    { receiver_id: 'ref.testnet', amount: '1000', msg: '{"min_out":"5"}' });
}));

test('concurrent requests sharing one journal cannot submit the same setup id twice', () => withFixture(async f => {
  const results = await Promise.allSettled([f.submit(), f.submit()]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(f.sends, 1);
}));
