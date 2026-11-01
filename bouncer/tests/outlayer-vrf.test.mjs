import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyOutlayerProbeVrf } from '../agent/outlayer-vrf.mjs';

function fixture() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const expectedPublicKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const requestId = 42, owner = 'owner.testnet', seed = 'unique_seed-1', alpha = `vrf:${requestId}:${owner}:${seed}`;
  const signature = crypto.sign(null, Buffer.from(alpha), privateKey);
  const output = { ok: true, operation: 'vrf', vrf_alpha: alpha, vrf_pubkey: expectedPublicKey,
    vrf_signature: signature.toString('hex'), vrf_output: crypto.createHash('sha256').update(signature).digest('hex') };
  return { output, requestId, owner, seed, expectedPublicKey };
}

test('verifies Ed25519 and signature-derived randomness under an independently pinned testnet key', () => {
  const f = fixture(), proof = verifyOutlayerProbeVrf(f);
  assert.equal(proof.alpha, `vrf:42:${f.owner}:${f.seed}`); assert.equal(proof.output_hex, f.output.vrf_output);
  const withoutEmbeddedKey = structuredClone(f); delete withoutEmbeddedKey.output.vrf_pubkey;
  assert.deepEqual(verifyOutlayerProbeVrf(withoutEmbeddedKey), proof);
});

test('rejects substitutions of signer, request, caller, seed, signature, hash or embedded key', () => {
  for (const change of [
    f => { f.expectedPublicKey = '00'.repeat(32); }, f => { f.requestId++; }, f => { f.owner = 'attacker.testnet'; },
    f => { f.seed = 'another'; }, f => { f.output.vrf_alpha = 'vrf:41:owner.testnet:unique_seed-1'; },
    f => { f.output.vrf_pubkey = '00'.repeat(32); }, f => { f.output.vrf_signature = '00'.repeat(64); },
    f => { f.output.vrf_output = '00'.repeat(32); }, f => { f.output.ok = false; }, f => { f.output.operation = 'fetch'; },
    f => { f.requestId = Number.MAX_SAFE_INTEGER + 1; }, f => { f.seed = 'bad:delimiter'; }, f => { f.owner = 'owner.near'; },
    f => { f.output.vrf_signature = f.output.vrf_signature.toUpperCase(); },
  ]) { const f = fixture(); change(f); assert.throws(() => verifyOutlayerProbeVrf(f)); }
});