#!/usr/bin/env node
/** Size a reviewed UNSIGNED setup and send only inert HEAD probes to the fixed
 * MyNearWallet testnet endpoint. Never sends the serialized actions, wallet
 * identity, callback or any transaction to the wallet or chain. */
import fs from 'node:fs';
import nearApi from 'near-api-js';
import { buildBufferWalletSetup } from '../agent/buffer-wallet-setup-plan.mjs';
import { inspectMyNearWalletRedirectSizes } from '../agent/mynearwallet-redirect-probe.mjs';

if (process.argv.length !== 4) throw new Error('usage: node scripts/inspect-mynearwallet-redirect.mjs SNAPSHOT.json V12.wasm');
const [snapshotFile, wasmFile] = process.argv.slice(2);
const snapshotStat = fs.statSync(snapshotFile), wasmStat = fs.statSync(wasmFile);
if (!snapshotStat.isFile() || snapshotStat.size < 1 || snapshotStat.size > 64_000 ||
    !wasmStat.isFile() || wasmStat.size < 1 || wasmStat.size > 1_000_000) throw new Error('bounded regular input files required');
const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
const { batches } = buildBufferWalletSetup({ snapshot, wasmBytes: fs.readFileSync(wasmFile) });
const key = nearApi.utils.PublicKey.from('ed25519:11111111111111111111111111111111');
const block = nearApi.utils.serialize.base_decode(snapshot.block_hash);
const stageSizes = batches.map(batch => {
  const unsigned = nearApi.transactions.createTransaction(batch.signerId, key, batch.receiverId, 0n, batch.actions, block);
  const url = new URL('https://testnet.mynearwallet.com/sign/');
  url.searchParams.set('transactions', Buffer.from(nearApi.transactions.encodeTransaction(unsigned)).toString('base64'));
  // A synthetic callback is used only for sizing; this URL is never requested.
  url.searchParams.set('callbackUrl', 'https://bouncer-near.vercel.app/buffer-wallet-return');
  return { stage: batch.id, encoded_path_bytes: Buffer.byteLength(url.pathname + url.search) };
});
const pathBytes = [...new Set([1024, 8192, 32768, 65536, stageSizes[0].encoded_path_bytes])].sort((a,b) => a-b);
const result = await inspectMyNearWalletRedirectSizes({ pathBytes });
console.log(JSON.stringify({ ...result, unsigned_stage_sizes: stageSizes,
  note: 'The large deployment is measured locally; only equally long inert padding is sent. No real signing flow has been tested.' }, null, 2));
