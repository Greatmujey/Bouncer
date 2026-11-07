import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import { FileJournal, requestFingerprint, runProcurement, validatePlan } from '../agent/procurement.mjs';
import { recoverDirectPayment, recoverDirectResourcePayment } from '../agent/recover-direct-payment.mjs';
import { orderMemo } from '../services/resource-provider.mjs';
import { isTransactionHash, verifyDirectPayment } from '../shared/direct-payment-settlement.mjs';

const keyPair = nearApi.KeyPair.fromRandom('ed25519'), realSigner = new nearApi.KeyPairSigner(keyPair);
const key = keyPair.getPublicKey().toString();
const plan = validatePlan({ contract_id: 'bouncer.testnet', owner_account_id: 'owner.testnet', requests: [
  { id: 'compute-1', resource: 'compute', policy_id: 'compute', token: 'wrap.testnet', payee: 'vendor.testnet', amount: '100', memo: orderMemo('compute', { text: 'work', rounds: 2 }) },
] });
const request = plan.requests[0], enc = value => Buffer.from(JSON.stringify(value)).toString('base64');
const args = () => ({ policy_id: request.policy_id, payee: request.payee, amount: request.amount, memo: request.memo, expected_token: request.token });
const makeTransaction = actions => nearApi.transactions.createTransaction(plan.owner_account_id, keyPair.getPublicKey(), plan.contract_id,
  17n, actions, Buffer.alloc(32, 5));
const template = makeTransaction([nearApi.transactions.functionCall('execute', args(), 200000000000000n, 0n)]);
const bytes = crypto.createHash('sha256').update(nearApi.transactions.encodeTransaction(template)).digest();
const hash = nearApi.utils.serialize.base_encode(bytes);
const outcome = (id, executor_id, status, logs = [], receipt_ids = []) => ({ id, outcome: { executor_id, status, logs, receipt_ids } });
const receipt = (id, predecessor_id, receiver_id, method_name, value, deposit) => ({ receipt_id: id, predecessor_id, receiver_id,
  receipt: { Action: { actions: [{ FunctionCall: { method_name, args: enc(value), deposit } }] } } });
