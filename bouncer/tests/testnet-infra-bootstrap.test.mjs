import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../scripts/prepare-testnet-infra-session.mjs', import.meta.url));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-testnet-infra-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'infrastructure'));
  fs.mkdirSync(path.join(root, 'runner'));
  fs.copyFileSync(source, path.join(root, 'scripts', 'prepare.mjs'));
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength:4096 });
  fs.writeFileSync(path.join(root,'infrastructure','testnet-bootstrap-public.pem'), keys.publicKey.export({type:'spki',format:'pem'}));
  return { root, keys, close:()=>fs.rmSync(root,{recursive:true,force:true}) };
}
function run(root, role='coordinator') {
  return spawnSync(process.execPath, [path.join(root,'scripts','prepare.mjs')], { encoding:'utf8',
    env:{ ...process.env, RUNNER_TEMP:path.join(root,'runner'), GITHUB_RUN_ID:'1234', BOUNCER_INFRA_ROLE:role } });
}
function verifierFor(password, verifier) {
  const [algorithm, saltField, keyField] = verifier.split('$');
  const [rounds,salt] = saltField.split(':'), [stored,server] = keyField.split(':');
  const salted = crypto.pbkdf2Sync(password,Buffer.from(salt,'base64'),Number(rounds),32,'sha256');
  return algorithm === 'SCRAM-SHA-256' && Number(rounds) === 4096 &&
    crypto.createHash('sha256').update(crypto.createHmac('sha256',salted).update('Client Key').digest()).digest('base64') === stored &&
    crypto.createHmac('sha256',salted).update('Server Key').digest('base64') === server;
}

test('testnet session emits only an encrypted bootstrap; the actual database key stays local', () => {
  const f=fixture();
  try {
    const result=run(f.root);
    assert.equal(result.status,0,result.stderr);
    const dir=path.join(f.root,'runner','bouncer-testnet-infra-coordinator');
    const sealed=fs.readFileSync(path.join(dir,'bootstrap.enc'),'utf8');
    const payload=JSON.parse(crypto.privateDecrypt({key:f.keys.privateKey,oaepHash:'sha256',padding:crypto.constants.RSA_PKCS1_OAEP_PADDING},
      Buffer.from(sealed,'base64')).toString());
    const actual=fs.readFileSync(path.join(dir,'postgres-password'),'utf8');
    assert.equal(payload.version,1); assert.equal(payload.run_id,'1234'); assert.equal(payload.role,'coordinator');
    assert.notEqual(actual,payload.bootstrap_password); assert.equal(verifierFor(actual,payload.postgres_scram_verifier),true);
    assert.ok(!result.stdout.includes(actual) && !result.stdout.includes(payload.bootstrap_password) &&
      !result.stdout.includes(payload.postgres_scram_verifier));
    const key=crypto.createPrivateKey(fs.readFileSync(path.join(dir,'session-key.pem')));
    assert.equal(crypto.createPublicKey(key).export({type:'spki',format:'der'}).toString('base64'),payload.session_public_key_der_base64);
    assert.equal(fs.statSync(path.join(dir,'postgres-password')).mode & 0o077,0);
    assert.equal(fs.statSync(path.join(dir,'session-key.pem')).mode & 0o077,0);
    assert.match(result.stdout,/No wallet, transaction, database connection, or public prompt was started/);
  } finally { f.close(); }
});

test('invalid roles fail closed before credentials or provisioning are created',()=>{
  const f=fixture();
  try { const result=run(f.root,'unknown'); assert.notEqual(result.status,0); assert.deepEqual(fs.readdirSync(path.join(f.root,'runner')),[]); }
  finally { f.close(); }
});
