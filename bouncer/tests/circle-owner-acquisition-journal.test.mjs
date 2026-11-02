import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import { mockHash } from './mock-guarded-payment.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE, WRAP_TESTNET as WRAP, REF_TESTNET as REF } from '../scripts/circle-testnet-setup.mjs';
import { signCircleOwnerRegistration } from '../agent/circle-owner-registration.mjs';
import { verifySignedOwnerAcquisition } from '../agent/circle-owner-acquisition.mjs';
import { signAndJournalOwnerAcquisition } from '../agent/circle-owner-acquisition-journal.mjs';

const NOW = Date.parse('2026-11-02T16:50:00Z'), INPUT = '10000000000000000000000';
async function fixture(kind = 'wrap') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-acquisition-journal-')); fs.chmodSync(dir, 0o700);
  const key = nearApi.KeyPair.fromRandom('ed25519'), pub = String(key.getPublicKey());
  const plan = { version: 1, purpose: 'new-bouncer-testnet-owner', network: 'testnet',
    account_id: 'bouncer-owner-0123456789abcdef01234567.testnet', public_key: pub };
  const paths = Object.fromEntries(['primary', 'backup', 'snapshot', 'journal', 'evidence', 'lock', 'circleJournal', 'wrapJournal'].map(n => [n, path.join(dir, n)]));
  const cred = { network_id: 'testnet', account_id: plan.account_id, public_key: pub, private_key: key.toString() };
  for (const name of ['primary', 'backup']) fs.writeFileSync(paths[name], JSON.stringify(cred), { mode: 0o600 });
  const base = { version: 1, chain: 'testnet', owner: plan.account_id, public_key: pub, owner_key_count: 1,
    block_hash: mockHash('journal-acquisition-block'), block_timestamp_nanosec: (BigInt(NOW) * 1_000_000n).toString(),
    owner_native_yocto: '10000000000000000000000000', owner_key_nonce: '100', circle_token: CIRCLE,
    circle_registration: 'REGISTERED_AT_VIEW', circle_symbol: 'USDC', circle_decimals: 6, circle_code_hash: mockHash('circle-code'),
    circle_balance_atoms: '0', circle_storage_min_yocto: storage(), wrap_token: WRAP, wrap_symbol: 'wNEAR', wrap_decimals: 24,
    wrap_code_hash: mockHash('wrap-code'), wrap_storage_min_yocto: storage(), owner_wrap_registration: 'NOT_REGISTERED_AT_VIEW',
    owner_wrap_balance_yocto: '0', ref_exchange: REF, ref_wrap_registration: 'REGISTERED_AT_VIEW', ref_circle_registration: 'REGISTERED_AT_VIEW',
    acquisition_input_yocto: INPUT, max_usdc_atoms: '100000', selected: { pool_id: 1845, quote_atoms: '6500', min_output_atoms: '6175' },
    signed: false, sent: false };
  const reg = await signCircleOwnerRegistration({ plan, snapshot: { ...base, circle_registration: 'NOT_REGISTERED_AT_VIEW' }, keyPair: key, nowMs: NOW });
  fs.writeFileSync(paths.circleJournal, JSON.stringify({ version: 1, status: 'ORIGINAL_FINAL_VERIFIED', envelope: reg,
    final_verification: { tx_hash: reg.tx_hash } }), { mode: 0o600 });
  fs.writeFileSync(paths.snapshot, JSON.stringify(base), { mode: 0o600 });
  return { dir, key, plan, paths, base, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const storage = () => '1250000000000000000000';

test('wrap is journaled before public export, cannot be replaced, and can restore only original bytes', async () => {
  const f = await fixture();
  try {
    const result = await signAndJournalOwnerAcquisition({ plan: f.plan, paths: f.paths, kind: 'wrap', nowMs: NOW });
    const journal = JSON.parse(fs.readFileSync(f.paths.journal)), evidence = JSON.parse(fs.readFileSync(f.paths.evidence));
    assert.equal(result.tx_hash, journal.envelope.tx_hash); assert.deepEqual(evidence, journal.envelope);
    assert.equal((fs.statSync(f.paths.journal).mode & 0o777), 0o600); assert.equal(JSON.stringify(evidence).includes(f.key.toString()), false);
    assert.ok(verifySignedOwnerAcquisition(evidence, f.plan));
    await assert.rejects(signAndJournalOwnerAcquisition({ plan: f.plan, paths: f.paths, kind: 'wrap', nowMs: NOW }), /already journaled/);
    fs.unlinkSync(f.paths.evidence);
    const restored = await signAndJournalOwnerAcquisition({ plan: f.plan, paths: f.paths, kind: 'wrap', restore: true });
    assert.equal(restored.tx_hash, result.tx_hash); assert.deepEqual(JSON.parse(fs.readFileSync(f.paths.evidence)), evidence);
  } finally { f.cleanup(); }
});

test('unverified Circle and wrap stages, stale snapshots, wrong backups and locks stop without signing', async () => {
  for (const scenario of ['circle', 'wrap', 'stale', 'backup', 'lock']) {
    const f = await fixture();
    try {
      if (scenario === 'circle') fs.writeFileSync(f.paths.circleJournal, JSON.stringify({ version: 1, status: 'pending' }));
      if (scenario === 'backup') fs.writeFileSync(f.paths.backup, '{}');
      if (scenario === 'lock') fs.mkdirSync(f.paths.lock);
      const kind = scenario === 'wrap' ? 'swap' : 'wrap';
      await assert.rejects(signAndJournalOwnerAcquisition({ plan: f.plan, paths: f.paths, kind, nowMs: NOW + (scenario === 'stale' ? 120_001 : 0) }));
      assert.equal(fs.existsSync(f.paths.journal), false); assert.equal(fs.existsSync(f.paths.evidence), false);
    } finally { f.cleanup(); }
  }
});

test('swap cannot be signed until the exact original wrap journal is marked FINAL verified', async () => {
  const f = await fixture();
  try {
    await signAndJournalOwnerAcquisition({ plan: f.plan, paths: f.paths, kind: 'wrap', nowMs: NOW });
    const wrap = JSON.parse(fs.readFileSync(f.paths.journal));
    wrap.status = 'ORIGINAL_FINAL_VERIFIED'; wrap.final_verification = { tx_hash: wrap.envelope.tx_hash };
    fs.writeFileSync(f.paths.wrapJournal, JSON.stringify(wrap), { mode: 0o600 });
    fs.unlinkSync(f.paths.journal); fs.unlinkSync(f.paths.evidence);
    fs.writeFileSync(f.paths.snapshot, JSON.stringify({ ...f.base, owner_key_nonce: '101', owner_wrap_registration: 'REGISTERED_AT_VIEW',
      owner_wrap_balance_yocto: INPUT }));
    const result = await signAndJournalOwnerAcquisition({ plan: f.plan, paths: f.paths, kind: 'swap', nowMs: NOW });
    assert.equal(result.kind, 'swap'); assert.equal(result.nonce, '102');
  } finally { f.cleanup(); }
});
