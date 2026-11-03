import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import { makeTollgateQuakesReview, tollgateQuakesReviewHash } from '../agent/tollgate-quakes-v13.mjs';
import { GithubTollgateVoucherFence } from '../agent/tollgate-github-voucher-fence.mjs';

const key = () => nearApi.KeyPair.fromRandom('ed25519'), pub = k => String(k.getPublicKey());
function fixture() {
  const owner = key(), voucher = key(), agent = key();
  const ownerPlan = { version: 1, purpose: 'new-bouncer-testnet-owner', network: 'testnet',
    account_id: 'bouncer-owner-aaaaaaaaaaaaaaaaaaaaaaaa.testnet', public_key: pub(owner) };
  const review = makeTollgateQuakesReview({ ownerPlan, intentId: 'one-data', agentPublicKey: pub(agent),
    voucherPublicKey: pub(voucher), expiresAtMs: String(Date.now() + 120_000) });
  return { review, snapshot: { review_hash: tollgateQuakesReviewHash(review), intent_id: review.intent_id,
    channel_id: '7', block_hash: '1'.repeat(32) } };
}
function dir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-remote-voucher-')); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function github({ lost = false, corruptRead = false } = {}) {
  const labels = new Map(), requests = [];
  const fetchImpl = async (url, opts) => {
    requests.push(opts.method);
    if (opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      if (labels.has(body.name)) return Response.json({ message: 'exists' }, { status: 422 });
      const label = { ...body, id: 12345 }; labels.set(body.name, label);
      if (lost) throw Error('lost acknowledgement');
      return Response.json(label, { status: 201 });
    }
    const name = decodeURIComponent(url.split('/').pop()), label = labels.get(name);
    if (!label) return new Response('', { status: 404 });
    return Response.json(corruptRead ? { ...label, description: 'different' } : label);
  };
  return { labels, requests, fetchImpl };
}
const token = 'x'.repeat(30);

test('two separate machines race on a repository-unique voucher key: only one reserves', async t => {
  const f = fixture(), g = github();
  const a = new GithubTollgateVoucherFence(dir(t), { token, fetchImpl: g.fetchImpl });
  const b = new GithubTollgateVoucherFence(dir(t), { token, fetchImpl: g.fetchImpl });
  const results = await Promise.allSettled([a.claim(f.review, f.snapshot), b.claim(f.review, f.snapshot)]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.filter(x => x.status === 'rejected').length, 1);
  assert.equal(g.labels.size, 1);
  const label = [...g.labels.values()][0];
  assert.match(label.name, /^bouncer-tollgate-voucher-[a-f0-9]{64}$/);
  assert.equal(label.description, `v13:${f.snapshot.review_hash}:7`);
  assert(!JSON.stringify(label).includes('secret'));
  await assert.rejects(() => a.claim(f.review, f.snapshot));
  await assert.rejects(() => b.claim(f.review, f.snapshot));
});

test('lost label acknowledgement or changed read-back never authorizes signing', async t => {
  for (const opts of [{ lost: true }, { corruptRead: true }]) {
    const f = fixture(), g = github(opts), a = new GithubTollgateVoucherFence(dir(t), { token, fetchImpl: g.fetchImpl });
    await assert.rejects(() => a.claim(f.review, f.snapshot));
    assert.equal(g.labels.size, 1);
    await assert.rejects(() => a.claim(f.review, f.snapshot));
    const other = new GithubTollgateVoucherFence(dir(t), { token, fetchImpl: g.fetchImpl });
    await assert.rejects(() => other.claim(f.review, f.snapshot));
  }
});

test('missing permission and invalid snapshot fail closed; no retry from the same local directory', async t => {
  const f = fixture(), calls = [];
  const denied = async (_url, opts) => { calls.push(opts.method); return new Response('', { status: 403 }); };
  const a = new GithubTollgateVoucherFence(dir(t), { token, fetchImpl: denied });
  await assert.rejects(() => a.claim(f.review, f.snapshot));
  await assert.rejects(() => a.claim(f.review, f.snapshot));
  assert.deepEqual(calls, ['POST']);
  const b = new GithubTollgateVoucherFence(dir(t), { token, fetchImpl: denied });
  await assert.rejects(() => b.claim(f.review, { ...f.snapshot, channel_id: 'bad' }));
  assert.deepEqual(calls, ['POST']);
});
