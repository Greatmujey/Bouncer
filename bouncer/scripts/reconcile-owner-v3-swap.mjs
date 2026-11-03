#!/usr/bin/env node
/** Read-only recovery of the fixed V3 swap original; this script cannot sign
 * or send. It verifies the retained original-run fence, original FINAL receipt,
 * and fresh pinned balances. Unknown stays unknown. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { ReadOnlyNearReceiptProvider } from '../agent/read-only-near-receipts.mjs';
import { reconcileOwnerAcquisition } from '../agent/circle-owner-acquisition-runner.mjs';
import { githubOriginalFence } from '../agent/github-original-fence.mjs';

const read = url => JSON.parse(fs.readFileSync(new URL(url, import.meta.url), 'utf8'));
const plan = read('../config/testnet-owner-v3-plan.json');
const config = read('../config/testnet-owner-v3-swap-reconcile.json');
const bytes = fs.readFileSync(new URL('../evidence/testnet-owner-v3/swap-original.json', import.meta.url));
const envelope = JSON.parse(bytes.toString('utf8')), digest = crypto.createHash('sha256').update(bytes).digest('hex');
const token = process.env.GITHUB_TOKEN, run = process.env.GITHUB_RUN_ID, commit = process.env.GITHUB_SHA;
if (config.version !== 1 || config.kind !== 'swap' || envelope.kind !== 'swap' || digest !== config.signed_envelope_sha256 ||
    process.env.GITHUB_REPOSITORY !== 'Greatmujey/Bouncer' || process.env.GITHUB_REF !== 'refs/heads/arena/25a7aaf6-near-hub' ||
    !/^[1-9][0-9]{0,19}$/.test(run ?? '') || !/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('fixed original and read-only reconciliation context required');
if (!await githubOriginalFence({ artifactId: config.original_fence_artifact_id, runId: config.original_run_id,
  headSha: config.original_commit, digest, token, maxArtifactBytes: 32_768, prefix: 'acquisition-v3-swap-fence' })) {
  throw new Error('original swap fence metadata unavailable or mismatched');
}
for (const endpoint of ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org']) {
  try {
    const result = await reconcileOwnerAcquisition({ plan, envelope,
      provider: new ReadOnlyNearReceiptProvider(endpoint, { timeoutMs: 15_000 }) });
    console.log(JSON.stringify({ ...result, signed_envelope_sha256: digest,
      fence_artifact_id: config.original_fence_artifact_id, run_id: config.original_run_id, commit: config.original_commit,
      reconciliation_run_id: run, reconciliation_commit: commit, rpc: endpoint }, null, 2));
    process.exit(0);
  } catch (error) {
    const detail = typeof error?.message === 'string' ? error.message.replace(/[\r\n]/g, ' ').slice(0, 300) : 'unknown error';
    console.error(`Original swap unavailable or mismatched at ${new URL(endpoint).hostname}: ${detail}; no send`);
  }
}
console.error(`Original swap ${envelope.tx_hash} remains unresolved; retain the hash and never resend.`);
process.exitCode = 1;