function finalResult() {
  return { final_execution_status: 'FINAL', status: { SuccessValue: '' },
    transaction_outcome: { id: hash, outcome: { receipt_ids: ['init'] } },
    transaction: { hash, signer_id: plan.owner_account_id, receiver_id: plan.contract_id, public_key: key,
      actions: [{ FunctionCall: { method_name: 'execute', deposit: '0', gas: '200000000000000', args: enc(args()) } }] },
    receipts_outcome: [outcome('init', plan.contract_id, { SuccessReceiptId: 'callback' }, ['BOUNCER payment initiated'], ['transfer', 'callback']),
      outcome('transfer', request.token, { SuccessValue: '' }), outcome('callback', plan.contract_id, { SuccessValue: '' })],
    receipts: [receipt('transfer', plan.contract_id, request.token, 'ft_transfer', { receiver_id: request.payee, amount: request.amount, memo: request.memo }, '1'),
      receipt('callback', plan.contract_id, plan.contract_id, 'after_execute', { policy_id: request.policy_id, token: request.token, amount: request.amount, bucket: 24 }, '0')],
  };
}
const verify = result => verifyDirectPayment({ result, contractId: plan.contract_id, ownerAccountId: plan.owner_account_id, request, publicKey: key, txHash: hash });
function fixture(journal) {
  let sends = 0, signs = 0, balance = 0n, lost = false, chain = finalResult();
  const records = new Map();
  journal ||= { get: id => records.get(id), put: (id, value) => records.set(id, structuredClone(value)) };
  const account = { accountId: plan.owner_account_id, signer: {
    async getPublicKey() { return key; },
    async signTransaction(tx) { signs++; assert.equal(tx.receiverId, plan.contract_id); return realSigner.signTransaction(tx); },
  }, async createTransaction(receiver, actions, publicKey) {
    assert.equal(publicKey, key); assert.equal(receiver, plan.contract_id); assert.equal(actions.length, 1);
    const a = actions[0].functionCall; assert.equal(a.methodName, 'execute'); assert.equal(a.gas, 200000000000000n); assert.equal(a.deposit, 0n);
    assert.deepEqual(JSON.parse(Buffer.from(a.args).toString()), args());
    return makeTransaction(actions);
  }, async callFunctionRaw() { throw new Error('legacy sender must not run'); } };
  const provider = {
    async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewAccessKey() { return { permission: { FunctionCall: { receiver_id: plan.contract_id, method_names: ['execute'] } } }; },
    async callFunction(_, method) {
      if (method === 'contract_version') return 'bouncer-agent-v7';
      if (method === 'get_policy') return { token: request.token };
      if (method === 'is_agent_key_allowed') return true;
      if (method === 'check') return [true, 'ok'];
      if (method === 'ft_balance_of') return balance.toString();
      throw new Error(`unexpected ${method}`);
    },
    async sendTransactionUntil(signed, wait) {
      sends++; assert.equal(signed.transaction.receiverId, plan.contract_id); assert.equal(wait, 'FINAL');
      const pending = journal.get(request.id); assert.equal(pending.status, 'pending'); assert.equal(pending.tx_hash, hash);
      assert.equal(pending.agent_public_key, key); assert.equal(pending.payment_version, 'direct-signed-v1');
      assert.equal(JSON.stringify(pending).includes('private_key'), false); balance += 100n;
      if (lost) throw new Error('lost RPC response after broadcast');
      return { transaction_outcome: { id: hash } };
    },
    async txStatusReceipts(txHash, signerId, wait) {
      assert.equal(txHash, hash); assert.equal(signerId, plan.owner_account_id); assert.equal(wait, 'FINAL'); return structuredClone(chain);
    },
  };
  return { account, provider, journal, setLost: value => { lost = value; }, setChain: value => { chain = value; },
    get sends() { return sends; }, get signs() { return signs; } };
}
const run = (f, extra = {}) => runProcurement({ plan, account: f.account, provider: f.provider, publicKey: key, journal: f.journal,
  execute: true, durablePayment: true, log: () => {}, ...extra });
const recover = (f, extra = {}) => recoverDirectPayment({ plan, requestId: request.id, provider: f.provider, journal: f.journal, log: () => {}, ...extra });

test('direct settlement binds the full signed request, actual transfer, callback and transaction graph', () => {
  assert.equal(isTransactionHash(hash), true);
  assert.deepEqual(verify(finalResult()), { tx_hash: hash, token: request.token, payee: request.payee, amount: request.amount,
    verification: 'FINAL trusted-RPC Bouncer and token receipts; provider delivery not established' });
  for (const bad of ['', '0'.repeat(44), '1'.repeat(31), 'z'.repeat(100), null]) assert.equal(isTransactionHash(bad), false);
});

