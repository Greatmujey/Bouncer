import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { RUN, LATEST_MISSION, explorerAccount, explorerTx, formatUnits, readCurrentBalances, shortId } from '../web/evidence.mjs';

test('recorded website evidence describes the real multi-token run and separate security account', () => {
  assert.equal(RUN.account, 'bouncer-42dcdfb7.testnet');
  assert.equal(RUN.securityAccount, 'bouncer-f646cc.testnet');
  assert.notEqual(RUN.account, RUN.securityAccount);
  assert.deepEqual(RUN.resources.map(r => r.id), ['compute', 'storage', 'api']);
  assert.deepEqual(RUN.resources.map(r => formatUnits(r.amount, r.decimals)), ['0.1', '1.5', '2']);
  assert.deepEqual(RUN.resources.map(r => formatUnits(r.vault, r.decimals)), ['0.9', '8.5', '8']);
  for (const r of RUN.resources) {
    assert.equal(BigInt(r.funded) - BigInt(r.amount), BigInt(r.vault));
    assert.ok(BigInt(r.amount) <= BigInt(r.perTx));
    assert.ok(BigInt(r.amount) <= BigInt(r.daily));
    assert.match(r.vendor, /\.bouncer-42dcdfb7\.testnet$/);
    assert.match(r.tx, /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    assert.equal(explorerTx(r.tx), `https://testnet.nearblocks.io/txns/${r.tx}`);
  }
  assert.equal(explorerAccount(RUN.account), `https://testnet.nearblocks.io/address/${RUN.account}`);
  assert.match(explorerTx(RUN.securityRefundTx), /GkQL6ZNHC7gGmRmCHc9uFv7fSsNdeJkTZaHtNPcxfhtw$/);
});

test('recorded story inputs and service outputs match the real integration script', () => {
  const [compute, storage, api] = RUN.resources;
  let hash = Buffer.from('near-hub compute job');
  for (let i = 0; i < 1000; i++) hash = createHash('sha256').update(hash).digest();
  assert.equal(compute.story.result, `SHA-256 result: ${hash.toString('hex')}`);
  assert.match(compute.story.request, /1,000 rounds/);
  const note = 'Persisted by the Bouncer testnet provider.';
  assert.equal(Buffer.byteLength(note), 42);
  assert.ok(storage.story.result.includes(note));
  assert.match(storage.story.result, /stored and retrieved \(42 bytes\)/);
  const text = 'actual testnet resource API';
  assert.equal(text.split(/\s+/u).length, 4);
  assert.equal(Buffer.byteLength(text), 27);
  assert.match(api.story.result, /4 words and 27 bytes/);
  const script = fs.readFileSync(new URL('../demo-multi-resource.mjs', import.meta.url), 'utf8');
  for (const input of ['near-hub compute job', note, text]) assert.ok(script.includes(input));
});

test('token formatting is exact, validates inputs, and does not use floats', () => {
  assert.equal(formatUnits('0', 24), '0');
  assert.equal(formatUnits('10', 0), '10');
  assert.equal(formatUnits('1', 6), '0.000001');
  assert.equal(formatUnits('900000000000000000000000', 24), '0.9');
  assert.equal(formatUnits('123456789012345678901234567890', 24), '123456.78901234567890123456789');
  for (const [amount, decimals] of [['-1', 6], ['1.2', 6], ['01', 6], ['1', 25], ['1', -1]]) {
    assert.throws(() => formatUnits(amount, decimals), /Invalid token amount/);
  }
  assert.equal(shortId('abc'), 'abc');
  assert.equal(shortId('abcdefghijklmno', 4, 3), 'abcd…mno');
});

const rpcResponse = value => ({ ok: true, json: async () => ({ result: { result: [...new TextEncoder().encode(JSON.stringify(value))] } }) });

test('current balances are read only from the pinned contract via final view calls', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const request = JSON.parse(options.body);
    calls.push({ url, options, request });
    return rpcResponse(RUN.resources.find(r => r.id === request.id).vault);
  };
  const balances = await readCurrentBalances(fetchImpl);
  assert.deepEqual(balances, Object.fromEntries(RUN.resources.map(r => [r.id, r.vault])));
  assert.equal(calls.length, 3);
  for (const { url, options, request } of calls) {
    assert.equal(url, 'https://test.rpc.fastnear.com');
    assert.equal(options.method, 'POST'); // JSON-RPC view requests; no signing or transaction submission.
    assert.equal(request.method, 'query');
    assert.equal(request.params.request_type, 'call_function');
    assert.equal(request.params.finality, 'final');
    assert.equal(request.params.account_id, RUN.account);
    assert.equal(request.params.method_name, 'vault_balance');
    assert.deepEqual(JSON.parse(atob(request.params.args_base64)), { token: RUN.resources.find(r => r.id === request.id).token });
  }
});

