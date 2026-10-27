import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import nearApi from 'near-api-js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = 'bouncer/agent/resource-agent.mjs';
const preload = '--import=./bouncer/tests/mock-resource-cli.mjs';
function exec(args, env = {}) {
  return spawnSync(process.execPath, [preload, cli, ...args], { cwd: repo, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 15_000 });
}
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-cli-test-'));
  const goals = path.join(dir, 'goals.json'), key = path.join(dir, 'agent.json'), journal = path.join(dir, 'journal.json');
  fs.writeFileSync(goals, JSON.stringify({ contract_id: 'bouncer.testnet', owner_account_id: 'bouncer.testnet', provider_url: 'https://provider.example', journal_path: journal, goals: [{
    id: 'compute-1', resource: 'compute', policy_id: 'compute', token: 'wrap.testnet', payee: 'vendor.testnet', max_amount: '100', input: { text: 'hello', rounds: 3 },
  }] }));
  fs.writeFileSync(key, JSON.stringify({ account_id: 'bouncer.testnet', private_key: nearApi.KeyPair.fromRandom('ed25519').toString() }));
  return { dir, goals, key, journal, args: ['--goals', goals, '--key', key] };
}

test('resource CLI defaults to dry run; execution and retry use the local journal', () => {
  const f = fixture();
  try {
    const dry = exec(f.args);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /Dry run only/);
    assert.match(dry.stdout, /READY compute-1/);
    assert.equal(fs.existsSync(f.journal), false);
    const live = exec([...f.args, '--execute']);
    assert.equal(live.status, 0, live.stderr);
    assert.match(live.stdout, /PAID compute-1/);
    assert.match(live.stdout, /FULFILLED compute-1/);
    assert.equal(JSON.parse(fs.readFileSync(f.journal, 'utf8')).entries[0].status, 'completed');
    const again = exec([...f.args, '--execute']);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /SKIP compute-1/);
    assert.doesNotMatch(again.stdout, /PAID compute-1/);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('resource CLI rejects an untrusted quote before payment or fulfillment', () => {
  const f = fixture();
  try {
    const result = exec([...f.args, '--execute'], { MOCK_BAD_QUOTE: '1' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /quote does not match/);
    assert.doesNotMatch(result.stdout, /PAID|FULFILLED/);
    assert.equal(fs.existsSync(f.journal), false);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('resource CLI help does not require files and unknown flags fail', () => {
  assert.match(exec(['--help']).stdout, /Default is read-only/);
  const result = exec(['--not-a-flag']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown or incomplete/);
});


test('resource CLI returns a nonzero blocked result without paying or fulfilling', () => {
  const f = fixture();
  try {
    const result = exec([...f.args, '--execute'], { MOCK_BLOCKED: '1' });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stdout, /BLOCKED compute-1/);
    assert.doesNotMatch(result.stdout, /PAID|FULFILLED/);
    assert.equal(fs.existsSync(f.journal), false);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});


test('resource CLI starts its local provider for dry run, payment and replay recovery with mocked RPC', () => {
  const f = fixture();
  try {
    const goals = JSON.parse(fs.readFileSync(f.goals, 'utf8')); goals.provider_url = 'http://127.0.0.1:0';
    fs.writeFileSync(f.goals, JSON.stringify(goals));
    const providerFile = path.join(f.dir, 'provider.json');
    const products = Object.fromEntries(['compute', 'storage', 'api'].map(name => [name, {
      policy_id: name, token: 'wrap.testnet', payee: 'vendor.testnet', amount: '80',
    }]));
    fs.writeFileSync(providerFile, JSON.stringify({ contract_id: 'bouncer.testnet', data_dir: path.join(f.dir, 'data'), port: 0, products }));
    const result = exec([...f.args, '--local-provider', providerFile]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Local development provider/);
    assert.match(result.stdout, /READY compute-1/);
    assert.match(result.stdout, /Dry run only/);
    assert.equal(fs.existsSync(f.journal), false);
    const paid = exec([...f.args, '--local-provider', providerFile, '--execute']);
    assert.equal(paid.status, 0, paid.stderr);
    assert.match(paid.stdout, /PAID compute-1/);
    assert.match(paid.stdout, /FULFILLED compute-1/);
    const repeated = exec([...f.args, '--local-provider', providerFile, '--execute']);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.match(repeated.stdout, /SKIP compute-1/);
    assert.match(repeated.stdout, /FULFILLED compute-1/);
    const bad = JSON.parse(fs.readFileSync(providerFile, 'utf8')); bad.contract_id = 'other.testnet';
    fs.writeFileSync(providerFile, JSON.stringify(bad));
    const mismatch = exec([...f.args, '--local-provider', providerFile]);
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /contract does not match/);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
