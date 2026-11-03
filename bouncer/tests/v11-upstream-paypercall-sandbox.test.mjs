import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import wabt from 'wabt';
import { validateUpstreamFixture, exerciseUpstreamPayPerCall, waitForPatchedFaultKey } from '../integration/v11-paypercall-upstream-sandbox.mjs';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const exports = ['new', 'register_service', 'storage_deposit', 'storage_withdraw', 'get_storage_credit',
  'ft_on_transfer', 'fulfill', 'reject', 'claim', 'get_call', 'get_owed'];
async function moduleWith(names) {
  const compiler = await wabt();
  const compiled = compiler.parseWat('fixture.wat', `(module ${names.map(n => `(func (export "${n}"))`).join(' ')})`);
  try { return Buffer.from(compiled.toBinary({}).buffer); } finally { compiled.destroy(); }
}

test('upstream fixture gate verifies bytes, WASM and expected method names, but not provenance', async () => {
  const bytes = await moduleWith(exports), digest = sha(bytes);
  assert.deepEqual(validateUpstreamFixture(bytes, digest), { sha256: digest, bytes: bytes.length });
  assert.throws(() => validateUpstreamFixture(bytes, '0'.repeat(64)), /invalid source-built/);
  assert.throws(() => validateUpstreamFixture(bytes, 'NOT-A-HASH'), /invalid source-built/);
  assert.throws(() => validateUpstreamFixture(Buffer.from('not wasm'), sha(Buffer.from('not wasm'))), /invalid source-built/);
  const missing = await moduleWith(exports.filter(n => n !== 'claim'));
  assert.throws(() => validateUpstreamFixture(missing, sha(missing)), /missing expected methods/);
  const invalid = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 1, 1]);
  assert.throws(() => validateUpstreamFixture(invalid, sha(invalid)), /invalid source-built/);
  const tooLarge = Buffer.alloc(4 * 1024 * 1024 + 1);
  assert.throws(() => validateUpstreamFixture(tooLarge, sha(tooLarge)), /invalid source-built/);
});

test('source-built escrow harness refuses non-loopback URLs and mismatched local identities before signing', async () => {
  await assert.rejects(exerciseUpstreamPayPerCall({ rpcUrl: 'https://rpc.testnet.near.org', root: {}, tokenOwner: {} }), /loopback|sandbox/i);
  await assert.rejects(exerciseUpstreamPayPerCall({ rpcUrl: 'http://127.0.0.1:3030', root: {}, tokenOwner: {} }), /isolated sandbox/);
  const fake = id => ({ accountId: id, provider: { connection: { url: 'http://127.0.0.1:3030' } } });
  await assert.rejects(exerciseUpstreamPayPerCall({ rpcUrl: 'http://127.0.0.1:3030', root: fake('testnet'),
    tokenOwner: fake('owner.testnet'), wasm: Buffer.alloc(536325), escrowWasm: Buffer.alloc(8),
    escrowSha256: '0'.repeat(64), storageMin: '1' }), /pinned V11/);
});

test('artificial sandbox fault key must reach FINAL with the exact key and full-access permission', async () => {
  const item = { public_key: 'ed25519:fixed-test', access_key: { permission: 'FullAccess' } };
  let reads = 0, pauses = 0;
  const provider = { async viewAccessKeyList(id, final) {
    assert.equal(id, 'bridge.upstream-buyer.testnet'); assert.deepEqual(final, { finality: 'final' });
    return { keys: ++reads < 3 ? [] : [item] };
  } };
  await waitForPatchedFaultKey(provider, item.public_key, { pause: async ms => { assert.equal(ms, 500); pauses++; } });
  assert.equal(reads, 3); assert.equal(pauses, 2);
  const fixed = keys => ({ viewAccessKeyList: async () => ({ keys }) });
  await assert.rejects(waitForPatchedFaultKey(fixed([{ ...item, public_key: 'wrong' }]), item.public_key), /unexpected isolated fault key/);
  await assert.rejects(waitForPatchedFaultKey(fixed([{ ...item, access_key: { permission: 'FunctionCall' } }]), item.public_key), /unexpected isolated fault key/);
  await assert.rejects(waitForPatchedFaultKey(fixed([item, item]), item.public_key), /unexpected isolated fault-key list/);
  await assert.rejects(waitForPatchedFaultKey(fixed([]), item.public_key, { maxViews: 2, pause: async () => {} }), /did not reach FINAL/);
  await assert.rejects(waitForPatchedFaultKey(fixed([]), item.public_key, { maxViews: 41 }), /invalid isolated fault-key wait/);
});
