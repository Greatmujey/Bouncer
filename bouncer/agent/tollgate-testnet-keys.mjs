/** Offline-only identity preparation for the experimental V13 Tollgate path.
 * The restricted agent key and off-chain voucher key are distinct from each
 * other and the owner. Creating these files does not grant on-chain authority,
 * sign a transaction or contact a seller. The local wrapping key is stored
 * alongside both ciphertexts: this is NOT an independent backup. Do not install
 * either key or expose a voucher until durable recovery and the outstanding
 * V3 original-transaction safety issues have been resolved. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import nearApi from 'near-api-js';
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { TOLLGATE_CONTRACT, TOLLGATE_RESOURCE, TOLLGATE_SELLER } from './tollgate-v12-readiness.mjs';
import { syncWrite } from './circle-owner-offline-journal.mjs';

const PLAN_FIELDS = ['version','purpose','network','owner','owner_public_key','vault','channel_contract','seller','resource',
  'agent_public_key','voucher_public_key','restricted_receiver','restricted_methods'];
const BOX_FIELDS = ['version','network','owner','vault','agent_public_key','voucher_public_key','iv','tag','ciphertext'];
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v, expected) => object(v) && Object.keys(v).sort().join(',') === [...expected].sort().join(',');
function pub(value) {
  try {
    const p = nearApi.utils.PublicKey.fromString(value);
    if (typeof value !== 'string' || !value.startsWith('ed25519:') || p.keyType !== 0 || String(p) !== value) throw Error();
    return value;
  } catch { throw new Error('canonical Ed25519 public key required'); }
}
function privateDirectory(dir) {
  const s = fs.lstatSync(dir);
  if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && s.uid !== process.getuid()) || fs.realpathSync(dir) !== dir) {
    throw new Error('private non-symlink Tollgate keyring directory required');
  }
}
function privateFile(file, max) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || s.size < 1 || s.size > max || (s.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && s.uid !== process.getuid())) throw Error();
    const value = fs.readFileSync(fd);
    if (value.length !== s.size) throw Error();
    return value;
  } catch { throw new Error('Tollgate keyring file missing or exposed'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function canonicalPlan(raw, ownerPlan) {
  const owner = validateOwnerBootstrapPlan(ownerPlan), vault = `data.${owner.account_id}`;
  if (!keys(raw, PLAN_FIELDS) || raw.version !== 1 || raw.purpose !== 'v13-tollgate-dedicated-testnet-keys' ||
      raw.network !== 'testnet' || raw.owner !== owner.account_id || raw.owner_public_key !== owner.public_key ||
      raw.vault !== vault || vault.length > 64 || raw.channel_contract !== TOLLGATE_CONTRACT || raw.seller !== TOLLGATE_SELLER ||
      raw.resource !== TOLLGATE_RESOURCE || raw.restricted_receiver !== vault ||
      !isDeepStrictEqual(raw.restricted_methods, ['execute_tollgate_intent'])) throw new Error('invalid dedicated Tollgate key plan');
  const agent = pub(raw.agent_public_key), voucher = pub(raw.voucher_public_key);
  if (new Set([agent, voucher, owner.public_key]).size !== 3) throw new Error('Tollgate keys must be distinct');
  return { version: 1, purpose: 'v13-tollgate-dedicated-testnet-keys', network: 'testnet', owner: owner.account_id,
    owner_public_key: owner.public_key, vault, channel_contract: TOLLGATE_CONTRACT, seller: TOLLGATE_SELLER,
    resource: TOLLGATE_RESOURCE, agent_public_key: agent, voucher_public_key: voucher,
    restricted_receiver: vault, restricted_methods: ['execute_tollgate_intent'] };
}
export function validateTollgateTestnetKeyPlan(plan, ownerPlan) { return canonicalPlan(plan, ownerPlan); }
const aad = p => Buffer.from(`bouncer-tollgate-testnet-keys-v1\0${JSON.stringify(p)}`, 'utf8');
function seal(plan, agent, voucher, master) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', master, iv); cipher.setAAD(aad(plan));
  const plaintext = Buffer.from(JSON.stringify({ agent_private_key: agent.toString(), voucher_private_key: voucher.toString() }));
  try {
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { version: 1, network: 'testnet', owner: plan.owner, vault: plan.vault, agent_public_key: plan.agent_public_key,
      voucher_public_key: plan.voucher_public_key, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
      ciphertext: encrypted.toString('base64') };
  } finally { plaintext.fill(0); }
}
function decode(value, length, max) {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw Error();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || bytes.length > max || (length !== null && bytes.length !== length)) throw Error();
  return bytes;
}
function unseal(box, plan, master) {
  let plain;
  try {
    if (!keys(box, BOX_FIELDS) || box.version !== 1 || box.network !== 'testnet' || box.owner !== plan.owner || box.vault !== plan.vault ||
        box.agent_public_key !== plan.agent_public_key || box.voucher_public_key !== plan.voucher_public_key) throw Error();
    const iv = decode(box.iv, 12, 12), tag = decode(box.tag, 16, 16), ciphertext = decode(box.ciphertext, null, 4096);
    if (!ciphertext.length) throw Error();
    const cipher = crypto.createDecipheriv('aes-256-gcm', master, iv); cipher.setAAD(aad(plan)); cipher.setAuthTag(tag);
    plain = Buffer.concat([cipher.update(ciphertext), cipher.final()]);
    const c = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
    if (!keys(c, ['agent_private_key','voucher_private_key']) || typeof c.agent_private_key !== 'string' || typeof c.voucher_private_key !== 'string') throw Error();
    const agent = nearApi.KeyPair.fromString(c.agent_private_key), voucher = nearApi.KeyPair.fromString(c.voucher_private_key);
    if (String(agent.getPublicKey()) !== plan.agent_public_key || String(voucher.getPublicKey()) !== plan.voucher_public_key) throw Error();
    return { agentKey: agent, voucherKey: voucher };
  } catch { throw new Error('Tollgate keyring cannot be authenticated'); }
  finally { plain?.fill(0); }
}
function parse(file, max) {
  const bytes = privateFile(file, max);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('invalid private Tollgate keyring JSON'); }
  finally { bytes.fill(0); }
}

/** Create exactly once in a new private directory. Nothing is installed. */
export function createTollgateTestnetKeys({ directory, ownerPlan } = {}) {
  const owner = validateOwnerBootstrapPlan(ownerPlan);
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('absolute Tollgate keyring path required');
  const dir = path.resolve(directory), parent = path.dirname(dir); privateDirectory(parent);
  fs.mkdirSync(dir, { mode: 0o700 }); privateDirectory(dir);
  const agent = nearApi.KeyPair.fromRandom('ed25519'), voucher = nearApi.KeyPair.fromRandom('ed25519'), master = crypto.randomBytes(32);
  const plan = canonicalPlan({ version: 1, purpose: 'v13-tollgate-dedicated-testnet-keys', network: 'testnet', owner: owner.account_id,
    owner_public_key: owner.public_key, vault: `data.${owner.account_id}`, channel_contract: TOLLGATE_CONTRACT, seller: TOLLGATE_SELLER,
    resource: TOLLGATE_RESOURCE, agent_public_key: String(agent.getPublicKey()), voucher_public_key: String(voucher.getPublicKey()),
    restricted_receiver: `data.${owner.account_id}`, restricted_methods: ['execute_tollgate_intent'] }, owner);
  try {
    syncWrite(path.join(dir, 'master.key'), master, 'wx', 0o600);
    for (const name of ['primary.enc.json', 'backup.enc.json']) syncWrite(path.join(dir, name), JSON.stringify(seal(plan, agent, voucher, master)) + '\n', 'wx', 0o600);
    syncWrite(path.join(dir, 'public-plan.json'), JSON.stringify(plan, null, 2) + '\n', 'wx', 0o600);
    const read = readTollgateTestnetKeys({ directory: dir, ownerPlan: owner, plan });
    if (String(read.agentKey.getPublicKey()) !== plan.agent_public_key || String(read.voucherKey.getPublicKey()) !== plan.voucher_public_key) throw Error('Tollgate key copies differ');
    return { plan, encrypted_copies_checked: 2, independently_backed_up: false, installed_on_chain: false,
      transaction_signed: false, voucher_signed: false, seller_contacted: false, private_keys_logged: false };
  } finally { master.fill(0); }
}

/** Return both keys in-process only; callers must never log them. */
export function readTollgateTestnetKeys({ directory, ownerPlan, plan: raw } = {}) {
  const plan = canonicalPlan(raw, ownerPlan);
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('absolute Tollgate keyring path required');
  const dir = path.resolve(directory); privateDirectory(dir);
  if (!isDeepStrictEqual(parse(path.join(dir, 'public-plan.json'), 4096), plan)) throw new Error('Tollgate key plan differs');
  const master = privateFile(path.join(dir, 'master.key'), 32);
  try {
    if (master.length !== 32) throw new Error('invalid Tollgate wrapping key');
    const a = unseal(parse(path.join(dir, 'primary.enc.json'), 8192), plan, master);
    const b = unseal(parse(path.join(dir, 'backup.enc.json'), 8192), plan, master);
    if (String(a.agentKey.getPublicKey()) !== String(b.agentKey.getPublicKey()) ||
        String(a.voucherKey.getPublicKey()) !== String(b.voucherKey.getPublicKey())) throw new Error('Tollgate key copies differ');
    return a;
  } finally { master.fill(0); }
}
