import test from 'node:test';
import assert from 'node:assert/strict';
import { inertWalletProbePath, inspectMyNearWalletRedirectSizes } from '../agent/mynearwallet-redirect-probe.mjs';

test('inert wallet probes are bounded paths with no account, callback, or transaction', () => {
  for (const n of [128, 1024, 8192, 730000]) {
    const path = inertWalletProbePath(n);
    assert.equal(Buffer.byteLength(path), n);
    const parsed = new URL(`https://testnet.mynearwallet.com${path}`);
    assert.equal(parsed.pathname, '/sign/');
    assert.deepEqual([...parsed.searchParams.keys()], ['bouncer_readonly_probe']);
    assert.match(parsed.searchParams.get('bouncer_readonly_probe'), /^a+$/);
  }
  for (const invalid of [-1, 0, 900001, 1.5, '128', NaN]) assert.throws(() => inertWalletProbePath(invalid));
});

test('HEAD probes use only the fixed host, proceed sequentially, and report unknown failures honestly', async () => {
  const calls = [], sequence = [200, 414, 'error'];
  const report = await inspectMyNearWalletRedirectSizes({ pathBytes: [1024, 8192, 65536], fetchImpl: async (url, options) => {
    calls.push({ url, options });
    const status = sequence.shift();
    if (status === 'error') throw new Error('network unavailable');
    return { status, body: { cancel: async () => {} } };
  }});
  assert.equal(calls.length, 3);
  for (const { url, options } of calls) {
    assert(url.startsWith('https://testnet.mynearwallet.com/sign/?bouncer_readonly_probe='));
    assert.equal(options.method, 'HEAD'); assert.equal(options.redirect, 'manual');
    assert(!url.includes('transactions=')); assert(!url.includes('callbackUrl='));
  }
  assert.deepEqual(report.results, [{ path_bytes: 1024, http_status: 200 }, { path_bytes: 8192, http_status: 414 },
    { path_bytes: 65536, http_status: null, outcome: 'NETWORK_OR_CLIENT_ERROR' }]);
  assert.equal(report.transaction_submitted, false); assert.equal(report.wallet_approval_obtained, false);
  assert.equal(report.sign_in_checked, false);
});

test('invalid batch is rejected before any network request', async () => {
  let called = 0;
  for (const pathBytes of [[], [1024, 1024], [1024, 900001], [1024, 8192, 32768, 65536, 131072, 200000, 300000]]) {
    await assert.rejects(() => inspectMyNearWalletRedirectSizes({ pathBytes, fetchImpl: async () => { called++; } }));
  }
  assert.equal(called, 0);
});
