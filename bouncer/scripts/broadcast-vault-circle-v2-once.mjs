#!/usr/bin/env node
/** CI-only one-shot Circle TESTNET vault setup. No private key is read. A
 * published signed envelope is a bearer and can be relayed before preflight. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { githubOriginalFence } from '../agent/github-original-fence.mjs';
import { validateOwnerBootstrapPlan } from '../agent/testnet-owner-bootstrap.mjs';
import { verifySignedVaultCircle } from '../agent/keyless-vault-circle.mjs';
import { broadcastVaultCircleOnce } from '../agent/keyless-vault-circle-runner.mjs';
import { ExperimentalSvalinSetupRpc } from '../agent/svalin-setup-rpc.mjs';
const kind = process.env.BOUNCER_VAULT_CIRCLE_KIND;
if (!['register','fund'].includes(kind)) throw new Error('a fixed Circle vault action is required');
const plan = validateOwnerBootstrapPlan(JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v2-plan.json', import.meta.url), 'utf8')));
const input = new URL(`../evidence/testnet-owner-v2/vault-circle-${kind}-original.json`, import.meta.url), stat = fs.lstatSync(input);
if (!stat.isFile() || stat.size < 1 || stat.size > 16_384) throw new Error('invalid original Circle vault bearer');
const bytes = fs.readFileSync(input);
if (bytes.length !== stat.size) throw new Error('original Circle vault bearer changed while reading');
const envelope = JSON.parse(bytes.toString('utf8'));
if (envelope.kind !== kind) throw new Error('original Circle vault kind differs');
verifySignedVaultCircle(envelope, plan);
const digest = crypto.createHash('sha256').update(bytes).digest('hex'), run = process.env.GITHUB_RUN_ID,
  attempt = process.env.GITHUB_RUN_ATTEMPT, sha = process.env.GITHUB_SHA,
  artifact = process.env.BOUNCER_FENCE_ARTIFACT_ID, token = process.env.GITHUB_TOKEN;
if (!/^[1-9][0-9]{0,19}$/.test(run ?? '') || attempt !== '1' || !/^[a-f0-9]{40}$/.test(sha ?? '') ||
    !/^[1-9][0-9]{0,19}$/.test(artifact ?? '') || typeof token !== 'string' || token.length < 20 ||
    process.env.GITHUB_REPOSITORY !== 'Greatmujey/Bouncer' || process.env.GITHUB_REF !== 'refs/heads/arena/25a7aaf6-near-hub') {
  throw new Error('Circle vault setup requires the first attempt of the intended branch workflow');
}
async function persistAttempt(record) {
  if (record.kind !== kind || record.tx_hash !== envelope.tx_hash || record.owner !== plan.account_id || record.vault !== envelope.vault) return false;
  return githubOriginalFence({ artifactId: artifact, runId: run, headSha: sha, digest, token, maxArtifactBytes: 32_768,
    prefix: `vault-circle-v2-${kind}-fence` });
}
try {
  const result = await broadcastVaultCircleOnce({ plan, envelope,
    provider: new ExperimentalSvalinSetupRpc('https://rpc.testnet.near.org', { readTimeoutMs: 12_000 }), persistAttempt });
  console.log(JSON.stringify({ ...result, signed_envelope_sha256: digest, fence_artifact_id: artifact, run_id: run, commit: sha }, null, 2));
} catch (error) { console.error(`Original Circle vault ${kind} stopped: ${error?.message ?? 'unknown error'}`); process.exitCode = 1; }
