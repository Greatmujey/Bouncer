import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import { createResourceProvider } from '../services/resource-provider.mjs';
import { signClaimAuthorization } from '../packages/provider-sdk/index.mjs';
import { mockGuardedPayment, mockHash } from './mock-guarded-payment.mjs';

const contract = 'bouncer.testnet', owner = 'owner.testnet', origin = 'http://127.0.0.1:0';
const agent = nearApi.KeyPair.fromRandom('ed25519'), thief = nearApi.KeyPair.fromRandom('ed25519');
const products = Object.fromEntries(['compute', 'storage', 'api'].map(resource => [resource,
  { policy_id: resource, token: 'token.testnet', payee: 'seller.testnet', amount: '1000' }]));
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seller-v3-test-')), receipts = new Map(); let reads = 0;
  const provider = { async viewNodeStatus() { return { chain_id: 'testnet' }; }, async txStatusReceipts(hash) {
    reads++; return structuredClone(receipts.get(hash));
  } };
  const create = (sellerOrigin = origin) => createResourceProvider({ rpcProvider: provider, contractId: contract, ownerAccountId: owner,
    products, dataDir: dir, sellerOrigin });
  function payment(hash, quote, key = agent) {
    receipts.set(hash, mockGuardedPayment({ hash, owner, contract, publicKey: key.getPublicKey().toString(), args: {
      policy_id: quote.policy_id, payee: quote.payee, amount: quote.amount, memo: quote.memo, expected_token: quote.token } }));
  }
  async function authorization(hash, quote, key = agent, sellerOrigin = origin) {
    return signClaimAuthorization({ publicKey: key.getPublicKey(), signer: new nearApi.KeyPairSigner(key), terms: {
      network: 'near:testnet', contract_id: contract, owner_account_id: owner, seller_origin: sellerOrigin,
      resource: quote.resource, policy_id: quote.policy_id, token: quote.token, payee: quote.payee, amount: quote.amount,
      memo: quote.memo, tx_hash: hash } });
  }
  return { dir, provider, receipts, create, payment, authorization, get reads() { return reads; }, cleanup() { fs.rmSync(dir, { recursive: true, force: true }); } };
}
const issued = (provider, resource, input) => provider.quote({ resource, input, order_binding: 'seller-v3' });
const order = (hash, resource, input, quote, authorization) => ({ tx_hash: hash, resource, input, memo: quote.memo, authorization });

test('seller-v3 rejects public-proof theft, wrong transaction key, downgrade and cached-result theft across restart', async () => {
  const f = fixture(), p = f.create(), input = { text: 'owned request', rounds: 2 }, hash = mockHash('authenticated-claim'); let reopened;
  try {
    const quote = issued(p, 'compute', input); f.payment(hash, quote);
    assert.equal(quote.seller_origin, origin); assert.equal(quote.auth_scheme, 'bouncer-nep413-claim-v1');
    const valid = await f.authorization(hash, quote), forged = await f.authorization(hash, quote, thief);
    await assert.rejects(p.redeem({ tx_hash: hash, resource: 'compute', input, memo: quote.memo }), /invalid seller-bound redemption/);
    await assert.rejects(p.redeem(order(hash, 'compute', input, quote, { ...valid, signature: forged.signature })), /signature/);
    assert.equal(f.reads, 0);
    await assert.rejects(p.redeem(order(hash, 'compute', input, quote, forged)), /transaction signing key/);
    assert.equal(f.reads, 1);
    const status = JSON.parse(fs.readFileSync(path.join(f.dir, 'redemptions.json'), 'utf8'));
    assert.equal(Object.values(status.quotes)[0].tx_hash, null);
    const result = await p.redeem(order(hash, 'compute', input, quote, valid));
    assert.equal(result.type, 'compute');
    await assert.rejects(p.redeem(order(hash, 'compute', input, quote, forged)), /recorded transaction key/);
    await assert.rejects(p.redeem(order(hash, 'compute', { ...input, rounds: 3 }, quote, valid)), /exact order/);
    const stored = JSON.parse(fs.readFileSync(path.join(f.dir, 'redemptions.json'), 'utf8'));
    assert.equal(stored.version, 4); assert.equal(Object.values(stored.quotes)[0].agent_public_key, agent.getPublicKey().toString());
    assert.ok(!JSON.stringify(stored).includes(valid.signature)); // no off-chain bearer signature in the seller's state
    await p.close();
    assert.throws(() => f.create('https://different.example'), /invalid origin or signing key/);
    reopened = f.create();
    assert.deepEqual(await reopened.redeem(order(hash, 'compute', input, quote, valid)), result);
    await assert.rejects(reopened.redeem(order(hash, 'compute', input, quote, forged)), /recorded transaction key/);
  } finally { await p.close(); if (reopened) await reopened.close(); f.cleanup(); }
});

