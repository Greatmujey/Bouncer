import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestnetOwnerKeyring, readTestnetOwnerKeyring, exportTemporaryTestnetOwner, restoreTestnetOwnerKeyring } from '../agent/testnet-owner-local-keyring.mjs';
import { keyFrom, readBoundedPrivate } from '../agent/circle-owner-offline-journal.mjs';

function temp() { const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-private-test-')); fs.chmodSync(base, 0o700);
  return { base, dir: path.join(base, 'keyring'), cleanup: () => fs.rmSync(base, { recursive: true, force: true }) }; }

test('new testnet-only owner is generated once with two authenticated encrypted copies and no secret in output', () => {
  const t = temp();
  try {
    const result = createTestnetOwnerKeyring(t.dir), pair = readTestnetOwnerKeyring({ dir: t.dir, plan: result.plan });
    assert.match(result.plan.account_id, /^bouncer-owner-[a-f0-9]{24}\.testnet$/);
    assert.equal(result.plan.network, 'testnet'); assert.equal(result.encrypted_copies_checked, 2);
    assert.equal(result.transaction_signed, false); assert.equal(result.helper_request_sent, false);
    assert.equal(JSON.stringify(result).includes(pair.toString()), false);
    for (const file of ['master.key', 'primary.enc.json', 'backup.enc.json', 'public-plan.json']) {
      assert.equal(fs.statSync(path.join(t.dir, file)).mode & 0o777, 0o600);
      assert.equal(fs.readFileSync(path.join(t.dir, file)).includes(Buffer.from(pair.toString())), false);
    }
    assert.notEqual(fs.readFileSync(path.join(t.dir, 'primary.enc.json'), 'utf8'), fs.readFileSync(path.join(t.dir, 'backup.enc.json'), 'utf8'));
    assert.throws(() => createTestnetOwnerKeyring(t.dir), /EEXIST/);
  } finally { t.cleanup(); }
});

test('tampered encrypted copy, exposed file and changed plan cannot be read', () => {
  for (const scenario of ['tamper', 'permissions', 'plan']) {
    const t = temp();
    try {
      const { plan } = createTestnetOwnerKeyring(t.dir);
      const file = path.join(t.dir, 'backup.enc.json');
      if (scenario === 'tamper') {
        const value = JSON.parse(fs.readFileSync(file)); value.ciphertext = Buffer.alloc(Buffer.from(value.ciphertext, 'base64').length).toString('base64');
        fs.writeFileSync(file, JSON.stringify(value));
      }
      if (scenario === 'permissions') fs.chmodSync(file, 0o644);
      const changed = scenario === 'plan' ? { ...plan, account_id: 'bouncer-owner-ffffffffffffffffffffffff.testnet' } : plan;
      assert.throws(() => readTestnetOwnerKeyring({ dir: t.dir, plan: changed }));
    } finally { t.cleanup(); }
  }
});

test('temporary private copies authenticate to the owner and conflicting files are never overwritten', () => {
  const t = temp();
  try {
    const { plan } = createTestnetOwnerKeyring(t.dir), primary = path.join(t.base, 'temporary', 'primary.json'),
      backup = path.join(t.base, 'temporary', 'recovery.json');
    const out = exportTemporaryTestnetOwner({ dir: t.dir, plan, primary, backup });
    assert.equal(out.local_copies_verified, 2); assert.equal(out.user_backup_export_verified, false); assert.equal(out.private_key_logged, false);
    for (const file of [primary, backup]) {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(String(keyFrom(plan, readBoundedPrivate(file)).getPublicKey()), plan.public_key);
    }
    assert.equal(exportTemporaryTestnetOwner({ dir: t.dir, plan, primary, backup }).local_copies_verified, 2);
    fs.unlinkSync(backup); fs.writeFileSync(backup, '{}', { mode: 0o600 });
    assert.throws(() => exportTemporaryTestnetOwner({ dir: t.dir, plan, primary, backup }));
    assert.equal(fs.readFileSync(backup, 'utf8'), '{}');
  } finally { t.cleanup(); }
});

test('privately restores the same reviewed synthetic owner into two new encrypted copies', () => {
  const t = temp();
  try {
    const { plan } = createTestnetOwnerKeyring(t.dir), original = readTestnetOwnerKeyring({ dir: t.dir, plan });
    const primary = path.join(t.base, 'temporary', 'primary.json'), backup = path.join(t.base, 'temporary', 'backup.json');
    exportTemporaryTestnetOwner({ dir: t.dir, plan, primary, backup });
    const restoredDir = path.join(t.base, 'restored');
    const result = restoreTestnetOwnerKeyring({ dir: restoredDir, plan, credentialsFile: primary });
    assert.equal(result.original_owner_restored, true); assert.equal(result.replacement_owner_created, false);
    assert.equal(result.transaction_signed, false); assert.equal(result.transaction_sent, false);
    assert.equal(result.encrypted_copies_checked, 2); assert(!JSON.stringify(result).includes(original.toString()));
    assert.equal(String(readTestnetOwnerKeyring({ dir: restoredDir, plan }).getPublicKey()), plan.public_key);
    for (const file of ['master.key', 'primary.enc.json', 'backup.enc.json', 'public-plan.json']) {
      assert.equal(fs.statSync(path.join(restoredDir, file)).mode & 0o777, 0o600);
      assert(!fs.readFileSync(path.join(restoredDir, file)).includes(Buffer.from(original.toString())));
    }
    assert.throws(() => restoreTestnetOwnerKeyring({ dir: restoredDir, plan, credentialsFile: primary }), /EEXIST/);
  } finally { t.cleanup(); }
});

test('restore rejects a changed key, unexpected fields, exposed file or symbolic link before creating a keyring', () => {
  for (const scenario of ['key', 'fields', 'permissions', 'symlink', 'hardlink']) {
    const t = temp();
    try {
      const { plan } = createTestnetOwnerKeyring(t.dir), primary = path.join(t.base, 'temporary', 'primary.json'),
        backup = path.join(t.base, 'temporary', 'backup.json');
      exportTemporaryTestnetOwner({ dir: t.dir, plan, primary, backup });
      let source = primary;
      if (scenario === 'key') { const obj = JSON.parse(fs.readFileSync(primary)); obj.public_key = 'ed25519:changed'; fs.writeFileSync(primary, JSON.stringify(obj)); }
      if (scenario === 'fields') { const obj = JSON.parse(fs.readFileSync(primary)); obj.extra = true; fs.writeFileSync(primary, JSON.stringify(obj)); }
      if (scenario === 'permissions') fs.chmodSync(primary, 0o644);
      if (scenario === 'symlink') { source = path.join(t.base, 'temporary', 'link.json'); fs.symlinkSync(primary, source); }
      if (scenario === 'hardlink') { source = path.join(t.base, 'temporary', 'hardlink.json'); fs.linkSync(primary, source); }
      const dest = path.join(t.base, 'restored');
      assert.throws(() => restoreTestnetOwnerKeyring({ dir: dest, plan, credentialsFile: source }));
      assert.equal(fs.existsSync(dest), false);
    } finally { t.cleanup(); }
  }
});
