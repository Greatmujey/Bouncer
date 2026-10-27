import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('local build helper uses the crate target and writes the requested wasm without touching the checked-in artifact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-build-test-'));
  try {
    const bin = path.join(dir, 'bin'), target = path.join(dir, 'target'), output = path.join(dir, 'bouncer.wasm');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'cargo'), '#!/usr/bin/env bash\nset -e\nmkdir -p "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release"\nprintf test-wasm > "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/bouncer.wasm"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'rustup'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'wasm-opt'), '#!/usr/bin/env bash\nset -e\nwhile [[ "$1" != "-o" ]]; do shift; done\ncp "$3" "$2"\n', { mode: 0o755 });
    const result = spawnSync('bash', ['bouncer/scripts/build.sh'], {
      cwd: repo, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CARGO_TARGET_DIR: target, BOUNCER_WASM_OUTPUT: output }, encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(output, 'utf8'), 'test-wasm');
    assert.match(result.stdout, /WASM built to/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
