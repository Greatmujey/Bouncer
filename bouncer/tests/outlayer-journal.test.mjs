import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import { runOutlayerGoal, recoverOutlayerGoal } from '../agent/outlayer.mjs';
import { FileJournal } from '../agent/procurement.mjs';
import { finishDemoEvidence } from '../demo-outlayer.mjs';

const key = 'ed25519:agent';
const bytes = Buffer.alloc(32, 4), hash = nearApi.utils.serialize.base_encode(bytes);
const goal = { id: 'random-1', contract_id: 'bouncer.testnet', owner_account_id: 'owner.testnet', policy_id: 'external', amount: '100', input: { min: 1, max: 100 },
  program: { url: 'https://example.org/program.wasm', sha256: 'a'.repeat(64), build_target: 'wasm32-wasip1', max_instructions: 100, max_memory_mb: 128, max_execution_seconds: 60 } };
function fixture() {
  const entries = new Map(); let sends = 0;
  const journal = { get: id => entries.get(id), put: (id, item) => entries.set(id, item) };
  const provider = {
    async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewAccessKey() { return { permission: { FunctionCall: { receiver_id: goal.contract_id, method_names: ['execute_outlayer'] } } }; },
    async callFunction(_, method) {
      if (method === 'contract_version') return 'bouncer-agent-v5';
      if (method === 'get_owner') return goal.owner_account_id;
      if (method === 'get_policy') return { token: 'native' };
      if (method === 'get_outlayer_program') return goal.program;
      if (method === 'is_agent_key_allowed') return true;
      if (method === 'check') return [true, 'ok'];
      throw new Error('unexpected query');
    },
    async sendTransactionUntil() { sends++; throw new Error('uncertain broadcast'); },
    async txStatusReceipts() { throw new Error('transaction unavailable'); },
  };
  const account = { accountId: goal.owner_account_id, async createTransaction() { return {}; },
    signer: { async getPublicKey() { return key; }, async signTransaction() { return [bytes, {}]; } } };
  return { journal, entries, provider, account, sends: () => sends };
}
const run = f => runOutlayerGoal({ goal, provider: f.provider, account: f.account, publicKey: key, journal: f.journal, execute: true, log: () => {} });

test('journal persistence failure occurs before any broadcast', async () => {
  const f = fixture(); f.journal.put = () => { throw new Error('disk full'); };
  await assert.rejects(run(f), /disk full/);
  assert.equal(f.sends(), 0);
});

test('unavailable or expired transaction remains pending and never causes a resend', async () => {
  const f = fixture();
  await assert.rejects(run(f), /do not resend automatically/);
  assert.equal(f.entries.get(goal.id).tx_hash, hash);
  for (let i = 0; i < 2; i++) await assert.rejects(recoverOutlayerGoal({ goal, provider: f.provider, journal: f.journal, log: () => {} }), /transaction unavailable/);
  assert.equal(f.sends(), 1);
  assert.equal(f.entries.get(goal.id).status, 'pending');
});

test('a changed reviewed goal or missing signing key cannot be recovered', async () => {
  const f = fixture();
  await assert.rejects(run(f), /do not resend automatically/);
  await assert.rejects(recoverOutlayerGoal({ goal: { ...goal, amount: '101' }, provider: f.provider, journal: f.journal }), /does not match/);
  const old = f.entries.get(goal.id); delete old.agent_public_key;
  await assert.rejects(recoverOutlayerGoal({ goal, provider: f.provider, journal: f.journal }), /public key is required/);
  assert.equal(f.sends(), 1);
});

test('live demo preserves its goal and pending journal on failure; success removes only the temporary directory', () => {
  for (const completed of [false, true]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-evidence-test-'));
    const journalPath = path.join(directory, 'journal.json'), goalPath = path.join(directory, 'goal.json');
    fs.writeFileSync(goalPath, JSON.stringify(goal));
    const journal = new FileJournal(journalPath, goal.contract_id, goal.owner_account_id);
    journal.put(goal.id, { status: 'pending', fingerprint: 'x', tx_hash: hash, outlayer_goal: goal, agent_public_key: key });
    const messages = [];
    finishDemoEvidence({ journal, directory, journalPath, goalPath, completed, log: message => messages.push(message) });
    if (completed) {
      assert.equal(fs.existsSync(directory), false);
      assert.deepEqual(messages, []);
    } else {
      assert.equal(fs.existsSync(goalPath), true);
      assert.equal(fs.existsSync(`${journalPath}.lock`), false);
      assert.match(messages[0], /never resend automatically/);
      const reopened = new FileJournal(journalPath, goal.contract_id, goal.owner_account_id);
      assert.equal(reopened.get(goal.id).tx_hash, hash);
      reopened.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});
