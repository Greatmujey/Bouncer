import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileJournal, requestFingerprint } from '../agent/procurement.mjs';
import { multiAgencyPaymentPlan } from '../agent/multiagency-research.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { MULTIAGENCY_TREASURY as TREASURY } from '../agent/multiagency-readiness.mjs';
import { mockGuardedPayment, mockHash, MOCK_PUBLIC_KEY } from './mock-guarded-payment.mjs';

const cli = fileURLToPath(new URL('../agent/multiagency.mjs', import.meta.url));
const goal = { version: 1, id: 'research', vault: 'vault.testnet', owner: 'owner.testnet', vault_code_hash: mockHash('vault'),
  policy_id: 'research', title: 'Independent research brief', brief: 'Produce a cited public report about safe autonomous agent purchasing.',
  amount: '3000000', accept_public_brief: true, accept_stalled_deposit_risk: true, accept_unsigned_quote_and_memo_risk: true };
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-cli-')), input = path.join(dir, 'goal.json'), state = path.join(dir, 'journal.json'),
    key = path.join(dir, 'journal.key'), agent = path.join(dir, 'agent.json'), secret = crypto.randomBytes(32);
  fs.writeFileSync(input, JSON.stringify(goal)); fs.writeFileSync(key, secret, { mode: 0o600 });
  fs.writeFileSync(agent, JSON.stringify({ account_id: goal.owner, private_key: 'not-a-real-key' }), { mode: 0o644 });
  const base = ['--goal', input, '--state', state];
  return { dir, state, key, agent, secret, base,
    run(args, overrides = {}) { return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, BOUNCER_FILE_JOURNAL_KEY_FILE: key, ...overrides } }); },
    existing() { const j = new FileJournal(state, goal.vault, goal.owner, { encryptionKey: secret });
      j.put('historical', { status: 'pending', fingerprint: 'test' }); j.close(); },
    close() { secret.fill(0); fs.rmSync(dir, { recursive: true, force: true }); } };
}
test('research CLI is explicit and refuses to recreate a missing original journal', () => {
  const f = fixture(); try {
    const help = f.run(['--help']); assert.equal(help.status, 0); assert.match(help.stdout, /testnet USDC has no financial value/i);
    for (const args of [
      [...f.base, '--quote'], [...f.base, '--pay', '--key', f.agent], [...f.base, '--quote', '--execute', '--new-journal'],
      [...f.base, '--recover', '--execute'], [...f.base, '--inspect', '--task', '0'],
      [...f.base, '--quote', '--execute'], [...f.base, '--quote', '--execute', '--ack-provider-availability'], [...f.base, '--recover'],
    ]) {
      const result = f.run(args); assert.equal(result.status, 1, result.stderr); assert.equal(fs.existsSync(f.state), false);
    }
    const missingCapacity = f.run([...f.base, '--quote', '--execute', '--new-journal', '--ack-key-backup']);
    assert.match(missingCapacity.stderr, /operator assertion of provider availability/);
    assert.equal(fs.existsSync(`${f.state}.lock`), false);
  } finally { f.close(); }
});

test('research CLI will not replace an original journal or read an unsafe signing key', () => {
  const f = fixture(); try {
    f.existing(); const before = fs.readFileSync(f.state);
    let result = f.run([...f.base, '--quote', '--execute', '--ack-provider-availability', '--new-journal', '--ack-key-backup']);
    assert.equal(result.status, 1); assert.match(result.stderr, /journal already exists/);
    result = f.run([...f.base, '--pay', '--execute', '--ack-provider-availability', '--key', f.agent]);
    assert.equal(result.status, 1); assert.match(result.stderr, /signing keys must be owner-only/);
    result = f.run([...f.base, '--inspect', '--task', '40']);
    assert.equal(result.status, 1); assert.match(result.stderr, /original research-quote journal/);
    assert.deepEqual(fs.readFileSync(f.state), before); assert.equal(fs.existsSync(`${f.state}.lock`), false);
  } finally { f.close(); }
});

