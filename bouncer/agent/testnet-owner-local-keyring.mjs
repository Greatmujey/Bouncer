/** Local TESTNET-ONLY keyring. Its encrypted files and wrapping key must remain
 * in an ignored, private workspace directory; they are NOT an off-device user
 * backup. Nothing here contacts a chain, seller, GitHub or external service. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import nearApi from 'near-api-js';
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { keyFrom, readBoundedPrivate, syncWrite } from './circle-owner-offline-journal.mjs';

const FIELDS = ['version', 'network', 'account_id', 'public_key', 'iv', 'tag', 'ciphertext'];
const b64 = x => typeof x === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(x) &&
  Buffer.from(x, 'base64').toString('base64') === x;
const aad = plan => Buffer.from(`bouncer-testnet-owner-keyring-v1\0${plan.account_id}\0${plan.public_key}`);
function secretFile(file, max) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || s.size < 1 || s.size > max || (s.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && s.uid !== process.getuid())) throw Error();
    return fs.readFileSync(fd);
  } catch { throw new Error('local testnet keyring file is missing or exposed'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function privateDir(dir) {
  const s = fs.lstatSync(dir);
  if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && s.uid !== process.getuid())) throw new Error('local keyring directory is not private');
}
function seal(plan, credentials, master) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', master, iv);
  cipher.setAAD(aad(plan));
  const plaintext = Buffer.from(JSON.stringify(credentials));
  try {
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { version: 1, network: 'testnet', account_id: plan.account_id, public_key: plan.public_key,
      iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: encrypted.toString('base64') };
  } finally { plaintext.fill(0); }
}
function unseal(value, plan, master) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...FIELDS].sort().join(',') ||
      value.version !== 1 || value.network !== 'testnet' || value.account_id !== plan.account_id || value.public_key !== plan.public_key ||
      !b64(value.iv) || Buffer.from(value.iv, 'base64').length !== 12 || !b64(value.tag) || Buffer.from(value.tag, 'base64').length !== 16 ||
      !b64(value.ciphertext) || Buffer.from(value.ciphertext, 'base64').length > 4096) throw new Error('invalid encrypted testnet keyring');
  let plaintext;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', master, Buffer.from(value.iv, 'base64'));
    decipher.setAAD(aad(plan)); decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    plaintext = Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]);
    const credentials = JSON.parse(plaintext.toString('utf8'));
    return keyFrom(plan, credentials);
  } catch { throw new Error('testnet keyring cannot be authenticated or does not match the public plan'); }
  finally { plaintext?.fill(0); }
}

/** Generate exactly once in a newly created mode-0700 directory. An existing
 * directory, including an interrupted partial keyring, is never replaced. */
export function createTestnetOwnerKeyring(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('absolute private keyring path required');
  fs.mkdirSync(dir, { mode: 0o700 });
  privateDir(dir);
  const master = crypto.randomBytes(32), pair = nearApi.KeyPair.fromRandom('ed25519');
  const account = `bouncer-owner-${crypto.randomBytes(12).toString('hex')}.testnet`;
  const plan = validateOwnerBootstrapPlan({ version: 1, purpose: 'new-bouncer-testnet-owner', network: 'testnet',
    account_id: account, public_key: String(pair.getPublicKey()) });
  const credentials = { network_id: 'testnet', account_id: account, public_key: plan.public_key, private_key: pair.toString() };
  try {
    syncWrite(path.join(dir, 'master.key'), master, 'wx', 0o600);
    for (const name of ['primary.enc.json', 'backup.enc.json']) {
      syncWrite(path.join(dir, name), JSON.stringify(seal(plan, credentials, master), null, 2) + '\n', 'wx', 0o600);
    }
    syncWrite(path.join(dir, 'public-plan.json'), JSON.stringify(plan, null, 2) + '\n', 'wx', 0o600);
    const verified = readTestnetOwnerKeyring({ dir, plan });
    if (String(verified.getPublicKey()) !== plan.public_key) throw new Error('new keyring copies do not match');
    return { plan, encrypted_copies_checked: 2, local_wrapping_key_retained: true, user_backup_export_verified: false,
      transaction_signed: false, helper_request_sent: false };
  } finally { master.fill(0); credentials.private_key = undefined; }
}

/** Restore only an already-reviewed testnet owner from an existing private
 * credentials file. This never generates a replacement account, signs or
 * broadcasts. A partial/pre-existing keyring directory is never overwritten;
 * preserve the user's independent backup separately. */
