import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { main, parseBufferReview } from '../scripts/inspect-buffer-delivery.mjs';
import { BUFFER_V12_CODE_HASH } from '../agent/buffer-delivery-evidence.mjs';
import { CIRCLE_TESTNET_REVIEWED_CODE_HASH } from '../agent/paypercall-forwarder-evidence.mjs';
import { mockHash } from './mock-guarded-payment.mjs';
const key = () => nearApi.KeyPair.fromRandom('ed25519').getPublicKey().toString();
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
function review() {
  return { format: 'bouncer-buffer-delivery-evidence-v1', terms: {
    owner: 'buyer.testnet', vault: 'vault.buyer.testnet', adapter: 'bridge.buyer.testnet',
    vault_agent_public_key: key(), forwarder_agent_public_key: key(), policy_id: 'research', intent_id: 'buffer-one',
    amount: '100', expires_at_ms: 1_800_000_000_000, native_return_cap: '1000000000000000000000000',
    native_reserve: '1000000000000000000000000', api_order_id: '123e4567-e89b-12d3-a456-426614174000',
    onchain_order_id: 'o-123456789abc', sku: 'weekly-market-brief', brief_sha256: sha('Private fixture brief') },
    pins: { vault_code_hash: BUFFER_V12_CODE_HASH, token_code_hash: CIRCLE_TESTNET_REVIEWED_CODE_HASH,
      seller_code_hash: mockHash('seller-code'), fulfillment_signer: 'seller-agent.testnet' },
    funding_hash: mockHash('funding'), opening_hash: mockHash('opening'), fulfillment_hash: mockHash('fulfillment') };
}
function files() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buffer-evidence-cli-'));
  const manifest = path.join(dir, 'review.json'), order = path.join(dir, 'private.json');
  fs.writeFileSync(manifest, JSON.stringify(review()));
  fs.writeFileSync(order, JSON.stringify({ brief: 'Private fixture brief', report: { content: 'Private fixture report' } }), { mode: 0o600 });
  return { dir, manifest, order, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const args = f => ['--rpc', 'https://rpc.testnet.near.org', '--review', f.manifest, '--private-order', f.order];
test('CLI keeps the private order local and prints only the verifier result', async () => {
  const f = files(); let output = '', calls = 0;
  try {
    const provider = {};
    await main(args(f), { createProvider(url) { calls++; assert.equal(url, 'https://rpc.testnet.near.org'); return provider; },
      async inspect(request) {
        calls++; assert.equal(request.provider, provider); assert.equal(request.privateOrder.brief, 'Private fixture brief');
        assert.equal(request.privateOrder.report.content, 'Private fixture report');
        return { status: 'synthetic only', independent_fulfillment_verified: false };
      }, print(text) { output += text; } });
    assert.equal(calls, 2); assert.match(output, /synthetic only/); assert(!output.includes('Private fixture'));
  } finally { f.cleanup(); }
});
test('malformed review, extra fields and private symlinks fail before any RPC creation', async () => {
  const f = files(); let calls = 0;
  const options = { createProvider() { calls++; }, inspect() { calls++; }, print() {} };
  try {
    const bad = review(); bad.secret = 'not allowed'; fs.writeFileSync(f.manifest, JSON.stringify(bad));
    await assert.rejects(main(args(f), options), /invalid Buffer review/);
    const badTerms = review(); badTerms.terms.token = 'attacker.testnet'; fs.writeFileSync(f.manifest, JSON.stringify(badTerms));
    await assert.rejects(main(args(f), options));
    const dup = review(); dup.opening_hash = dup.funding_hash; fs.writeFileSync(f.manifest, JSON.stringify(dup));
    await assert.rejects(main(args(f), options), /invalid Buffer review/);
    fs.writeFileSync(f.manifest, JSON.stringify(review()));
    const link = path.join(f.dir, 'link'); fs.symlinkSync(f.order, link);
    await assert.rejects(main(['--rpc', 'https://rpc.testnet.near.org', '--review', f.manifest, '--private-order', link], options));
    assert.equal(calls, 0); assert.throws(() => parseBufferReview(Buffer.from([0xff])), /invalid Buffer review/);
  } finally { f.cleanup(); }
});
test('help and invalid arguments never open a provider', async () => {
  let output = '', called = false;
  await main(['--help'], { print(text) { output = text; } });
  assert.match(output, /never contacts/); assert.match(output, /not\s+proof of HTTP provenance/);
  await assert.rejects(main(['--rpc', 'x', '--unknown', 'y'], { createProvider() { called = true; }, print() {} }), /unknown/);
  assert.equal(called, false);
});
