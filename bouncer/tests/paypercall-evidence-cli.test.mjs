import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import nearApi from 'near-api-js';
import { main, parseEvidenceReview, readBoundedEvidenceFile } from '../scripts/inspect-paypercall-forwarder.mjs';
import { PAYPERCALL_VAULT_CODE_HASHES, CIRCLE_TESTNET_REVIEWED_CODE_HASH } from '../agent/paypercall-forwarder-evidence.mjs';
import { mockHash } from './mock-guarded-payment.mjs';

const key = () => nearApi.KeyPair.fromRandom('ed25519').getPublicKey().toString();
function manifest() {
  return { format: 'bouncer-paypercall-forwarder-evidence-v1', terms: {
    owner: 'buyer.testnet', vault: 'vault.buyer.testnet', adapter: 'bridge.buyer.testnet',
    vault_agent_public_key: key(), forwarder_agent_public_key: key(), policy_id: 'call', intent_id: 'one',
    amount: '100', service_id: 0, request: 'wrap.testnet', expires_at_ms: 1_800_000_000_000,
    native_return_cap: '1000000000000000000000000', native_reserve: '1000000000000000000000000' },
    offer: { provider: 'provider.testnet', operator: 'operator.testnet', price: '60',
      vault_code_hash: PAYPERCALL_VAULT_CODE_HASHES[0], token_code_hash: CIRCLE_TESTNET_REVIEWED_CODE_HASH,
      escrow_code_hash: mockHash('test-only-escrow') },
    funding_hash: mockHash('test-only-funding'), opening_hash: mockHash('test-only-opening'),
    fulfillment_hash: mockHash('test-only-fulfill'), fulfillment_signer: 'operator.testnet' };
}
function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-evidence-cli-test-'));
  const review = path.join(dir, 'review.json'), answer = path.join(dir, 'answer.bin');
  fs.writeFileSync(review, JSON.stringify(manifest())); fs.writeFileSync(answer, 'local fixture answer\n');
  return { dir, review, answer, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('CLI reads exact local answer bytes and submits only public fields to a read-only inspector', async () => {
  const t = temp(); let providerCalls = 0, inspected = 0, output = '';
  try {
    const provider = {};
    await main(['--rpc', 'https://rpc.testnet.near.org', '--review', t.review, '--answer', t.answer], {
      createProvider(rpc) { providerCalls++; assert.equal(rpc, 'https://rpc.testnet.near.org'); return provider; },
      async inspect(request) {
        inspected++; assert.equal(request.provider, provider); assert.equal(request.fulfillmentSigner, 'operator.testnet');
        assert.equal(request.answerBytes.toString(), 'local fixture answer\n');
        assert.equal(request.terms.request, 'wrap.testnet'); assert.equal(request.offer.price, '60');
        return { status: 'synthetic only', independent_fulfillment_verified: false };
      }, print(text) { output += text; },
    });
    assert.equal(providerCalls, 1); assert.equal(inspected, 1); assert.match(output, /synthetic only/);
    assert(!output.includes('local fixture answer')); assert.match(output, /independent_fulfillment_verified/);
  } finally { t.cleanup(); }
});

test('malformed reviews, extra secret-like fields and invalid files stop before the RPC provider is created', async () => {
  const t = temp(); let calls = 0;
  const opts = { createProvider() { calls++; return {}; }, async inspect() { calls++; }, print() {} };
  const args = ['--rpc', 'https://rpc.testnet.near.org', '--review', t.review, '--answer', t.answer];
  try {
    const invalid = manifest(); invalid.signed_tx = 'must not be accepted'; fs.writeFileSync(t.review, JSON.stringify(invalid));
    await assert.rejects(main(args, opts), /invalid evidence review/);
    const badTerms = manifest(); badTerms.terms.token = 'attacker.testnet'; fs.writeFileSync(t.review, JSON.stringify(badTerms));
    await assert.rejects(main(args, opts));
    fs.writeFileSync(t.review, JSON.stringify(manifest())); fs.writeFileSync(t.answer, '');
    await assert.rejects(main(args, opts), /unsafe or oversized/);
    assert.equal(calls, 0);
    assert.throws(() => parseEvidenceReview(Buffer.from([0xff, 0xfe])), /invalid evidence review/);
    assert.throws(() => parseEvidenceReview(Buffer.from('{}')), /invalid evidence review/);
  } finally { t.cleanup(); }
});

test('bounded file reader rejects symbolic links, hard links, directories and oversized files', () => {
  const t = temp();
  try {
    const symlink = path.join(t.dir, 'symlink'), hardlink = path.join(t.dir, 'hardlink');
    fs.symlinkSync(t.answer, symlink);
    assert.throws(() => readBoundedEvidenceFile(symlink, 1024));
    fs.linkSync(t.answer, hardlink);
    assert.throws(() => readBoundedEvidenceFile(t.answer, 1024), /unsafe or oversized/);
    fs.unlinkSync(hardlink);
    assert.throws(() => readBoundedEvidenceFile(t.dir, 1024), /unsafe or oversized/);
    assert.throws(() => readBoundedEvidenceFile(t.answer, 2), /unsafe or oversized/);
    assert.equal(readBoundedEvidenceFile(t.answer, 1024).toString(), 'local fixture answer\n');
  } finally { t.cleanup(); }
});

test('CLI help disclaims payment and unknown arguments fail without network access', async () => {
  const help = execFileSync(process.execPath, ['scripts/inspect-paypercall-forwarder.mjs', '--help'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8' });
  assert.match(help, /No seller is/); assert.match(help, /not proof of HTTP delivery/);
  let called = false;
  await assert.rejects(main(['--rpc', 'https://rpc.testnet.near.org', '--bogus', 'x'], {
    createProvider() { called = true; }, inspect() { called = true; }, print() {},
  }), /unknown/);
  assert.equal(called, false);
});
