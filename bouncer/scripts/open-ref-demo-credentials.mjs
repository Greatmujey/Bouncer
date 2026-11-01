#!/usr/bin/env node
// Restore ONLY disposable testnet demo keys sealed to the operator's separate
// local RSA key. Never prints credentials, never signs and never sends.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import { openTestnetCredentials } from '../agent/testnet-credential-envelope.mjs';

function readPrivate(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || stat.size > 16_384) {
    throw new Error('recovery private key must be an owner-only regular file');
  }
  return fs.readFileSync(file, 'utf8');
}
function writeExclusive(dir, name, data) {
  const fd = fs.openSync(path.join(dir, name), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(data, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function main() {
  if (process.argv.length !== 5 || !/^[A-Za-z0-9_-]{1,64}$/.test(process.argv[4])) {
    throw new Error('usage: node open-ref-demo-credentials.mjs ENVELOPE.json PRIVATE_KEY.pem OUTPUT_NAME');
  }
  const file = fs.statSync(process.argv[2]);
  if (!file.isFile() || file.size > 16_384) throw new Error('invalid recovery envelope file');
  const payload = openTestnetCredentials(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), readPrivate(process.argv[3]));
  const root = path.join(os.homedir(), '.near-credentials', 'testnet');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && rootStat.uid !== process.getuid())) throw new Error('testnet credential directory must be owner-only');
  const dir = path.join(root, process.argv[4]); fs.mkdirSync(dir, { mode: 0o700 }); // never overwrite a previous recovery
  for (const [name, secret] of [['owner.json', payload.owner_secret], ['input.json', payload.input_secret], ['sweep.json', payload.sweep_secret]]) {
    writeExclusive(dir, name, { account_id: payload.owner_account_id, private_key: secret });
  }
  writeExclusive(dir, 'identity.json', { version: 1, owner_account_id: payload.owner_account_id, contract_id: payload.contract_id,
    router_id: payload.router_id, public_keys: Object.fromEntries([['owner', payload.owner_secret], ['input', payload.input_secret], ['sweep', payload.sweep_secret]]
      .map(([name, secret]) => [name, nearApi.KeyPair.fromString(secret).getPublicKey().toString()])) });
  const dfd = fs.openSync(dir, 'r'), pfd = fs.openSync(root, 'r');
  try { fs.fsyncSync(dfd); fs.fsyncSync(pfd); } finally { fs.closeSync(dfd); fs.closeSync(pfd); }
  console.log(`Restored disposable testnet keys into ${dir}. Verify each public key and route against FINAL chain state before use; never resend an uncertain transaction.`);
}
try { main(); } catch (error) { console.error(`[ref-demo-recovery] ${error.message}`); process.exitCode = 1; }