test('direct settlement fails closed on tampered or incomplete transaction and receipt data', () => {
  const mutations = [
    x => { x.final_execution_status = 'EXECUTED_OPTIMISTIC'; },
    x => { x.status = { Failure: {} }; },
    x => { x.transaction_outcome.id = 'wrong'; },
    x => { x.transaction.hash = 'wrong'; },
    x => { x.transaction.signer_id = 'attacker.testnet'; },
    x => { x.transaction.receiver_id = 'other.testnet'; },
    x => { x.transaction.public_key = 'ed25519:other'; },
    x => { x.transaction.actions.push(x.transaction.actions[0]); },
    x => { x.transaction.actions[0].FunctionCall.method_name = 'set_policy'; },
    x => { x.transaction.actions[0].FunctionCall.deposit = '1'; },
    x => { x.transaction.actions[0].FunctionCall.gas = '1'; },
    x => { x.transaction.actions[0].FunctionCall.args = enc({ ...args(), payee: 'other.testnet' }); },
    x => { x.transaction.actions[0].FunctionCall.args = 'not*base64'; },
    x => { x.transaction_outcome.outcome.receipt_ids = ['other']; },
    x => { x.receipts_outcome[0].outcome.logs = []; },
    x => { x.receipts_outcome[0].outcome.receipt_ids = ['callback']; },
    x => { x.receipts[0].predecessor_id = 'attacker.testnet'; },
    x => { x.receipts[0].receiver_id = 'other.testnet'; },
    x => { x.receipts[0].receipt.Action.actions[0].FunctionCall.deposit = '0'; },
    x => { x.receipts[0].receipt.Action.actions[0].FunctionCall.args = enc({ receiver_id: 'other.testnet', amount: request.amount, memo: request.memo }); },
    x => { x.receipts_outcome[1].outcome.status = { Failure: 'failed token' }; },
    x => { x.receipts[1].receipt.Action.actions[0].FunctionCall.args = enc({ policy_id: request.policy_id, token: 'other.testnet', amount: request.amount, bucket: 24 }); },
    x => { x.receipts_outcome[2].outcome.status = { Failure: 'callback failed' }; },
    x => { x.receipts_outcome[2].id = 'other'; },
    x => { x.receipts.push(structuredClone(x.receipts[0])); },
    x => { delete x.receipts; },
  ];
  for (const mutate of mutations) { const result = finalResult(); mutate(result); assert.throws(() => verify(result)); }
});

