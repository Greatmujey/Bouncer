// Actual recovery CLIs, synthetic local files and deliberately disabled network.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FileJournal } from '../agent/procurement.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const denyNetwork = fileURLToPath(new URL('./fixtures/deny-test-network.mjs', import.meta.url));
const disappear = fileURLToPath(new URL('./fixtures/disappear-locked-journal.mjs', import.meta.url));
const readExample = name => JSON.parse(fs.readFileSync(path.join(root, 'examples', name), 'utf8'));
const common = { contract_id: 'bouncer.testnet', owner_account_id: 'owner.testnet' };

test('all file recovery CLIs stop if the original disappears under the lock, without a send or replacement', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-recovery-race-'));
  const key = crypto.randomBytes(32), keyFile = path.join(dir, 'key');
  const writeInput = (name, value) => { const file = path.join(dir, `${name}.json`); fs.writeFileSync(file, JSON.stringify(value)); return file; };
  try {
    fs.writeFileSync(keyFile, key, { mode: 0o600 });
    const resource = { ...readExample('seller-v3-goals.example.json'), ...common };
    const resourceFile = writeInput('resources', resource);
    const oracleWorkflow = readExample('dependent-workflow.example.json');
    const workflowFile = writeInput('workflow', oracleWorkflow);
    const oracleFile = writeInput('oracle', oracleWorkflow.source.goal);
    const onchain = readExample('onchain-proof-goal.example.json');
    onchain.accept_public_proof_risk = true; onchain.accept_unbound_resource_risk = true;
    const onchainFile = writeInput('onchain', onchain);
    const proofWorkflow = readExample('onchain-proof-workflow.example.json');
    proofWorkflow.source.goal.accept_public_proof_risk = true; proofWorkflow.source.goal.accept_unbound_resource_risk = true;
    proofWorkflow.source.output.accept_untrusted_data_risk = true;
    const proofWorkflowFile = writeInput('proof-workflow', proofWorkflow);
    const ft = { id: 'api-credit', ...common, policy_id: 'api', payee: 'vendor.testnet', token: 'usdc.fakes.testnet',
      amount: '100', msg: '{"action":"deposit_balance"}', policy_revision: 1, route_revision: 2 };
    const ftFile = writeInput('ft', ft);
    const outlayer = { id: 'random-1', ...common, policy_id: 'external-compute', amount: '100', input: { min: 1, max: 100 },
      program: { url: 'https://example.org/pinned.wasm', sha256: 'a'.repeat(64), build_target: 'wasm32-wasip1',
        max_instructions: 10_000_000, max_memory_mb: 128, max_execution_seconds: 60 } };
    const outlayerFile = writeInput('outlayer', outlayer);
    const project = { id: 'paid-fetch', ...common, native_policy_id: 'api-native', amount: '100', expected_author: 'zavodil.testnet',
      route: { project: { project_id: 'connectors.outlayer.testnet/connector-probe', version_key: 'a'.repeat(64),
        usd_policy_id: 'api-token', token: 'usdc.fakes.testnet', attached_usd: '15000', input_data: '{"operation":"fetch"}',
        max_instructions: 1_000_000_000, max_memory_mb: 256, max_execution_seconds: 60 },
      route_revision: 1, native_policy_revision: 1, usd_policy_revision: 1, native_payee_revision: 1, usd_payee_revision: 1, active: true } };
    const projectFile = writeInput('project', project);
    const cases = [
      { name: 'payment', scope: resource, script: 'recover-direct-payment', args: s => ['--goals', resourceFile, '--id', 'compute-demo', '--state', s] },
      { name: 'delivery', scope: resource, script: 'recover-direct-delivery', args: s => ['--goals', resourceFile, '--id', 'compute-demo', '--state', s] },
      { name: 'workflow', scope: oracleWorkflow.source.goal, script: 'workflow', args: s => ['--workflow', workflowFile, '--journal', s, '--recover-only'] },
      { name: 'proof-workflow', scope: proofWorkflow.source.goal, script: 'workflow', args: s => ['--workflow', proofWorkflowFile, '--journal', s, '--recover-only', '--redeem-source'] },
      { name: 'onchain', scope: onchain, script: 'onchain-proof', args: s => ['--goal', onchainFile, '--state', s, '--recover', '--redeem'] },
      { name: 'ft', scope: ft, script: 'ft-call', args: s => ['--goal', ftFile, '--state', s, '--recover'] },
      { name: 'oracle', scope: oracleWorkflow.source.goal, script: 'oracle-outlayer', args: s => ['--goal', oracleFile, '--state', s, '--recover'] },
      { name: 'project', scope: project, script: 'outlayer-project', args: s => ['--goal', projectFile, '--state', s, '--recover'] },
      { name: 'outlayer', scope: outlayer, script: 'outlayer', args: s => ['--goal', outlayerFile, '--state', s, '--recover'] },
    ];
    for (const encrypted of [false, true]) {
      for (const item of cases) {
        const state = path.join(dir, `${encrypted ? 'encrypted' : 'plaintext'}-${item.name}.journal`);
        const journal = new FileJournal(state, item.scope.contract_id, item.scope.owner_account_id, encrypted ? { encryptionKey: key } : {});
        journal.put('pending', { status: 'pending', fingerprint: 'synthetic', tx_hash: 'original-synthetic-hash' }); journal.close();
        const original = fs.readFileSync(state);
        const child = spawnSync(process.execPath, [`--import=${denyNetwork}`, `--import=${disappear}`,
          path.join(root, 'agent', `${item.script}.mjs`), ...item.args(state)], {
          env: { ...process.env, BOUNCER_FILE_JOURNAL_KEY_FILE: encrypted ? keyFile : undefined, BOUNCER_TEST_DISAPPEARING_JOURNAL: state },
          encoding: 'utf8', timeout: 15_000,
        });
        const label = `${item.name} ${encrypted ? 'encrypted' : 'plaintext'}`;
        assert.equal(child.status, 1, `${label}: ${child.stderr}`);
        assert.match(child.stderr, /original journal not found; refusing to create an empty journal/, label);
        assert.doesNotMatch(child.stdout + child.stderr, /unexpected network request/, label);
        assert.equal(fs.existsSync(state), false, label);
        assert.equal(fs.existsSync(`${state}.lock`), false, label);
        assert.deepEqual(fs.readFileSync(`${state}.disappeared`), original, label);
      }
    }
  } finally { key.fill(0); fs.rmSync(dir, { recursive: true, force: true }); }
});
