#!/usr/bin/env node
/**
 * Prepare credentials for a short-lived, explicitly triggered testnet
 * infrastructure session. This script does NOT connect a wallet, send a NEAR
 * transaction, contact a provider, provision a database, or enable prompts.
 *
 * The actual database password and X25519 private key stay on the GitHub
 * Actions runner. An independent RSA public key encrypts a temporary bootstrap
 * password, the SCRAM verifier for the actual password, and the session public
 * key for the operator. The resulting ciphertext is safe to put in the public
 * workflow output; the bootstrap password MUST be revoked immediately after
 * project creation. Loss of this runner is not permission to reopen a prompt.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function required(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || !value) throw new Error('missing required session configuration');
  return value;
}
function writeSecret(file, data) {
  fs.writeFileSync(file, data, { mode: 0o600, flag: 'wx' });
  if ((fs.statSync(file).mode & 0o077) !== 0) throw new Error('unsafe local secret permissions');
}
function makeScramVerifier(password) {
  // PostgreSQL accepts SCRAM verifiers in ALTER ROLE ... PASSWORD; the raw,
  // 256-bit random database password never enters the management API or logs.
  const salt = crypto.randomBytes(16), rounds = 4096;
  const salted = crypto.pbkdf2Sync(password, salt, rounds, 32, 'sha256');
  try {
    const client = crypto.createHmac('sha256', salted).update('Client Key').digest();
    const stored = crypto.createHash('sha256').update(client).digest('base64');
    const server = crypto.createHmac('sha256', salted).update('Server Key').digest('base64');
    client.fill(0);
    return `SCRAM-SHA-256$${rounds}:${salt.toString('base64')}$${stored}:${server}`;
  } finally { salted.fill(0); }
}

const role = required('BOUNCER_INFRA_ROLE');
const runId = required('GITHUB_RUN_ID');
const temporary = required('RUNNER_TEMP');
if (!['coordinator', 'checkpoint'].includes(role) || !/^[1-9][0-9]{0,19}$/.test(runId) || !path.isAbsolute(temporary)) {
  throw new Error('invalid session');
}
const directory = path.join(temporary, `bouncer-testnet-infra-${role}`);
fs.mkdirSync(directory, { mode: 0o700 });
if ((fs.statSync(directory).mode & 0o077) !== 0) throw new Error('unsafe local session directory');
const rsa = crypto.createPublicKey(fs.readFileSync(new URL('../infrastructure/testnet-bootstrap-public.pem', import.meta.url)));
if (rsa.asymmetricKeyType !== 'rsa' || rsa.asymmetricKeyDetails?.modulusLength !== 4096) throw new Error('invalid bootstrap public key');
const bootstrapPassword = crypto.randomBytes(24).toString('base64url');
const password = crypto.randomBytes(32).toString('base64url');
const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
writeSecret(path.join(directory, 'postgres-password'), password);
writeSecret(path.join(directory, 'session-key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
const payload = JSON.stringify({ version: 1, run_id: runId, role, bootstrap_password: bootstrapPassword,
  postgres_scram_verifier: makeScramVerifier(password),
  session_public_key_der_base64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') });
const sealed = crypto.publicEncrypt({ key: rsa, oaepHash: 'sha256', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(payload));
writeSecret(path.join(directory, 'bootstrap.enc'), sealed.toString('base64'));
console.log('Prepared the encrypted provisioning envelope. No wallet, transaction, database connection, or public prompt was started.');
