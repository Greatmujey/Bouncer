// Offline tests only: real local seller, journal, signatures and buyer; mocked FINAL NEAR receipts.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import { FileJournal } from '../agent/procurement.mjs';
import { runResourceAgent, planFromQuotes, routedResourceProvider } from '../agent/resource-agent.mjs';
import { recoverResourceDelivery } from '../agent/recover-direct-payment.mjs';
import { createResourceProvider } from '../services/resource-provider.mjs';
import { orderMemoV2, orderMemoV3, verifyClaimAuthorization } from '../packages/provider-sdk/index.mjs';
import { mockGuardedPayment } from './mock-guarded-payment.mjs';

const owner = 'owner.testnet', contract = 'bouncer.testnet', token = 'token.testnet', payee = 'seller.testnet', origin = 'http://127.0.0.1:0';
const keyPair = nearApi.KeyPair.fromRandom('ed25519'), signer = new nearApi.KeyPairSigner(keyPair), publicKey = keyPair.getPublicKey();
const products = Object.fromEntries(['compute', 'storage', 'api'].map(name => [name, { policy_id: 'resources', token, payee, amount: '1000' }]));
const goals = [
  { id: 'compute', resource: 'compute', input: { text: 'compute work', rounds: 3 } },
  { id: 'storage', resource: 'storage', input: { name: 'file', content: 'protected contents' } },
  { id: 'api', resource: 'api', input: { text: 'some useful data' } },
].map(item => ({ ...item, policy_id: 'resources', token, payee, max_amount: '1000', order_binding: 'seller-v3' }));
function fixture({ encryptionKey, keyFile } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-v3-buyer-')), file = path.join(root, 'journal.json'), state = path.join(root, 'seller');
  const journalOptions = encryptionKey ? { encryptionKey, ...(keyFile ? { keyFile } : {}) } : {};
  let journal = new FileJournal(file, contract, owner, journalOptions), nonce = 0n, sends = 0, sellerBalance = 0n, lost = true; const chains = new Map();
  const account = { accountId: owner, signer, async createTransaction(receiver, actions, key) {
    return nearApi.transactions.createTransaction(owner, key, receiver, ++nonce, actions, Buffer.alloc(32, 4));
  } };
  const provider = { async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewAccessKey() { return { permission: { FunctionCall: { receiver_id: contract, method_names: ['execute'] } } }; },
    async callFunction(_, method) {
      if (method === 'contract_version') return 'bouncer-agent-v9';
      if (method === 'get_policy') return { token, per_tx_cap: '1000', daily_cap: '10000' };
      if (method === 'is_agent_key_allowed') return true;
      if (method === 'check') return [true, 'ok'];
      if (method === 'daily_spent') return String(sellerBalance);
      if (method === 'vault_balance') return String(10000n - sellerBalance);
      if (method === 'ft_balance_of') return String(sellerBalance);
      throw new Error(`unexpected ${method}`);
    },
    async sendTransactionUntil(signed) {
      sends++;
      const txHash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(nearApi.transactions.encodeTransaction(signed.transaction)).digest());
      const args = JSON.parse(Buffer.from(signed.transaction.actions[0].functionCall.args).toString()), entry = journal.list().find(e => e.tx_hash === txHash);
      assert.equal(entry.status, 'pending'); assert.ok(entry.resource_authorization); // persisted before broadcast
      const request = entry.request;
      verifyClaimAuthorization({ network: 'near:testnet', contract_id: contract, owner_account_id: owner, seller_origin: origin,
        resource: request.resource, policy_id: request.policy_id, token: request.token, payee: request.payee, amount: request.amount,
        memo: request.memo, tx_hash: txHash }, entry.resource_authorization, String(publicKey));
      chains.set(txHash, mockGuardedPayment({ hash: txHash, owner, contract, publicKey: String(publicKey), args }));
      sellerBalance += BigInt(args.amount);
      if (lost) { lost = false; throw new Error('synthetic response loss after payment'); }
      return { transaction_outcome: { id: txHash } };
    },
    async txStatusReceipts(hash) { if (!chains.has(hash)) throw new Error('unknown hash'); return structuredClone(chains.get(hash)); },
  };
  let server, client;
  async function startSeller() {
    server = createResourceProvider({ rpcProvider: provider, contractId: contract, ownerAccountId: owner, products, dataDir: state, sellerOrigin: origin });
    await new Promise(resolve => server.server.listen(0, '127.0.0.1', resolve));
    const actual = `http://127.0.0.1:${server.server.address().port}`;
    client = routedResourceProvider({ providerUrl: origin, goals, overrides: new Map([[origin, actual]]),
      fetchImpl: (url, options) => fetch(url, { ...options, headers: { ...options.headers, connection: 'close' } }) });
    return actual;
  }
  async function restart() { await server.close(); journal.close(); journal = new FileJournal(file, contract, owner, journalOptions); return startSeller(); }
  const run = (subset, extra = {}) => runResourceAgent({ contractId: contract, ownerAccountId: owner, goals: subset, providerUrl: origin,
    provider, account, publicKey, journal, ...client, execute: true, durablePayment: true, log: () => {}, ...extra });
  return { root, file, state, provider, account, startSeller, restart, run, get client() { return client; }, get journal() { return journal; },
    get sends() { return sends; }, async cleanup() { if (server) await server.close(); journal.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('authenticated compute, storage and API recover original signed claim after lost payment and seller restart', async () => {
  const f = fixture();
  try {
    await f.startSeller();
    await assert.rejects(f.run([goals[0]]), /synthetic response loss/);
    const pending = structuredClone(f.journal.get('compute'));
    assert.equal(f.sends, 1); assert.equal(pending.status, 'pending'); assert.ok(pending.resource_authorization.signature);
    assert.equal(fs.statSync(f.file).mode & 0o077, 0);
    assert.ok(!fs.readFileSync(f.file, 'utf8').includes(keyPair.toString()));
    await f.restart();
    const recovered = await recoverResourceDelivery({ goal: goals[0], contractId: contract, ownerAccountId: owner, providerUrl: origin,
      provider: f.provider, journal: f.journal, ...f.client, log: () => {} });
    assert.equal(recovered.receipt.tx_hash, pending.tx_hash); assert.equal(f.sends, 1);
    assert.equal(f.journal.get('compute').delivery.status, 'verified');
    const result = await f.run(goals.slice(1));
    assert.equal(result.payments.paid, 2); assert.deepEqual(result.deliveries.map(item => item.id), ['storage', 'api']);
    assert.equal(f.sends, 3);
    for (const goal of goals) {
      const item = f.journal.get(goal.id);
      assert.equal(item.status, 'completed'); assert.equal(item.delivery.status, 'verified');
      assert.ok(item.resource_authorization.signature); assert.match(item.request.memo, /^bouncer-order-v3:/);
    }
    const quoteState = JSON.parse(fs.readFileSync(path.join(f.state, 'redemptions.json'), 'utf8'));
    assert.equal(quoteState.version, 4); assert.equal(Object.keys(quoteState.quotes).length, 3);
    assert.equal(Object.values(quoteState.redemptions).filter(e => e.status === 'completed').length, 3);
  } finally { await f.cleanup(); }
});

test('encrypted v3 file journal preserves the original claim across lost response and signing-key-free recovery', async () => {
  const encryptionKey = crypto.randomBytes(32), f = fixture({ encryptionKey });
  try {
    await f.startSeller();
    await assert.rejects(f.run([goals[0]]), /synthetic response loss/);
    const pending = structuredClone(f.journal.get('compute'));
    assert.equal(f.sends, 1); assert.equal(pending.status, 'pending');
    const ciphertext = fs.readFileSync(f.file, 'utf8');
    assert.ok(!ciphertext.includes(pending.resource_authorization.signature));
    assert.ok(!ciphertext.includes(pending.tx_hash));
    await f.restart();
    const recovered = await recoverResourceDelivery({ goal: goals[0], contractId: contract, ownerAccountId: owner, providerUrl: origin,
      provider: f.provider, journal: f.journal, ...f.client, log: () => {} });
    assert.equal(recovered.receipt.tx_hash, pending.tx_hash); assert.equal(f.sends, 1);
    const result = await f.run(goals.slice(1));
    assert.equal(result.payments.paid, 2); assert.equal(f.sends, 3);
    for (const goal of goals) assert.equal(f.journal.get(goal.id).delivery.status, 'verified');
    assert.ok(!fs.readFileSync(f.file, 'utf8').includes(pending.resource_authorization.signature));
  } finally { await f.cleanup(); encryptionKey.fill(0); }
});

test('a changed configured encryption key stops a v3 payment before reservation and broadcast', async () => {
  const keyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-v3-key-')), keyFile = path.join(keyRoot, 'key');
  const encryptionKey = crypto.randomBytes(32); fs.writeFileSync(keyFile, encryptionKey, { mode: 0o600 });
  const f = fixture({ encryptionKey, keyFile });
  try {
    await f.startSeller();
    await assert.rejects(f.run([goals[0]], { beforePayment: async () => fs.writeFileSync(keyFile, crypto.randomBytes(32)) }), /key changed or is unreadable/);
    assert.equal(f.sends, 0); assert.equal(fs.existsSync(f.file), false);
    assert.throws(() => f.journal.get('compute'), /failed write/);
  } finally { await f.cleanup(); encryptionKey.fill(0); fs.rmSync(keyRoot, { recursive: true, force: true }); }
});

test('encrypted v3 journal directory-sync failure records a pending claim but blocks broadcast and repayment', async () => {
  const encryptionKey = crypto.randomBytes(32), f = fixture({ encryptionKey }), sync = fs.fsyncSync;
  try {
    await f.startSeller(); const root = fs.statSync(f.root); let injected = false;
    fs.fsyncSync = fd => {
      const stat = fs.fstatSync(fd);
      if (!injected && stat.isDirectory() && stat.dev === root.dev && stat.ino === root.ino) {
        injected = true; throw new Error('synthetic encrypted journal directory sync failure');
      }
      return sync(fd);
    };
    await assert.rejects(f.run([goals[0]]), /synthetic encrypted journal directory sync failure/);
    fs.fsyncSync = sync;
    assert.equal(injected, true); assert.equal(f.sends, 0); assert.throws(() => f.journal.get('compute'), /failed write/);
    const raw = fs.readFileSync(f.file, 'utf8'); assert.equal(JSON.parse(raw).format, 'bouncer-encrypted-file-journal-v1');
    await f.restart();
    const pending = f.journal.get('compute'); assert.equal(pending.status, 'pending');
    assert.ok(!raw.includes(pending.resource_authorization.signature)); assert.ok(!raw.includes(pending.tx_hash));
    await assert.rejects(f.run([goals[0]]), /unresolved pending/); assert.equal(f.sends, 0);
  } finally { fs.fsyncSync = sync; await f.cleanup(); encryptionKey.fill(0); }
});

test('tampered journal claim blocks key-free recovery before RPC or seller contact', async () => {
  const f = fixture();
  try {
    await f.startSeller();
    await assert.rejects(f.run([goals[0]]), /synthetic response loss/);
    const original = structuredClone(f.journal.get('compute'));
    f.journal.put('compute', { ...original, resource_authorization: { ...original.resource_authorization, signature: Buffer.alloc(64).toString('base64') } });
    let reads = 0, contacts = 0;
    const provider = new Proxy(f.provider, { get(target, prop) {
      if (prop === 'txStatusReceipts') return async (...args) => { reads++; return target.txStatusReceipts(...args); };
      return target[prop];
    } });
    await assert.rejects(recoverResourceDelivery({ goal: goals[0], contractId: contract, ownerAccountId: owner, providerUrl: origin,
      provider, journal: f.journal, fulfill: async () => { contacts++; }, log: () => {} }), /invalid authenticated claim signature/);
    assert.equal(reads, 0); assert.equal(contacts, 0); assert.equal(f.sends, 1);
  } finally { await f.cleanup(); }
});

test('claim signer substitution fails before journaling or sending a payment', async () => {
  const f = fixture();
  try {
    await f.startSeller();
    f.account.signer = { getPublicKey: () => signer.getPublicKey(), signTransaction: tx => signer.signTransaction(tx),
      signNep413Message: (_message, account, recipient, nonce) => signer.signNep413Message('substituted', account, recipient, nonce) };
    await assert.rejects(f.run([goals[0]]), /invalid authenticated claim signature/);
    assert.equal(f.sends, 0); assert.equal(f.journal.list().length, 0);
  } finally { await f.cleanup(); }
});

test('reviewable v3 example goals and seller config agree without contacting a service', async () => {
  const buyer = JSON.parse(fs.readFileSync(new URL('../examples/seller-v3-goals.example.json', import.meta.url), 'utf8'));
  const seller = JSON.parse(fs.readFileSync(new URL('../examples/seller-v3-provider.example.json', import.meta.url), 'utf8'));
  assert.equal(buyer.provider_url, seller.seller_origin); assert.equal(buyer.contract_id, seller.contract_id);
  assert.equal(buyer.owner_account_id, seller.owner_account_id); assert.equal(buyer.goals.length, 3);
  const plan = await planFromQuotes({ contractId: buyer.contract_id, ownerAccountId: buyer.owner_account_id,
    providerUrl: buyer.provider_url, goals: buyer.goals, getQuote: async order => ({ resource: order.resource, ...seller.products[order.resource],
      memo: orderMemoV3(order.resource, order.input, crypto.randomBytes(16).toString('hex')),
      auth_scheme: 'bouncer-nep413-claim-v1', seller_origin: seller.seller_origin }) });
  assert.equal(plan.requests.length, 3); assert.ok(buyer.goals.every(goal => goal.order_binding === 'seller-v3'));
});

test('seller-v3 quote cannot downgrade or substitute origin, task, scheme or owner limits', async () => {
  const goal = goals[0], challenge = '0'.repeat(32), quote = { resource: 'compute', ...products.compute,
    memo: orderMemoV3('compute', goal.input, challenge), auth_scheme: 'bouncer-nep413-claim-v1', seller_origin: origin };
  const plan = fn => planFromQuotes({ contractId: contract, ownerAccountId: owner, providerUrl: origin, goals: [goal], getQuote: fn });
  assert.equal((await plan(async () => quote)).requests[0].memo, quote.memo);
  for (const change of [{ seller_origin: 'https://evil.example' }, { auth_scheme: 'other' }, { payee: 'evil.testnet' },
    { amount: '1001' }, { memo: orderMemoV2('compute', goal.input, challenge) },
    { memo: orderMemoV3('compute', { ...goal.input, text: 'changed' }, challenge) }]) {
    await assert.rejects(plan(async () => ({ ...quote, ...change })));
  }
  await assert.rejects(planFromQuotes({ contractId: contract, ownerAccountId: owner, goals: [goal], getQuote: async () => quote }), /pinned seller origin/);
  await assert.rejects(runResourceAgent({ contractId: contract, ownerAccountId: owner, goals: [goal], providerUrl: origin,
    getQuote: async () => { throw new Error('must not quote'); }, fulfill: () => {}, journal: { get() {}, put() {} }, execute: true }), /durable signed-hash/);
});
