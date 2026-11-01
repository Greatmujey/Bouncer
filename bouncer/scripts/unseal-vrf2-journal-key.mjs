#!/usr/bin/env node
/** Local only: derive the VRF2 encrypted journal key from the retained sealed
 * disposable credentials without printing or writing any NEAR signing key.
 * The envelope is not creator-authenticated. Verify public keys/FINAL chain
 * state separately, keep the private recovery key outside Git, and never send
 * an unresolved hash again. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { openTestnetCredentials, testnetRecoveryKeyId } from '../agent/testnet-credential-envelope.mjs';

const KEY_ID = '77f3170a5df339b2ef4affeb39e8fa549d3b4ca9ac5579d0a21f9936e927508b';
export function deriveVrf2JournalKey(payload, identity) {
  if (payload?.version !== 3 || payload.purpose !== 'outlayer-vrf-testnet' || payload.owner_account_id !== identity?.owner ||
      payload.contract_id !== identity?.vault || identity?.purpose !== 'fresh-testnet-fake-token-independent-vrf-diagnostic') {
    throw new Error('recovery payload does not match the retained VRF2 identity');
  }
  for (const [secret, pub] of [['owner_secret', 'owner_public_key'], ['contract_secret', 'vault_public_key'],
    ['funding_secret', 'funding_public_key'], ['project_secret', 'project_public_key']]) {
    let actual;
    try { actual = nearApi.KeyPair.fromString(payload[secret]).getPublicKey().toString(); } catch { throw new Error('invalid recovered disposable key'); }
    if (actual !== identity[pub]) throw new Error('recovered key does not match retained public identity');
  }
  return crypto.createHash('sha256').update('bouncer-vrf2-journal-v1\0').update(payload.contract_secret).digest();
}

export function writePrivateVrf2JournalKey(file, key) {
  if (typeof file !== 'string' || !file || !Buffer.isBuffer(key) || key.length !== 32) throw new Error('invalid journal key output');
  const target = path.resolve(file), parent = path.dirname(target);
  let dirFd, fd, created = false;
  try {
    dirFd = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(dirFd), named = fs.lstatSync(parent);
    if (!stat.isDirectory() || !named.isDirectory() || (stat.mode & 0o777) !== 0o700 || (named.mode & 0o777) !== 0o700 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || stat.dev !== named.dev || stat.ino !== named.ino) {
      throw new Error('key parent must be an existing owner-only directory with mode 0700');
    }
    fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    created = true; fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, key); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    const after = fs.lstatSync(parent);
    if (after.dev !== stat.dev || after.ino !== stat.ino || (after.mode & 0o777) !== 0o700) throw new Error('key directory changed');
    fs.fsyncSync(dirFd);
  } catch (error) {
    if (created) throw new Error('journal key creation incomplete; inspect the existing path before use', { cause: error });
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); if (dirFd !== undefined) fs.closeSync(dirFd); }
}

function main() {
  const [directory, privateFile, output] = process.argv.slice(2);
  if (process.argv.length !== 5 || !directory || !privateFile || !output) {
    throw new Error('usage: node unseal-vrf2-journal-key.mjs RETAINED-DIR RECOVERY-PRIVATE-PEM NEW-PRIVATE-KEY-FILE');
  }
  const pem = fs.readFileSync(privateFile, 'utf8');
  if (testnetRecoveryKeyId(pem) !== KEY_ID) throw new Error('unexpected VRF2 recovery key');
  const envelope = JSON.parse(fs.readFileSync(path.join(directory, 'sealed-testnet-credentials.json'), 'utf8'));
  const identity = JSON.parse(fs.readFileSync(path.join(directory, 'identity.json'), 'utf8'));
  if (identity.recovery_key_id !== KEY_ID) throw new Error('retained recovery key identity differs');
  const payload = openTestnetCredentials(envelope, pem);
  const key = deriveVrf2JournalKey(payload, identity);
  try { writePrivateVrf2JournalKey(output, key); } finally { key.fill(0); }
  console.log('Derived an owner-only journal decryption key; no NEAR signing key was written and no network call was made.');
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { main(); } catch (error) { console.error(`[vrf2-journal-key] ${error.message}`); process.exitCode = 1; }
}
