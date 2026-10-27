import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function runDemo(mode = '') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-demo-test-'));
  try {
    return spawnSync(process.execPath, [
      '--import=./bouncer/tests/mock-near.mjs', 'bouncer/demo-all.mjs',
    ], {
      cwd: repo,
      env: { ...process.env, HOME: home, NODE_OPTIONS: '--require=./bouncer/quiet.cjs', BOUNCER_MOCK_MODE: mode },
      encoding: 'utf8', timeout: 30_000,
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('full demo uses gas units, runs with quiet preload, and verifies settlement and rejections', () => {
  const result = runDemo();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /All checks passed/);
  assert.match(result.stdout, /user:\s+0\.5 wNEAR/);
  assert.match(result.stdout, /vendor:\s+0\.1 wNEAR/);
  assert.match(result.stdout, /vault:\s+1\.4 wNEAR \(matches token contract\)/);
  assert.equal((result.stdout.match(/rejected as expected/g) || []).length, 4);
});

test('storage errors containing warning stay visible instead of recursing on stderr', () => {
  const result = runDemo('storage_failure');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FATAL:.*RPC warning: storage failed/);
  assert.doesNotMatch(result.stderr, /Maximum call stack size exceeded/);
});

test('a refunded downstream transfer is not reported as a successful payment', () => {
  const result = runDemo('payment_refund');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /execute: a receipt failed/);
  assert.doesNotMatch(result.stdout, /All checks passed/);
});

test('a policy call that unexpectedly succeeds fails the demo', () => {
  const result = runDemo('allow_daily');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /daily cap: transaction unexpectedly succeeded/);
});

test('an unrelated network error does not count as the expected policy rejection', () => {
  const result = runDemo('wrong_rejection');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /daily cap: expected .*RPC warning: connection lost/);
});
