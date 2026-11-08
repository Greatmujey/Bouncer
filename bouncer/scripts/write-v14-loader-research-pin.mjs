#!/usr/bin/env node
// CI-only: pin the exact local V14 build into a research loader. This does not
// verify provenance, deploy anything, or authorize a wallet operation.
import fs from 'node:fs';
import path from 'node:path';
import { inspectV14MobileArtifact } from './inspect-v14-mobile-artifact.mjs';

if (process.argv.length !== 4 || !path.isAbsolute(process.argv[3])) {
  throw new Error('usage: write-v14-loader-research-pin.mjs <v14.wasm> <absolute-new-pin.rs>');
}
const info = inspectV14MobileArtifact(fs.readFileSync(process.argv[2]));
const bytes = Buffer.from(info.sha256, 'hex');
const source = `// Generated CI-only pin; do not use as an authorization.\nconst CODE_LEN: usize = ${info.wasm_bytes};\nconst CODE_SHA256: [u8; 32] = [${Array.from(bytes, byte => `0x${byte.toString(16).padStart(2,'0')}`).join(', ')}];\n`;
fs.writeFileSync(process.argv[3], source, { flag:'wx', mode:0o600 });
console.log(`Pinned local V14 research build ${info.near_code_hash}; no deployment or wallet approval.`);
