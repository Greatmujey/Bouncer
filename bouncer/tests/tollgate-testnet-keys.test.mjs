import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import { createTollgateTestnetKeys, readTollgateTestnetKeys, validateTollgateTestnetKeyPlan } from '../agent/tollgate-testnet-keys.mjs';
import { makeTollgateQuakesReview } from '../agent/tollgate-quakes-v13.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-tollgate-keys-')); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = { version: 1, purpose: 'new-bouncer-testnet-owner', network: 'testnet',
    account_id: 'bouncer-owner-aaaaaaaaaaaaaaaaaaaaaaaa.testnet', public_key: String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey()) };
  return { root, directory: path.join(root, 'keys'), ownerPlan: owner };
}

test('generates distinct offline keys, two sealed copies, and the exact V13 agent scope without installing them', t => {
  const f = fixture(t), result = createTollgateTestnetKeys(f), plan = result.plan;
  const pair = readTollgateTestnetKeys({ ...f, plan });
  assert.equal(new Set([plan.owner_public_key, plan.agent_public_key, plan.voucher_public_key]).size, 3);
  assert.deepEqual(plan.restricted_methods, ['execute_tollgate_intent']); assert.equal(plan.restricted_receiver, plan.vault);
  assert.equal(result.encrypted_copies_checked, 2); assert.equal(result.independently_backed_up, false);
  assert.equal(result.installed_on_chain, false); assert.equal(result.transaction_signed, false); assert.equal(result.voucher_signed, false);
  for (const secret of [pair.agentKey.toString(), pair.voucherKey.toString()]) {
    assert(!JSON.stringify(result).includes(secret));
    for (const file of ['master.key', 'primary.enc.json', 'backup.enc.json', 'public-plan.json']) {
      assert.equal(fs.statSync(path.join(f.directory, file)).mode & 0o777, 0o600);
      assert(!fs.readFileSync(path.join(f.directory, file)).includes(Buffer.from(secret)));
    }
  }
  assert.notEqual(fs.readFileSync(path.join(f.directory, 'primary.enc.json'), 'utf8'), fs.readFileSync(path.join(f.directory, 'backup.enc.json'), 'utf8'));
  const review = makeTollgateQuakesReview({ ownerPlan: f.ownerPlan, intentId: 'synthetic-key-test', agentPublicKey: plan.agent_public_key,
    voucherPublicKey: plan.voucher_public_key, expiresAtMs: String(Date.now() + 120_000) });
  assert.equal(review.voucher_public_key, plan.voucher_public_key);
  assert.throws(() => createTollgateTestnetKeys(f), /EEXIST/);
});

test('rejects key substitution, added authority, changed provider, and non-testnet plans', t => {
  const f = fixture(t), { plan } = createTollgateTestnetKeys(f);
  for (const changed of [{ agent_public_key: plan.owner_public_key }, { voucher_public_key: plan.agent_public_key },
    { restricted_methods: ['set_policy'] }, { restricted_receiver: plan.owner }, { resource: 'https://attacker.invalid/' },
    { seller: 'attacker.testnet' }, { network: 'mainnet' }, { extra: true }]) {
    assert.throws(() => validateTollgateTestnetKeyPlan({ ...plan, ...changed }, f.ownerPlan));
  }
});

test('tampering, unsafe permissions, symlinks and hard links fail closed', t => {
  for (const scenario of ['tamper', 'permissions', 'symlink', 'hardlink', 'directory', 'plan']) {
    const f = fixture(t), { plan } = createTollgateTestnetKeys(f), master = path.join(f.directory, 'master.key'), backup = path.join(f.directory, 'backup.enc.json');
    if (scenario === 'tamper') { const box = JSON.parse(fs.readFileSync(backup)); box.tag = Buffer.alloc(16).toString('base64'); fs.writeFileSync(backup, JSON.stringify(box)); }
    if (scenario === 'permissions') fs.chmodSync(master, 0o644);
    if (scenario === 'symlink') { fs.renameSync(master, path.join(f.root, 'saved.key')); fs.symlinkSync(path.join(f.root, 'saved.key'), master); }
    if (scenario === 'hardlink') fs.linkSync(master, path.join(f.root, 'hardlink.key'));
    if (scenario === 'directory') fs.chmodSync(f.directory, 0o755);
    if (scenario === 'plan') { const obj = JSON.parse(fs.readFileSync(path.join(f.directory, 'public-plan.json'))); obj.seller = 'bad.testnet'; fs.writeFileSync(path.join(f.directory, 'public-plan.json'), JSON.stringify(obj)); }
    assert.throws(() => readTollgateTestnetKeys({ ...f, plan }));
  }
});
