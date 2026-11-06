#!/usr/bin/env node
/** Public read-only comparison; no signing, wallet, seller API or transaction. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';
import { compareBufferCode } from '../agent/buffer-code-comparison.mjs';

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/inspect-buffer-code.mjs --wasm <source-built.wasm>\nReads testnet public state only; no seller contact or payment.'); return;
  }
  if (args.length !== 2 || args[0] !== '--wasm' || !args[1]) throw new Error('exactly --wasm <path> is required');
  const stat = fs.statSync(args[1]);
  if (!stat.isFile() || stat.size < 8 || stat.size > 4 * 1024 * 1024) throw new Error('bounded source-built WASM file required');
  const bytes = fs.readFileSync(args[1]);
  const provider = new ReadOnlyNearRpcProvider('https://test.rpc.fastnear.com');
  const result = await compareBufferCode({ wasmBytes: bytes, provider });
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`[buffer-code-comparison] ERROR: ${error.message}`); process.exitCode = 1; });
}
