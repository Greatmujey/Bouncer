import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import { mockHash } from './mock-guarded-payment.mjs';
import { CIRCLE_TESTNET_USDC } from '../scripts/circle-testnet-setup.mjs';
import { signAndJournalCircleRegistration, recordFinalCircleRegistration } from '../agent/circle-owner-offline-journal.mjs';
import { verifySignedCircleRegistration } from '../agent/circle-owner-registration.mjs';

const NOW = Date.parse('2026-11-02T16:20:00Z');
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-offline-registration-')); fs.chmodSync(dir, 0o700);
  const key = nearApi.KeyPair.fromRandom('ed25519'), pub = String(key.getPublicKey());
  const plan = { version: 1, purpose: 'new-bouncer-testnet-owner', network: 'testnet',
    account_id: 'bouncer-owner-0123456789abcdef01234567.testnet', public_key: pub };
  const paths = Object.fromEntries(['primary', 'backup', 'snapshot', 'journal', 'evidence', 'lock'].map(n => [n, path.join(dir, n)]));
  const cred = { network_id: 'testnet', account_id: plan.account_id, public_key: pub, private_key: key.toString() };
  const snapshot = { version: 1, chain: 'testnet', owner: plan.account_id, public_key: pub,
    block_hash: mockHash('offline-block'), block_timestamp_nanosec: (BigInt(NOW) * 1_000_000n).toString(),
    owner_native_yocto: '10000000000000000000000000', owner_key_count: 1, owner_key_nonce: '10',
    circle_token: CIRCLE_TESTNET_USDC, circle_code_hash: mockHash('offline-circle'), circle_symbol: 'USDC', circle_decimals: 6,
    circle_storage_min_yocto: '1250000000000000000000', circle_registration: 'NOT_REGISTERED_AT_VIEW', signed: false, sent: false };
  for (const name of ['primary', 'backup']) fs.writeFileSync(paths[name], JSON.stringify(cred), { mode: 0o600 });
  fs.writeFileSync(paths.snapshot, JSON.stringify(snapshot), { mode: 0o600 });
  return { dir, key, plan, paths, snapshot, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('offline signing durably journals before exporting only fixed public bearer bytes', async () => {
  const f = fixture();
  try {
    const result = await signAndJournalCircleRegistration({ plan: f.plan, paths: f.paths, nowMs: NOW });
    const journal = JSON.parse(fs.readFileSync(f.paths.journal)), evidence = JSON.parse(fs.readFileSync(f.paths.evidence));
    assert.equal(result.tx_hash, journal.envelope.tx_hash); assert.deepEqual(journal.envelope, evidence);
    assert.equal((fs.statSync(f.paths.journal).mode & 0o777), 0o600); assert.equal(result.private_key_exported, false);
    assert.ok(verifySignedCircleRegistration(evidence, f.plan));
    assert.equal(JSON.stringify(journal).includes(f.key.toString()), false);
    await assert.rejects(signAndJournalCircleRegistration({ plan: f.plan, paths: f.paths, nowMs: NOW }), /already journaled/);
    fs.unlinkSync(f.paths.evidence);
    const restored = await signAndJournalCircleRegistration({ plan: f.plan, paths: f.paths, restore: true });
    assert.equal(restored.tx_hash, result.tx_hash); assert.deepEqual(JSON.parse(fs.readFileSync(f.paths.evidence)), evidence);
    journal.status = 'ORIGINAL_FINAL_VERIFIED';
    fs.writeFileSync(f.paths.journal, JSON.stringify(journal), { mode: 0o600 });
    fs.unlinkSync(f.paths.evidence);
    const confirmed = await signAndJournalCircleRegistration({ plan: f.plan, paths: f.paths, restore: true });
    assert.equal(confirmed.tx_hash, result.tx_hash); assert.deepEqual(JSON.parse(fs.readFileSync(f.paths.evidence)), evidence);
    await assert.rejects(signAndJournalCircleRegistration({ plan: f.plan, paths: f.paths, nowMs: NOW }), /already journaled/);
  } finally { f.cleanup(); }
});

test('bad backup, exposed file, stale snapshot or lock stop before a journal or bearer export', async () => {
  for (const scenario of ['backup', 'mode', 'stale', 'lock']) {
    const f = fixture();
    try {
      if (scenario === 'backup') fs.writeFileSync(f.paths.backup, JSON.stringify({ network_id: 'testnet' }));
      if (scenario === 'mode') fs.chmodSync(f.paths.primary, 0o644);
      if (scenario === 'lock') fs.mkdirSync(f.paths.lock);
      await assert.rejects(signAndJournalCircleRegistration({ plan: f.plan, paths: f.paths, nowMs: NOW + (scenario === 'stale' ? 120_001 : 0) }));
      assert.equal(fs.existsSync(f.paths.journal), false); assert.equal(fs.existsSync(f.paths.evidence), false);
    } finally { f.cleanup(); }
  }
});

test('an interrupted or conflicting export preserves the original hash and cannot sign a replacement', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.paths.evidence, 'different public file');
    await assert.rejects(signAndJournalCircleRegistration({ plan: f.plan, paths: f.paths, nowMs: NOW }));
    const original = JSON.parse(fs.readFileSync(f.paths.journal)).envelope;
    await assert.rejects(signAndJournalCircleRegistration({ plan: f.plan, paths: f.paths, nowMs: NOW }), /already journaled/);
    fs.unlinkSync(f.paths.evidence);
    const restored = await signAndJournalCircleRegistration({ plan: f.plan, paths: f.paths, restore: true });
    assert.equal(restored.tx_hash, original.tx_hash); assert.deepEqual(JSON.parse(fs.readFileSync(f.paths.evidence)), original);
  } finally { f.cleanup(); }
});

