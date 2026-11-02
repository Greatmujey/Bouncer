#!/usr/bin/env node
/** CI-only single broadcast of the original, locally signed public bearer.
 * The private testnet key never enters GitHub. Never retry this original. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { ExperimentalSvalinSetupRpc } from '../agent/svalin-setup-rpc.mjs';
import { githubOriginalFence } from '../agent/github-original-fence.mjs';
import { broadcastNamedVaultTopupOnce } from '../agent/named-vault-topup-runner.mjs';
import { verifySignedNamedVaultTopup, TOPUP_SOURCE, TOPUP_VAULT, TOPUP_ATOMS } from '../agent/named-vault-topup.mjs';

const PARENT = '3ad41fbd970ea7e0378e0d481e80c1d4b640d9d8';
const plan = JSON.parse(fs.readFileSync(new URL('../config/greatmujey-testnet-claim.json', import.meta.url), 'utf8'));
const file = new URL('../evidence/greatmujey-testnet/vault-topup-original.json', import.meta.url), stat = fs.lstatSync(file);
if (!stat.isFile() || stat.size < 1 || stat.size > 16_384) throw new Error('invalid original topup bearer');
const bytes = fs.readFileSync(file);
if (bytes.length !== stat.size) throw new Error('original topup changed while reading');
const envelope = JSON.parse(bytes.toString('utf8')); verifySignedNamedVaultTopup(envelope, plan);
const digest = crypto.createHash('sha256').update(bytes).digest('hex');
const { GITHUB_RUN_ID: run, GITHUB_RUN_ATTEMPT: attempt, GITHUB_SHA: sha,
  BOUNCER_FENCE_ARTIFACT_ID: artifact, GITHUB_TOKEN: token, GITHUB_EVENT_PATH: eventPath } = process.env;
if (!/^[1-9][0-9]{0,15}$/.test(run ?? '') || attempt !== '1' || !/^[a-f0-9]{40}$/.test(sha ?? '') ||
    !/^[1-9][0-9]{0,15}$/.test(artifact ?? '') || typeof token !== 'string' || token.length < 20 ||
    process.env.GITHUB_REPOSITORY !== 'Greatmujey/Bouncer' || process.env.GITHUB_REF !== 'refs/heads/arena/25a7aaf6-near-hub' ||
    process.env.GITHUB_EVENT_NAME !== 'push' || typeof eventPath !== 'string') throw new Error('unexpected topup workflow identity');
const eventStat = fs.lstatSync(eventPath);
if (!eventStat.isFile() || eventStat.size < 1 || eventStat.size > 1_000_000) throw new Error('invalid GitHub push event');
const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
if (event.before !== PARENT || event.after !== sha || event.ref !== process.env.GITHUB_REF ||
    !event.head_commit?.message?.includes('[named-vault-topup-once]')) throw new Error('unexpected push identity; no broadcast');

async function persistAttempt(record) {
  if (record.tx_hash !== envelope.tx_hash || record.source !== TOPUP_SOURCE || record.vault !== TOPUP_VAULT ||
      record.amount_atoms !== TOPUP_ATOMS) return false;
  return githubOriginalFence({ artifactId: artifact, runId: run, headSha: sha, digest, token,
    maxArtifactBytes: 32_768, prefix: 'named-vault-topup-fence' });
}
const provider = new ExperimentalSvalinSetupRpc('https://rpc.testnet.near.org', { readTimeoutMs: 10_000 });
try {
  const result = await broadcastNamedVaultTopupOnce({ plan, envelope, provider, persistAttempt });
  console.log(JSON.stringify({ ...result, original_envelope_sha256: digest, fence_artifact_id: artifact,
    run_id: run, commit: sha }, null, 2));
} catch {
  console.error(`Original testnet topup ${envelope.tx_hash} not safely confirmed; retain the original and reconcile, never resend.`);
  process.exitCode = 1;
}
