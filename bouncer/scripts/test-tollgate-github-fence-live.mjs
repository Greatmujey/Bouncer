#!/usr/bin/env node
/** CI permission/uniqueness smoke test with randomly generated synthetic keys.
 * No live account, voucher signature, paid request or chain operation. Only
 * this freshly created synthetic label is deleted; real reservations must
 * never be deleted. A lost create response is not retried or cleaned up. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { makeTollgateQuakesReview, tollgateQuakesReviewHash } from '../agent/tollgate-quakes-v13.mjs';
import { GithubTollgateVoucherFence } from '../agent/tollgate-github-voucher-fence.mjs';

const REPO = 'Greatmujey/Bouncer', BRANCH = 'arena/25a7aaf6-near-hub', token = process.env.GITHUB_TOKEN;
if (process.env.GITHUB_REPOSITORY !== REPO || process.env.GITHUB_REF !== `refs/heads/${BRANCH}` ||
    process.env.GITHUB_EVENT_NAME !== 'push' || process.env.GITHUB_RUN_ATTEMPT !== '1' ||
    !/^[1-9][0-9]{0,15}$/.test(process.env.GITHUB_RUN_ID ?? '') || typeof token !== 'string' || token.length < 20 ||
    !JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))?.head_commit?.message?.includes('[v13-remote-fence-check]')) {
  throw new Error('first-attempt fixed-branch synthetic GitHub Actions context required');
}
const key = () => nearApi.KeyPair.fromRandom('ed25519'), owner = key(), agent = key(), voucher = key();
const ownerPlan = { version: 1, purpose: 'new-bouncer-testnet-owner', network: 'testnet',
  account_id: `bouncer-owner-${crypto.randomBytes(12).toString('hex')}.testnet`, public_key: String(owner.getPublicKey()) };
const review = makeTollgateQuakesReview({ ownerPlan, intentId: `synthetic-${process.env.GITHUB_RUN_ID}`,
  agentPublicKey: String(agent.getPublicKey()), voucherPublicKey: String(voucher.getPublicKey()),
  expiresAtMs: String(Date.now() + 120_000) });
const snapshot = { review_hash: tollgateQuakesReviewHash(review), intent_id: review.intent_id,
  channel_id: '0', block_hash: '1'.repeat(32) };
const root = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'bouncer-synthetic-fence-'));
const one = path.join(root, 'one'), two = path.join(root, 'two'); fs.mkdirSync(one, { mode: 0o700 }); fs.mkdirSync(two, { mode: 0o700 });
let result, duplicateBlocked = false, deleted = false;
try {
  const a = new GithubTollgateVoucherFence(one, { token }), b = new GithubTollgateVoucherFence(two, { token });
  result = await a.claim(review, snapshot); // no voucher is signed
  try { await b.claim(review, snapshot); }
  catch { duplicateBlocked = true; }
  if (!duplicateBlocked) throw new Error('GitHub allowed a second synthetic key reservation');
  const expectedName = `bouncer-tollgate-voucher-${crypto.createHash('sha256').update(review.voucher_public_key).digest('hex')}`;
  const expectedDescription = `v13:${snapshot.review_hash}:0`;
  if (result.github_label_name !== expectedName || !Number.isSafeInteger(result.github_label_id)) throw new Error('synthetic label identity differs');
  // Only this generated, unexposed, synthetic key is used in this program.
  // Confirm the exact record before deleting it. Never do this for a real key.
  const url = `https://api.github.com/repos/${REPO}/labels/${encodeURIComponent(expectedName)}`;
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28', 'user-agent': 'bouncer-synthetic-voucher-fence-test' };
  const check = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!check.ok) throw new Error('synthetic cleanup identity unavailable');
  const label = await check.json();
  if (label.id !== result.github_label_id || label.name !== expectedName || label.description !== expectedDescription) {
    throw new Error('synthetic cleanup identity differs; leave label in place');
  }
  const deletion = await fetch(url, { method: 'DELETE', headers, redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (deletion.status !== 204) throw new Error('synthetic label cleanup unconfirmed');
  deleted = true;
  console.log(JSON.stringify({ synthetic_only: true, no_chain_operations: true, no_voucher_signed: true,
    no_provider_contact: true, github_label_created_and_read_back: true, duplicate_reservation_blocked: true,
    synthetic_label_deleted: deleted, live_reservation_tested: false, live_purchase_tested: false }));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
