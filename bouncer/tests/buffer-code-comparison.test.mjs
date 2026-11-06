import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { compareBufferCode } from '../agent/buffer-code-comparison.mjs';
import { BUFFER_TESTNET_CONTRACT } from '../experiments/buffer-forwarder/build.mjs';

// A minimal valid synthetic WASM and fabricated RPC views only; no live call.
const wasm = () => Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const hash = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n));
const localCodeHash = bytes => nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(bytes).digest());
const NOW = 1_800_000_000_000;
function mock() {
  const state = { network: 'testnet', block: hash(1), accountBlock: hash(1), code: localCodeHash(wasm()),
    timestamp: String(BigInt(NOW) * 1_000_000n), height: 123, globalHash: null, globalAccount: null };
  return { state, async viewNodeStatus() { return { chain_id: state.network }; },
    async viewBlock(arg) { assert.deepEqual(arg, { finality: 'final' }); return { header: { hash: state.block,
      timestamp_nanosec: state.timestamp, height: state.height } }; },
    async viewAccount(account, at) { assert.equal(account, BUFFER_TESTNET_CONTRACT); assert.deepEqual(at, { blockId: state.block });
      return { block_hash: state.accountBlock, code_hash: state.code, global_contract_hash: state.globalHash,
        global_contract_account_id: state.globalAccount }; } };
}
const compare = (provider, bytes = wasm()) => compareBufferCode({ wasmBytes: bytes, provider, now: () => NOW });

test('matching code hash is bounded to one trusted FINAL block, not a purchase or audit', async () => {
  const p = mock(), result = await compare(p);
  assert.equal(result.bytecode_matches, true); assert.equal(result.seller, BUFFER_TESTNET_CONTRACT);
  assert.equal(result.block_hash, hash(1)); assert.equal(result.local_wasm_near_code_hash, result.deployed_code_hash);
  assert.equal(result.local_wasm_sha256, crypto.createHash('sha256').update(wasm()).digest('hex'));
  assert.equal(result.audited, false); assert.equal(result.payment_authorized, false); assert.equal(result.sent, false);
  assert.equal(result.independent_delivery_verified, false);
});

test('nonmatching valid code hash is an explicit mismatch, never inferred equivalence', async () => {
  const p = mock(); p.state.code = hash(2);
  const result = await compare(p); assert.equal(result.bytecode_matches, false);
  assert.match(result.source_equivalence_scope, /not established/);
});

test('wrong chain, stale/mixed block, invalid account or global redirects fail closed', async () => {
  for (const change of [
    s => { s.network = 'mainnet'; }, s => { s.timestamp = String(BigInt(NOW - 121_000) * 1_000_000n); },
    s => { s.height = 0; }, s => { s.accountBlock = hash(2); }, s => { s.code = 'bad'; },
    s => { s.globalHash = hash(5); }, s => { s.globalAccount = 'other.testnet'; },
  ]) { const p = mock(); change(p.state); await assert.rejects(compare(p)); }
});

test('malformed or oversized WASM is rejected before any RPC', async () => {
  const p = mock(); let calls = 0; p.viewNodeStatus = async () => { calls++; return { chain_id: 'testnet' }; };
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(8), Buffer.alloc(4 * 1024 * 1024 + 1),
    Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 0xff])]) await assert.rejects(compare(p, bytes));
  assert.equal(calls, 0);
});

test('comparison snapshots bytes before awaiting the provider', async () => {
  const p = mock(), bytes = wasm(), expected = localCodeHash(bytes);
  p.viewNodeStatus = async () => { bytes[0] = 1; return { chain_id: 'testnet' }; };
  const result = await compare(p, bytes);
  assert.equal(result.local_wasm_near_code_hash, expected); assert.equal(result.bytecode_matches, true);
});
