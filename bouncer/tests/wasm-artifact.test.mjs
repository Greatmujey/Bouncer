import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWasmArtifact } from '../scripts/check-wasm-artifact.mjs';

const source = `impl Bouncer { pub fn contract_version(&self) -> &'static str { "bouncer-agent-v7" } }`;
const wasm = marker => Buffer.concat([Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), Buffer.from(marker)]);

test('fresh WASM marker is checked against the source and reported with a checksum', () => {
  const binary = wasm('bouncer-agent-v7'), result = checkWasmArtifact(binary, source);
  assert.equal(result.version, 'bouncer-agent-v7'); assert.equal(result.bytes, binary.length);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
});

test('checked-in deployment artifact carries the current source marker', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const checked = checkWasmArtifact(fs.readFileSync(path.join(root, 'bouncer.wasm')),
    fs.readFileSync(path.join(root, 'bouncer/contracts/bouncer/src/lib.rs'), 'utf8'));
  assert.match(checked.version, /^bouncer-agent-v[0-9]+$/);
  assert.ok(fs.readFileSync(path.join(root, 'README.md'), 'utf8').includes(checked.sha256), 'README must report the checked-in artifact checksum');
});

test('stale, malformed, oversized and ambiguous artifacts fail closed', () => {
  assert.throws(() => checkWasmArtifact(wasm('bouncer-agent-v5'), source), /rebuild/);
  assert.throws(() => checkWasmArtifact(Buffer.from('bouncer-agent-v7'), source), /WebAssembly/);
  assert.throws(() => checkWasmArtifact(Buffer.alloc(2_000_001), source), /WebAssembly/);
  assert.throws(() => checkWasmArtifact(wasm('bouncer-agent-v7'), source + source), /unique/);
  assert.throws(() => checkWasmArtifact(wasm('bouncer-agent-v7'), 'no version'), /unique/);
});
