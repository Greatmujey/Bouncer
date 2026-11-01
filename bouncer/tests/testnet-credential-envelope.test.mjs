import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { sealTestnetCredentials, openTestnetCredentials, testnetRecoveryKeyId } from '../agent/testnet-credential-envelope.mjs';

const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 3072, publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const credentials = () => ({ version: 1, owner_account_id: 'owner.testnet', contract_id: 'vault.testnet', router_id: 'router.testnet',
  owner_secret: nearApi.KeyPair.fromRandom('ed25519').toString(), input_secret: nearApi.KeyPair.fromRandom('ed25519').toString(),
  sweep_secret: nearApi.KeyPair.fromRandom('ed25519').toString() });
function flip64(s) { const b = Buffer.from(s, 'base64'); b[0] ^= 1; return b.toString('base64'); }

test('disposable testnet credentials round-trip under a separate private recovery key', () => {
  const payload = credentials(), first = sealTestnetCredentials(payload, rsa.publicKey), second = sealTestnetCredentials(payload, rsa.publicKey);
  assert.equal(first.key_id, testnetRecoveryKeyId(rsa.publicKey)); assert.notEqual(first.ciphertext, second.ciphertext);
  assert.notEqual(first.iv, second.iv); assert(!JSON.stringify(first).includes(payload.owner_secret));
  assert.deepEqual(openTestnetCredentials(first, rsa.privateKey), payload);
});

test('version 2 preserves deploy keys for failures before contracts are locked', () => {
  const payload = { ...credentials(), version: 2, contract_secret: nearApi.KeyPair.fromRandom('ed25519').toString(),
    router_secret: nearApi.KeyPair.fromRandom('ed25519').toString() };
  assert.deepEqual(openTestnetCredentials(sealTestnetCredentials(payload, rsa.publicKey), rsa.privateKey), payload);
  assert.throws(() => sealTestnetCredentials({ ...payload, router_secret: payload.contract_secret }, rsa.publicKey), /distinct/);
  const incomplete = { ...payload }; delete incomplete.contract_secret;
  assert.throws(() => sealTestnetCredentials(incomplete, rsa.publicKey), /invalid/);
  assert.throws(() => sealTestnetCredentials({ ...payload, version: 1 }, rsa.publicKey), /invalid/);
});

test('version 3 binds distinct testnet OutLayer owner, deploy and scoped payment keys', () => {
  const v3 = { version: 3, purpose: 'outlayer-vrf-testnet', owner_account_id: 'owner.testnet', contract_id: 'vault.testnet',
    owner_secret: nearApi.KeyPair.fromRandom('ed25519').toString(), contract_secret: nearApi.KeyPair.fromRandom('ed25519').toString(),
    funding_secret: nearApi.KeyPair.fromRandom('ed25519').toString(), project_secret: nearApi.KeyPair.fromRandom('ed25519').toString() };
  assert.deepEqual(openTestnetCredentials(sealTestnetCredentials(v3, rsa.publicKey), rsa.privateKey), v3);
  for (const bad of [{ ...v3, purpose: 'other' }, { ...v3, owner_account_id: 'owner.near' },
    { ...v3, contract_id: v3.owner_account_id }, { ...v3, project_secret: v3.funding_secret }, { ...v3, extra: true }]) {
    assert.throws(() => sealTestnetCredentials(bad, rsa.publicKey));
  }
});

test('tampering, wrong keys and malformed envelopes fail authentication', () => {
  const sealed = sealTestnetCredentials(credentials(), rsa.publicKey);
  for (const field of ['wrapped_key', 'iv', 'ciphertext', 'tag']) {
    assert.throws(() => openTestnetCredentials({ ...sealed, [field]: flip64(sealed[field]) }, rsa.privateKey));
  }
  assert.throws(() => openTestnetCredentials({ ...sealed, key_id: '0'.repeat(64) }, rsa.privateKey));
  assert.throws(() => openTestnetCredentials({ ...sealed, algorithm: 'other' }, rsa.privateKey));
  assert.throws(() => openTestnetCredentials({ ...sealed, extra: true }, rsa.privateKey));
  assert.throws(() => openTestnetCredentials({ ...sealed, ciphertext: 'a'.repeat(10000) }, rsa.privateKey));
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 3072, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } });
  assert.throws(() => openTestnetCredentials(sealed, other.privateKey));
});

test('envelopes cannot accidentally capture mainnet, duplicate keys or a weak recovery key', () => {
  const payload = credentials();
  assert.throws(() => sealTestnetCredentials({ ...payload, owner_account_id: 'owner.near' }, rsa.publicKey));
  assert.throws(() => sealTestnetCredentials({ ...payload, owner_secret: payload.input_secret }, rsa.publicKey));
  assert.throws(() => sealTestnetCredentials({ ...payload, input_secret: 'bad' }, rsa.publicKey));
  assert.throws(() => sealTestnetCredentials({ ...payload, extra: 'secret' }, rsa.publicKey));
  const weak = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  assert.throws(() => sealTestnetCredentials(payload, weak.publicKey), /3072/);
});

