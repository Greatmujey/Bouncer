/** SINGLE-ATTEMPT V3/V12 testnet deploy. A retained GitHub original-hash
 * artifact, a fresh FINAL snapshot, canonical original block and unchanged
 * signature are mandatory. An uncertain result is reconciled read-only;
 * never resend or replace the original. CI receives no owner private key. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ExperimentalSvalinSetupRpc } from '../agent/svalin-setup-rpc.mjs';
import { githubOriginalFence } from '../agent/github-original-fence.mjs';
import { broadcastVaultBootstrapOnce } from '../agent/keyless-vault-v12-runner.mjs';
const read = rel => JSON.parse(fs.readFileSync(path.join(process.cwd(), rel), 'utf8'));
const plan = read('config/testnet-owner-v3-plan.json');
const file = path.join(process.cwd(), 'evidence/testnet-owner-v3/vault-v12-bootstrap-original.json');
const bytes = fs.readFileSync(file), envelope = JSON.parse(bytes);
const digest = crypto.createHash('sha256').update(bytes).digest('hex');
const artifactId = process.env.BOUNCER_FENCE_ARTIFACT_ID, runId = process.env.GITHUB_RUN_ID;
const headSha = process.env.GITHUB_SHA, token = process.env.GITHUB_TOKEN;
const provider = new ExperimentalSvalinSetupRpc('https://test.rpc.fastnear.com');
const result = await broadcastVaultBootstrapOnce({ plan, envelope, provider,
  persistAttempt: async attempt => attempt.tx_hash === envelope.tx_hash && attempt.owner === plan.account_id &&
    await githubOriginalFence({ artifactId, runId, headSha, digest, token, maxArtifactBytes: 1_500_000,
      prefix: 'vault-v3-v12-bootstrap-fence' }) });
console.log(JSON.stringify({ ...result, run_id: runId, fence_artifact_id: artifactId,
  signed_envelope_sha256: digest, commit: headSha }, null, 2));
