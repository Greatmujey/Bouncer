#!/usr/bin/env node
/**
 * OPTIONAL transport for a separately authorized private CI build when the
 * normal artifact host cannot be reached. This does not build, attest, deploy,
 * or audit WASM. Emission puts compressed binary into GitHub check annotations
 * and logs; use only for non-secret contract code in a private repository.
 * Extraction requires an independently retained expected SHA-256 and refuses
 * incomplete, duplicated, altered or oversized data. GitHub's real annotation
 * behavior and limits still need to be checked on an approved run.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

const MAX_WASM = 4 * 1024 * 1024;
const CHUNK = 60_000; // under the Checks API's 64 KiB per-message ceiling
const MAX_PARTS = 10; // GitHub Actions documents 10 notices per step
const MAX_JSON = 2 * 1024 * 1024;
const MAGIC = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const MARKER = Buffer.from('bouncer-agent-v11-exact-ft-testnet');
const EXPORTS = ['new', 'contract_version', 'get_owner', 'get_policy', 'set_policy', 'allow_payee', 'grant_agent_key',
  'is_agent_key_allowed', 'lock_ft_policy_to_intents', 'is_exact_ft_policy_locked', 'is_exact_ft_payee_locked',
  'set_exact_ft_intent', 'get_exact_ft_intent', 'execute_exact_ft', 'after_exact_ft_transfer', 'ft_on_transfer',
  'vault_balance', 'daily_spent', 'check', 'withdraw'];
const pattern = /^BOUNCER-V11-WASM-([0-9]{2})-OF-([0-9]{2})-SHA256-([a-f0-9]{64})$/;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function checkedWasm(input) {
  if (!(input instanceof Uint8Array) || input.byteLength < 8 || input.byteLength > MAX_WASM) throw new Error('invalid bounded V11 WASM');
  const wasm = Buffer.from(input);
  if (!wasm.subarray(0, 8).equals(MAGIC) || !wasm.includes(MARKER)) throw new Error('V11 marker or header is missing');
  let exports;
  try { exports = WebAssembly.Module.exports(new WebAssembly.Module(wasm)); }
  catch { throw new Error('invalid V11 WASM module'); }
  if (EXPORTS.some(name => !exports.some(item => item.name === name && item.kind === 'function'))) throw new Error('V11 function export is missing');
  return wasm; // these checks can be forged; no source/behavior is proven
}

/** Produce at most 10 non-secret notice annotations. The raw SHA is an
 * integrity identifier, not a trust anchor or evidence of a reproducible build. */
export function packV11WasmAnnotations(input) {
  const wasm = checkedWasm(input), hash = sha256(wasm);
  const encoded = zlib.gzipSync(wasm, { level: 9 }).toString('base64');
  const count = Math.ceil(encoded.length / CHUNK);
  if (!count || count > MAX_PARTS) throw new Error('compressed V11 artifact exceeds private annotation transport limits');
  const title = i => `BOUNCER-V11-WASM-${String(i).padStart(2, '0')}-OF-${String(count).padStart(2, '0')}-SHA256-${hash}`;
  return { sha256: hash, bytes: wasm.length, annotations: Array.from({ length: count }, (_, index) => ({
    title: title(index + 1), message: encoded.slice(index * CHUNK, (index + 1) * CHUNK) })) };
}

/** Decode annotations from the exact selected private CI check. Other notices
 * are ignored, but any malformed or duplicate V11 chunk stops extraction. The
 * expected hash must come from an independently retained review channel. */
export function unpackV11WasmAnnotations(annotations, expectedSha256) {
  if (!Array.isArray(annotations) || annotations.length > 200 || typeof expectedSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error('bounded annotations and expected V11 SHA-256 are required');
  const parts = new Map(); let count;
  for (const annotation of annotations) {
    if (!record(annotation) || typeof annotation.title !== 'string' || !annotation.title.startsWith('BOUNCER-V11-WASM-')) continue;
    const match = pattern.exec(annotation.title);
    if (!match || match[3] !== expectedSha256) throw new Error('invalid V11 annotation identity');
    const number = Number(match[1]), total = Number(match[2]);
    if (total < 1 || total > MAX_PARTS || number < 1 || number > total || (count !== undefined && total !== count) || parts.has(number) ||
        typeof annotation.message !== 'string' || !annotation.message.length || annotation.message.length > CHUNK ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(annotation.message)) throw new Error('invalid, duplicated or inconsistent V11 annotation part');
    count = total; parts.set(number, annotation.message);
  }
  if (count === undefined || parts.size !== count || Array.from({ length: count }, (_, i) => i + 1).some(i => !parts.has(i))) {
    throw new Error('incomplete V11 annotation parts');
  }
  const encoded = Array.from({ length: count }, (_, i) => parts.get(i + 1)).join('');
  const compressed = Buffer.from(encoded, 'base64');
  if (compressed.toString('base64') !== encoded) throw new Error('invalid V11 annotation encoding');
  let wasm;
  try { wasm = zlib.gunzipSync(compressed, { maxOutputLength: MAX_WASM }); }
  catch { throw new Error('invalid or oversized compressed V11 artifact'); }
  wasm = checkedWasm(wasm);
  if (sha256(wasm) !== expectedSha256) throw new Error('reconstructed V11 artifact hash mismatch');
  return wasm;
}

function readBounded(file, max) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > max) throw new Error('invalid size');
    const result = Buffer.alloc(stat.size); let offset = 0;
    while (offset < result.length) { const n = fs.readSync(fd, result, offset, result.length - offset, null); if (!n) throw new Error('short read'); offset += n; }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, null) || fs.fstatSync(fd).size !== stat.size) throw new Error('changed input');
    return result;
  } catch { throw new Error('cannot read a bounded regular input file'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Private CI annotation transport for non-secret V11 WASM only; no build, audit or deployment.');
    console.log('emit WASM | extract EXPECTED_SHA256 ANNOTATIONS.json NEW_OUTPUT.wasm');
    return;
  }
  if (args[0] === 'emit' && args.length === 2) {
    const packed = packV11WasmAnnotations(readBounded(args[1], MAX_WASM));
    for (const { title, message } of packed.annotations) console.log(`::notice title=${title}::${message}`);
    return;
  }
  if (args[0] === 'extract' && args.length === 4) {
    let annotations;
    try { annotations = JSON.parse(readBounded(args[2], MAX_JSON).toString('utf8')); }
    catch { throw new Error('invalid bounded annotation JSON'); }
    const wasm = unpackV11WasmAnnotations(annotations, args[1]);
    const fd = fs.openSync(args[3], fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, wasm); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    console.log(JSON.stringify({ file: path.resolve(args[3]), sha256: args[1], bytes: wasm.length,
      source_to_binary_verified: false, audited: false, deployed: false }));
    return;
  }
  throw new Error('invalid V11 annotation transport options; see --help');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(`V11 artifact transport blocked: ${error.message}`); process.exitCode = 1; }
}
