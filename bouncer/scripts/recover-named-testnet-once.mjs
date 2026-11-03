#!/usr/bin/env node
/** CI-only single helper request. Only the public plan enters GitHub; the
 * corresponding private key stays in the local testnet-only keyring. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';
import { githubOriginalFence } from '../agent/github-original-fence.mjs';
import { recoverNamedTestnetOnce, validateNamedRecoveryPlan } from '../agent/named-testnet-recovery.mjs';

const PARENT = '82b558227f29e84254c445acecc3d165d0593357';
const planPath = new URL('../config/greatmujey-testnet-claim.json', import.meta.url);
const st = fs.lstatSync(planPath);
if (!st.isFile() || st.size < 1 || st.size > 4096) throw new Error('invalid public named-account plan');
const bytes = fs.readFileSync(planPath);
if (bytes.length !== st.size) throw new Error('public plan changed while reading');
const plan = validateNamedRecoveryPlan(JSON.parse(bytes.toString('utf8')));
const digest = crypto.createHash('sha256').update(bytes).digest('hex');
const { GITHUB_RUN_ID: run, GITHUB_RUN_ATTEMPT: attempt, GITHUB_SHA: sha,
  BOUNCER_FENCE_ARTIFACT_ID: artifact, GITHUB_TOKEN: token, GITHUB_EVENT_PATH: eventPath } = process.env;
if (!/^[1-9][0-9]{0,15}$/.test(run ?? '') || attempt !== '1' || !/^[a-f0-9]{40}$/.test(sha ?? '') ||
    !/^[1-9][0-9]{0,15}$/.test(artifact ?? '') || typeof token !== 'string' || token.length < 20 ||
    process.env.GITHUB_REPOSITORY !== 'Greatmujey/Bouncer' || process.env.GITHUB_REF !== 'refs/heads/arena/25a7aaf6-near-hub' ||
    process.env.GITHUB_EVENT_NAME !== 'push' || typeof eventPath !== 'string') {
  throw new Error('named-account recovery is restricted to the intended first-attempt branch push');
}
const eventStat = fs.lstatSync(eventPath);
if (!eventStat.isFile() || eventStat.size < 1 || eventStat.size > 1_000_000) throw new Error('invalid GitHub push event');
const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
if (event.before !== PARENT || event.after !== sha || event.ref !== process.env.GITHUB_REF ||
    !event.head_commit?.message?.includes('[named-testnet-recovery-once]')) throw new Error('unexpected push identity; no helper request');

async function persistAttempt(record) {
  if (record.account_id !== plan.account_id || record.public_key !== plan.public_key ||
      record.circle_balance_atoms !== plan.observed_circle_atoms) return false;
  return githubOriginalFence({ artifactId: artifact, runId: run, headSha: sha, digest, token,
    maxArtifactBytes: 16_384, prefix: 'named-testnet-recovery-fence' });
}
const provider = new ReadOnlyNearRpcProvider('https://rpc.testnet.near.org', { timeoutMs: 10_000 });
try {
  const result = await recoverNamedTestnetOnce({ plan, provider, persistAttempt });
  console.log(JSON.stringify({ ...result, public_plan_sha256: digest, fence_artifact_id: artifact,
    run_id: run, commit: sha }, null, 2));
} catch (error) {
  // The only emitted text is the fixed operational error, never the response.
  console.error(`Named testnet recovery stopped: ${error?.message ?? 'unknown error'}`);
  process.exitCode = 1;
}
