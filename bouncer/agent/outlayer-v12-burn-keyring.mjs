/** Local, TESTNET-ONLY restricted-key pair for the fixed OutLayer diagnostic.
 * No network calls or installation. Both ciphertext copies and their wrapping
 * key are local and are NOT an off-device backup. The full-access owner key is
 * not generated, stored or sent by this module. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import nearApi from 'near-api-js';
import { readBoundedPrivate, syncWrite } from './circle-owner-offline-journal.mjs';
import { createOutlayerBurnPlan, validateOutlayerBurnPlan } from './outlayer-v12-burn-plan.mjs';
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';

const aad = p => Buffer.from(`bouncer-outlayer-v12-burn-testnet-v1\0${JSON.stringify(p)}`);
function privateDir(dir) {
  const s = fs.lstatSync(dir);
  if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && s.uid !== process.getuid())) throw new Error('OutLayer keyring directory is not private');
}
function readSecret(file, max) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.size < 1 || s.size > max || (s.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && s.uid !== process.getuid())) throw Error();
    return fs.readFileSync(fd);
  } catch { throw new Error('OutLayer testnet keyring file missing or exposed'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function seal(plan, funding, project, master) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', master, iv);
  cipher.setAAD(aad(plan));
  const plain = Buffer.from(JSON.stringify({ network:'testnet', owner:plan.owner, vault:plan.vault,
    funding_private_key:funding.toString(), project_private_key:project.toString() }));
  try {
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    return { version:1, network:'testnet', owner:plan.owner, vault:plan.vault,
      funding_public_key:plan.funding_public_key, project_public_key:plan.project_public_key,
      iv:iv.toString('base64'), tag:cipher.getAuthTag().toString('base64'), ciphertext:encrypted.toString('base64') };
  } finally { plain.fill(0); }
}
function open(v, plan, master) {
  const fields=['version','network','owner','vault','funding_public_key','project_public_key','iv','tag','ciphertext'];
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== fields.sort().join(',') ||
      v.version !== 1 || v.network !== 'testnet' || v.owner !== plan.owner || v.vault !== plan.vault ||
      v.funding_public_key !== plan.funding_public_key || v.project_public_key !== plan.project_public_key) throw new Error('invalid encrypted OutLayer keyring');
  const decode=x=>{if(typeof x!=='string')throw Error();const b=Buffer.from(x,'base64');if(b.toString('base64')!==x)throw Error();return b};
  let plain;
  try {
    const iv=decode(v.iv),tag=decode(v.tag),ciphertext=decode(v.ciphertext);
    if(iv.length!==12||tag.length!==16||ciphertext.length<1||ciphertext.length>4096)throw Error();
    const decipher=crypto.createDecipheriv('aes-256-gcm',master,iv);decipher.setAAD(aad(plan));decipher.setAuthTag(tag);
    plain=Buffer.concat([decipher.update(ciphertext),decipher.final()]);
    const x=JSON.parse(plain.toString('utf8'));
    if(x.network!=='testnet'||x.owner!==plan.owner||x.vault!==plan.vault||typeof x.funding_private_key!=='string'||
       typeof x.project_private_key!=='string')throw Error();
    const funding=nearApi.KeyPair.fromString(x.funding_private_key),project=nearApi.KeyPair.fromString(x.project_private_key);
    if(String(funding.getPublicKey())!==plan.funding_public_key||String(project.getPublicKey())!==plan.project_public_key)throw Error();
    return {funding,project};
  } catch { throw new Error('OutLayer testnet keyring cannot be authenticated'); }
  finally {plain?.fill(0)}
}
export function createOutlayerBurnKeyring({dir,ownerPlan:raw}={}) {
  const owner=validateOwnerBootstrapPlan(raw);
  if(typeof dir!=='string'||!path.isAbsolute(dir))throw new Error('absolute private OutLayer keyring path required');
  // Refuse an existing directory: never overwrite an installed or pending key.
  fs.mkdirSync(dir,{mode:0o700});privateDir(dir);
  const funding=nearApi.KeyPair.fromRandom('ed25519'),project=nearApi.KeyPair.fromRandom('ed25519'),master=crypto.randomBytes(32);
  const plan=createOutlayerBurnPlan({ownerPlan:owner,
    fundingPublicKey:String(funding.getPublicKey()),projectPublicKey:String(project.getPublicKey())});
  try {
    syncWrite(path.join(dir,'master.key'),master,'wx',0o600);
    for(const name of ['primary.enc.json','backup.enc.json'])syncWrite(path.join(dir,name),JSON.stringify(seal(plan,funding,project,master),null,2)+'\n','wx',0o600);
    syncWrite(path.join(dir,'public-plan.json'),JSON.stringify(plan,null,2)+'\n','wx',0o600);
    readOutlayerBurnKeyring({dir,plan,ownerPlan:owner});
    return {plan,encrypted_copies_checked:2,off_device_backup_verified:false,installed_on_chain:false,private_keys_logged:false};
  } finally {master.fill(0)}
}
export function readOutlayerBurnKeyring({dir,plan:raw,ownerPlan}={}) {
  const plan=validateOutlayerBurnPlan(raw,ownerPlan);privateDir(dir);
  const stored=JSON.parse(readSecret(path.join(dir,'public-plan.json'),8192).toString('utf8'));
  if(JSON.stringify(stored)!==JSON.stringify(plan))throw new Error('local OutLayer plan differs from reviewed plan');
  const master=readSecret(path.join(dir,'master.key'),32);
  try {
    if(master.length!==32)throw new Error('invalid OutLayer wrapping key');
    const a=open(readBoundedPrivate(path.join(dir,'primary.enc.json')),plan,master),
      b=open(readBoundedPrivate(path.join(dir,'backup.enc.json')),plan,master);
    if(String(a.funding.getPublicKey())!==String(b.funding.getPublicKey())||String(a.project.getPublicKey())!==String(b.project.getPublicKey())){
      throw new Error('OutLayer keyring copies differ');
    }
    return a;
  } finally {master.fill(0)}
}