test('current balance read fails closed on HTTP, RPC, and malformed values', async () => {
  await assert.rejects(readCurrentBalances(async () => ({ ok: false, status: 503 })), /HTTP 503/);
  await assert.rejects(readCurrentBalances(async () => ({ ok: true, json: async () => ({ error: { code: -1 } }) })), /invalid response/);
  for (const value of [42, '-1', '1.2', '01', null]) {
    await assert.rejects(readCurrentBalances(async () => rpcResponse(value)), /invalid balance/);
  }
});

test('active website, package and documentation links use the renamed GitHub repository', () => {
  const sources = [
    new URL('../../README.md', import.meta.url),
    new URL('../package.json', import.meta.url),
    new URL('../packages/provider-sdk/README.md', import.meta.url),
    new URL('../web/index.html', import.meta.url),
    new URL('../web/evidence.mjs', import.meta.url),
    ...fs.readdirSync(new URL('../docs/', import.meta.url))
      .filter(name => name.endsWith('.md')).map(name => new URL(`../docs/${name}`, import.meta.url)),
  ];
  let count = 0;
  for (const source of sources) {
    const text = fs.readFileSync(source, 'utf8');
    const links = text.matchAll(/https:\/\/github\.com\/([^/\s"')<>`]+)\/Bouncer(?=\/|[\s"')<>`]|$)/gi);
    for (const link of links) {
      assert.equal(link[1], 'Greatmujey', `stale Bouncer link in ${source}`);
      count++;
    }
  }
  assert.ok(count >= 50, 'expected the existing website and evidence links to be checked');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.repository.url, 'https://github.com/Greatmujey/Bouncer');
  assert.match(fs.readFileSync(new URL('../docs/WEB.md', import.meta.url), 'utf8'), /https:\/\/greatmujey\.github\.io\/Bouncer\//);
});

test('the public site documentation and smoke tests agree on the restored address', () => {
  const current = 'https://bouncer-near.vercel.app/';
  for (const source of [
    new URL('../../README.md', import.meta.url),
    new URL('../docs/WEB.md', import.meta.url),
    new URL('../scripts/check-public-web-assets.mjs', import.meta.url),
    new URL('../scripts/test-public-web-preview.mjs', import.meta.url),
    new URL('../../.github/workflows/web-preview.yml', import.meta.url),
  ]) {
    const text = fs.readFileSync(source, 'utf8');
    assert.ok(text.includes(current), `missing restored site URL in ${source}`);
    assert.ok(!text.includes('https://bouncer-testnet.vercel.app/'), `stale site URL in ${source}`);
  }
});

test('latest oracle-led mission links to the verified testnet data and three resource payments', () => {
  assert.equal(LATEST_MISSION.account, 'bouncer-oracle-6a42bf32.testnet');
  assert.equal(LATEST_MISSION.owner, 'owner.bouncer-oracle-6a42bf32.testnet');
  assert.notEqual(LATEST_MISSION.account, LATEST_MISSION.owner);
  assert.equal(LATEST_MISSION.testToken, '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af');
  assert.equal(LATEST_MISSION.resourceMicroUsdc, '1000');
  assert.equal(LATEST_MISSION.priceUsd, '4.27625');
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  for (const key of ['setupSwapTx', 'fundingTx', 'oracleTx', 'computeTx', 'storageTx', 'apiTx']) {
    assert.match(LATEST_MISSION[key], /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    assert.ok(html.includes(explorerTx(LATEST_MISSION[key])), `missing link for ${key}`);
  }
  assert.ok(html.includes(LATEST_MISSION.actionUrl));
  assert.ok(html.includes(LATEST_MISSION.aiActionUrl));
  assert.match(html, /Coinbase’s public endpoint through OutLayer/);
  assert.match(html, /testnet NEAR/);
  assert.match(html, /Circle testnet USDC/);
  assert.match(html, /self-hosted development examples/);
  assert.match(html, /no real value/);
  assert.match(html, /not independently verified for accuracy or market freshness/);
  assert.match(html, /intentionally corrupted result stopped later payments/);
  assert.match(html, /independent execution was not paid in USDC/);
  assert.match(html, /process is non-atomic/);
  assert.equal((html.match(/class="track-card"/g) || []).length, 3);
  assert.match(html, /ONE FOCUS · AI SECURITY &amp; DEFENSE/);
  assert.doesNotMatch(html, /SIX TRACKS · ONE ROADMAP/);
});

test('the same custom Bouncer mark appears in both navigation layouts, the tour and favicon', () => {
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const logo = fs.readFileSync(new URL('../web/favicon.svg', import.meta.url), 'utf8');
  assert.equal((html.match(/class="brand-mark" aria-hidden="true"/g) || []).length, 3);
  assert.equal((html.match(/<use href="#i-bouncer"\/>/g) || []).length, 4);
  assert.match(html, /rel="icon"[^>]*href="\.\/favicon\.svg\?v=3"/);
  assert.match(logo, /viewBox="16 17 300 300"/);
  const symbol = html.match(/<symbol id="i-bouncer"[^>]*>(.*?)<\/symbol>/s)?.[1];
  assert.ok(symbol, 'brand symbol is present');
  const pathData = source => [...source.matchAll(/<path d="([^"]+)"/g)].map(match => match[1]);
  assert.equal(pathData(logo).length, 3);
  assert.deepEqual(pathData(symbol), pathData(logo), 'favicon and website use the same mark');
  assert.doesNotMatch(logo, /<script|<foreignObject|\b(?:href|src)\s*=/i);
});

test('website discloses testnet limitations, historical examples and identity-only Google sign-in', () => {
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /unaudited testnet prototype/i);
  assert.match(html, /not a live purchasing dashboard/i);
  assert.match(html, /self-hosted development examples, not commercial vendors/);
  assert.match(html, /newly created testnet tokens/);
  assert.match(html, /Separate earlier refund test/);
  assert.match(html, /The new guarded mission and an independent security audit remain open/);
  assert.match(html, /The direct wallet test bypassed Bouncer/);
  assert.match(html, /older vault funding and guard transactions do not prove independent delivery/);
  assert.doesNotMatch(html, /Start buying/i);
  assert.match(html, /Sign in with Google/i);
  assert.match(html, /does not create a Bouncer vault or grant agent spending access/i);
  assert.match(html, /Ethereum wallet setup may require an approved testnet transaction/i);
  assert.match(html, /Never enter a seed phrase or private key into Bouncer/i);
  assert.match(html, /Gemini CLI and Claude Code passed local connection checks/i);
  assert.match(html, /ChatGPT web and other hosted assistants need HTTPS/i);
  assert.match(html, /Model conversations have not been tested/i);
  assert.match(html, /id="welcome-tour"/);
  assert.match(html, /local AI model to propose resource tasks/i);
  assert.match(html, /not yet an open marketplace/i);
  assert.equal((html.match(/data-story-tab=/g) || []).length, 3);
  for (const tx of [
    'Ep5vWogSd2nqitJFdLxR8J9CnZaqUjn6wnbRCaXVq2fM',
    'Fegksi5b8KmqnHN3fHaH1Ak9vyLFA2JjgoqL5UAtjpu2',
    '2xrD5cbvz2MgaThp3VdwbRZU8GAXoJHcbsHN4TispdjL',
  ]) assert.ok(html.includes(explorerTx(tx)), `missing current transaction ${tx}`);
});

test('workspace picker contains the six testnet wallets, WalletConnect and Google identity', () => {
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8');
  const views = [...html.matchAll(/data-route-view="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(views, ['workspace', 'resources', 'guardrails', 'proof', 'connect']);
  const wallets = [...html.matchAll(/data-wallet-id="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(wallets, ['near-mobile', 'meteor-wallet', 'intear-wallet', 'nightly-wallet', 'ledger', 'ethereum-wallets', 'near-cli', 'wallet-connect']);
  assert.ok(html.indexOf('id="google-start"') > html.indexOf('data-wallet-id="wallet-connect"'));
  assert.match(html, /id="wallet-dialog"/);
  assert.match(html, /id="google-signin-button"/);
  assert.match(html, /id="google-signout"/);
  assert.match(html, /id="account-status"[^>]*role="status"/);
  assert.match(html, /sign in with Google/i);
  assert.match(html, /id="walletconnect-pairing"/);
  assert.match(html, /id="walletconnect-canvas"/);
  assert.match(html, /THE IDEA IN MOTION/);
  assert.match(css, /prefers-reduced-motion:reduce/);
});

test('recovery screen distinguishes the two file types and warns before an uncertain Railway save', () => {
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const panel = html.slice(html.indexOf('id="wallet-bootstrap-recovery-panel"'), html.indexOf('id="wallet-v14-recovery-open"'));
  assert.match(panel, /recovery export\? Choose it here — not the preparation file/i);
  assert.match(panel, /recovery export includes the owner-attested encrypted kit; it is a different file/i);
  assert.match(panel, /If you already tried to save to Railway, or are not sure, do not save again/i);
  assert.match(panel, /Creating and updating Railway copies is paused/i);
  assert.doesNotMatch(panel, /id="wallet-bootstrap-anchor-save"/);
  assert.match(panel, /A failed restore does not prove the copy is absent/i);
  assert.match(panel, /No passphrase or transaction is needed/i);
  assert.match(panel, /A missing record does not prove an earlier save never happened/i);
  const position = id => {
    const pattern = `id="${id}"`;
    assert.equal(panel.split(pattern).length, 2, `${id} must occur once`);
    return panel.indexOf(pattern);
  };
  assert.ok(position('wallet-bootstrap-recovery-read') < position('wallet-bootstrap-recovery-backup'));
  assert.ok(position('wallet-bootstrap-recovery-passphrase') < position('wallet-bootstrap-recovery-unlock'));
  assert.ok(position('wallet-bootstrap-recovery-unlock') < position('wallet-bootstrap-recovery-export'));
  assert.ok(position('wallet-bootstrap-recovery-export') < position('wallet-bootstrap-anchor-panel'));
  assert.ok(position('wallet-bootstrap-anchor-inspect') < position('wallet-bootstrap-anchor-passphrase'));
});

test('proof page distinguishes historical independent native lookup from self-hosted resource examples', () => {
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /Independent OutLayer price lookup/);
  assert.match(html, /Historical testnet NEAR payment and owner refund/);
  assert.match(html, /A direct wallet test fetched a NEAR price through OutLayer on testnet, bypassing Bouncer/);
  assert.match(html, /compute, storage and API examples used self-hosted development services/);
  assert.match(html, /guarded wallet-initiated mission is not yet live/);
  assert.match(html, /single-source price is not independently verified for accuracy/);
  assert.match(html, /Direct phone wallet → OutLayer/);
  assert.ok(html.includes(explorerTx('Ci7R3GXe2RxQ4fGs6fyzS8H3rfb3GjVi5iyXj5FyTYas')));
});
