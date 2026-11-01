#!/usr/bin/env node
/** Copy only the original encrypted journal through bounded public annotations.
 * No plaintext keys, signatures, signed transactions, RPC calls or sends. The
 * ciphertext is not creator-authenticated; verify the retained RSA envelope,
 * key fingerprint and FINAL chain state separately before any recovery. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

export function encodeVrf2Journal(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < 2 || raw.length > 500_000) throw new Error('invalid bounded encrypted journal');
  let obj;
  try { obj = JSON.parse(raw.toString('utf8')); } catch { throw new Error('invalid encrypted journal JSON'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || obj.format !== 'bouncer-encrypted-file-journal-v1' ||
      obj.cipher !== 'aes-256-gcm' || typeof obj.ciphertext !== 'string' || typeof obj.nonce !== 'string' ||
      typeof obj.tag !== 'string' || Object.keys(obj).sort().join(',') !== 'cipher,ciphertext,format,nonce,tag') {
    throw new Error('journal is not an encrypted envelope');
  }
  const compressed = zlib.gzipSync(raw, { level: 9 }), data = compressed.toString('base64'), chunkSize = 3000;
  const total = Math.ceil(data.length / chunkSize);
  if (total > 30) throw new Error('encrypted journal exceeds annotation limit');
  const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
  return Array.from({ length: total }, (_, i) => ({ version: 1, name: 'journal.enc.json', index: i, total,
    bytes: raw.length, sha256, gzip_base64: data.slice(i * chunkSize, (i + 1) * chunkSize) }));
}

function main() {
  if (process.argv.length !== 3) throw new Error('usage: node emit-vrf2-recovery.mjs RETAINED-DIR');
  const dir = process.argv[2], identity = JSON.parse(fs.readFileSync(path.join(dir, 'identity.json'), 'utf8'));
  if (identity.vault !== 'bouncer-vrf2-3a0af45958.testnet' || identity.owner !== 'owner-vrf2-3a0af45958.testnet' ||
      identity.recovery_key_id !== '77f3170a5df339b2ef4affeb39e8fa549d3b4ca9ac5579d0a21f9936e927508b') {
    throw new Error('retained encrypted journal identity differs from original run');
  }
  const chunks = encodeVrf2Journal(fs.readFileSync(path.join(dir, 'journal.enc.json')));
  for (const chunk of chunks) console.log(`::notice title=Original encrypted VRF2 journal chunk::${JSON.stringify(chunk)}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(`[emit-vrf2-recovery] ${error.message}`); process.exitCode = 1; }
}
