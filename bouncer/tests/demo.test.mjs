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
  assert.equal((result.stdout.match(/rejected as expected/g) || []).length, 10);
  assert.match(result.stdout, /restricted key \(execute\)/);
  assert.match(result.stdout, /one-yocto policy escalation \(NEAR protocol\): rejected as expected/);
  assert.match(result.stdout, /payment signed by a restricted agent key/);
  assert.match(result.stdout, /Failed transfer refunded vault and daily budget/);
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


test('a missing protocol deposit guard is not reported as a security success', () => {
  const result = runDemo('missing_protocol_guard');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /one-yocto policy escalation \(NEAR protocol\): transaction unexpectedly succeeded/);
  assert.doesNotMatch(result.stdout, /All checks passed/);
});


test('refund proof rejects a missing failed receipt, missing callback, or unrefunded vault', () => {
  for (const [mode, error] of [
    ['missing_ft_failure', /expected failed wNEAR receipt/],
    ['missing_refund_log', /expected failed wNEAR receipt/],
    ['broken_refund', /recorded vault after refund/],
    ['broken_daily_refund', /failed transfer did not restore daily budget/],
  ]) {
    const result = runDemo(mode);
    assert.equal(result.status, 1);
    assert.match(result.stderr, error);
    assert.doesNotMatch(result.stdout, /All checks passed/);
  }
});
