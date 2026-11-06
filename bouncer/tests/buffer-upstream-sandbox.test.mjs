import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import wabt from 'wabt';
import { validateBufferFixture, exerciseBufferSandbox } from '../integration/buffer-upstream-sandbox.mjs';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const names = ['new', 'set_product', 'set_quote_rules', 'create_quote', 'get_quote', 'ft_on_transfer', 'refund', 'mark_fulfilled', 'settle', 'get_order'];
async function fixture(exports) {
  const compiler = await wabt();
  const compiled = compiler.parseWat('fixture.wat', `(module ${exports.map(x => `(func (export "${x}"))`).join(' ')})`);
  try { return Buffer.from(compiled.toBinary({}).buffer); } finally { compiled.destroy(); }
}
test('isolated fixture gate checks a hash, WASM shape and methods, not provenance', async () => {
  const bytes = await fixture(names), digest = sha(bytes);
  assert.deepEqual(validateBufferFixture(bytes, digest), { sha256: digest, bytes: bytes.length });
  assert.throws(() => validateBufferFixture(bytes, '0'.repeat(64)), /invalid source-built/);
  assert.throws(() => validateBufferFixture(Buffer.from('not wasm'), sha(Buffer.from('not wasm'))));
  const missing = await fixture(names.filter(x => x !== 'refund'));
  assert.throws(() => validateBufferFixture(missing, sha(missing)), /missing Buffer methods/);
  const tooLarge = Buffer.alloc(4 * 1024 * 1024 + 1);
  assert.throws(() => validateBufferFixture(tooLarge, sha(tooLarge)), /invalid source-built/);
});
test('sandbox harness refuses a public RPC, wrong local identities and unpinned V12 before signing', async () => {
  await assert.rejects(exerciseBufferSandbox({ rpcUrl: 'https://rpc.testnet.near.org', root: {}, tokenOwner: {} }), /loopback|sandbox/i);
  await assert.rejects(exerciseBufferSandbox({ rpcUrl: 'http://127.0.0.1:3030', root: {}, tokenOwner: {} }), /loopback|sandbox/i);
  const fake = id => ({ accountId: id, provider: { connection: { url: 'http://127.0.0.1:3030' } } });
  await assert.rejects(exerciseBufferSandbox({ rpcUrl: 'http://127.0.0.1:3030', root: fake('testnet'),
    tokenOwner: fake('owner.testnet'), v12: Buffer.alloc(536_651), sellerWasm: Buffer.alloc(8),
    sellerSha256: '0'.repeat(64), storageMin: '1' }), /pinned V12/);
});