test('credential recovery CLI writes owner-only testnet files without printing or overwriting secrets', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-sealed-key-test-'));
  try {
    const payload = credentials(), envelope = path.join(root, 'envelope.json'), privateFile = path.join(root, 'private.pem');
    fs.writeFileSync(envelope, JSON.stringify(sealTestnetCredentials(payload, rsa.publicKey)), { mode: 0o600 });
    fs.writeFileSync(privateFile, rsa.privateKey, { mode: 0o600 });
    const script = path.resolve('scripts/open-ref-demo-credentials.mjs');
    const run = () => spawnSync(process.execPath, [script, envelope, privateFile, 'ref-test'], { env: { ...process.env, HOME: root }, encoding: 'utf8' });
    let child = run(); assert.equal(child.status, 0, child.stderr); assert(!child.stdout.includes(payload.owner_secret));
    const dir = path.join(root, '.near-credentials/testnet/ref-test');
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    for (const [name, secret] of [['owner.json', payload.owner_secret], ['input.json', payload.input_secret], ['sweep.json', payload.sweep_secret]]) {
      const file = path.join(dir, name); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(JSON.parse(fs.readFileSync(file)).private_key, secret);
    }
    child = run(); assert.notEqual(child.status, 0); assert(!child.stderr.includes(payload.owner_secret));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'))).private_key, payload.owner_secret);
    const v2 = { ...credentials(), version: 2, contract_secret: nearApi.KeyPair.fromRandom('ed25519').toString(),
      router_secret: nearApi.KeyPair.fromRandom('ed25519').toString() };
    fs.writeFileSync(envelope, JSON.stringify(sealTestnetCredentials(v2, rsa.publicKey)));
    child = spawnSync(process.execPath, [script, envelope, privateFile, 'ref-v2'], { env: { ...process.env, HOME: root }, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr); assert(!child.stdout.includes(v2.contract_secret));
    const dir2 = path.join(root, '.near-credentials/testnet/ref-v2');
    for (const [name, account, secret] of [['contract', v2.contract_id, v2.contract_secret], ['router', v2.router_id, v2.router_secret]]) {
      const file = path.join(dir2, `${name}.json`), data = JSON.parse(fs.readFileSync(file));
      assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(data.account_id, account); assert.equal(data.private_key, secret);
    }
    const v3 = { version: 3, purpose: 'outlayer-vrf-testnet', owner_account_id: 'owner.testnet', contract_id: 'vault.testnet',
      owner_secret: nearApi.KeyPair.fromRandom('ed25519').toString(), contract_secret: nearApi.KeyPair.fromRandom('ed25519').toString(),
      funding_secret: nearApi.KeyPair.fromRandom('ed25519').toString(), project_secret: nearApi.KeyPair.fromRandom('ed25519').toString() };
    fs.writeFileSync(envelope, JSON.stringify(sealTestnetCredentials(v3, rsa.publicKey)));
    child = spawnSync(process.execPath, [path.resolve('scripts/open-testnet-demo-credentials.mjs'), envelope, privateFile, 'vrf-v3'],
      { env: { ...process.env, HOME: root }, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const dir3 = path.join(root, '.near-credentials/testnet/vrf-v3');
    for (const [name, account, secret] of [['contract', v3.contract_id, v3.contract_secret], ['funding', v3.owner_account_id, v3.funding_secret],
      ['project', v3.owner_account_id, v3.project_secret]]) {
      const file = path.join(dir3, `${name}.json`), data = JSON.parse(fs.readFileSync(file));
      assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(data.account_id, account); assert.equal(data.private_key, secret);
    }
    fs.chmodSync(privateFile, 0o644); child = run(); assert.notEqual(child.status, 0); assert.match(child.stderr, /owner-only/);
    fs.chmodSync(privateFile, 0o600);
    const link = path.join(root, 'private-link.pem'); fs.symlinkSync(privateFile, link);
    child = spawnSync(process.execPath, [script, envelope, link, 'ref-second'], { env: { ...process.env, HOME: root }, encoding: 'utf8' });
    assert.notEqual(child.status, 0); assert(!child.stderr.includes(payload.owner_secret));
    assert.equal(fs.existsSync(path.join(root, '.near-credentials/testnet/ref-second')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('live Ref demo refuses to begin without an explicit testnet-only acknowledgement', async () => {
  const path = await import('node:path'), { spawnSync } = await import('node:child_process');
  const env = { ...process.env }; delete env.BOUNCER_REF_DEMO_ACK;
  const child = spawnSync(process.execPath, [path.resolve('demo-ref-swap.mjs')], { env, encoding: 'utf8', timeout: 10_000 });
  assert.notEqual(child.status, 0); assert.match(child.stderr, /testnet-only one-shot acknowledgement is required/);
});

test('independent VRF demo refuses to begin without its own testnet-only acknowledgement', async () => {
  const path = await import('node:path'), { spawnSync } = await import('node:child_process');
  const env = { ...process.env, BOUNCER_PAID_PROBE: 'vrf' }; delete env.BOUNCER_VRF_DEMO_ACK;
  const child = spawnSync(process.execPath, [path.resolve('demo-ft-call.mjs')], { env, encoding: 'utf8', timeout: 10_000 });
  assert.notEqual(child.status, 0); assert.match(child.stderr, /testnet-only VRF acknowledgement is required/);
});

test('checked-in testnet recovery public key matches the single-use demo pin', async () => {
  const fs = await import('node:fs');
  const pem = fs.readFileSync('config/testnet-ref-demo-recovery-public.pem', 'utf8');
  assert.equal(testnetRecoveryKeyId(pem), '4dea968ec5691e26569b92b85fef218b2b1d08a43e32011b1f22d9c6ac2222ec');
  const vrf = fs.readFileSync('config/testnet-outlayer-vrf-recovery-public.pem', 'utf8');
  assert.equal(testnetRecoveryKeyId(vrf), 'bf02736cddec49ea0c015b4a8da99e1904956f8d6254d228a794b83c0bd07b04');
});