test('only a matching authenticated-run result can mark the exact local registration original final', async () => {
  const f = fixture();
  try {
    await signAndJournalCircleRegistration({ plan: f.plan, paths: f.paths, nowMs: NOW });
    const original = JSON.parse(fs.readFileSync(f.paths.journal)).envelope;
    const digest = crypto.createHash('sha256').update(fs.readFileSync(f.paths.evidence)).digest('hex');
    const result = { status: 'CIRCLE_OWNER_REGISTERED_AT_FINAL', network: 'testnet', owner: f.plan.account_id,
      token: CIRCLE_TESTNET_USDC, tx_hash: original.tx_hash, receipt: { tx_hash: original.tx_hash,
        root_receipt_id: mockHash('root'), circle_reported_total_yocto: original.deposit_yocto,
        linked_successful_outcomes: 2, trusted_rpc_not_consensus_proof: true },
      registration_block_hash: mockHash('final'), storage_registration: 'REGISTERED_AT_VIEW', owner_circle_balance_atoms: '0',
      usdc_funding_verified: false, vault_deployed: false, seller_contacted: false, do_not_resend: true,
      signed_envelope_sha256: digest, run_id: '12345', fence_artifact_id: '56789', commit: 'a'.repeat(40) };
    const variants = [
      { tx_hash: mockHash('other') }, { owner: 'other.testnet' }, { token: 'other.testnet' },
      { signed_envelope_sha256: '0'.repeat(64) }, { storage_registration: 'NOT_REGISTERED_AT_VIEW' },
      { do_not_resend: false }, { run_id: '0' }, { commit: 'invalid' },
      { receipt: { ...result.receipt, tx_hash: mockHash('wrong') } },
      { receipt: { ...result.receipt, trusted_rpc_not_consensus_proof: false } },
      { receipt: { ...result.receipt, circle_reported_total_yocto: '1' } },
    ];
    for (const change of variants) {
      assert.throws(() => recordFinalCircleRegistration({ plan: f.plan, paths: f.paths, result: { ...result, ...change } }), /does not match/);
      assert.equal(JSON.parse(fs.readFileSync(f.paths.journal)).status, 'ORIGINAL_SIGNED_NOT_CONFIRMED');
    }
    const saved = recordFinalCircleRegistration({ plan: f.plan, paths: f.paths, result });
    assert.equal(saved.tx_hash, original.tx_hash); assert.equal(saved.journal_status, 'ORIGINAL_FINAL_VERIFIED');
    assert.deepEqual(JSON.parse(fs.readFileSync(f.paths.journal)).final_verification, result);
    assert.equal((fs.statSync(f.paths.journal).mode & 0o777), 0o600);
    assert.equal(recordFinalCircleRegistration({ plan: f.plan, paths: f.paths, result }).already_recorded, true);
    assert.throws(() => recordFinalCircleRegistration({ plan: f.plan, paths: f.paths, result: { ...result, run_id: '999' } }), /already differs/);
  } finally { f.cleanup(); }
});
