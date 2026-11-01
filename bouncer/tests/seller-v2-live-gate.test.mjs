import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ci = fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url));
const demo = fileURLToPath(new URL('../demo-oracle-mission.mjs', import.meta.url));

test('seller-v2 paid testnet job is explicit, isolated, first-attempt-only and retains public recovery state', () => {
  const workflow = fs.readFileSync(ci, 'utf8');
  const job = workflow.split('\n  seller-v2-workflow-live:\n')[1]?.split('\n  ft-call-live:\n')[0];
  assert.ok(job, 'the isolated v2 job must exist');
  assert.match(job, /github\.event_name == 'push'/);
  assert.match(job, /github\.run_attempt == '1'/);
  assert.match(job, /contains\(github\.event\.head_commit\.message, '\[seller-v2-live\]'\)/);
  assert.match(job, /needs: \[js-tests, contract-tests, build-contract\]/);
  assert.match(job, /node bouncer\/demo-oracle-mission\.mjs --seller-v2-workflow/);
  assert.match(job, /if: always\(\)/);
  for (const file of ['setup-journal.json', 'journal.json', 'workflow.json', 'provider-config.json', 'development-provider']) {
    assert.ok(job.includes(file), `public recovery evidence must include ${file}`);
  }
  assert.doesNotMatch(job, /\*\/[^\n]*(?:private_key|secret_key|\.near-credentials)/i);
  const source = fs.readFileSync(demo, 'utf8');
  assert.match(source, /const sellerV2 = args\[0\] === '--seller-v2-workflow'/);
  assert.match(source, /sellerV2 \? \{ orderBinding: 'seller-v2' \} : \{\}/);
});
