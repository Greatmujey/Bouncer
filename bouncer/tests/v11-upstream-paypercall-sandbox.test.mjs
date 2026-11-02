import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import wabt from 'wabt';
import { validateUpstreamFixture, exerciseUpstreamPayPerCall } from '../integration/v11-paypercall-upstream-sandbox.mjs';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const exports = ['new', 'register_service', 'storage_deposit', 'storage_withdraw', 'get_storage_credit',
  'ft_on_transfer', 'reject', 'claim', 'get_call', 'get_owed'];
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
