import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readProtectedCheckpointToken } from '../agent/protected-checkpoint-token.mjs';

test('checkpoint token requires one private, canonical 32-byte token file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-checkpoint-token-'));
  const file = path.join(dir, 'token'), link = path.join(dir, 'link');
  const token = crypto.randomBytes(32).toString('base64url');
  try {
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
    assert.equal(readProtectedCheckpointToken(file), token);
    fs.writeFileSync(file, token, { mode: 0o600 });
    assert.equal(readProtectedCheckpointToken(file), token);
    fs.chmodSync(file, 0o644);
    assert.throws(() => readProtectedCheckpointToken(file), /protected checkpoint token unavailable/);
    fs.chmodSync(file, 0o600);
    fs.symlinkSync(file, link);
    assert.throws(() => readProtectedCheckpointToken(link), /protected checkpoint token unavailable/);
    fs.unlinkSync(link);
    fs.linkSync(file, link);
    assert.throws(() => readProtectedCheckpointToken(file), /protected checkpoint token unavailable/);
    fs.unlinkSync(link);
    fs.writeFileSync(file, `${token}\r\n`);
    assert.throws(() => readProtectedCheckpointToken(file), /protected checkpoint token unavailable/);
    fs.writeFileSync(file, 'x'.repeat(43)); // 43 alphabet characters, but non-canonical final bits
    assert.throws(() => readProtectedCheckpointToken(file), /protected checkpoint token unavailable/);
    assert.throws(() => readProtectedCheckpointToken('relative/path'), /protected checkpoint token unavailable/);
    assert.throws(() => readProtectedCheckpointToken(dir), /protected checkpoint token unavailable/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
