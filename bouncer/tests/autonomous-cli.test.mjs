import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import nearApi from 'near-api-js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = 'bouncer/agent/autonomous.mjs';
const baseEnv = { BOUNCER_LLM_URL: 'https://model.example/v1/chat/completions', BOUNCER_LLM_MODEL: 'fake-test-model',
  NODE_OPTIONS: '--import=./bouncer/tests/mock-autonomous-cli.mjs' };
function exec(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, ...baseEnv, ...env }, encoding: 'utf8', timeout: 20_000 });
}
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-autonomous-cli-'));
  const config = path.join(dir, 'owner.json'), objective = path.join(dir, 'objective.txt'), output = path.join(dir, 'goals.json'), key = path.join(dir, 'key.json');
  fs.writeFileSync(config, JSON.stringify({ version: 1, contract_id: 'bouncer.testnet', owner_account_id: 'bouncer.testnet', provider_url: 'https://provider.example', max_tasks: 1,
    resources: { compute: { policy_id: 'compute', token: 'wrap.testnet', payee: 'vendor.testnet', max_amount: '100', max_tasks: 1, max_total_amount: '100' } } }));
  fs.writeFileSync(objective, 'Please hash hello with three rounds.');
  fs.writeFileSync(key, JSON.stringify({ account_id: 'bouncer.testnet', private_key: nearApi.KeyPair.fromRandom('ed25519').toString() }));
  return { dir, output, key, args: ['--config', config, '--objective-file', objective, '--output', output] };
}

test('autonomous CLI only plans without a key, never overwrites, and preflights with a key', () => {
  const f = fixture();
  try {
    const planned = exec(f.args);
    assert.equal(planned.status, 0, planned.stderr);
    assert.match(planned.stdout, /Planning only: no quotes/);
    const goals = JSON.parse(fs.readFileSync(f.output, 'utf8'));
    assert.equal(goals.goals[0].payee, 'vendor.testnet');
    assert.equal(goals.journal_path, `${f.output}.bouncer-journal.json`);
    assert.equal(fs.existsSync(goals.journal_path), false);
    const overwrite = exec(f.args);
    assert.equal(overwrite.status, 1);
    assert.match(overwrite.stderr, /output already exists/);
    assert.equal(fs.readFileSync(f.output, 'utf8'), JSON.stringify(goals, null, 2) + '\n');
    const previewFile = path.join(f.dir, 'preview.json');
    const previewArgs = f.args.map(x => x === f.output ? previewFile : x);
    const preview = exec([...previewArgs, '--key', f.key]);
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /READY compute-1/);
    assert.match(preview.stdout, /Dry run only/);
    assert.doesNotMatch(preview.stdout, /PAID|FULFILLED/);
    assert.equal(fs.existsSync(`${previewFile}.bouncer-journal.json`), false);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('explicit execute uses guarded runner and stable journal with mocked transport', () => {
  const f = fixture();
  try {
    const result = exec([...f.args, '--key', f.key, '--execute']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PAID compute-1/);
    assert.match(result.stdout, /FULFILLED compute-1/);
    const journal = JSON.parse(fs.readFileSync(`${f.output}.bouncer-journal.json`, 'utf8'));
    assert.equal(journal.entries[0].status, 'completed');
    assert.match(exec(f.args).stderr, /output already exists/);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('bad model output, bad quotes, and missing execute key fail without a payment', () => {
  for (const env of [{ MOCK_MODEL_ATTACK: '1' }, { MOCK_MODEL_ERROR: '1' }, { MOCK_BAD_QUOTE: '1' }]) {
    const f = fixture();
    try {
      const result = exec([...f.args, '--key', f.key, '--execute'], env);
      assert.equal(result.status, 1, result.stderr);
      assert.doesNotMatch(result.stdout, /PAID|FULFILLED/);
      assert.equal(fs.existsSync(`${f.output}.bouncer-journal.json`), false);
      if (!env.MOCK_BAD_QUOTE) assert.equal(fs.existsSync(f.output), false);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  }
  const f = fixture();
  try { assert.match(exec([...f.args, '--execute']).stderr, /require --key/); }
  finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('autonomous execution rejects a non-testnet RPC before submitting transactions', () => {
  const f = fixture();
  try {
    const result = exec([...f.args, '--key', f.key, '--execute'], { MOCK_CHAIN: 'mainnet' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /RPC must report the NEAR testnet chain/);
    assert.doesNotMatch(result.stdout, /PAID|FULFILLED/);
    assert.equal(fs.existsSync(`${f.output}.bouncer-journal.json`), false);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('autonomous CLI propagates a blocked dry run without payment', () => {
  const f = fixture();
  try {
    const result = exec([...f.args, '--key', f.key, '--execute'], { MOCK_BLOCKED: '1' });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stdout, /BLOCKED compute-1/);
    assert.doesNotMatch(result.stdout, /PAID|FULFILLED/);
    assert.equal(fs.existsSync(`${f.output}.bouncer-journal.json`), false);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
