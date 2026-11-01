import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createResourceProvider, orderMemo } from '../services/resource-provider.mjs';
import { mockGuardedPayment, mockHash } from './mock-guarded-payment.mjs';

const contractId = 'bouncer.testnet', ownerId = 'owner.testnet';
const products = Object.fromEntries(['compute', 'storage', 'api'].map(resource => [resource,
  { policy_id: resource, token: 'wrap.testnet', payee: 'vendor.testnet', amount: '100' }]));
const storageInput = { name: 'durable', content: 'persist across restart' };
const computeInput = { text: 'hello', rounds: 3 };
const hash = mockHash('durability-storage');
const order = { tx_hash: hash, resource: 'storage', input: storageInput };
function options(dir, override = {}) {
  const rpcProvider = { async viewNodeStatus() { return { chain_id: 'testnet' }; }, async txStatusReceipts(txHash) {
    const input = txHash === hash ? storageInput : computeInput, resource = txHash === hash ? 'storage' : 'compute';
    return mockGuardedPayment({ hash: txHash, owner: ownerId, contract: contractId, args: {
      policy_id: resource, expected_token: products[resource].token, payee: products[resource].payee,
      amount: products[resource].amount, memo: orderMemo(resource, input) } });
  }, ...override };
  return { rpcProvider, contractId, ownerAccountId: ownerId, products, dataDir: dir };
}
const makeDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-provider-durable-'));
const moduleUrl = new URL('../services/resource-provider.mjs', import.meta.url).href;
const childCode = dir => `
  import { createResourceProvider } from ${JSON.stringify(moduleUrl)};
  const products = ${JSON.stringify(products)};
  const rpcProvider = { async viewNodeStatus(){ return {chain_id:'testnet'} }, async txStatusReceipts(){} };
  const p = createResourceProvider({rpcProvider, contractId:'bouncer.testnet', ownerAccountId:'owner.testnet', products, dataDir:${JSON.stringify(dir)}});
  console.log('READY');
  if (process.env.HOLD) setInterval(() => {}, 1000); else await p.close();`;

