import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateWorkflow } from '../agent/workflow.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(root, 'bouncer/agent/workflow.mjs');
const example = path.join(root, 'bouncer/examples/dependent-workflow.example.json');
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', timeout: 10_000 });

test('documented workflow example validates and CLI help clearly distinguishes recovery', () => {
  const workflow = validateWorkflow(JSON.parse(fs.readFileSync(example, 'utf8')));
  assert.deepEqual(workflow.steps.map(step => step.id), ['compute', 'storage', 'api']);
  const result = run('--help'); assert.equal(result.status, 0);
  assert.match(result.stdout, /--recover-only/); assert.match(result.stdout, /without keys or new payments/);
});

test('CLI recovery requires the original journal and refuses keys or execution', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-workflow-cli-'));
  try {
    const journal = path.join(dir, 'missing.json');
    const absent = run('--workflow', example, '--journal', journal, '--recover-only');
    assert.equal(absent.status, 1); assert.match(absent.stderr, /original journal not found/); assert.equal(fs.existsSync(journal), false);
    const key = run('--workflow', example, '--journal', journal, '--recover-only', '--source-key', 'never-read.json');
    assert.equal(key.status, 1); assert.match(key.stderr, /without keys/);
    const execute = run('--workflow', example, '--journal', journal, '--recover-only', '--execute');
    assert.equal(execute.status, 1); assert.match(execute.stderr, /without keys/);
    fs.writeFileSync(journal, JSON.stringify({ version: 1, contract_id: 'bouncer.testnet', owner_account_id: 'owner.testnet', entries: [] }));
    const empty = run('--workflow', example, '--journal', journal, '--recover-only');
    assert.equal(empty.status, 0); assert.match(empty.stdout, /NOT_STARTED/); assert.match(empty.stdout, /recovery sent no payments/);
    const unpaid = run('--workflow', example, '--journal', journal, '--ft-key', 'never-read.json', '--execute');
    assert.equal(unpaid.status, 1); assert.match(unpaid.stderr, /source key is required for an unpaid/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
