/** LOCAL TESTNET-ONLY restricted agent keyring. The two ciphertexts and the
 * wrapping key are stored together and are NOT an independent backup. The
 * agent key is not the owner's full-access key. This module never contacts a
 * chain, GitHub, an RPC or a seller. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import nearApi from 'near-api-js';
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { newTestnetVaultId } from './keyless-vault-bootstrap-readiness.mjs';
import { readBoundedPrivate, syncWrite } from './circle-owner-offline-journal.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE } from '../scripts/circle-testnet-setup.mjs';
const METHODS = ['execute', 'execute_ft_call'];
const aad = p => Buffer.from(`bouncer-testnet-resource-agent-v1\0${p.owner}\0${p.vault}\0${p.public_key}`);
const fields = ['version','purpose','network','owner','owner_public_key','vault','public_key','policy_id','token','per_tx_cap_atoms','daily_cap_atoms','methods','gas_allowance_yocto'];
const encFields = ['version','network','owner','vault','public_key','iv','tag','ciphertext'];
function privateDir(dir) {
  const s = fs.lstatSync(dir);
  if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && s.uid !== process.getuid())) throw new Error('testnet agent keyring directory is not private');
}
function secret(file, max) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.size < 1 || s.size > max || (s.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && s.uid !== process.getuid())) throw Error();
    return fs.readFileSync(fd);
  } catch { throw new Error('testnet agent keyring file missing or exposed'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
export function validateTestnetResourceAgentPlan(p, rawOwner) {
  const owner = validateOwnerBootstrapPlan(rawOwner);
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).sort().join(',') !== [...fields].sort().join(',') ||
      p.version !== 1 || p.purpose !== 'restricted-testnet-resource-agent' || p.network !== 'testnet' ||
      p.owner !== owner.account_id || p.owner_public_key !== owner.public_key || p.vault !== newTestnetVaultId(owner) ||
      p.policy_id !== 'circle-resources' || p.token !== CIRCLE || p.per_tx_cap_atoms !== '3000' || p.daily_cap_atoms !== '6907' ||
      JSON.stringify(p.methods) !== JSON.stringify(METHODS) || p.gas_allowance_yocto !== '100000000000000000000000' ||
      typeof p.public_key !== 'string' || p.public_key === owner.public_key) throw new Error('invalid restricted testnet agent plan');
  let key; try { key = nearApi.utils.PublicKey.from(p.public_key); } catch { throw new Error('invalid restricted testnet agent public key'); }
  if (key.keyType !== 0 || String(key) !== p.public_key) throw new Error('invalid restricted testnet agent public key');
  return p;
}
function seal(plan, keyPair, master) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', master, iv); cipher.setAAD(aad(plan));
  const plain = Buffer.from(JSON.stringify({ network_id: 'testnet', account_id: plan.owner,
    public_key: plan.public_key, private_key: keyPair.toString() }));
  try { const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    return { version: 1, network: 'testnet', owner: plan.owner, vault: plan.vault, public_key: plan.public_key,
      iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
  } finally { plain.fill(0); }
}
function unseal(v, plan, master) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== [...encFields].sort().join(',') ||
      v.version !== 1 || v.network !== 'testnet' || v.owner !== plan.owner || v.vault !== plan.vault || v.public_key !== plan.public_key ||
      typeof v.iv !== 'string' || typeof v.tag !== 'string' || typeof v.ciphertext !== 'string') throw new Error('invalid encrypted agent keyring');
  const decode = x => { const b = Buffer.from(x, 'base64'); if (b.toString('base64') !== x) throw Error(); return b; };
  let plain;
  try {
    const iv = decode(v.iv), tag = decode(v.tag), ciphertext = decode(v.ciphertext);
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length < 1 || ciphertext.length > 4096) throw Error();
    const decipher = crypto.createDecipheriv('aes-256-gcm', master, iv); decipher.setAAD(aad(plan)); decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const c = JSON.parse(plain.toString('utf8'));
    if (c.network_id !== 'testnet' || c.account_id !== plan.owner || c.public_key !== plan.public_key || typeof c.private_key !== 'string') throw Error();
    const key = nearApi.KeyPair.fromString(c.private_key);
    if (String(key.getPublicKey()) !== plan.public_key) throw Error();
    return key;
  } catch { throw new Error('testnet agent keyring cannot be authenticated'); }
  finally { plain?.fill(0); }
}
export function createTestnetResourceAgentKeyring({ dir, ownerPlan: raw } = {}) {
  const owner = validateOwnerBootstrapPlan(raw);
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('absolute private agent keyring path required');
  fs.mkdirSync(dir, { mode: 0o700 }); privateDir(dir);
  const pair = nearApi.KeyPair.fromRandom('ed25519'), master = crypto.randomBytes(32);
  const plan = validateTestnetResourceAgentPlan({ version: 1, purpose: 'restricted-testnet-resource-agent', network: 'testnet',
    owner: owner.account_id, owner_public_key: owner.public_key, vault: newTestnetVaultId(owner), public_key: String(pair.getPublicKey()),
    policy_id: 'circle-resources', token: CIRCLE, per_tx_cap_atoms: '3000', daily_cap_atoms: '6907', methods: [...METHODS],
    gas_allowance_yocto: '100000000000000000000000' }, owner);
  try {
    syncWrite(path.join(dir, 'master.key'), master, 'wx', 0o600);
    for (const name of ['primary.enc.json','backup.enc.json']) syncWrite(path.join(dir, name), JSON.stringify(seal(plan, pair, master), null, 2)+'\n','wx',0o600);
    syncWrite(path.join(dir, 'public-plan.json'), JSON.stringify(plan, null, 2)+'\n','wx',0o600);
    if (String(readTestnetResourceAgentKeyring({ dir, plan, ownerPlan: owner }).getPublicKey()) !== plan.public_key) throw new Error('agent keyring copies differ');
    return { plan, encrypted_copies_checked: 2, local_wrapping_key_retained: true, off_device_backup_verified: false,
      installed_on_chain: false, private_key_logged: false };
  } finally { master.fill(0); }
}
export function readTestnetResourceAgentKeyring({ dir, plan: rawPlan, ownerPlan } = {}) {
  const plan = validateTestnetResourceAgentPlan(rawPlan, ownerPlan); privateDir(dir);
  const stored = JSON.parse(secret(path.join(dir, 'public-plan.json'), 8192).toString('utf8'));
  if (JSON.stringify(stored) !== JSON.stringify(plan)) throw new Error('local agent plan differs from reviewed plan');
  const master = secret(path.join(dir, 'master.key'), 32);
  try {
    if (master.length !== 32) throw new Error('invalid testnet agent wrapping key');
    const a = unseal(readBoundedPrivate(path.join(dir, 'primary.enc.json')), plan, master),
      b = unseal(readBoundedPrivate(path.join(dir, 'backup.enc.json')), plan, master);
    if (String(a.getPublicKey()) !== String(b.getPublicKey())) throw new Error('testnet agent copies differ');
    return a;
  } finally { master.fill(0); }
}
