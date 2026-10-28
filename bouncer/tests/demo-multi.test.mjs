import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function run(mode = '', ai = false, publicData = false, compare = false, badDelivery = false) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-multi-test-'));
  try {
    const child = spawnSync(process.execPath, ['--import=./bouncer/tests/mock-multi-near.mjs', 'bouncer/demo-multi-resource.mjs'], {
      cwd: repo, env: { ...process.env, HOME: home, BOUNCER_MOCK_MODE: mode, BOUNCER_DEMO_AI: ai ? '1' : '', BOUNCER_DEMO_PUBLIC_DATA: publicData ? '1' : '',
        BOUNCER_DEMO_COMPARE: compare ? '1' : '', BOUNCER_DEMO_BAD_DELIVERY: badDelivery ? '1' : '',
        BOUNCER_LLM_URL: 'https://model.example/v1/chat/completions', BOUNCER_LLM_MODEL: 'mock-model' }, encoding: 'utf8', timeout: 30_000,
    });
    const dir = path.join(home, '.bouncer', 'testnet');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const journalFile = files.find(file => file.endsWith('.bouncer-journal.json'));
    const journal = journalFile ? JSON.parse(fs.readFileSync(path.join(dir, journalFile), 'utf8')) : null;
    const planFile = files.find(file => file.endsWith('.plan.json'));
    const plan = planFile ? JSON.parse(fs.readFileSync(path.join(dir, planFile), 'utf8')) : null;
    const goalsFile = files.find(file => file.endsWith('.goals.json') && !file.endsWith('.comparison.goals.json') && !file.endsWith('.public-data.goals.json'));
    const comparisonFile = files.find(file => file.endsWith('.comparison.goals.json'));
    const providerFile = files.find(file => file.endsWith('.provider.json'));
    const ownerFile = files.find(file => file.endsWith('.owner.json'));
    const goals = goalsFile ? JSON.parse(fs.readFileSync(path.join(dir, goalsFile), 'utf8')) : null;
    const provider = providerFile ? JSON.parse(fs.readFileSync(path.join(dir, providerFile), 'utf8')) : null;
    const owner = ownerFile ? JSON.parse(fs.readFileSync(path.join(dir, ownerFile), 'utf8')) : null;
    const comparison = comparisonFile ? JSON.parse(fs.readFileSync(path.join(dir, comparisonFile), 'utf8')) : null;
    return { ...child, journal, plan, goals, provider, owner, comparison };
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

test('multi-token setup and real procurement runner complete using a mock transport', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Three real testnet FT payments and self-hosted resource services verified/);
  assert.match(result.stdout, /self-hosted development provider, not commercial/);
  assert.deepEqual(result.plan.requests.map(r => r.resource), ['compute', 'storage', 'api']);
  assert.equal(new Set(result.plan.requests.map(r => r.token)).size, 3);
  assert.match(result.goals.journal_path, /\.bouncer-journal\.json$/);
  assert.equal(result.goals.goals.length, 3);
  assert.equal(Object.keys(result.provider.products).length, 3);
  assert.equal(Object.keys(result.owner.resources).length, 3);
  assert.equal(result.owner.resources.compute.token, 'wrap.testnet');
  assert.equal(result.owner.resources.storage.max_amount, result.provider.products.storage.amount);
  assert.equal(result.journal.entries.filter(e => e.status === 'completed').length, 3);
  assert.ok(result.journal.entries.every(e => e.delivery.receipt.provider_origin === result.goals.provider_url));
  assert.equal((result.stdout.match(/\[procurement\] PAID /g) || []).length, 3);
  assert.equal((result.stdout.match(/\[procurement\] SKIP /g) || []).length, 3);
  assert.equal((result.stdout.match(/\[resource-agent\] FULFILLED /g) || []).length, 6);
  assert.equal((result.stdout.match(/VERIFIED /g) || []).length, 3);
  assert.match(result.stdout, /Provider rejected a changed order/);
});

test('demo setup retries only an explicit pre-admission Expired error once', () => {
  for (const mode of ['setup_expired_once', 'setup_policy_expired_once']) {
    const result = run(mode);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Testnet demo setup .* explicit expired transaction; retrying once/);
    assert.equal((result.stderr.match(/retrying once/g) || []).length, 1);
    assert.equal(result.journal.entries.filter(entry => entry.status === 'completed').length, 3);
  }
  for (const mode of ['setup_expired_twice', 'setup_timeout', 'setup_expired_with_outcome']) {
    const result = run(mode);
    assert.equal(result.status, 1);
    assert.equal((result.stderr.match(/retrying once/g) || []).length, mode === 'setup_expired_twice' ? 1 : 0);
    assert.equal(result.journal, null);
  }
});

test('an expired procurement payment is never retried by the demo setup helper', () => {
  const result = run('payment_expired');
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /retrying once/);
  assert.match(result.stderr, /payment could not be confirmed/);
  assert.equal(result.journal.entries.length, 1);
  assert.equal(result.journal.entries[0].status, 'pending');
});

