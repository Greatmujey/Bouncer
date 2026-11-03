#!/usr/bin/env node
/** CI-only one-shot testnet owner acquisition broadcaster. No private key is
 * read. Signed public bytes may be relayed by anyone; never blindly resend. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { readBoundedJson } from '../shared/bounded-json.mjs';
import { validateOwnerBootstrapPlan } from '../agent/testnet-owner-bootstrap.mjs';
import { verifySignedOwnerAcquisition } from '../agent/circle-owner-acquisition.mjs';
import { broadcastOwnerAcquisitionOnce } from '../agent/circle-owner-acquisition-runner.mjs';
import { ExperimentalSvalinSetupRpc } from '../agent/svalin-setup-rpc.mjs';
const kind = process.env.BOUNCER_ACQUISITION_KIND;
if (!['wrap', 'swap'].includes(kind)) throw new Error('a fixed testnet acquisition kind is required');
const plan = validateOwnerBootstrapPlan(JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v2-plan.json', import.meta.url), 'utf8')));
const input = new URL(`../evidence/testnet-owner-v2/${kind}-original.json`, import.meta.url), stat = fs.lstatSync(input);
if (!stat.isFile() || stat.size < 1 || stat.size > 16_384) throw new Error('invalid original public acquisition envelope');
const bytes = fs.readFileSync(input);
if (bytes.length !== stat.size) throw new Error('original acquisition envelope changed while reading');
const envelope = JSON.parse(bytes.toString('utf8'));
if (envelope.kind !== kind) throw new Error('original acquisition kind differs');
verifySignedOwnerAcquisition(envelope, plan);
const digest = crypto.createHash('sha256').update(bytes).digest('hex'), run = process.env.GITHUB_RUN_ID,
  attempt = process.env.GITHUB_RUN_ATTEMPT, sha = process.env.GITHUB_SHA,
  artifact = process.env.BOUNCER_FENCE_ARTIFACT_ID, token = process.env.GITHUB_TOKEN;
if (!/^[1-9][0-9]{0,19}$/.test(run ?? '') || attempt !== '1' || !/^[a-f0-9]{40}$/.test(sha ?? '') ||
    !/^[1-9][0-9]{0,19}$/.test(artifact ?? '') || typeof token !== 'string' || token.length < 20 ||
    process.env.GITHUB_REPOSITORY !== 'Greatmujey/Bouncer' || process.env.GITHUB_REF !== 'refs/heads/arena/25a7aaf6-near-hub') {
  throw new Error('testnet acquisition requires the first attempt of the intended branch workflow');
}
async function persistAttempt(record) {
  if (record.kind !== kind || record.tx_hash !== envelope.tx_hash || record.owner !== plan.account_id) return false;
  const response = await fetch(`https://api.github.com/repos/Greatmujey/Bouncer/actions/artifacts/${artifact}`, {
    method: 'GET', redirect: 'error', headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`,
      'user-agent': 'bouncer-testnet-owner-acquisition' }, signal: AbortSignal.timeout(15_000) });
  try {
    if (!response.ok) return false;
    const metadata = await readBoundedJson(response, { maxBytes: 32_768, label: 'original acquisition artifact' });
    return metadata?.id === Number(artifact) && metadata.name === `acquisition-v2-${kind}-fence-${run}-${digest}` &&
      metadata.expired === false && Number.isSafeInteger(metadata.size_in_bytes) && metadata.size_in_bytes > 0 &&
      metadata.size_in_bytes < 32_768 && metadata.workflow_run?.id === Number(run) && metadata.workflow_run?.head_sha === sha;
  } finally { await response.body?.cancel().catch(() => {}); }
}
const provider = new ExperimentalSvalinSetupRpc('https://rpc.testnet.near.org', { readTimeoutMs: 12_000 });
try {
  const result = await broadcastOwnerAcquisitionOnce({ plan, envelope, provider, persistAttempt });
  console.log(JSON.stringify({ ...result, signed_envelope_sha256: digest, fence_artifact_id: artifact, run_id: run, commit: sha }, null, 2));
} catch (error) {
  console.error(`Testnet ${kind} acquisition stopped: ${error?.message ?? 'unknown error'}`);
  process.exitCode = 1;
}
