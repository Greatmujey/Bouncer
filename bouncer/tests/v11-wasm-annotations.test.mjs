import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packV11WasmAnnotations, unpackV11WasmAnnotations } from '../scripts/v11-wasm-annotations.mjs';

const names = ['new', 'contract_version', 'get_owner', 'get_policy', 'set_policy', 'allow_payee', 'grant_agent_key',
  'is_agent_key_allowed', 'lock_ft_policy_to_intents', 'is_exact_ft_policy_locked', 'is_exact_ft_payee_locked',
  'set_exact_ft_intent', 'get_exact_ft_intent', 'execute_exact_ft', 'after_exact_ft_transfer', 'ft_on_transfer',
  'vault_balance', 'daily_spent', 'check', 'withdraw'];
function leb(value) { const out = []; do { let n = value & 127; value >>>= 7; if (value) n |= 128; out.push(n); } while (value); return out; }
const section = (id, bytes) => [id, ...leb(bytes.length), ...bytes];
// A no-op test module; passing the marker/export checks does not authenticate Bouncer.
function stubWasm(extraBytes = 0) {
  const exports = names.flatMap(name => { const b = [...Buffer.from(name)]; return [...leb(b.length), ...b, 0, 0]; });
  const small = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, ...section(1, [1, 0x60, 0, 0]), ...section(3, [1, 0]),
    ...section(7, [...leb(names.length), ...exports]), ...section(10, [1, 2, 0, 0x0b]),
    ...section(0, [1, 0x78, ...Buffer.from('bouncer-agent-v11-exact-ft-testnet')])]);
  if (!extraBytes) return small;
  const bytes = crypto.randomBytes(extraBytes);
  return Buffer.concat([small, Buffer.from([0, ...leb(bytes.length + 2), 1, 0x78]), bytes]);
}

test('bounded compressed annotation chunks reconstruct the exact bytes, in any order', () => {
  const wasm = stubWasm(240_000), packed = packV11WasmAnnotations(wasm);
  assert.equal(packed.sha256, crypto.createHash('sha256').update(wasm).digest('hex'));
  assert.equal(packed.bytes, wasm.length); assert.ok(packed.annotations.length > 9 && packed.annotations.length <= 90);
  assert.ok(packed.annotations.every(a => a.message.length <= 4_000 && /^BOUNCER-V11-WASM-/.test(a.title)));
  // GitHub returned only the first 4,096 chars of each previous long notice.
  // The revised notices remain intact under the same observed truncation.
  assert.deepEqual(unpackV11WasmAnnotations(packed.annotations.map(a => ({ ...a, message: a.message.slice(0, 4_096) })), packed.sha256), wasm);
  const annotations = [{ title: 'unrelated', message: 'notice' }, ...packed.annotations.toReversed()];
  assert.deepEqual(unpackV11WasmAnnotations(annotations, packed.sha256), wasm);
  // The fixture has all expected names and a marker but does nothing useful.
  assert.equal(new WebAssembly.Instance(new WebAssembly.Module(wasm)).exports.contract_version(), undefined);
});

test('missing, mixed, duplicate, corrupted or oversized parts never reconstruct an artifact', () => {
  const packed = packV11WasmAnnotations(stubWasm(110_000)), parts = packed.annotations;
  assert.ok(parts.length > 1);
  const cases = [
    [parts.slice(1), packed.sha256], [[...parts, parts[0]], packed.sha256],
    [parts, '0'.repeat(64)], [[{ ...parts[0], title: 'BOUNCER-V11-WASM-malformed' }, ...parts.slice(1)], packed.sha256],
    [[{ ...parts[0], message: 'a'.repeat(4_001) }, ...parts.slice(1)], packed.sha256],
    [[{ ...parts[0], message: parts[0].message.slice(0, 3_000) }, ...parts.slice(1)], packed.sha256],
    [[{ ...parts[0], message: '!!' }, ...parts.slice(1)], packed.sha256],
    [[{ ...parts[0], message: (parts[0].message[0] === 'A' ? 'B' : 'A') + parts[0].message.slice(1) }, ...parts.slice(1)], packed.sha256],
    [[{ title: `BOUNCER-V11-WASM-01-OF-01-SHA256-${packed.sha256}`,
      message: zlib.gzipSync(Buffer.alloc(5 * 1024 * 1024)).toString('base64') }], packed.sha256],
  ];
  for (const [annotations, hash] of cases) assert.throws(() => unpackV11WasmAnnotations(annotations, hash));
  assert.throws(() => packV11WasmAnnotations(Buffer.from('not wasm')), /WASM|marker|header/);
  assert.throws(() => packV11WasmAnnotations(stubWasm(400_000)), /transport limits/);
  assert.throws(() => unpackV11WasmAnnotations(Array(201).fill({}), packed.sha256), /bounded/);
});

test('CLI emits only notice chunks and extraction refuses existing files, bad hashes and symlinks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v11-annotation-'));
  const cli = fileURLToPath(new URL('../scripts/v11-wasm-annotations.mjs', import.meta.url));
  const wasm = stubWasm(80_000), input = path.join(dir, 'fixture.wasm'), output = path.join(dir, 'out.wasm');
  const json = path.join(dir, 'annotations.json');
  const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10_000 });
  try {
    fs.writeFileSync(input, wasm);
    const annotations = [];
    for (let batch = 1; batch <= 10; batch++) {
      const emitted = run(['emit', input, String(batch)]); assert.equal(emitted.status, 0, emitted.stderr);
      const lines = emitted.stdout.trim() ? emitted.stdout.trim().split('\n') : [];
      assert.ok(lines.length <= 9, `batch ${batch} exceeds the step's notice cap`);
      for (const line of lines) {
        const m = /^::notice title=([^:]+)::(.+)$/.exec(line); assert.ok(m);
        assert.ok(m[2].length <= 4_000); annotations.push({ title: m[1], message: m[2] });
      }
    }
    for (const invalid of [[], ['0'], ['11'], ['01'], ['1.0'], ['-1']]) {
      const r = run(['emit', input, ...invalid]); assert.equal(r.status, 1, `batch ${invalid} must be rejected`);
      assert.equal(r.stdout, '');
    }
    assert.ok(annotations.length > 9);
    fs.writeFileSync(json, JSON.stringify(annotations));
    const hash = crypto.createHash('sha256').update(wasm).digest('hex');
    let r = run(['extract', hash, json, output]); assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fs.readFileSync(output), wasm); assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    const description = JSON.parse(r.stdout);
    assert.equal(description.source_to_binary_verified, false); assert.equal(description.audited, false); assert.equal(description.deployed, false);
    r = run(['extract', hash, json, output]); assert.equal(r.status, 1); assert.deepEqual(fs.readFileSync(output), wasm);
    r = run(['extract', '0'.repeat(64), json, path.join(dir, 'wrong.wasm')]); assert.equal(r.status, 1);
    const link = path.join(dir, 'link'); fs.symlinkSync(input, link);
    r = run(['emit', link, '1']); assert.equal(r.status, 1); assert.match(r.stderr, /bounded regular/);
    r = run(['--help']); assert.equal(r.status, 0); assert.match(r.stdout, /no build, audit or deployment/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