test('two approved local providers are compared and the cheaper is paid once with mocked testnet', () => {
  const result = run('', false, false, true);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /VERIFIED owner-approved comparison/);
  assert.match(result.stdout, /Both compared endpoints are self-hosted development services/);
  assert.equal(result.comparison.goals[0].provider_id, 'alternative');
  assert.equal(result.comparison.goals[0].token, 'wrap.testnet');
  assert.equal(result.comparison.goals[0].quote_amount, '80000000000000000000000');
  assert.equal(result.comparison.quote_comparisons[0].quotes[0].amount, '100000000000000000000000');
  assert.equal(result.journal.entries.filter(e => e.status === 'completed').length, 4);
  assert.equal((result.stdout.match(/\[procurement\] PAID /g) || []).length, 4);
  assert.equal((result.stdout.match(/\[procurement\] SKIP /g) || []).length, 4);
});

test('model-planned multi-resource path completes with a mocked model and mocked testnet', () => {
  const result = run('', true);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Model proposed the three requested inputs/);
  assert.match(result.stdout, /resource inputs were planned by the configured model/);
  assert.deepEqual(result.goals.goals.map(g => g.resource), ['compute', 'storage', 'api']);
  assert.equal(result.journal.entries.filter(e => e.status === 'completed').length, 3);
});

test('model-planned public data adds a fourth payment with replay safety using mocked transports', () => {
  const result = run('', true, true);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Model also proposed the requested public GitHub data lookup/);
  assert.match(result.stdout, /VERIFIED public GitHub data: near\/near-api-js, repository ID 184860689/);
  assert.equal(result.journal.entries.filter(e => e.status === 'completed').length, 4);
  assert.equal((result.stdout.match(/\[procurement\] PAID /g) || []).length, 4);
  assert.equal((result.stdout.match(/\[procurement\] SKIP /g) || []).length, 4);
});

test('combined mock-model flow plans comparison work and pays the selected provider once', () => {
  const result = run('', true, true, true);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Model also proposed the comparison compute task before testnet setup/);
  assert.match(result.stdout, /VERIFIED public GitHub data/);
  assert.match(result.stdout, /VERIFIED owner-approved comparison/);
  assert.equal(result.comparison.goals[0].provider_id, 'alternative');
  assert.equal(result.journal.entries.filter(e => e.status === 'completed').length, 5);
  assert.equal((result.stdout.match(/\[procurement\] PAID /g) || []).length, 5);
  assert.equal((result.stdout.match(/\[procurement\] SKIP /g) || []).length, 5);
});

test('mocked combined run rejects an injected bad delivery and recovers the same payment without requoting', () => {
  const result = run('', true, true, true, true);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Injected an incorrect local reply after payment: rejected, then recovered with the same transaction and no requote/);
  assert.match(result.stdout, /First locally corrupted reply stopped the batch before storage\/API payments; recovery reused the first payment/);
  assert.match(result.stdout, /Private journal receipts bind payments to agent-checked results/);
  assert.equal(result.journal.entries.filter(e => e.status === 'completed' && e.delivery?.status === 'verified').length, 5);
  assert.equal(result.journal.entries.find(e => e.id === 'compute-market-1').delivery.receipt.verification.scope, 'iterated-sha256');
  assert.equal(result.journal.entries.find(e => e.id === 'storage-1').delivery.receipt.verification.scope, 'single-read-content');
  assert.equal(result.journal.entries.find(e => e.id === 'api-github-1').delivery.receipt.verification.scope, 'repository-identity-only');
  assert.equal((result.stdout.match(/\[procurement\] PAID /g) || []).length, 5);
  assert.equal((result.stdout.match(/\[procurement\] SKIP /g) || []).length, 7);
});

test('an inaccurate model comparison task fails before any account setup', () => {
  const result = run('comparison_wrong', true, true, true);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /model did not reproduce the comparison task/);
  assert.doesNotMatch(result.stdout, /Create funded Bouncer|PAID|FULFILLED/);
  assert.equal(result.journal, null);
});

test('one model-only correction is allowed before setup; repeated wrong repository fails closed', () => {
  const corrected = run('wrong_repo_once', true, true);
  assert.equal(corrected.status, 0, corrected.stderr);
  assert.match(corrected.stdout, /requesting one correction before any testnet setup/);
  assert.match(corrected.stdout, /VERIFIED public GitHub data/);
  const repeated = run('wrong_repo_always', true, true);
  assert.equal(repeated.status, 1);
  assert.match(repeated.stderr, /model did not select the requested public repository/);
  assert.doesNotMatch(repeated.stdout, /Create funded Bouncer|PAID/);
  assert.equal(repeated.journal, null);
});

test('a malicious or inaccurate model plan fails before any testnet setup', () => {
  for (const mode of ['model_attack', 'model_wrong_input']) {
    const result = run(mode, true);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /Create funded Bouncer|PAID|FULFILLED/);
    assert.equal(result.journal, null);
    assert.equal(result.plan, null);
  }
});

test('multi-token setup refuses a non-testnet RPC before creating accounts', () => {
  const result = run('wrong_chain');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RPC must report the NEAR testnet chain/);
  assert.doesNotMatch(result.stdout, /Create funded Bouncer|PAID/);
});

test('a token factory failure stops the multi-token run, without claiming success', () => {
  const result = run('factory_failure');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /factory unavailable/);
  assert.doesNotMatch(result.stdout, /Three real testnet FT payments and self-hosted resource services verified/);
});
