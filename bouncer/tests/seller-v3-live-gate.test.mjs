import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ci = fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url));
const demo = fileURLToPath(new URL('../demo-oracle-mission.mjs', import.meta.url));
const proof = fileURLToPath(new URL('../agent/dependent-live-proof.mjs', import.meta.url));
test('authenticated testnet workflow is opt-in, first-attempt-only and preserves sensitive recovery state', () => {
  const workflow = fs.readFileSync(ci, 'utf8');
  const job = workflow.split('\n  seller-v3-workflow-live:\n')[1]?.split('\n  reconcile-seller-v3-oracle:\n')[0];
  assert.ok(job);
  assert.match(job, /github\.event_name == 'push'/); assert.match(job, /github\.event\.repository\.private == true/);
  assert.match(job, /github\.run_attempt == '1'/);
  assert.match(job, /contains\(github\.event\.head_commit\.message, '\[seller-v3-live\]'\)/);
  assert.match(job, /needs: \[js-tests, contract-tests, build-contract\]/);
  assert.match(job, /node bouncer\/demo-oracle-mission\.mjs --seller-v3-workflow/);
  assert.match(job, /if: always\(\)/); assert.match(job, /claim signatures/);
  for (const name of ['journal.json', 'setup-journal.json', 'workflow.json', 'provider-config.json', 'development-provider']) assert.ok(job.includes(name));
  assert.doesNotMatch(job, /\*\/[^\n]*(?:private_key|secret_key|\.near-credentials)/i);
  const src = fs.readFileSync(demo, 'utf8');
  assert.match(src, /const sellerV3 = args\[0\] === '--seller-v3-workflow'/);
  assert.match(src, /orderBinding: 'seller-v3'/); assert.match(src, /verifySellerV3AccessControls/);
  const probes = fs.readFileSync(proof, 'utf8');
  assert.match(probes, /public proof without claim signature/);
  assert.match(probes, /wrong-key signed claim/);
  assert.match(probes, /unauthenticated storage read/);
});

test('fresh testnet proof uses a distinct marker, journal directory and first attempt only', () => {
  const workflow = fs.readFileSync(ci, 'utf8');
  const job = workflow.split('\n  seller-v3-fresh-proof:\n')[1]?.split('\n  x402-independent-inspection:\n')[0];
  assert.ok(job); assert.match(job, /github\.event_name == 'push'/); assert.match(job, /github\.event\.repository\.private == true/);
  assert.match(job, /github\.ref == 'refs\/heads\/arena\/88d70c7c-near-hub'/);
  assert.match(job, /github\.event\.before == 'a1abce25721de00c6123dcb2cbe23d51077a1c12'/);
  assert.match(job, /github\.run_attempt == '1'/); assert.match(job, /\[seller-v3-fresh-20261101\]/);
  assert.match(job, /needs: \[js-tests, contract-tests, build-contract\]/);
  assert.match(job, /demo-oracle-mission\.mjs --seller-v3-fresh/); assert.match(job, /if: always\(\)/);
  assert.match(job, /seller-v3-fresh-restricted-recovery/); assert.match(job, /bouncer-seller-v3-fresh-\*/);
  assert.doesNotMatch(job, /\[seller-v3-live\]|41268548592|CCbbcM73/);
  assert.doesNotMatch(job, /\*\/[^\n]*(?:private_key|secret_key|\.near-credentials)/i);
  const src = fs.readFileSync(demo, 'utf8');
  assert.match(src, /sellerV3Fresh = args\[0\] === '--seller-v3-fresh'/); assert.match(src, /recoverSourceWithoutKeys/);
  const proofSrc = fs.readFileSync(proof, 'utf8');
  assert.match(proofSrc, /sourceBroadcasts === 1 && resourceBroadcasts === 0/);
  assert.match(proofSrc, /status === 'completed'.*tx_hash === sourceHash/);
});

test('oracle reconciliation is pinned to the original artifact and cannot trigger another paid proof', () => {
  const workflow = fs.readFileSync(ci, 'utf8');
  const job = workflow.split('\n  reconcile-seller-v3-oracle:\n')[1]?.split('\n  piprail-onchain-proof-live:\n')[0];
  assert.ok(job); assert.match(job, /\[seller-v3-reconcile\]/); assert.match(job, /run-id: 41268548592/);
  assert.match(job, /seller-v3-restricted-recovery-evidence/); assert.match(job, /CCbbcM73XZc1r8WcmyPMYHaudaR7qfjKKYhihZpHcuZ8/);
  assert.match(job, /reconcile-oracle-journal\.mjs/); assert.match(job, /unexpected resource payment/);
  assert.doesNotMatch(job, /--execute|--key|demo-oracle-mission|upload-artifact/);
});
