import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PUBLIC_WEB_FILES, stagePublicWeb, validatePublicWeb } from '../scripts/stage-public-web.mjs';

const realSource = fileURLToPath(new URL('../web/', import.meta.url));
const script = fileURLToPath(new URL('../scripts/stage-public-web.mjs', import.meta.url));
function fixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-public-web-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const source = path.join(tmp, 'source');
  fs.mkdirSync(source);
  for (const file of PUBLIC_WEB_FILES) fs.copyFileSync(path.join(realSource, file), path.join(source, file));
  return { tmp, source, dest: path.join(tmp, 'site') };
}

test('public staging copies exactly the reviewed assets, not other files', t => {
  const { source, dest } = fixture(t);
  fs.writeFileSync(path.join(source, 'credentials.txt'), 'private');
  fs.mkdirSync(path.join(source, 'journals'));
  fs.writeFileSync(path.join(source, 'journals', 'recovery.json'), 'private');
  assert.equal(PUBLIC_WEB_FILES.length, 10);
  assert.ok(PUBLIC_WEB_FILES.includes('hero-orbit.jpg'));
  assert.ok(PUBLIC_WEB_FILES.includes('manrope-latin.woff2'));
  assert.ok(PUBLIC_WEB_FILES.includes('manrope-OFL.txt'));
  assert.deepEqual(stagePublicWeb(dest, source), [...PUBLIC_WEB_FILES]);
  assert.deepEqual(fs.readdirSync(dest).sort(), [...PUBLIC_WEB_FILES].sort());
  for (const file of PUBLIC_WEB_FILES) assert.deepEqual(fs.readFileSync(path.join(dest, file)), fs.readFileSync(path.join(source, file)));
});

test('public staging refuses reused destinations and leaves their contents untouched', t => {
  const { source, dest } = fixture(t);
  fs.mkdirSync(dest);
  fs.writeFileSync(path.join(dest, 'do-not-publish'), 'untouched');
  assert.throws(() => stagePublicWeb(dest, source), /EEXIST/);
  assert.deepEqual(fs.readdirSync(dest), ['do-not-publish']);
  assert.equal(fs.readFileSync(path.join(dest, 'do-not-publish'), 'utf8'), 'untouched');
});

test('public staging refuses symlinked or missing assets before creating output', t => {
  const { tmp, source, dest } = fixture(t);
  const asset = path.join(source, 'styles.css');
  fs.unlinkSync(asset);
  assert.throws(() => stagePublicWeb(dest, source));
  assert.equal(fs.existsSync(dest), false);
  fs.symlinkSync(path.join(realSource, 'styles.css'), asset);
  assert.throws(() => stagePublicWeb(dest, source), /Refusing unexpected website file styles.css/);
  assert.equal(fs.existsSync(dest), false);
  const linkedSource = path.join(tmp, 'linked-source');
  fs.symlinkSync(source, linkedSource, 'dir');
  assert.throws(() => validatePublicWeb(linkedSource), /real directory/);
  assert.throws(() => validatePublicWeb(`${linkedSource}/`), /real directory/);
});

test('public staging approves only the dedicated Bouncer wallet origin', t => {
  const { source, dest } = fixture(t);
  const index = path.join(source, 'index.html');
  const original = fs.readFileSync(index, 'utf8');
  const marker = '<meta name="bouncer-wallet-origin" content="https://bouncer-near.vercel.app">';
  assert.ok(original.includes(marker));
  for (const replacement of [
    '<meta name="bouncer-wallet-origin" content="https://owner.github.io">',
    '<meta name="bouncer-wallet-origin" content="https://other.vercel.app">',
    '<meta name="bouncer-wallet-origin" content="">',
    '',
    `${marker}\n${marker}`,
    '<meta name="bouncer-wallet-origin" content="https://bouncer-near.vercel.app" content="https://example.com">',
  ]) {
    fs.writeFileSync(index, original.replace(marker, replacement));
    assert.throws(() => stagePublicWeb(dest, source), /exactly the dedicated Bouncer wallet origin/);
    assert.equal(fs.existsSync(dest), false);
  }
});

test('staging CLI runs from the web root and publishes only allowlisted files', t => {
  const { dest } = fixture(t);
  const output = execFileSync(process.execPath, [script, dest], { cwd: realSource, encoding: 'utf8' });
  assert.match(output, /Staged 10 reviewed public website files/);
  assert.deepEqual(fs.readdirSync(dest).sort(), [...PUBLIC_WEB_FILES].sort());
});
