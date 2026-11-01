import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ci = fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url));
const demo = fileURLToPath(new URL('../demo-onchain-proof.mjs', import.meta.url));
test('onchain-proof testnet payment is explicitly gated, first-attempt-only and preserves public journals', () => {
  const workflow = fs.readFileSync(ci, 'utf8');
  const job = workflow.split('\n  piprail-onchain-proof-live:\n')[1]?.split('\n  ft-call-live:\n')[0];
  assert.ok(job);
  assert.match(job, /github\.event_name == 'push'/);
  assert.match(job, /github\.run_attempt == '1'/);
  assert.match(job, /contains\(github\.event\.head_commit\.message, '\[piprail-live\]'\)/);
  assert.match(job, /needs: \[js-tests, contract-tests, build-contract\]/);
  assert.match(job, /node bouncer\/demo-onchain-proof\.mjs/);
  assert.match(job, /if: always\(\)/);
  for (const file of ['setup-journal.json', 'journal.json', 'goal.json', 'evidence.json']) assert.ok(job.includes(file));
  assert.doesNotMatch(job, /\*\/[^\n]*(?:private_key|secret_key|\.near-credentials)/i);
  const src = fs.readFileSync(demo, 'utf8');
  assert.match(src, /submitOwnerSetupOnce/); assert.match(src, /runOnchainProofLiveProof/);
  assert.match(src, /seller: 'self-hosted local SDK gate; not an independent merchant'/);
});
