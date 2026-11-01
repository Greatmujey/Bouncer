#!/usr/bin/env node
// Restore ONLY disposable testnet demo keys sealed to the operator's separate
// local RSA key. Never prints credentials, never signs and never sends.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import { openTestnetCredentials } from '../agent/testnet-credential-envelope.mjs';

function readPrivate(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || stat.size > 16_384) {
      throw new Error('recovery private key must be an owner-only regular file');
    }
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}
function writeExclusive(dir, name, data) {
  const fd = fs.openSync(path.join(dir, name), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(data, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function main() {
  if (process.argv.length !== 5 || !/^[A-Za-z0-9_-]{1,64}$/.test(process.argv[4])) {
    throw new Error('usage: node open-testnet-demo-credentials.mjs ENVELOPE.json PRIVATE_KEY.pem OUTPUT_NAME');
  }
  const file = fs.statSync(process.argv[2]);
  if (!file.isFile() || file.size > 16_384) throw new Error('invalid recovery envelope file');
  const payload = openTestnetCredentials(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), readPrivate(process.argv[3]));
  if (payload.version === 4) throw new Error('transient scoped handoff is not a recoverable key bundle');
  const parent = path.join(os.homedir(), '.near-credentials'), root = path.join(parent, 'testnet');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const directory of [parent, root]) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('testnet credential directories must be owner-only and not symlinks');
  }
  const dir = path.join(root, process.argv[4]); fs.mkdirSync(dir, { mode: 0o700 }); // never overwrite a previous recovery
  const keys = payload.version === 3 ? [
    ['owner', payload.owner_account_id, payload.owner_secret], ['contract', payload.contract_id, payload.contract_secret],
    ['funding', payload.owner_account_id, payload.funding_secret], ['project', payload.owner_account_id, payload.project_secret],
  ] : [
    ['owner', payload.owner_account_id, payload.owner_secret], ['input', payload.owner_account_id, payload.input_secret],
    ['sweep', payload.owner_account_id, payload.sweep_secret], ...(payload.version === 2 ? [
      ['contract', payload.contract_id, payload.contract_secret], ['router', payload.router_id, payload.router_secret],
    ] : []),
  ];
  for (const [name, account_id, secret] of keys) writeExclusive(dir, `${name}.json`, { account_id, private_key: secret });
  writeExclusive(dir, 'identity.json', { version: payload.version, owner_account_id: payload.owner_account_id, contract_id: payload.contract_id,
    ...(payload.version === 3 ? { purpose: payload.purpose } : { router_id: payload.router_id }),
    public_keys: Object.fromEntries(keys.map(([name, , secret]) => [name, nearApi.KeyPair.fromString(secret).getPublicKey().toString()])) });
  const dfd = fs.openSync(dir, 'r'), pfd = fs.openSync(root, 'r');
  try { fs.fsyncSync(dfd); fs.fsyncSync(pfd); } finally { fs.closeSync(dfd); fs.closeSync(pfd); }
  console.log(`Restored disposable testnet keys into ${dir}. Verify each public key and route against FINAL chain state before use; never resend an uncertain transaction.`);
}
try { main(); } catch (error) { console.error(`[ref-demo-recovery] ${error.message}`); process.exitCode = 1; }
