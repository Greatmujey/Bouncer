#!/usr/bin/env node
/** CI-only one-shot execution of the committed PUBLIC owner plan. The secret
 * key is never passed to GitHub. The workflow gate permits exactly one branch
 * push and forbids reruns; an uploaded public attempt fence is verified before
 * the helper request. No transaction is signed here. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';
import { readBoundedJson } from '../shared/bounded-json.mjs';
import { requestTestnetOwnerOnce, validateOwnerBootstrapPlan } from '../agent/testnet-owner-bootstrap.mjs';

const PLAN = new URL('../config/testnet-owner-bootstrap-plan.json', import.meta.url);
const stat = fs.lstatSync(PLAN);
if (!stat.isFile() || stat.size < 1 || stat.size > 4096) throw new Error('invalid committed public owner plan');
const bytes = fs.readFileSync(PLAN);
if (bytes.length !== stat.size) throw new Error('public owner plan changed while reading');
const plan = validateOwnerBootstrapPlan(JSON.parse(bytes.toString('utf8')));
const digest = crypto.createHash('sha256').update(bytes).digest('hex');
const run = process.env.GITHUB_RUN_ID, attempt = process.env.GITHUB_RUN_ATTEMPT, sha = process.env.GITHUB_SHA;
const artifact = process.env.BOUNCER_FENCE_ARTIFACT_ID, token = process.env.GITHUB_TOKEN;
if (!/^[1-9][0-9]{0,19}$/.test(run ?? '') || attempt !== '1' || !/^[a-f0-9]{40}$/.test(sha ?? '') ||
    !/^[1-9][0-9]{0,19}$/.test(artifact ?? '') || typeof token !== 'string' || token.length < 20 ||
    process.env.GITHUB_REPOSITORY !== 'Greatmujey/Bouncer' || process.env.GITHUB_REF !== 'refs/heads/arena/25a7aaf6-near-hub') {
  throw new Error('owner bootstrap is restricted to the first attempt of the intended branch workflow');
}

async function persistAttempt(record) {
  if (record.account_id !== plan.account_id || record.public_key !== plan.public_key) return false;
  const url = `https://api.github.com/repos/Greatmujey/Bouncer/actions/artifacts/${artifact}`;
  const response = await fetch(url, { method: 'GET', redirect: 'error',
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'bouncer-testnet-owner-bootstrap' },
    signal: AbortSignal.timeout(15_000) });
  try {
    if (!response.ok) return false;
    const metadata = await readBoundedJson(response, { maxBytes: 32_768, label: 'public owner attempt artifact' });
    return metadata?.id === Number(artifact) && metadata.name === `owner-fence-${run}-${digest}` && metadata.expired === false &&
      Number.isSafeInteger(metadata.size_in_bytes) && metadata.size_in_bytes > 0 && metadata.size_in_bytes < 16_384 &&
      metadata.workflow_run?.id === Number(run) && metadata.workflow_run?.head_sha === sha;
  } finally { await response.body?.cancel().catch(() => {}); }
}

const provider = new ReadOnlyNearRpcProvider('https://rpc.testnet.near.org', { timeoutMs: 10_000 });
try {
  const result = await requestTestnetOwnerOnce({ plan, provider, persistAttempt });
  console.log(JSON.stringify({ ...result, public_plan_sha256: digest, fence_artifact_id: artifact,
    run_id: run, commit: sha }, null, 2));
} catch (error) {
  // The message contains only public account/operational state. No error stack,
  // response body, Authorization header or private key is printed.
  console.error(`Testnet owner bootstrap stopped: ${error?.message ?? 'unknown error'}`);
  process.exitCode = 1;
}