test('legacy, v2 and v3 claims coexist through the v4 migration without weakening v3', async () => {
  const f = fixture(), p = f.create(); let reopened;
  try {
    const input1 = { text: 'legacy', rounds: 1 }, q1 = p.quote({ resource: 'compute', input: input1 }), h1 = mockHash('mixed-v1');
    f.payment(h1, q1); const r1 = { resource: 'compute', input: input1, tx_hash: h1 };
    const input2 = { text: 'v2', rounds: 1 }, q2 = p.quote({ resource: 'compute', input: input2, order_binding: 'seller-v2' }), h2 = mockHash('mixed-v2');
    f.payment(h2, q2); const r2 = { resource: 'compute', input: input2, memo: q2.memo, tx_hash: h2 };
    const input3 = { text: 'v3', rounds: 1 }, q3 = issued(p, 'compute', input3), h3 = mockHash('mixed-v3');
    f.payment(h3, q3); const r3 = order(h3, 'compute', input3, q3, await f.authorization(h3, q3));
    const results = await Promise.all([p.redeem(r1), p.redeem(r2), p.redeem(r3)]);
    const state = JSON.parse(fs.readFileSync(path.join(f.dir, 'redemptions.json'), 'utf8'));
    assert.equal(state.version, 4); assert.equal(Object.keys(state.redemptions).length, 3); assert.equal(Object.keys(state.quotes).length, 2);
    await p.close(); reopened = f.create();
    assert.deepEqual(await reopened.redeem(r1), results[0]); assert.deepEqual(await reopened.redeem(r2), results[1]);
    assert.deepEqual(await reopened.redeem(r3), results[2]);
    const { authorization: _, ...unsigned } = r3;
    await assert.rejects(reopened.redeem(unsigned), /invalid seller-bound redemption/);
  } finally { await p.close(); if (reopened) await reopened.close(); f.cleanup(); }
});

test('v3 seller fails closed on corrupt persisted claim or changed configured origin', async () => {
  const f = fixture(), p = f.create();
  try {
    const input = { text: 'corrupt', rounds: 1 }, quote = issued(p, 'compute', input), txHash = mockHash('corrupt-claim');
    f.payment(txHash, quote);
    await p.redeem(order(txHash, 'compute', input, quote, await f.authorization(txHash, quote)));
    await p.close();
    const file = path.join(f.dir, 'redemptions.json'), original = fs.readFileSync(file, 'utf8'), state = JSON.parse(original);
    const challenge = Object.keys(state.quotes)[0]; state.quotes[challenge].agent_public_key = 'ed25519:malformed';
    fs.writeFileSync(file, JSON.stringify(state));
    assert.throws(() => f.create(), /state|store|invalid/i);
    fs.writeFileSync(file, original);
    assert.throws(() => f.create('https://different.example'), /seller|origin|state/i);
  } finally { await p.close(); f.cleanup(); }
});

test('a wrong-key in-flight request cannot join a legitimate claimant or steal its result', async () => {
  const f = fixture(), input = { text: 'race', rounds: 1 }, hash = mockHash('v3-wrong-key-race'); let release, started;
  const entered = new Promise(resolve => { started = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  const original = f.provider.txStatusReceipts;
  f.provider.txStatusReceipts = async (...args) => { started(); await blocked; return original(...args); };
  const p = f.create();
  try {
    const quote = issued(p, 'compute', input); f.payment(hash, quote);
    const valid = await f.authorization(hash, quote), forged = await f.authorization(hash, quote, thief);
    const attacker = p.redeem(order(hash, 'compute', input, quote, forged)); await entered;
    await assert.rejects(p.redeem(order(hash, 'compute', input, quote, valid)), /different order or claimant/);
    release(); await assert.rejects(attacker, /transaction signing key/);
    assert.equal((await p.redeem(order(hash, 'compute', input, quote, valid))).type, 'compute');
  } finally { release(); await p.close(); f.cleanup(); }
});

test('two correctly signed payments racing for one quote result in at most one fulfillment', async () => {
  const f = fixture(), input = { name: 'once', content: 'one object' }; let release, arrived = 0, started;
  const entered = new Promise(resolve => { started = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  const original = f.provider.txStatusReceipts;
  f.provider.txStatusReceipts = async (...args) => { if (++arrived === 2) started(); await blocked; return original(...args); };
  const p = f.create();
  try {
    const quote = issued(p, 'storage', input), a = mockHash('v3-race-a'), b = mockHash('v3-race-b');
    f.payment(a, quote); f.payment(b, quote);
    const claims = [order(a, 'storage', input, quote, await f.authorization(a, quote)), order(b, 'storage', input, quote, await f.authorization(b, quote))];
    const pending = claims.map(value => p.redeem(value)); await entered; release();
    const outcomes = await Promise.allSettled(pending);
    assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
    assert.match(outcomes.find(item => item.status === 'rejected').reason.message, /already claimed/);
    assert.equal(fs.readdirSync(path.join(f.dir, 'objects')).length, 1);
  } finally { release(); await p.close(); f.cleanup(); }
});

test('v3 storage readback requires the original claim; legacy public GET cannot bypass it', async () => {
  const f = fixture(), p = f.create(), input = { name: 'private', content: 'test content' }, hash = mockHash('v3-private-storage');
  try {
    await new Promise(resolve => p.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${p.server.address().port}`;
    const quote = issued(p, 'storage', input); f.payment(hash, quote);
    const auth = await f.authorization(hash, quote), result = await p.redeem(order(hash, 'storage', input, quote, auth));
    assert.equal((await fetch(`${base}/storage/${result.object_id}`)).status, 403);
    const read = body => fetch(`${base}/storage-read`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify(body) });
    assert.equal((await read({ tx_hash: hash, object_id: result.object_id, authorization: await f.authorization(hash, quote, thief) })).status, 400);
    assert.equal((await read({ tx_hash: mockHash('wrong'), object_id: result.object_id, authorization: auth })).status, 400);
    const response = await read({ tx_hash: hash, object_id: result.object_id, authorization: auth });
    assert.equal(response.status, 200); assert.equal(await response.text(), input.content);
  } finally { await p.close(); f.cleanup(); }
});
