import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inspectX402 } from '../agent/inspect-x402.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';

test('live inspection job is explicitly gated, read-only and pinned to the public URL', () => {
  const ci = fs.readFileSync(fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)), 'utf8');
  const job = ci.split('\n  x402-independent-inspection:\n')[1]?.split('\n  independent-market-discovery:\n')[0];
  assert.ok(job); assert.match(job, /github\.event_name == 'push'/); assert.match(job, /github\.run_attempt == '1'/);
  assert.match(job, /\[x402-inspect\]/); assert.match(job, /node bouncer\/agent\/inspect-x402\.mjs --url https:\/\/piprail\.com\/x402\/demo/);
  assert.doesNotMatch(job, /--execute|--key|--redeem|sendTransaction|upload-artifact/i);
});

const url = 'https://seller.example/api';
const enc = v => Buffer.from(JSON.stringify(v)).toString('base64');
const candidate = () => ({ scheme: 'onchain-proof', network: 'near:testnet', asset: TOKEN, payTo: 'vendor.testnet', amount: '1000',
  maxTimeoutSeconds: 600, extra: { nonce: 'do-not-print-this', decimals: 6, minConfirmations: 1, amountFormatted: '0.001' } });
const challenge = accepts => ({ x402Version: 2, resource: { url }, accepts });
const fetchFor = body => async (_url, options) => {
  assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
  assert.equal(options.headers['payment-signature'], undefined);
  return new Response('ignored body', { status: 402, headers: { 'payment-required': enc(body) } });
};

test('one read-only GET classifies the Base-only independent demo shape as incompatible', async () => {
  const base = { scheme: 'onchain-proof', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    payTo: '0x28Dc25bf88BF06fc0a3Af1747D1aA4a21f313ed0', amount: '10000' };
  let calls = 0;
  const result = await inspectX402({ url, fetchImpl: async (...args) => { calls++; return fetchFor(challenge([base]))(...args); } });
  assert.equal(calls, 1); assert.equal(result.mode, 'read-only'); assert.equal(result.payment_enabled, false);
  assert.equal(result.offers[0].wire_candidate, false); assert.match(result.offers[0].reasons.join(' '), /not NEAR testnet/);
});

test('a matching advertisement is only a wire candidate, with no nonce leakage or spending authority', async () => {
  const result = await inspectX402({ url, fetchImpl: fetchFor(challenge([candidate()])) });
  assert.equal(result.offers[0].wire_candidate, true); assert.equal(result.owner_approval_required, true);
  assert.match(result.note, /not approval/); assert.doesNotMatch(JSON.stringify(result), /do-not-print-this/);
  for (const mutate of [c => { c.accepts[0].scheme = 'exact'; }, c => { c.accepts[0].network = 'near:mainnet'; },
    c => { c.accepts[0].amount = '999999999999999999999999999999999999999'; }, c => { c.accepts[0].extra.nonce = ''; },
    c => { c.resource.url = 'https://attacker.example/'; }, c => { c.accepts.push(structuredClone(c.accepts[0])); }]) {
    const c = challenge([candidate()]); mutate(c);
    const out = await inspectX402({ url, fetchImpl: fetchFor(c) });
    assert.equal(out.offers[0].wire_candidate, false);
  }
});

test('invalid endpoints, challenges and injected control characters fail closed without leaking fields', async () => {
  for (const bad of ['http://seller.example/api', 'https://user:secret@seller.example/api', 'https://seller.example/api?q=secret',
    'https://seller.example/api#fragment', 'https://seller.example/a/../api']) {
    await assert.rejects(inspectX402({ url: bad, fetchImpl: () => { throw new Error('must not fetch'); } }));
  }
  for (const header of ['junk!', Buffer.from('{').toString('base64'), Buffer.from([0xff]).toString('base64'), 'a'.repeat(9000)]) {
    await assert.rejects(inspectX402({ url, fetchImpl: async () => new Response('', { status: 402, headers: { 'payment-required': header } }) }));
  }
  await assert.rejects(inspectX402({ url, fetchImpl: fetchFor({ x402Version: 1, accepts: [candidate()] }) }), /unsupported/);
  await assert.rejects(inspectX402({ url, fetchImpl: fetchFor(challenge(new Array(17).fill(candidate()))) }), /unsupported/);
  const c = candidate(); c.payTo = 'evil\u202e.testnet'; c.scheme = 'bad\nname';
  const out = await inspectX402({ url, fetchImpl: fetchFor(challenge([c])) });
  assert.equal(out.offers[0].payee, '<invalid>'); assert.equal(out.offers[0].scheme, '<invalid>');
  const noHeader = await inspectX402({ url, fetchImpl: async () => new Response('body is ignored', { status: 402 }) });
  assert.equal(noHeader.offers.length, 0); assert.match(noHeader.note, /No PAYMENT-REQUIRED/);
  const ok = await inspectX402({ url, fetchImpl: async () => new Response('not a challenge', { status: 200 }) });
  assert.equal(ok.offers.length, 0); assert.match(ok.note, /did not return/);
});
