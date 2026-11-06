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

test('public staging copies only reviewed wallet and Google assets, never credentials', t => {
  const { source, dest } = fixture(t);
  fs.writeFileSync(path.join(source, 'credentials.txt'), 'private');
  fs.mkdirSync(path.join(source, 'journals'));
  fs.writeFileSync(path.join(source, 'journals', 'recovery.json'), 'private');
  assert.equal(PUBLIC_WEB_FILES.length, 18);
  assert.ok(PUBLIC_WEB_FILES.includes('google-signin.mjs'));
  assert.ok(PUBLIC_WEB_FILES.includes('hero-orbit.jpg'));
  assert.ok(PUBLIC_WEB_FILES.includes('manrope-latin.woff2'));
  assert.ok(PUBLIC_WEB_FILES.includes('manrope-OFL.txt'));
  for (const file of ['wallet.bundle.js', 'intear-wallet.executor.js', 'intear-wallet-source.zip', 'ethereum-wallet.executor.js', 'ethereum-wallet-NOTICE.txt', 'walletconnect.bundle.js', 'walletconnect-config.json', 'walletconnect-NOTICES.txt']) assert.ok(PUBLIC_WEB_FILES.includes(file));
  assert.ok(PUBLIC_WEB_FILES.every(file => !/^api\//i.test(file)));
  assert.deepEqual(stagePublicWeb(dest, source), [...PUBLIC_WEB_FILES]);
  assert.deepEqual(fs.readdirSync(dest).sort(), [...PUBLIC_WEB_FILES].sort());
  for (const file of PUBLIC_WEB_FILES) assert.deepEqual(fs.readFileSync(path.join(dest, file)), fs.readFileSync(path.join(source, file)));
});

test('staging injects only a validated public WalletConnect project ID', t => {
  const { source, dest } = fixture(t);
  const projectId = '1234567890abcdef1234567890abcdef'; // synthetic, never contacts a relay
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

test('staging approves only the dedicated Bouncer wallet origin', t => {
  const { source, dest } = fixture(t), index = path.join(source, 'index.html');
  const original = fs.readFileSync(index, 'utf8');
  const marker = '<meta name="bouncer-wallet-origin" content="https://bouncer-near.vercel.app">';
  for (const replacement of [
    '<meta name="bouncer-wallet-origin" content="https://owner.github.io">',
    '<meta name="bouncer-wallet-origin" content="https://other.vercel.app">', '', `${marker}\n${marker}`,
  ]) {
    fs.writeFileSync(index, original.replace(marker, replacement));
    assert.throws(() => stagePublicWeb(dest, source), /exactly the dedicated Bouncer wallet origin/);
    assert.equal(fs.existsSync(dest), false);
  }
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

test('public staging requires six wallets, WalletConnect, then Google', t => {
  const { source, dest } = fixture(t), index = path.join(source, 'index.html');
  const original = fs.readFileSync(index, 'utf8');
  for (const altered of [
    original.replace('google-signin.mjs?v=2', 'old.mjs?v=2'),
    original.replace('wallet.bundle.js?v=18', 'old-wallet.js?v=18'),
    original.replace('data-wallet-id="near-cli"', 'data-wallet-id="other"'),
    original.replace('data-wallet-id="ethereum-wallets"', 'data-wallet-id="other"'),
    original.replace('data-wallet-id="wallet-connect"', 'data-wallet-id="other"'),
    original.replace('id="google-start"', 'id="missing-google"'),
    original.replace('id="walletconnect-pairing"', 'id="missing-pairing"'),
  ]) {
    fs.writeFileSync(index, altered);
    assert.throws(() => stagePublicWeb(dest, source), /wallets and WalletConnect followed by Google/);
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
  for (const file of ['styles.css', 'app.mjs', 'google-signin.mjs', 'wallet.bundle.js']) assert.match(html, new RegExp(`\\./${file.replaceAll('.', '\\.') }\\?v=\\d+`));
});

test('Google session and WalletConnect relay are server functions, never public static files', async () => {
  assert.deepEqual(fs.readdirSync(path.join(realSource, 'api')).sort(), ['google-session.mjs', 'wc-relay.mjs']);
  for (const file of ['api/google-session.mjs', 'api/wc-relay.mjs']) assert.ok(!PUBLIC_WEB_FILES.includes(file));
  const api = await import('../web/api/google-session.mjs');
  assert.equal(typeof api.default, 'function');
  const script = `import http from 'node:http'; import server from ${JSON.stringify(new URL('../web/api/wc-relay.mjs', import.meta.url).href)};
    if (!(server instanceof http.Server)) throw new Error('Not an HTTP server');
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const result = await fetch('http://127.0.0.1:' + server.address().port + '/api/wc-relay');
    if (result.status !== 426) throw new Error('Unexpected relay response');
    await new Promise(resolve => server.close(resolve));`;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, BOUNCER_WALLETCONNECT_PROJECT_ID: '1234567890abcdef1234567890abcdef' } });
});

test('staging CLI runs from the web root and publishes only allowlisted files', t => {
  const { dest } = fixture(t);
  const output = execFileSync(process.execPath, [script, dest], { cwd: realSource, encoding: 'utf8' });
  assert.match(output, /Staged 18 reviewed public website files/);
  assert.deepEqual(fs.readdirSync(dest).sort(), [...PUBLIC_WEB_FILES].sort());
});
