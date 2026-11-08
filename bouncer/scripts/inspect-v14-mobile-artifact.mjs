#!/usr/bin/env node
/**
 * Read-only size measurement for the experimental V14 WASM. The 400,000-byte
 * Meteor bridge limit applies to the complete request, not just its code.
 * A raw base64 code field above that limit is therefore impossible; being
 * below it is NOT proof the full request, wallet, or setup flow will work.
 * Compression sizes are research data only: no loader is built or endorsed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const MAGIC = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const MARKER = Buffer.from('bouncer-agent-v14-native-storage-testnet');
export const METEOR_MOBILE_BRIDGE_LIMIT = 400_000;

export function inspectV14MobileArtifact(input) {
  if (!(input instanceof Uint8Array) || input.length < MAGIC.length || input.length > 20_000_000) {
    throw new Error('a bounded V14 WASM artifact is required');
  }
  const wasm = Buffer.from(input);
  if (!wasm.subarray(0, MAGIC.length).equals(MAGIC) || !wasm.includes(MARKER)) {
    throw new Error('artifact does not contain the V14 WASM header and marker');
  }
  const compressed = deflateRawSync(wasm, { level: 9 });
  const base64Bytes = 4 * Math.ceil(wasm.length / 3);
  return Object.freeze({
    wasm_bytes: wasm.length,
    sha256: crypto.createHash('sha256').update(wasm).digest('hex'),
    raw_base64_bytes: base64Bytes,
    meteor_bridge_limit_bytes: METEOR_MOBILE_BRIDGE_LIMIT,
    raw_code_field_exceeds_meteor_limit: base64Bytes > METEOR_MOBILE_BRIDGE_LIMIT,
    experimental_deflate_bytes: compressed.length,
    experimental_deflate_base64_bytes: 4 * Math.ceil(compressed.length / 3),
    limitations: 'Size only. No wallet compatibility, safe loader, deployment, or signing established.',
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: inspect-v14-mobile-artifact.mjs <v14.wasm>');
    const result = inspectV14MobileArtifact(fs.readFileSync(process.argv[2]));
    console.log(JSON.stringify(result));
    if (process.env.GITHUB_ACTIONS === 'true') {
      console.log(`::notice title=V14 mobile artifact size::WASM ${result.wasm_bytes} bytes; raw base64 code ${result.raw_base64_bytes} bytes; Meteor request limit ${result.meteor_bridge_limit_bytes} bytes; deflate-only research ${result.experimental_deflate_base64_bytes} bytes. Size alone does not establish wallet support or a safe loader.`);
    }
  } catch (error) {
    console.error(`V14 size inspection failed: ${error.message}`); process.exitCode = 1;
  }
}
