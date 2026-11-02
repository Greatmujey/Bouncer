import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { classifyProbeValidity } from '../agent/testnet-resource-agent-expiry.mjs';
const hash = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n));
const now = Date.now();
function fixture() {
  const envelope = { stage: 'guard-probe', tx_hash: hash(1), block_hash: hash(2), nonce: '43',
    owner: 'owner.testnet', owner_public_key: 'ed25519:owner' };
  const state = { network: 'testnet', owner: envelope.owner, public_key: envelope.owner_public_key,
    block_hash: hash(3), owner_key_nonce: '42', policy: null, agent_granted: false,
    vault_actual_circle_atoms: '6907', vault_tracked_circle_atoms: '6907' };
  return { envelope, state, baseBlock: { header: { hash: hash(2), height: 1000 } },
    canonicalBlock: { header: { hash: hash(2), height: 1000 } },
    finalBlock: { header: { hash: hash(3), height: 1101, timestamp_nanosec: String(BigInt(now) * 1_000_000n) } },
    protocol: { chain_id: 'testnet', transaction_validity_period: 100 }, nowMs: now };
}

test('reports expired original with unchanged nonce without claiming a receipt or authorizing a retry', () => {
  const f = fixture(), out = classifyProbeValidity(f);
  assert.equal(out.validity_window_passed_at_final, true);
  assert.equal(out.owner_nonce_unchanged_since_signing, true);
  assert.equal(out.receipt_status, 'UNKNOWN_UNLESS_SEPARATELY_VERIFIED');
  assert.equal(out.guard_failure_verified, false);
  assert.equal(out.do_not_resend_original, true);
  assert.equal(out.sent, false);
  f.finalBlock.header.height = 1100;
  assert.equal(classifyProbeValidity(f).validity_window_passed_at_final, false);
  f.finalBlock.header.height = 1101; f.state.owner_key_nonce = '43';
  assert.equal(classifyProbeValidity(f).owner_nonce_unchanged_since_signing, false);
});

test('refuses noncanonical, wrong-network, mixed-block, malformed and stale observations', () => {
  const changes = [
    f => { f.canonicalBlock.header.hash = hash(4); },
    f => { f.baseBlock.header.hash = hash(4); },
    f => { f.finalBlock.header.hash = hash(4); },
    f => { f.finalBlock.header.height = 999; },
    f => { f.protocol.chain_id = 'mainnet'; },
    f => { f.protocol.transaction_validity_period = 0; },
    f => { f.protocol.transaction_validity_period = '100'; },
    f => { f.state.owner_key_nonce = Number.MAX_SAFE_INTEGER + 1; },
    f => { f.envelope.stage = 'configure'; },
    f => { f.finalBlock.header.timestamp_nanosec = String(BigInt(now - 180_000) * 1_000_000n); },
  ];
  for (const change of changes) { const f = fixture(); change(f); assert.throws(() => classifyProbeValidity(f)); }
});