test('same directory is exclusive even across processes; graceful close releases it', async () => {
  const dir = makeDir(), p = createResourceProvider(options(dir));
  try {
    const blocked = spawnSync(process.execPath, ['--input-type=module', '-e', childCode(dir)], { encoding: 'utf8', timeout: 10000 });
    assert.notEqual(blocked.status, 0); assert.match(blocked.stderr, /data directory is locked/);
    await p.close();
    const ready = spawnSync(process.execPath, ['--input-type=module', '-e', childCode(dir)], { encoding: 'utf8', timeout: 10000 });
    assert.equal(ready.status, 0, ready.stderr); assert.match(ready.stdout, /READY/);
  } finally { await p.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a killed writer leaves a non-stealable stale lock, requiring explicit reconciliation', async () => {
  const dir = makeDir();
  const child = spawn(process.execPath, ['--input-type=module', '-e', childCode(dir)],
    { env: { ...process.env, HOLD: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const [data] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) });
    assert.match(data.toString(), /READY/);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    assert.throws(() => createResourceProvider(options(dir)), /locked.*stale lock/);
    // Test operator has observed the child exit. Production must also ensure
    // no other host/writer holds the store, and reconcile any pending entries.
    fs.unlinkSync(path.join(dir, 'provider.lock'));
    const recovered = createResourceProvider(options(dir)); await recovered.close();
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pending state, object and completion each sync file and directory in order', async () => {
  const dir = makeDir(), p = createResourceProvider(options(dir));
  const original = fs.fsyncSync, synced = [];
  try {
    fs.fsyncSync = fd => { synced.push(fs.fstatSync(fd).isDirectory() ? 'dir' : 'file'); return original(fd); };
    const result = await p.redeem(order);
    assert.deepEqual(synced, ['file', 'dir', 'file', 'dir', 'file', 'dir']);
    assert.equal(fs.readFileSync(path.join(dir, 'objects', result.object_id), 'utf8'), storageInput.content);
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'redemptions.json'), 'utf8'));
    assert.equal(state.version, 2); assert.equal(state.contract_id, contractId); assert.equal(state.owner_account_id, ownerId);
    assert.equal(state.redemptions[hash].status, 'completed');
  } finally { fs.fsyncSync = original; await p.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a failed pending directory sync stops before creating an object and leaves reconciliation state', async () => {
  const dir = makeDir(), p = createResourceProvider(options(dir)), original = fs.fsyncSync;
  try {
    let calls = 0;
    fs.fsyncSync = fd => { if (++calls === 2) throw new Error('injected directory sync failure'); return original(fd); };
    await assert.rejects(p.redeem(order), /state persistence failed.*reconcile/);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'objects')), []);
    await assert.rejects(p.redeem(order), /state persistence failed/);
  } finally { fs.fsyncSync = original; await p.close(); }
  try {
    const reopened = createResourceProvider(options(dir));
    await assert.rejects(reopened.redeem(order), /manual reconciliation/);
    await reopened.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an object sync failure poisons the provider and never redoes its pending work after restart', async () => {
  const dir = makeDir(), p = createResourceProvider(options(dir)), original = fs.fsyncSync;
  try {
    let calls = 0;
    fs.fsyncSync = fd => { if (++calls === 3) throw new Error('injected object sync failure'); return original(fd); };
    await assert.rejects(p.redeem(order), /object persistence failed.*reconcile/);
    await assert.rejects(p.redeem({ tx_hash: mockHash('another'), resource: 'compute', input: computeInput }), /state persistence failed/);
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'redemptions.json'), 'utf8'));
    assert.equal(state.redemptions[hash].status, 'pending');
  } finally { fs.fsyncSync = original; await p.close(); }
  try {
    const reopened = createResourceProvider(options(dir));
    await assert.rejects(reopened.redeem(order), /manual reconciliation/);
    await reopened.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a completion sync error never re-executes the paid side effect after restart', async () => {
  const dir = makeDir(), p = createResourceProvider(options(dir)), original = fs.fsyncSync;
  try {
    let calls = 0;
    // Pending and object are fully synced; completion rename occurs before its
    // directory sync fails. The instance must not return success or keep going.
    fs.fsyncSync = fd => { if (++calls === 6) throw new Error('injected completion sync failure'); return original(fd); };
    await assert.rejects(p.redeem(order), /state persistence failed.*reconcile/);
    await assert.rejects(p.redeem(order), /state persistence failed/);
  } finally { fs.fsyncSync = original; await p.close(); }
  try {
    const reopened = createResourceProvider(options(dir, { txStatusReceipts: async () => { throw new Error('must not reverify or redo'); } }));
    const result = await reopened.redeem(order);
    assert.equal(result.type, 'storage');
    assert.equal(fs.readFileSync(path.join(dir, 'objects', result.object_id), 'utf8'), storageInput.content);
    assert.equal(fs.readdirSync(path.join(dir, 'objects')).length, 1);
    await reopened.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('closing drains in-flight work before releasing the directory lock', async () => {
  const dir = makeDir(); let started, release;
  const entered = new Promise(resolve => { started = resolve; }), pause = new Promise(resolve => { release = resolve; });
  const config = options(dir), original = config.rpcProvider.txStatusReceipts;
  config.rpcProvider.txStatusReceipts = async (...args) => { started(); await pause; return original(...args); };
  const p = createResourceProvider(config);
  try {
    const work = p.redeem(order); await entered;
    let closed = false; const shutting = p.close().then(() => { closed = true; });
    await assert.rejects(p.redeem(order), /closing/);
    assert.throws(() => createResourceProvider(options(dir)), /locked/);
    assert.equal(closed, false);
    release(); assert.equal((await work).type, 'storage'); await shutting;
    const next = createResourceProvider(options(dir)); assert.equal((await next.redeem(order)).type, 'storage'); await next.close();
  } finally { release(); await p.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('changed lock and unbound/wrong-owner state fail closed; reviewed legacy state needs explicit adoption', async () => {
  const dir = makeDir(), p = createResourceProvider(options(dir));
  try {
    fs.unlinkSync(path.join(dir, 'provider.lock'));
    fs.writeFileSync(path.join(dir, 'provider.lock'), 'replacement');
    await assert.rejects(p.redeem(order), /state persistence failed/);
    await assert.rejects(p.close(), /lock disappeared or changed/);
    assert.equal(fs.readFileSync(path.join(dir, 'provider.lock'), 'utf8'), 'replacement');
    fs.unlinkSync(path.join(dir, 'provider.lock'));
    const pending = { status: 'pending', resource: 'storage', memo: orderMemo('storage', storageInput) };
    fs.writeFileSync(path.join(dir, 'redemptions.json'), JSON.stringify({ version: 1, redemptions: { [hash]: pending } }));
    assert.throws(() => createResourceProvider(options(dir)), /explicitly adopt/);
    const adopted = createResourceProvider({ ...options(dir), adoptLegacyState: true });
    await assert.rejects(adopted.redeem(order), /manual reconciliation/);
    await adopted.close();
    assert.throws(() => createResourceProvider({ ...options(dir), ownerAccountId: 'other.testnet' }), /different contract, owner or network/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
