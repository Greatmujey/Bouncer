import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/local-model.sh', import.meta.url));
const workflow = fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url));
const run = (args = [], env = {}) => spawnSync('bash', [script, ...args], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 5000 });

test('local model bootstrap discloses the download and validates options before network access', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /1\.12 GB/);
  assert.match(help.stdout, /127\.0\.0\.1/);
  assert.match(help.stdout, /No API key or paid inference/);
  assert.equal(run(['--unknown']).status, 2);
  for (const env of [{ BOUNCER_MODEL_PORT: '0' }, { BOUNCER_MODEL_PORT: '1;whoami' }, { BOUNCER_MODEL_THREADS: '100' }]) {
    const result = run([], env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid BOUNCER_MODEL_/);
  }
});

test('a corrupt existing cached runtime is refused, not overwritten or executed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-model-script-'));
  try {
    const archive = path.join(dir, 'llama-b11932-bin-ubuntu-x64.tar.gz');
    fs.writeFileSync(archive, 'not a valid archive');
    const result = run(['--prepare'], { BOUNCER_MODEL_CACHE: dir });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /failed SHA-256 verification/);
    assert.equal(fs.readFileSync(archive, 'utf8'), 'not a valid archive');
    assert.deepEqual(fs.readdirSync(dir), ['llama-b11932-bin-ubuntu-x64.tar.gz']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('local bootstrap pins both hashes and opt-in CI uses the same script', () => {
  const local = fs.readFileSync(script, 'utf8'), ci = fs.readFileSync(workflow, 'utf8');
  for (const hash of [
    'dd5370127e82d15130f76876615dcca7fe80d5c451297c37ad4029df0abc84ba',
    '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e',
  ]) {
    assert.ok(local.includes(hash));
  }
  assert.match(ci, /bash bouncer\/scripts\/local-model\.sh --prepare/);
  assert.match(ci, /bash bouncer\/scripts\/local-model\.sh > /);
  assert.match(local, /--host 127\.0\.0\.1/);
  assert.doesNotMatch(local, /curl[^\n]* -k(?:\s|$)/);
});
