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
  assert.equal(PUBLIC_WEB_FILES.length, 21);
  assert.ok(PUBLIC_WEB_FILES.includes('v14-bootstrap-artifact-v1.json'));
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

test('staging can explicitly approve one dedicated HTTPS Netlify origin without changing the source', t => {
  const {source,dest} = fixture(t);
  for (const walletOrigin of ['http://example.netlify.app','https://owner.github.io','https://madethis.website',
    'https://a.madethis.website','https://user@site.netlify.app','https://site.netlify.app/path',
    'https://site.netlify.app/', 'https://127.0.0.1', 'https://site.netlify.app?q=x', 'javascript:alert(1)']) {
    assert.throws(() => stagePublicWeb(dest, source, {walletOrigin}), /dedicated HTTPS/);
    assert.equal(fs.existsSync(dest), false);
  }
  stagePublicWeb(dest, source, {walletOrigin:'https://my-bouncer.netlify.app'});
  assert.match(fs.readFileSync(path.join(dest,'index.html'),'utf8'), /bouncer-wallet-origin" content="https:\/\/my-bouncer\.netlify\.app"/);
  assert.match(fs.readFileSync(path.join(source,'index.html'),'utf8'), /bouncer-wallet-origin" content="https:\/\/bouncer-near\.vercel\.app"/);
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
    original.replace('google-signin.mjs?v=3', 'old.mjs?v=3'),
    original.replace(/wallet\.bundle\.js\?v=\d+/, 'old-wallet.js?v=19'),
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
  assert.equal(config.git?.deploymentEnabled, false, 'the website must not automatically deploy any branch containing this configuration');
  const relay = JSON.parse(fs.readFileSync(new URL('../testnet-relay/vercel.json', import.meta.url), 'utf8'));
  assert.equal(relay.git?.deploymentEnabled, false, 'the relay must not automatically deploy any branch containing this configuration');
  for (const source of ['/', '/index.html']) {
    const headers = config.headers.find(rule => rule.source === source)?.headers || [];
    assert.match(headers.find(header => header.key.toLowerCase() === 'cache-control')?.value || '', /no-cache.*must-revalidate/);
  }
  const globalHeaders = config.headers.find(rule => rule.source === '/(.*)').headers;
  assert.equal(globalHeaders.find(h => h.key.toLowerCase() === 'cross-origin-opener-policy').value, 'same-origin-allow-popups');
  const csp=globalHeaders.find(h=>h.key.toLowerCase()==='content-security-policy')?.value || '';
  assert.match(csp,/script-src 'self' 'nonce-Qm91bmNlclRlc3RuZXQyMDI2' https:\/\/accounts\.google\.com/);
  assert.match(csp,/object-src 'none'/);assert.match(csp,/base-uri 'none'/);assert.doesNotMatch(csp,/'unsafe-inline'|https:\/\/\*/);
  const html = fs.readFileSync(path.join(realSource, 'index.html'), 'utf8');
  assert.match(html,/<meta name="bouncer-csp-nonce" content="Qm91bmNlclRlc3RuZXQyMDI2">/);
  for (const file of ['styles.css', 'app.mjs', 'google-signin.mjs', 'wallet.bundle.js']) assert.match(html, new RegExp(`\\./${file.replaceAll('.', '\\.') }\\?v=\\d+`));
});

test('Google, WalletConnect and disabled-by-default mission proxies are server functions, never public static files', async () => {
  assert.deepEqual(fs.readdirSync(path.join(realSource, 'api')).sort(), ['google-session.mjs', 'native-mission', 'railway-connection.mjs', 'wc-relay.mjs']);
  const actions=['challenge','config','execute','originals','preview','recover','v14-completed-history','v14-preflight','v14-receipt'];
  assert.deepEqual(fs.readdirSync(path.join(realSource,'api/native-mission')).sort(),actions.map(action=>`${action}.mjs`));
  for (const file of ['api/google-session.mjs','api/railway-connection.mjs','api/wc-relay.mjs',...actions.map(action=>`api/native-mission/${action}.mjs`)]) {
    assert.ok(!PUBLIC_WEB_FILES.includes(file));
  }
  const api = await import('../web/api/google-session.mjs');
  assert.equal(typeof api.default, 'function');
  // Exercise the generated deployment artifacts, not just their source.
  // All destinations and credentials below are synthetic; fetch is replaced.
  const proxyScript=`import assert from 'node:assert/strict';
    const actions=${JSON.stringify(actions)},base=${JSON.stringify(new URL('../web/api/native-mission/',import.meta.url).href)};
    let calls=[];globalThis.fetch=async (url,options)=>{calls.push([url,options]);return new Response('{"status":"synthetic"}',{headers:{'content-type':'application/json'}})};
    const modules=await Promise.all(actions.map(action=>import(base+action+'.mjs')));
    const invoke=async (handler,req)=>{let status,body;await handler(req,{writeHead(code){status=code},end(data){body=data}});return {status,body}};
    for(const [i,module] of modules.entries()){
      const action=actions[i],req={method:action==='config'?'GET':'POST',url:'/api/native-mission/'+action,
        headers:{host:'bouncer-near.vercel.app','x-forwarded-proto':'https','x-bouncer-native-mission':'v1',origin:'https://bouncer-near.vercel.app','content-type':'application/json'},body:{missionSha256:'a'.repeat(64)}};
      assert.equal((await invoke(module.default,req)).status,404);
      process.env.BOUNCER_NATIVE_MISSION_PROXY_ENABLED='1';process.env.BOUNCER_V14_SETUP_PROXY_ENABLED='1';process.env.BOUNCER_WALLET_ORIGIN='https://bouncer-near.vercel.app';
      process.env.BOUNCER_NATIVE_MISSION_BACKEND_ORIGIN='https://bouncer-synthetic.up.railway.app';process.env.BOUNCER_NATIVE_MISSION_PROXY_SECRET='ab'.repeat(32);
      assert.equal((await invoke(module.default,req)).status,200);assert.equal(calls.at(-1)[0],'https://bouncer-synthetic.up.railway.app/api/native-mission/'+action);
      assert.equal((await invoke(module.default,{...req,url:'/api/native-mission/not-'+action})).status,403);
      process.env.BOUNCER_NATIVE_MISSION_PROXY_ENABLED='';process.env.BOUNCER_V14_SETUP_PROXY_ENABLED='';
    }
    assert.equal(calls.length,actions.length);`;
  execFileSync(process.execPath,['--input-type=module','-e',proxyScript],{env:{...process.env,BOUNCER_NATIVE_MISSION_PROXY_ENABLED:'',BOUNCER_V14_SETUP_PROXY_ENABLED:''}});
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
  assert.match(output, /Staged 21 reviewed public website files/);
  assert.deepEqual(fs.readdirSync(dest).sort(), [...PUBLIC_WEB_FILES].sort());
});
