import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import nearApi from 'near-api-js';
import { FileJournal } from '../agent/procurement.mjs';
import { mockHash } from './mock-guarded-payment.mjs';

const cli = fileURLToPath(new URL('../agent/svalin-pro.mjs', import.meta.url));
const preload = fileURLToPath(new URL('./fixtures/mock-svalin-cli.mjs', import.meta.url));
const start = Date.parse('2026-11-01T19:25:00.000Z');
const goal = { version: 1, id: 'risk', vault: 'vault.testnet', owner: 'owner.testnet', vault_code_hash: mockHash('svalin-cli-v11'),
  policy_id: 'api', accept_unsigned_seller_risk: true, accept_exact_amount_matching_risk: true };
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svalin-cli-')), input = path.join(dir, 'goal.json'), state = path.join(dir, 'journal.enc');
  const journalKey = path.join(dir, 'journal.key'), signingKey = path.join(dir, 'agent.json'), unsafeKey = path.join(dir, 'unsafe.json');
  const config = path.join(dir, 'synthetic.json'), log = path.join(dir, 'calls.log'), secret = crypto.randomBytes(32);
  const pair = nearApi.KeyPair.fromRandom('ed25519');
  fs.writeFileSync(input, JSON.stringify(goal)); fs.writeFileSync(journalKey, secret, { mode: 0o600 });
  fs.writeFileSync(signingKey, JSON.stringify({ account_id: goal.owner, private_key: pair.toString() }), { mode: 0o600 });
  fs.writeFileSync(unsafeKey, JSON.stringify({ account_id: goal.owner, private_key: pair.toString() }), { mode: 0o644 });
  fs.writeFileSync(config, JSON.stringify({ goal }), { mode: 0o600 }); fs.writeFileSync(log, '');
  const base = ['--goal', input, '--state', state];
  return { dir, input, state, journalKey, signingKey, unsafeKey, config, log, secret, pair, base,
    run(args, env = {}) { return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, BOUNCER_FILE_JOURNAL_KEY_FILE: journalKey, NODE_OPTIONS: `--import=${preload}`,
        BOUNCER_SVALIN_TEST_CONFIG: config, BOUNCER_SVALIN_TEST_LOG: log, BOUNCER_SVALIN_TEST_CLOCK: String(start), ...env } }); },
    calls() { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean); },
    code() { const j = new FileJournal(state, goal.vault, goal.owner, { encryptionKey: secret, requireExisting: true });
      try { return j.get(`${goal.id}-svalin-pro`).svalin.code; } finally { j.close(); } },
    close() { secret.fill(0); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('CLI requires separate explicit action, risk and backup flags and refuses missing journals', () => {
  const f = fixture(); try {
    const help = f.run(['--help']); assert.equal(help.status, 0); assert.match(help.stdout, /testnet USDC has no value/i);
    const cases = [
      [...f.base, '--init'], [...f.base, '--init', '--new-journal'], [...f.base, '--init', '--new-journal', '--ack-key-backup', '--execute'],
      [...f.base, '--reserve'], [...f.base, '--reserve', '--execute'], [...f.base, '--reserve', '--execute', '--ack-key-backup'],
      [...f.base, '--recover-reservation', '--execute', '--ack-key-backup'],
      [...f.base, '--activate', '--execute', '--ack-key-backup'],
      [...f.base, '--inspect-activation', '--execute', '--ack-key-backup'],
      [...f.base, '--risk', '--execute', '--ack-key-backup', '--ack-bearer-disclosure', '--target', 'root.near'],
      [...f.base, '--recover-payment', '--execute'], [...f.base, '--prepare-exact'],
      [...f.base, '--pay-exact', '--execute', '--ack-key-backup', '--key', f.signingKey],
      [...f.base, '--recover-payment'], [...f.base, '--init', '--init', '--new-journal', '--ack-key-backup'],
    ];
    for (const args of cases) { const got = f.run(args); assert.equal(got.status, 1, got.stderr); assert.equal(fs.existsSync(f.state), false); }
    assert.deepEqual(f.calls(), []); assert.equal(fs.existsSync(`${f.state}.lock`), false);
  } finally { f.close(); }
});

test('actual CLI runs a complete synthetic flow and recovers a lost payment response without a second send', () => {
  const f = fixture(); try {
    let got = f.run([...f.base, '--init', '--new-journal', '--ack-key-backup']);
    assert.equal(got.status, 0, got.stderr); assert.equal(JSON.parse(got.stdout).phase, 'prepared');
    const bearer = f.code(), privateKey = f.pair.toString();
    assert.equal(got.stdout.includes(bearer), false); assert.equal(fs.readFileSync(f.state, 'utf8').includes(bearer), false);
    const saved = fs.readFileSync(f.state);
    got = f.run([...f.base, '--init', '--new-journal', '--ack-key-backup']);
    assert.equal(got.status, 1); assert.match(got.stderr, /journal already exists/); assert.deepEqual(fs.readFileSync(f.state), saved);

    got = f.run([...f.base, '--reserve', '--execute', '--ack-key-backup']);
    assert.equal(got.status, 0, got.stderr); assert.equal(JSON.parse(got.stdout).reservation.amount_atoms, '5004217');
    assert.equal(got.stdout.includes(bearer), false);
    const callsAfterReservation = f.calls();
    got = f.run([...f.base, '--reserve', '--execute', '--ack-key-backup']);
    assert.equal(got.status, 0); assert.deepEqual(f.calls(), callsAfterReservation);
    const beforePrepare = fs.readFileSync(f.state);
    got = f.run([...f.base, '--prepare-exact', '--public-key', String(f.pair.getPublicKey())]);
    assert.equal(got.status, 0, got.stderr); const prepared = JSON.parse(got.stdout), a = prepared.owner_call.args;
    assert.equal(a.amount, '5004217'); assert.equal(prepared.owner_call.attached_yocto, '1');
    assert.equal(prepared.agent_call.attached_yocto, '0'); assert.equal(got.stdout.includes(bearer), false);
    assert.deepEqual(fs.readFileSync(f.state), beforePrepare);
    const view = { intent_id: a.intent_id, policy_id: a.policy_id, token: a.expected_token, payee: a.payee, amount: a.amount,
      memo: a.memo, review_hash: a.review_hash, expires_at_ms: a.expires_at_ms, agent_public_key: a.agent_public_key,
      policy_revision: 1, payee_revision: 2, agent_revision: 3, consumed: false, cancelled: false, active: true };
    fs.writeFileSync(f.config, JSON.stringify({ goal, prepared, view }), { mode: 0o600 });
    got = f.run([...f.base, '--pay-exact', '--execute', '--ack-key-backup', '--key', f.unsafeKey]);
    assert.equal(got.status, 1); assert.match(got.stderr, /signing keys must be owner-only/); assert.equal(f.calls().includes('send'), false);
    got = f.run([...f.base, '--pay-exact', '--execute', '--ack-key-backup', '--key', f.signingKey], { BOUNCER_SVALIN_TEST_LOSE_SEND: '1' });
    assert.equal(got.status, 1); assert.match(got.stderr, /unresolved/); assert.equal(got.stderr.includes(bearer), false);
    assert.equal(got.stderr.includes(privateKey), false); assert.equal(f.calls().filter(c => c === 'send').length, 1);

    got = f.run([...f.base, '--recover-payment']); assert.equal(got.status, 0, got.stderr);
    const recovery = JSON.parse(got.stdout); assert.equal(recovery.status, 'RECOVERED_PAYMENT_ONLY'); assert.equal(recovery.sends, 0);
    got = f.run([...f.base, '--pay-exact', '--execute', '--ack-key-backup', '--key', f.signingKey]);
    assert.equal(got.status, 1); assert.match(got.stderr, /already recorded/);
    const time = { BOUNCER_SVALIN_TEST_CLOCK: String(start + 31_000) };
    got = f.run([...f.base, '--activate', '--execute', '--ack-key-backup', '--ack-seller-mutation'], time);
    assert.equal(got.status, 0, got.stderr); assert.equal(JSON.parse(got.stdout).status, 'SELLER_REPORTED_ACTIVE');
    got = f.run([...f.base, '--risk', '--target', 'root.near', '--execute', '--ack-key-backup', '--ack-bearer-disclosure', '--ack-quota-use'], time);
    assert.equal(got.status, 0, got.stderr); const report = JSON.parse(got.stdout);
    assert.equal(report.status, 'SELLER_REPORT_RECEIVED'); assert.equal(report.report.score, 21);
    assert.equal(report.report.seller_reported_data_source, 'fastnear'); assert.equal(report.report.sample_data, false);
    assert.deepEqual(report.report.findings, [{ kind: 'small-portfolio', severity: 'info' }]); assert.equal(report.seller_attribution_verified, false);
    assert.equal(got.stdout.includes(bearer), false); assert.equal(got.stdout.includes(privateKey), false);
    got = f.run([...f.base, '--risk', '--target', 'root.near', '--execute', '--ack-key-backup', '--ack-bearer-disclosure', '--ack-quota-use'], time);
    assert.equal(got.status, 0); assert.equal(JSON.parse(got.stdout).paid_requests, 0);
    got = f.run([...f.base, '--activate', '--execute', '--ack-key-backup', '--ack-seller-mutation'], time);
    assert.equal(got.status, 0); assert.equal(JSON.parse(got.stdout).activation_posts, 0);
    const calls = f.calls();
    for (const action of ['reservation', 'send', 'activation', 'risk']) assert.equal(calls.filter(c => c === action).length, 1, action);
    assert.equal(fs.readFileSync(f.state, 'utf8').includes(bearer), false);
    assert.equal(fs.existsSync(`${f.state}.lock`), false);
  } finally { f.close(); }
});
