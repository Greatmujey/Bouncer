#!/usr/bin/env node
/** Read a public, fresh snapshot and hash-pinned WASM. Write an unsigned review
 * only; this has no wallet, key, network, seller call or transaction sender. */
import fs from 'node:fs';
import { buildBufferWalletSetup } from '../agent/buffer-wallet-setup-plan.mjs';

if (process.argv.length !== 4) throw new Error('usage: node scripts/prepare-buffer-wallet-setup.mjs SNAPSHOT.json V12.wasm');
const [snapshotFile, wasmFile] = process.argv.slice(2);
const snapshotStat = fs.statSync(snapshotFile), wasmStat = fs.statSync(wasmFile);
if (!snapshotStat.isFile() || snapshotStat.size < 1 || snapshotStat.size > 64_000 ||
    !wasmStat.isFile() || wasmStat.size < 1 || wasmStat.size > 1_000_000) throw new Error('bounded regular input files required');
const { review } = buildBufferWalletSetup({ snapshot: JSON.parse(fs.readFileSync(snapshotFile, 'utf8')), wasmBytes: fs.readFileSync(wasmFile) });
console.log(JSON.stringify(review, null, 2));
