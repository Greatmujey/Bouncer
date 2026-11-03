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
  assert.equal(PUBLIC_WEB_FILES.length, 15);
  assert.ok(PUBLIC_WEB_FILES.includes('walletconnect.bundle.js'));
  assert.ok(PUBLIC_WEB_FILES.includes('walletconnect-config.json'));
  assert.ok(PUBLIC_WEB_FILES.includes('walletconnect-NOTICES.txt'));
  assert.ok(PUBLIC_WEB_FILES.includes('intear-wallet.executor.js'));
  assert.ok(PUBLIC_WEB_FILES.includes('intear-wallet-source.zip'));
  assert.ok(PUBLIC_WEB_FILES.includes('hero-orbit.jpg'));
  assert.ok(PUBLIC_WEB_FILES.includes('manrope-latin.woff2'));
  assert.ok(PUBLIC_WEB_FILES.includes('manrope-OFL.txt'));
  assert.deepEqual(stagePublicWeb(dest, source), [...PUBLIC_WEB_FILES]);
  assert.deepEqual(fs.readdirSync(dest).sort(), [...PUBLIC_WEB_FILES].sort());
  for (const file of PUBLIC_WEB_FILES) assert.deepEqual(fs.readFileSync(path.join(dest, file)), fs.readFileSync(path.join(source, file)));
});

test('public staging generates only a validated WalletConnect project ID from deployment configuration', t => {
  const { source, dest } = fixture(t);
  const projectId = '1234567890abcdef1234567890abcdef'; // synthetic, never used with the network
  for (const invalid of ['abc', 'z'.repeat(32), `${projectId}\n`, { projectId }, '../x']) {
    assert.throws(() => stagePublicWeb(dest, source, { walletConnectProjectId: invalid }), /Invalid WalletConnect/);
    assert.equal(fs.existsSync(dest), false);
  }
  stagePublicWeb(dest, source, { walletConnectProjectId: projectId });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dest, 'walletconnect-config.json'))), { projectId });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(source, 'walletconnect-config.json'))), { projectId: '' });
  fs.writeFileSync(path.join(source, 'walletconnect-config.json'), JSON.stringify({ projectId }));
  assert.throws(() => validatePublicWeb(source), /must not contain a project ID/);
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

test('the deployed HTML revalidates and references versioned wallet and UI assets', () => {
  const config = JSON.parse(fs.readFileSync(path.join(realSource, 'vercel.json'), 'utf8'));
  assert.equal(config.git?.deploymentEnabled?.['arena/25a7aaf6-near-hub'], false, 'test-branch pushes must not consume the daily preview deployment quota');
  for (const source of ['/', '/index.html']) {
    const headers = config.headers.find(rule => rule.source === source)?.headers || [];
    assert.match(headers.find(header => header.key.toLowerCase() === 'cache-control')?.value || '', /no-cache.*must-revalidate/);
  }
  const html = fs.readFileSync(path.join(realSource, 'index.html'), 'utf8');
  for (const file of ['styles.css', 'app.mjs', 'wallet.bundle.js']) {
    assert.match(html, new RegExp(`\\./${file.replaceAll('.', '\\.') }\\?v=\\d+`));
  }
  assert.match(fs.readFileSync(path.join(realSource, 'wallet.bundle.js'), 'utf8'), /walletconnect\.bundle\.js\?v=\d+/);
});

test('the prebuilt relay is a detectable Node API entry, not a public static file', () => {
  const api = path.join(realSource, 'api');
  assert.deepEqual(fs.readdirSync(api), ['wc-relay.mjs']);
  assert.ok(!PUBLIC_WEB_FILES.includes('api/wc-relay.mjs'));
  const script = `import http from 'node:http'; import server from ${JSON.stringify(new URL('../web/api/wc-relay.mjs', import.meta.url).href)};
    if (!(server instanceof http.Server)) throw new Error('Not an HTTP server');
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const result = await fetch('http://127.0.0.1:' + server.address().port + '/api/wc-relay');
    if (result.status !== 426) throw new Error('Unexpected handler response');
    await new Promise(resolve => server.close(resolve));`;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, BOUNCER_WALLETCONNECT_PROJECT_ID: '1234567890abcdef1234567890abcdef' } });
});

test('staging CLI runs from the web root and publishes only allowlisted files', t => {
  const { dest } = fixture(t);
  const output = execFileSync(process.execPath, [script, dest], { cwd: realSource, encoding: 'utf8' });
  assert.match(output, /Staged 15 reviewed public website files/);
  assert.deepEqual(fs.readdirSync(dest).sort(), [...PUBLIC_WEB_FILES].sort());
});

test('Intear source offer contains exactly the vendored corresponding source and license', () => {
  const archive = path.join(realSource, 'intear-wallet-source.zip');
  const names = execFileSync('python3', ['-c', 'import sys,zipfile; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', archive], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(names, ['README.txt', 'LICENSE', 'web/src/js/near-selector.js', 'intearwallet-connect/src/index.ts', 'web/public/hot-wallet-connector-iframe.html']);
  for (const name of names) {
    const bytes = execFileSync('python3', ['-c', 'import sys,zipfile; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))', archive, name]);
    assert.deepEqual(bytes, fs.readFileSync(new URL(`../web-src/vendor/intear/${name}`, import.meta.url)));
  }
});
