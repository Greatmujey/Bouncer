#!/usr/bin/env node
// Read-only inspection of the original hypothetical diagnostic hashes. Never
// requests credentials, signs, broadcasts, buys a job or infers non-payment.
import fs from 'node:fs';
import path from 'node:path';
import { PaymentRpcProvider } from '../agent/near-account.mjs';
import { inspectYoutickGrantProbe } from '../agent/youtick-grant-probe-evidence.mjs';

function read(dir, name, required = true) {
  let file;
  try { file = fs.openSync(path.join(dir, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (error) { if (!required && error.code === 'ENOENT') return null; throw error; }
  try {
    const stat = fs.fstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 2 || stat.size > 16_384) throw new Error('invalid diagnostic evidence file');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } finally { fs.closeSync(file); }
}
async function main() {
  if (process.argv.length !== 3) throw new Error('usage: node inspect-youtick-grant-probe.mjs ORIGINAL_EVIDENCE_DIRECTORY');
  const dir = path.resolve(process.argv[2]), probe = read(dir, 'probe.json');
  const zero = read(dir, 'zero-guard-intent.json', false), grant = read(dir, 'grant-intent.json', false);
  if (!zero && !grant) throw new Error('no original grant or guard hash is present; this does not prove that nothing was sent');
  if ((zero && zero.id !== 'zero-guard') || (grant && grant.id !== 'grant')) throw new Error('diagnostic intent ID mismatch');
  const provider = new PaymentRpcProvider(process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com', { receiptTimeoutMs: 60_000 });
  const report = await inspectYoutickGrantProbe({ probe, provider, zeroHash: zero?.tx_hash, grantHash: grant?.tx_hash });
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(`[inspect-youtick-grant] ${String(error.message).slice(0, 1000)}`); process.exitCode = 1; });
