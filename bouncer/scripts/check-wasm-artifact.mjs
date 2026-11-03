#!/usr/bin/env node
/**
 * Sanity-check a freshly built artifact against the source version marker.
 * This catches stale/misplaced builds; it is NOT bytecode attestation or proof
 * that a deployed contract matches its source.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
export function checkWasmArtifact(bytes, source) {
  if (!(bytes instanceof Uint8Array) || bytes.length < MAGIC.length || bytes.length > 2_000_000 || !Buffer.from(bytes.subarray(0, MAGIC.length)).equals(MAGIC)) {
    throw new Error('artifact is not a bounded WebAssembly v1 binary');
  }
  if (typeof source !== 'string') throw new Error('contract source is required');
  const direct = [...source.matchAll(/pub\s+fn\s+contract_version\s*\([^)]*\)\s*->\s*&'static\s+str\s*\{\s*"(bouncer-agent-v[0-9]+)"\s*\}/g)];
  // This exact opt-in testnet branch has a separate version and artifact.
  // Only the cfg(not(...)) arm describes the default deployment artifact.
  const conditional = [...source.matchAll(/pub\s+fn\s+contract_version\s*\([^)]*\)\s*->\s*&'static\s+str\s*\{\s*#\[cfg\(feature\s*=\s*"youtick-playback-v10"\)\]\s*\{\s*"bouncer-agent-v10-youtick-testnet"\s*\}\s*#\[cfg\(not\(feature\s*=\s*"youtick-playback-v10"\)\)\]\s*\{\s*"(bouncer-agent-v[0-9]+)"\s*\}\s*\}/g)];
  // V11 is also an explicitly separate fresh-state testnet artifact. Accept
  // only this exact source form and continue checking the default V9 arm.
  const multiConditional = [...source.matchAll(/pub\s+fn\s+contract_version\s*\([^)]*\)\s*->\s*&'static\s+str\s*\{\s*#\[cfg\(feature\s*=\s*"exact-ft-v11"\)\]\s*\{\s*"bouncer-agent-v11-exact-ft-testnet"\s*\}\s*#\[cfg\(feature\s*=\s*"youtick-playback-v10"\)\]\s*\{\s*"bouncer-agent-v10-youtick-testnet"\s*\}\s*#\[cfg\(not\(any\(feature\s*=\s*"youtick-playback-v10",\s*feature\s*=\s*"exact-ft-v11"\)\)\)\]\s*\{\s*"(bouncer-agent-v[0-9]+)"\s*\}\s*\}/g)];
  // V12 implies the V11 feature but has its own version and fresh artifact.
  // Require this exact mutually-exclusive branch structure, not just any
  // nearby version-looking string.
  const v12Conditional = [...source.matchAll(/pub\s+fn\s+contract_version\s*\([^)]*\)\s*->\s*&'static\s+str\s*\{\s*#\[cfg\(feature\s*=\s*"exact-ft-v12"\)\]\s*\{\s*"bouncer-agent-v12-exact-ft-testnet"\s*\}\s*#\[cfg\(all\(feature\s*=\s*"exact-ft-v11",\s*not\(feature\s*=\s*"exact-ft-v12"\)\)\)\]\s*\{\s*"bouncer-agent-v11-exact-ft-testnet"\s*\}\s*#\[cfg\(feature\s*=\s*"youtick-playback-v10"\)\]\s*\{\s*"bouncer-agent-v10-youtick-testnet"\s*\}\s*#\[cfg\(not\(any\(feature\s*=\s*"youtick-playback-v10",\s*feature\s*=\s*"exact-ft-v11"\)\)\)\]\s*\{\s*"(bouncer-agent-v[0-9]+)"\s*\}\s*\}/g)];
  // V13 implies V12 and V11, but only the mutually exclusive default arm
  // describes the checked-in V9 deployment artifact. Do not accept a V13
  // marker as evidence for the default build.
  const v13Conditional = [...source.matchAll(/pub\s+fn\s+contract_version\s*\([^)]*\)\s*->\s*&'static\s+str\s*\{\s*#\[cfg\(feature\s*=\s*"tollgate-native-v13"\)\]\s*\{\s*"bouncer-agent-v13-tollgate-native-testnet"\s*\}\s*#\[cfg\(all\(feature\s*=\s*"exact-ft-v12",\s*not\(feature\s*=\s*"tollgate-native-v13"\)\)\)\]\s*\{\s*"bouncer-agent-v12-exact-ft-testnet"\s*\}\s*#\[cfg\(all\(feature\s*=\s*"exact-ft-v11",\s*not\(feature\s*=\s*"exact-ft-v12"\)\)\)\]\s*\{\s*"bouncer-agent-v11-exact-ft-testnet"\s*\}\s*#\[cfg\(feature\s*=\s*"youtick-playback-v10"\)\]\s*\{\s*"bouncer-agent-v10-youtick-testnet"\s*\}\s*#\[cfg\(not\(any\(feature\s*=\s*"youtick-playback-v10",\s*feature\s*=\s*"exact-ft-v11"\)\)\)\]\s*\{\s*"(bouncer-agent-v[0-9]+)"\s*\}\s*\}/g)];
  const matches = [...direct, ...conditional, ...multiConditional, ...v12Conditional, ...v13Conditional];
  if (matches.length !== 1) throw new Error('cannot find a unique contract source version');
  const version = matches[0][1], binary = Buffer.from(bytes);
  if (!binary.includes(Buffer.from(version))) throw new Error(`WASM does not contain source version ${version}; rebuild the artifact`);
  return { version, sha256: crypto.createHash('sha256').update(binary).digest('hex'), bytes: binary.length };
}
function main() {
  const result = checkWasmArtifact(fs.readFileSync(path.join(ROOT, 'bouncer.wasm')),
    fs.readFileSync(path.join(ROOT, 'bouncer/contracts/bouncer/src/lib.rs'), 'utf8'));
  console.log(`WASM sanity check: ${JSON.stringify(result)} (version marker is not code attestation)`);
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { main(); } catch (error) { console.error(`[wasm-check] ERROR: ${error.message}`); process.exitCode = 1; }
}
