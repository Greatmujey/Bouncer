import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getLiveQuote } from '../agent/intents.mjs';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('legacy cross-chain solver fails closed rather than generating or submitting fake fills', () => {
  const result = spawnSync(process.execPath, ['bouncer/agent/solver.mjs'], {
    cwd: repo, env: { ...process.env, REALLY_FILL: '1', ONE_CLICK_JWT: 'test-only-not-a-credential' }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /settlement is not implemented/);
  assert.match(result.stderr, /No bids or fills were submitted/);
});

test('legacy deploy and demo entry points stop before reading keys or making network calls', () => {
  for (const script of ['deploy.mjs', 'redeploy.mjs', 'demo.mjs', 'fund-and-pay.mjs', 'scripts/deploy.mjs']) {
    const result = spawnSync(process.execPath, [`bouncer/${script}`], { cwd: repo, env: { ...process.env, HOME: '/nonexistent' }, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1, `${script}: ${result.stderr}`);
    assert.match(result.stderr, /Legacy script disabled/);
  }
});

test('Intents quote failures never become invented prices or settlement', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('network unavailable'); };
    await assert.rejects(getLiveQuote({ dest_chain: 'near', amount_in: '100' }), /quote failed: network unavailable/);
    await assert.rejects(getLiveQuote({ dest_chain: 'unsupported', amount_in: '100' }), /unsupported quote asset/);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ quote: {} }) });
    await assert.rejects(getLiveQuote({ dest_chain: 'near', amount_in: '100' }), /no valid amount/);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ quote: { amountOut: '99' } }) });
    assert.deepEqual((({ amount_out, eta }) => ({ amount_out, eta }))(await getLiveQuote({ dest_chain: 'near', amount_in: '100' })), { amount_out: '99', eta: null });
  } finally { globalThis.fetch = original; }
});

test('static sample is visibly offline and does not fabricate block numbers', () => {
  const html = fs.readFileSync(path.join(repo, 'bouncer/demo/index.html'), 'utf8');
  assert.match(html, /OFFLINE SIMULATION · NOT ON-CHAIN/);
  assert.match(html, /no transaction is sent/i);
  assert.doesNotMatch(html, /settled · block/);
  assert.doesNotMatch(html, /rejected <b>on-chain<\/b>/);
});
