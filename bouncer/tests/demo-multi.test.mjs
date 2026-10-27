import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function run(mode = '') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-multi-test-'));
  try {
    const child = spawnSync(process.execPath, ['--import=./bouncer/tests/mock-multi-near.mjs', 'bouncer/demo-multi-resource.mjs'], {
      cwd: repo, env: { ...process.env, HOME: home, BOUNCER_MOCK_MODE: mode }, encoding: 'utf8', timeout: 30_000,
    });
    const dir = path.join(home, '.bouncer', 'testnet');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const journalFile = files.find(file => file.endsWith('.bouncer-journal.json'));
    const journal = journalFile ? JSON.parse(fs.readFileSync(path.join(dir, journalFile), 'utf8')) : null;
    const planFile = files.find(file => file.endsWith('.plan.json'));
    const plan = planFile ? JSON.parse(fs.readFileSync(path.join(dir, planFile), 'utf8')) : null;
    return { ...child, journal, plan };
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

test('multi-token setup and real procurement runner complete using a mock transport', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Three real testnet FT payments and self-hosted resource services verified/);
  assert.match(result.stdout, /self-hosted development provider, not commercial/);
  assert.deepEqual(result.plan.requests.map(r => r.resource), ['compute', 'storage', 'api']);
  assert.equal(new Set(result.plan.requests.map(r => r.token)).size, 3);
  assert.equal(result.journal.entries.filter(e => e.status === 'completed').length, 3);
  assert.equal((result.stdout.match(/\[procurement\] PAID /g) || []).length, 3);
  assert.equal((result.stdout.match(/\[procurement\] SKIP /g) || []).length, 3);
  assert.equal((result.stdout.match(/\[resource-agent\] FULFILLED /g) || []).length, 6);
  assert.equal((result.stdout.match(/VERIFIED /g) || []).length, 3);
  assert.match(result.stdout, /Provider rejected a changed order/);
});

test('a token factory failure stops the multi-token run, without claiming success', () => {
  const result = run('factory_failure');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /factory unavailable/);
  assert.doesNotMatch(result.stdout, /Three real testnet FT payments and self-hosted resource services verified/);
});