test('real CLI recovers a synthetic original payment and inspects its published task without any signing key or send', () => {
  const f = fixture(); try {
    const quote = { code: 'ma-0123456789', title: goal.title, status: 'awaiting_deposit', channel: 'wallet',
      expires_at: '2026-11-04T15:00:00.000Z', payment: { network: 'testnet', token: TOKEN, receiver: TREASURY, amount: goal.amount, memo: 'ma-0123456789' } };
    const hash = mockHash('synthetic-cli-payment'), txBlock = mockHash('synthetic-tx-block'), executionBlock = mockHash('synthetic-execution-block');
    const request = multiAgencyPaymentPlan(goal, quote, { allowExpired: true }).requests[0];
    const chain = mockGuardedPayment({ hash, owner: goal.owner, contract: goal.vault, publicKey: MOCK_PUBLIC_KEY,
      args: { policy_id: goal.policy_id, payee: TREASURY, amount: goal.amount, memo: quote.code, expected_token: TOKEN } });
    chain.transaction_outcome.block_hash = txBlock; chain.receipts_outcome[0].block_hash = executionBlock;
    chain.receipts_outcome[1].outcome.logs = ['EVENT_JSON:' + JSON.stringify({ standard: 'nep141', version: '1.0.0', event: 'ft_transfer',
      data: [{ old_owner_id: goal.vault, new_owner_id: TREASURY, amount: goal.amount, memo: quote.code }] })];
    const j = new FileJournal(f.state, goal.vault, goal.owner, { encryptionKey: f.secret });
    j.put(`${goal.id}-ma-quote`, { status: 'pending', fingerprint: crypto.createHash('sha256').update(JSON.stringify(goal)).digest('hex'),
      multiagency: { version: 1, phase: 'issued', goal, quote } });
    j.put(goal.id, { status: 'pending', fingerprint: requestFingerprint(request), request, payment_version: 'direct-signed-v1',
      tx_hash: hash, agent_public_key: MOCK_PUBLIC_KEY }); j.close();
    const board = 'https://github.com/MultiAgency/kanban-sandbox', api = 'https://api.github.com/repos/MultiAgency/kanban-sandbox/issues';
    const fence = (name, value) => `\`\`\`${name}\n${JSON.stringify(value)}\n\`\`\``;
    const seller = { ...structuredClone(quote), status: 'open', issue: 32, issue_url: `${board}/issues/32`,
      deposit: { transaction: hash, org: goal.vault, amount: goal.amount, memo: quote.code } };
    const engagement = { engagement_id: quote.code, channel: 'wallet', org: goal.vault,
      deposit: { amount: goal.amount, asset: TOKEN, treasury: TREASURY, transaction: hash, network: 'testnet' } };
    const epic = { number: 32, html_url: `${board}/issues/32`, user: { id: 334725530 }, title: `Job: ${goal.title}`,
      state: 'closed', state_reason: 'completed', closed_at: '2026-11-01T16:10:00Z', body: `intro\n\n${goal.brief}\n\n${fence('engagement', engagement)}\n\n${fence('team', { members: [{ issue: 40, engagement: 32, key: 'report', amount: '1000000', asset: TOKEN }] })}` };
    const task = { number: 40, html_url: `${board}/issues/40`, user: { id: 334725530 }, state: 'closed', state_reason: 'completed',
      closed_at: '2026-11-01T16:00:00Z', assignees: [{ id: 42 }], comments: 2,
      body: fence('terms', { engagement: 32, key: 'report', amount: '1000000', asset: TOKEN }) };
    const text = '**Deliverable**\n\nSynthetic report.', url = `${board}/issues/40#issuecomment-51`;
    const delivered = { id: 51, user: { id: 42 }, issue_url: `${api}/40`, html_url: url, body: text,
      created_at: '2026-11-01T15:30:00Z', updated_at: '2026-11-01T15:30:00Z' };
    const handoff = { id: 52, user: { id: 42 }, issue_url: `${api}/40`, html_url: `${board}/issues/40#issuecomment-52`,
      body: fence('handoff', { deliverable: { url, sha256: crypto.createHash('sha256').update(text).digest('hex') } }),
      created_at: '2026-11-01T15:31:00Z', updated_at: '2026-11-01T15:31:00Z' };
    const evidence = { hash, owner: goal.owner, vault: goal.vault, codeHash: goal.vault_code_hash, txBlock, executionBlock, chain,
      gets: { [`https://demo.multiagency.ai/api/quotes/${quote.code}`]: seller, [`${api}/32`]: epic, [`${api}/40`]: task,
        [`${api}/40/comments?per_page=100`]: [delivered, handoff] } };
    const evidencePath = path.join(f.dir, 'synthetic.json'); fs.writeFileSync(evidencePath, JSON.stringify(evidence));
    const preload = fileURLToPath(new URL('./fixtures/mock-multiagency-cli.mjs', import.meta.url));
    const env = { NODE_OPTIONS: `--import=${preload}`, BOUNCER_MULTIAGENCY_SYNTHETIC: evidencePath };
    let result = f.run([...f.base, '--recover'], env); assert.equal(result.status, 0, result.stderr);
    const recovered = JSON.parse(result.stdout); assert.equal(recovered.status, 'RECOVERED_PAYMENT_ONLY');
    assert.equal(recovered.settlement.tx_hash, hash); assert.equal(recovered.sends, 0);
    const before = fs.readFileSync(f.state);
    result = f.run([...f.base, '--inspect', '--task', '40'], env); assert.equal(result.status, 0, result.stderr);
    const published = JSON.parse(result.stdout); assert.equal(published.status, 'PUBLISHED_TASK_AFTER_FINAL_PAYMENT');
    assert.equal(published.text, text); assert.equal(published.sends, 0); assert.equal(published.journal_writes, 0);
    assert.deepEqual(fs.readFileSync(f.state), before);
  } finally { f.close(); }
});
