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
  const source = path.join(tmp, 'source'); fs.mkdirSync(source);
  for (const file of PUBLIC_WEB_FILES) fs.copyFileSync(path.join(realSource, file), path.join(source, file));
  return { tmp, source, dest: path.join(tmp, 'site') };
}

test('public staging copies only reviewed public assets, never credentials or retired wallet bundles', t => {
  const { source, dest } = fixture(t);
  fs.writeFileSync(path.join(source, 'credentials.txt'), 'private');
  fs.mkdirSync(path.join(source, 'journals'));
  fs.writeFileSync(path.join(source, 'journals', 'recovery.json'), 'private');
  assert.equal(PUBLIC_WEB_FILES.length, 10);
  assert.ok(PUBLIC_WEB_FILES.includes('google-signin.mjs'));
  assert.ok(PUBLIC_WEB_FILES.includes('hero-orbit.jpg'));
  assert.ok(PUBLIC_WEB_FILES.includes('manrope-latin.woff2'));
  assert.ok(PUBLIC_WEB_FILES.includes('manrope-OFL.txt'));
  assert.ok(PUBLIC_WEB_FILES.every(file => !/wallet|relay|^api\//i.test(file)));
  assert.deepEqual(stagePublicWeb(dest, source), [...PUBLIC_WEB_FILES]);
  assert.deepEqual(fs.readdirSync(dest).sort(), [...PUBLIC_WEB_FILES].sort());
  for (const file of PUBLIC_WEB_FILES) assert.deepEqual(fs.readFileSync(path.join(dest, file)), fs.readFileSync(path.join(source, file)));
});

test('public staging refuses reused destinations and leaves their contents untouched', t => {
  const { source, dest } = fixture(t);
  fs.mkdirSync(dest); fs.writeFileSync(path.join(dest, 'do-not-publish'), 'untouched');
  assert.throws(() => stagePublicWeb(dest, source), /EEXIST/);
  assert.deepEqual(fs.readdirSync(dest), ['do-not-publish']);
});

test('public staging refuses symlinked or missing assets before creating output', t => {
  const { tmp, source, dest } = fixture(t), asset = path.join(source, 'styles.css');
  fs.unlinkSync(asset); assert.throws(() => stagePublicWeb(dest, source));
  assert.equal(fs.existsSync(dest), false);
  fs.symlinkSync(path.join(realSource, 'styles.css'), asset);
  assert.throws(() => stagePublicWeb(dest, source), /Refusing unexpected website file styles.css/);
  const linkedSource = path.join(tmp, 'linked-source'); fs.symlinkSync(source, linkedSource, 'dir');
  assert.throws(() => validatePublicWeb(linkedSource), /real directory/);
  assert.throws(() => validatePublicWeb(`${linkedSource}/`), /real directory/);
});

test('public staging rejects a restored wallet experience or absent Google module', t => {
  const { source, dest } = fixture(t), index = path.join(source, 'index.html');
  const original = fs.readFileSync(index, 'utf8');
  for (const altered of [original.replace('google-signin.mjs?v=1', 'old.mjs?v=1'), `${original}\n<div data-wallet-open></div>`, `${original}\n<script src="wallet.bundle.js"></script>`]) {
    fs.writeFileSync(index, altered);
    assert.throws(() => stagePublicWeb(dest, source), /Google sign-in/);
    assert.equal(fs.existsSync(dest), false);
  }
});

test('deployment revalidates HTML, permits Google popups, and versions its assets', () => {
  const config = JSON.parse(fs.readFileSync(path.join(realSource, 'vercel.json'), 'utf8'));
  assert.equal(config.git?.deploymentEnabled?.['arena/6d538ba2-near-hub'], false);
  for (const source of ['/', '/index.html']) {
    const headers = config.headers.find(rule => rule.source === source)?.headers || [];
    assert.match(headers.find(header => header.key.toLowerCase() === 'cache-control')?.value || '', /no-cache.*must-revalidate/);
  }
  const globalHeaders = config.headers.find(rule => rule.source === '/(.*)').headers;
  assert.equal(globalHeaders.find(h => h.key.toLowerCase() === 'cross-origin-opener-policy').value, 'same-origin-allow-popups');
  const html = fs.readFileSync(path.join(realSource, 'index.html'), 'utf8');
  for (const file of ['styles.css', 'app.mjs', 'google-signin.mjs']) assert.match(html, new RegExp(`\\./${file.replaceAll('.', '\\.') }\\?v=\\d+`));
});

test('only the Google session API is detected by Vercel, never served as a public static file', async () => {
  assert.deepEqual(fs.readdirSync(path.join(realSource, 'api')), ['google-session.mjs']);
  assert.ok(!PUBLIC_WEB_FILES.includes('api/google-session.mjs'));
  const api = await import('../web/api/google-session.mjs');
  assert.equal(typeof api.default, 'function');
});

test('staging CLI runs from the web root and publishes only allowlisted files', t => {
  const { dest } = fixture(t);
  const output = execFileSync(process.execPath, [script, dest], { cwd: realSource, encoding: 'utf8' });
  assert.match(output, /Staged 10 reviewed public website files/);
  assert.deepEqual(fs.readdirSync(dest).sort(), [...PUBLIC_WEB_FILES].sort());
});