export function restoreTestnetOwnerKeyring({ dir, plan: raw, credentialsFile }) {
  const plan = validateOwnerBootstrapPlan(raw);
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || typeof credentialsFile !== 'string' ||
      !path.isAbsolute(credentialsFile) || path.resolve(dir) === path.dirname(path.resolve(credentialsFile))) {
    throw new Error('distinct absolute private restore and credential paths required');
  }
  const parent = path.dirname(path.resolve(dir)), recoveryParent = path.dirname(path.resolve(credentialsFile));
  privateDir(parent); privateDir(recoveryParent);
  if (fs.realpathSync(parent) !== parent || fs.realpathSync(recoveryParent) !== recoveryParent) {
    throw new Error('private restore paths must not traverse symbolic links');
  }
  const credentialsBytes = secretFile(credentialsFile, 4096);
  let credentials, master;
  try {
    try { credentials = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(credentialsBytes)); }
    catch { throw new Error('invalid private testnet recovery file'); }
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials) ||
        Object.keys(credentials).sort().join(',') !== 'account_id,network_id,private_key,public_key') {
      throw new Error('invalid private testnet recovery fields');
    }
    let recovered;
    try { recovered = keyFrom(plan, credentials); }
    catch { throw new Error('recovery key does not match reviewed testnet owner'); }
    if (String(recovered.getPublicKey()) !== plan.public_key) throw new Error('recovery key does not match reviewed owner');
    fs.mkdirSync(dir, { mode: 0o700 });
    privateDir(dir);
    master = crypto.randomBytes(32);
    syncWrite(path.join(dir, 'master.key'), master, 'wx', 0o600);
    for (const name of ['primary.enc.json', 'backup.enc.json']) {
      syncWrite(path.join(dir, name), JSON.stringify(seal(plan, credentials, master), null, 2) + '\n', 'wx', 0o600);
    }
    syncWrite(path.join(dir, 'public-plan.json'), JSON.stringify(plan, null, 2) + '\n', 'wx', 0o600);
    const checked = readTestnetOwnerKeyring({ dir, plan });
    if (String(checked.getPublicKey()) !== plan.public_key) throw new Error('restored encrypted keyring differs');
    return { account_id: plan.account_id, public_key: plan.public_key, encrypted_copies_checked: 2,
      original_owner_restored: true, replacement_owner_created: false, transaction_signed: false, transaction_sent: false };
  } finally {
    credentialsBytes.fill(0); master?.fill(0);
    if (credentials && typeof credentials === 'object') credentials.private_key = undefined;
  }
}

/** Both independently sealed copies must authenticate to the same public key.
 * The returned key pair is in-process only; callers must never log it. */
export function readTestnetOwnerKeyring({ dir, plan: raw }) {
  const plan = validateOwnerBootstrapPlan(raw); privateDir(dir);
  const saved = JSON.parse(secretFile(path.join(dir, 'public-plan.json'), 4096).toString('utf8'));
  if (JSON.stringify(saved) !== JSON.stringify(plan)) throw new Error('local keyring plan differs from the reviewed owner');
  const master = secretFile(path.join(dir, 'master.key'), 32);
  try {
    if (master.length !== 32) throw new Error('invalid local keyring wrapping key');
    const first = unseal(readBoundedPrivate(path.join(dir, 'primary.enc.json')), plan, master),
      second = unseal(readBoundedPrivate(path.join(dir, 'backup.enc.json')), plan, master);
    if (String(first.getPublicKey()) !== String(second.getPublicKey())) throw new Error('testnet keyring copies differ');
    return first;
  } finally { master.fill(0); }
}

/** Export two mode-0600 temporary recovery copies outside Git for the current
 * execution and the user's private viewer. Existing paths are never replaced. */
export function exportTemporaryTestnetOwner({ dir, plan: raw, primary, backup }) {
  const plan = validateOwnerBootstrapPlan(raw);
  if (![primary, backup].every(p => typeof p === 'string' && path.isAbsolute(p)) || primary === backup) {
    throw new Error('distinct absolute private recovery paths are required');
  }
  const pair = readTestnetOwnerKeyring({ dir, plan });
  const credentials = { network_id: 'testnet', account_id: plan.account_id, public_key: plan.public_key, private_key: pair.toString() };
  const content = JSON.stringify(credentials, null, 2) + '\n';
  try {
    for (const file of [primary, backup]) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      privateDir(path.dirname(file));
      try { syncWrite(file, content, 'wx', 0o600); }
      catch (error) {
        if (error?.code !== 'EEXIST' || String(keyFrom(plan, readBoundedPrivate(file)).getPublicKey()) !== plan.public_key) throw error;
      }
    }
    return { account_id: plan.account_id, public_key: plan.public_key, local_copies_verified: 2,
      user_backup_export_verified: false, private_key_logged: false };
  } finally { credentials.private_key = undefined; }
}
