import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { treeDigest, checkedSvalinSource } from '../scripts/test-svalin-upstream.mjs';

test('optional source test refuses a missing or non-pinned external seller tree', () => {
  assert.throws(() => checkedSvalinSource(''), /set BOUNCER_SVALIN_SOURCE/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svalin-harness-'));
  try {
    fs.writeFileSync(path.join(dir, 'app.ts'), 'not the pinned seller');
    assert.throws(() => checkedSvalinSource(dir), /differs from pinned commit/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('source and build digests notice changed bytes and names; checked trees reject symlinks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svalin-digest-'));
  try {
    fs.mkdirSync(path.join(dir, 'src')); fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'abc');
    const before = treeDigest(dir, [''], true); assert.equal(before.files, 1);
    fs.mkdirSync(path.join(dir, 'node_modules')); fs.writeFileSync(path.join(dir, 'node_modules', 'ignored'), 'installed');
    fs.mkdirSync(path.join(dir, 'dist')); fs.writeFileSync(path.join(dir, 'dist', 'a.js'), 'compiled');
    assert.deepEqual(treeDigest(dir, [''], true), before);
    const built = treeDigest(dir, ['dist'], false); assert.equal(built.files, 1);
    fs.writeFileSync(path.join(dir, 'dist', 'a.js'), 'tampered');
    assert.notEqual(treeDigest(dir, ['dist'], false).sha256, built.sha256);
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'abd');
    assert.notEqual(treeDigest(dir, [''], true).sha256, before.sha256);
    fs.renameSync(path.join(dir, 'src', 'a.ts'), path.join(dir, 'src', 'b.ts'));
    const renamed = treeDigest(dir, [''], true);
    fs.renameSync(path.join(dir, 'src', 'b.ts'), path.join(dir, 'src', 'a.ts'));
    assert.notEqual(treeDigest(dir, [''], true).sha256, renamed.sha256);
    fs.symlinkSync(path.join(dir, 'src', 'a.ts'), path.join(dir, 'src', 'link.ts'));
    assert.throws(() => treeDigest(dir, [''], true), /symbolic link/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
