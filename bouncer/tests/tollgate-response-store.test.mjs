import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { TollgateResponseStore } from '../agent/tollgate-response-store.mjs';

const reviewHash = 'a'.repeat(64), channelId = '7', now = 1793718828000;
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-quakes-response-')); fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new TollgateResponseStore(dir) };
}

test('stores exact original bytes privately and refuses to overwrite a response', t => {
  const { dir, store } = fixture(t), rawBytes = Buffer.from('{ "events": [1], "whitespace": true }\n');
  const saved = store.save({ reviewHash, channelId, observedAtMs: now, rawBytes });
  assert.equal(saved.response_sha256, crypto.createHash('sha256').update(rawBytes).digest('hex'));
  assert.equal(fs.statSync(path.join(dir, saved.filename)).mode & 0o777, 0o600);
  const loaded = store.load({ reviewHash, channelId });
  assert.deepEqual(loaded.rawBytes, rawBytes); assert.equal(loaded.record.observed_at_ms, String(now));
  assert.throws(() => store.save({ reviewHash, channelId, observedAtMs: now, rawBytes }), /EEXIST/);
  assert.deepEqual(store.load({ reviewHash, channelId }).rawBytes, rawBytes);
});

test('modified bytes, altered identity, extra fields and unsafe file permissions fail closed', t => {
  const { dir, store } = fixture(t), rawBytes = Buffer.from('{"ok":true}');
  const saved = store.save({ reviewHash, channelId, observedAtMs: now, rawBytes });
  const file = path.join(dir, saved.filename), original = JSON.parse(fs.readFileSync(file, 'utf8'));
  const bad = { ...original, body_base64: Buffer.from('{"ok":false}').toString('base64') };
  fs.writeFileSync(file, JSON.stringify(bad)); assert.throws(() => store.load({ reviewHash, channelId }), /integrity/);
  fs.writeFileSync(file, JSON.stringify({ ...original, review_hash: 'b'.repeat(64) }));
  assert.throws(() => store.load({ reviewHash, channelId }), /scope/);
  fs.writeFileSync(file, JSON.stringify({ ...original, extra: true }));
  assert.throws(() => store.load({ reviewHash, channelId }), /invalid/);
  fs.writeFileSync(file, JSON.stringify(original)); fs.chmodSync(file, 0o644);
  assert.throws(() => store.load({ reviewHash, channelId }), /unsafe/);
});

test('rejects unsafe directories, symbolic links, invalid identities and oversized responses', t => {
  const { dir, store } = fixture(t);
  assert.throws(() => store.save({ reviewHash: '../bad', channelId, observedAtMs: now, rawBytes: Buffer.from('x') }));
  assert.throws(() => store.save({ reviewHash, channelId: '../bad', observedAtMs: now, rawBytes: Buffer.from('x') }));
  assert.throws(() => store.save({ reviewHash, channelId, observedAtMs: now, rawBytes: Buffer.alloc(256 * 1024 + 1) }));
  const name = `tollgate-quakes-${reviewHash}-${channelId}.json`;
  fs.symlinkSync(path.join(dir, 'target'), path.join(dir, name));
  assert.throws(() => store.save({ reviewHash, channelId, observedAtMs: now, rawBytes: Buffer.from('x') }), /EEXIST/);
  assert.throws(() => store.load({ reviewHash, channelId }));
  fs.chmodSync(dir, 0o755); assert.throws(() => new TollgateResponseStore(dir), /private/);
});
