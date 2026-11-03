// Offline input validation only. No NEAR runtime or provider is contacted.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { checkV12SandboxWasm } from '../integration/v12-pair-lock-sandbox.mjs';

const magic = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const sample = Buffer.concat([magic, Buffer.from('bouncer-agent-v12-exact-ft-testnet')]);

test('V12 sandbox input requires bounded WASM with the distinct V12 marker', () => {
  assert.equal(checkV12SandboxWasm(sample), crypto.createHash('sha256').update(sample).digest('hex'));
  for (const invalid of [null, 'text', Buffer.alloc(0), Buffer.from('bouncer-agent-v12-exact-ft-testnet'),
    Buffer.concat([magic, Buffer.from('bouncer-agent-v11-exact-ft-testnet')]), Buffer.alloc(4 * 1024 * 1024 + 1)]) {
    assert.throws(() => checkV12SandboxWasm(invalid), /V12 sandbox/);
  }
});