test('a lost response leaves the signed hash before broadcast; key-free recovery prevents repayment', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-recovery-')), file = path.join(dir, 'journal.json');
  let journal = new FileJournal(file, plan.contract_id, plan.owner_account_id);
  try {
    const f = fixture(journal); f.setLost(true);
    await assert.rejects(run(f), /do not retry automatically.*lost RPC response/);
    assert.equal(f.sends, 1); assert.equal(f.signs, 1); assert.equal(journal.get(request.id).status, 'pending');
    assert.equal(journal.get(request.id).tx_hash, hash);
    journal.close(); journal = new FileJournal(file, plan.contract_id, plan.owner_account_id); f.journal = journal;
    // Recovery needs no account or signer and cannot initiate another transfer.
    const recovered = await recover(f); assert.equal(recovered.status, 'REUSED'); assert.equal(journal.get(request.id).status, 'completed');
    assert.equal((await run(f)).skipped, 1); assert.equal(f.sends, 1); assert.equal(f.signs, 1);
    assert.equal((await recover(f)).settlement.tx_hash, hash);
  } finally { journal.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('uncertain, failed, legacy and changed payments stay pending and are never resent', async () => {
  const f = fixture(); f.setLost(true); await assert.rejects(run(f), /do not retry automatically/);
  f.setChain({ ...finalResult(), final_execution_status: 'EXECUTED_OPTIMISTIC' });
  await assert.rejects(recover(f), /FINAL/); assert.equal(f.journal.get(request.id).status, 'pending');
  await assert.rejects(run(f), /unresolved pending/); assert.equal(f.sends, 1);
  f.setChain(finalResult());
  await assert.rejects(recover(f, { plan: { ...plan, requests: [{ ...request, amount: '99' }] } }), /does not match/);
  f.journal.put(request.id, { ...f.journal.get(request.id), payment_version: undefined });
  await assert.rejects(recover(f), /legacy or incomplete entries manually/);
  assert.equal(f.sends, 1);
});

test('dry runs, signer mismatches and journal write errors cannot broadcast', async () => {
  let f = fixture(); assert.equal((await run(f, { execute: false })).ready, 1); assert.equal(f.signs, 0); assert.equal(f.sends, 0);
  f = fixture(); f.account.signer.getPublicKey = async () => 'ed25519:other';
  await assert.rejects(run(f), /signer does not match/); assert.equal(f.sends, 0); assert.equal(f.journal.get(request.id), undefined);
  f = fixture({ get() {}, put() { throw new Error('disk full'); } });
  await assert.rejects(run(f), /disk full/); assert.equal(f.signs, 1); assert.equal(f.sends, 0);
});

test('a stale mission guard after signing leaves no journal entry or broadcast', async () => {
  const f = fixture();
  await assert.rejects(run(f, { beforePayment: async () => { throw new Error('price expired'); } }), /price expired/);
  assert.equal(f.signs, 1); assert.equal(f.sends, 0); assert.equal(f.journal.get(request.id), undefined);
  await run(f); assert.equal(f.sends, 1); assert.equal(f.journal.get(request.id).status, 'completed');
});

test('durable direct payments use the FINAL receipt graph, not a mutable seller balance', async () => {
  const f = fixture(), original = f.provider.callFunction; let balanceReads = 0;
  f.provider.callFunction = async (...args) => {
    if (args[1] === 'ft_balance_of') { balanceReads++; throw new Error('seller balance changed or was unavailable'); }
    return original(...args);
  };
  await run(f);
  assert.equal(balanceReads, 0); assert.equal(f.sends, 1);
  assert.equal(f.journal.get(request.id).status, 'completed');
  assert.equal(f.journal.get(request.id).settlement.tx_hash, hash);

  const bad = fixture(), prior = bad.provider.callFunction, chain = finalResult();
  chain.receipts[0].receipt.Action.actions[0].FunctionCall.args = enc({ receiver_id: 'other.testnet', amount: request.amount, memo: request.memo });
  bad.setChain(chain);
  bad.provider.callFunction = async (...args) => {
    if (args[1] === 'ft_balance_of') throw new Error('balance must not establish a payment');
    return prior(...args);
  };
  await assert.rejects(run(bad), /missing matching successful Bouncer-to-token transfer/);
  assert.equal(bad.sends, 1); assert.equal(bad.journal.get(request.id).status, 'pending');
  await assert.rejects(run(bad), /unresolved pending payment/); assert.equal(bad.sends, 1);
});

test('recovery refuses a changed stored request or settlement and can verify read-only', async () => {
  const f = fixture(); await run(f);
  const saved = f.journal.get(request.id);
  assert.equal(saved.fingerprint, requestFingerprint(request));
  assert.equal((await recover(f, { update: false })).status, 'REUSED'); assert.equal(f.sends, 1);
  f.journal.put(request.id, { ...saved, request: { ...saved.request, amount: '101' } });
  await assert.rejects(recover(f), /does not match/);
  f.journal.put(request.id, { ...saved, settlement: { ...saved.settlement, amount: '101' } });
  await assert.rejects(recover(f), /differs from chain/);
});

test('payment recovery holds the same journal lock and detects an externally changed original', async () => {
  const f=fixture();f.setLost(true);await assert.rejects(run(f),/lost RPC response/);assert.equal(f.sends,1);
  const entered=Promise.withResolvers(), release=Promise.withResolvers(), original=f.provider.txStatusReceipts;
  f.provider.txStatusReceipts=async(...args)=>{entered.resolve();await release.promise;return original(...args)};
  const first=recover(f), settled=first.then(value=>({value}),error=>({error}));await entered.promise;
  try {
    await assert.rejects(recover(f),/another payment operation is already running/);
    await assert.rejects(run(f),/another payment operation is already running/);
    const old=f.journal.get(request.id);f.journal.put(request.id,{...old,tx_hash:nearApi.utils.serialize.base_encode(Buffer.alloc(32,33))});
  }finally{release.resolve()}
  const result=await settled;assert.match(result.error?.message??'',/original payment changed during recovery/);
  assert.equal(f.sends,1);assert.notEqual(f.journal.get(request.id).tx_hash,hash);assert.equal(f.journal.get(request.id).status,'pending');
});

test('an async original-record read cannot be mistaken for a recoverable direct payment', async () => {
  const f=fixture({get:()=>Promise.reject(Error('late synthetic read failure')),put:()=>{throw Error('unexpected write')}});
  await assert.rejects(recover(f),/journal read must be synchronous/);assert.equal(f.sends,0);assert.equal(f.signs,0);
});
