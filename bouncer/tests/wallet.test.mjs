import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { KeyPair } from '@near-js/crypto';
import { nep413Payload } from '../web-src/cli-login.mjs';
import fs from 'node:fs';
import { initWallet as bootWallet, walletOriginAllowed } from '../web-src/wallet-core.mjs';
import { WALLET_MANIFEST } from '../web-src/wallet-manifest.mjs';
import { loadVerifiedExecutor, WALLET_EXECUTOR_SHA256 } from '../web-src/wallet-executor.mjs';

const location = url => { const u = new URL(url); return { hostname: u.hostname, host: u.host, protocol: u.protocol, origin: u.origin }; };
class FakeSandboxWallet {
  constructor(manifest, config) { this.manifest = manifest; this.config = config; this.executor = { async clearStorage() { config.cliStorageCleared = true; } }; }
  async signInAndSignMessage(params) {
    this.config.cliParams = params;
    if (this.config.fail) throw new Error('cancelled');
    const pair = this.config.cliKey || KeyPair.fromRandom('ed25519');
    const { message, nonce, recipient } = params.messageParams;
    const hash = createHash('sha256').update(nep413Payload({ message, nonce, recipient })).digest();
    const publicKey = pair.getPublicKey().toString(), accountId = this.config.account || 'cli.testnet';
    const signature = Buffer.from(pair.sign(hash).signature).toString('base64');
    return [{ accountId, publicKey, signedMessage: { accountId, publicKey, signature: this.config.badSignature ? 'bad' : signature } }];
  }
  async signMessage(params) {
    this.config.messageRequests ??= [];
    this.config.messageRequests.push(params);
    if (this.config.fail) throw new Error('cancelled');
    return this.config.messageResult || { accountId: 'mobile.testnet', publicKey: 'ed25519:public', signature: 'test-signature' };
  }
}
const initWallet = params => bootWallet({ ...params, SandboxWallet: FakeSandboxWallet });
class Element {
  constructor(dataset = {}) { this.listeners = {}; this.dataset = dataset; this.hidden = false; this.disabled = false; this.textContent = ''; this.open = false; this.attributes = {}; this.focused = false; }
  addEventListener(event, callback) { this.listeners[event] = callback; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  getContext() { return { clearRect: () => { this.renderedCanvas = null; }, drawImage: canvas => { this.renderedCanvas = canvas; } }; }
  async click() { if (!this.disabled) await this.listeners.click?.({ target: this }); }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.close?.(); }
  getBoundingClientRect() { return { left: 0, right: 100, top: 0, bottom: 100 }; }
}
function fakeBrowser(url, { top = true, storageFails = false, approved = '', walletConnectProjectId = '' } = {}) {
  const ids = ['wallet-connect', 'wallet-disconnect', 'wallet-status', 'wallet-open-site', 'wallet-dialog', 'wallet-close', 'wallet-options', 'wallet-dialog-status', 'wallet-title-text', 'wallet-dialog-description', 'wallet-banner',
    'walletconnect-pairing', 'walletconnect-caption', 'walletconnect-badge', 'walletconnect-qr', 'walletconnect-canvas', 'walletconnect-open', 'walletconnect-copy', 'walletconnect-cancel', 'walletconnect-retry', 'walletconnect-loading', 'walletconnect-progress', 'walletconnect-error', 'walletconnect-error-title', 'walletconnect-error-detail', 'walletconnect-ready', 'wallet-safety'];
  const nodes = Object.fromEntries(ids.map(id => [id, new Element()]));
  nodes['wallet-open-site'].hidden = true;
  const options = ['meteor-wallet', 'nightly-wallet', 'ledger', 'near-mobile', 'intear-wallet', 'near-cli', 'wallet-connect'].map(walletId => new Element({ walletId }));
  const openers = [nodes['wallet-connect'], new Element(), new Element()];
  const data = new Map(), labels = [new Element(), new Element(), new Element()];
  const win = { location: { ...location(url), href: url }, crypto: webcrypto,
    fetch: async target => {
      if (String(target).endsWith('/walletconnect-config.json')) return { ok: true, text: async () => JSON.stringify({ projectId: walletConnectProjectId }) };
      if (String(target) === 'https://test.rpc.fastnear.com') return { ok: true, text: async () => JSON.stringify({ result: { permission: win.cliKeyPermission || 'FullAccess' } }) };
      throw new Error('unexpected network');
    },
    navigator: { clipboard: { async writeText(value) { win.clipboard = value; } } }, localStorage: {
    getItem(key) { if (storageFails) throw new Error('storage disabled'); return data.get(key) ?? null; },
    setItem(key, value) { if (storageFails) throw new Error('storage disabled'); data.set(key, value); },
    removeItem(key) { if (storageFails) throw new Error('storage disabled'); data.delete(key); },
  } };
  win.self = {}; win.top = top ? win.self : {};
  const classes = new Set();
  const doc = { body: { classList: { add: value => classes.add(value), remove: value => classes.delete(value) } },
    createElement() { return new Element(); },
    querySelector(sel) { if (sel === 'meta[name="bouncer-wallet-origin"]') return { content: approved }; return nodes[sel.slice(1)]; },
    querySelectorAll(sel) { return sel === '[data-wallet-label]' ? labels : sel === '[data-wallet-id]' ? options : sel === '[data-wallet-open]' ? openers : []; } };
  return { win, doc, nodes, options, openers, data, labels, classes };
}
function connectorClass(config = {}) {
  return class FakeConnector {
    constructor(options) {
      config.options = options; config.instance = this;
      this.events = {}; this.wallets = options.manifest.wallets.map(manifest => new FakeSandboxWallet(manifest, config));
      this.db = {}; this.whenManifestLoaded = Promise.resolve();
    }
    on(event, fn) { this.events[event] = fn; }
    async getConnectedWallet() { throw new Error('not connected'); }
    async connect(input) {
      config.input = input;
      if (config.browser) config.dialogWasOpen = config.browser.nodes['wallet-dialog'].open;
      if (config.fail) throw new Error('cancelled');
      const wallet = this.wallets.find(w => w.manifest.id === input.walletId);
      this.events['wallet:signIn']({ wallet, accounts: [{ accountId: config.account || 'alice.testnet' }] });
    }
    async disconnect(wallet) { config.disconnected = wallet.manifest.id; this.events['wallet:signOut'](); }
  };
}

test('wallet origin policy blocks shared origins, unapproved sites, HTTP and iframes', () => {
  assert.equal(walletOriginAllowed(location('https://www.madethis.website/s/abc/'), true), false);
  assert.equal(walletOriginAllowed(location('https://www.madethis.website/s/abc/'), true, 'https://www.madethis.website'), false);
  // Different GitHub Pages repository paths share the account's origin.
  assert.equal(walletOriginAllowed(location('https://owner.github.io/Bouncer/'), true), false);
  assert.equal(walletOriginAllowed(location('https://owner.github.io/Bouncer/'), true, 'https://owner.github.io'), false);
  assert.equal(walletOriginAllowed(location('https://bouncer-testnet.vercel.app/'), true), false);
  assert.equal(walletOriginAllowed(location('https://bouncer-near.vercel.app/'), true), false);
  assert.equal(walletOriginAllowed(location('https://bouncer-near.vercel.app/'), true, 'https://bouncer-near.vercel.app'), true);
  assert.equal(walletOriginAllowed(location('https://bouncer-near.vercel.app/'), false, 'https://bouncer-near.vercel.app'), false);
  assert.equal(walletOriginAllowed(location('https://other.example/'), true), false);
  assert.equal(walletOriginAllowed(location('http://other.example/'), true, 'http://other.example'), false);
  assert.equal(walletOriginAllowed(location('https://other.example/'), true, 'https://other.example'), true);
  assert.equal(walletOriginAllowed(location('https://safe-4173.app.github.dev/'), true), true);
  assert.equal(walletOriginAllowed(location('https://4173-example.e2b.app/'), true), true);
  assert.equal(walletOriginAllowed(location('https://4173-example.e2b.app/'), false), false);
  assert.equal(walletOriginAllowed(location('http://127.0.0.1:4173/'), true), true);
});

test('wallet manifests are curated testnet choices with pinned, integrity-checked executors', () => {
  assert.deepEqual(WALLET_MANIFEST.wallets.map(w => w.id).sort(), ['intear-wallet', 'ledger', 'meteor-wallet', 'near-cli', 'near-mobile', 'nightly-wallet']);
  for (const wallet of WALLET_MANIFEST.wallets) {
    assert.equal(wallet.features.testnet, true);
    assert.match(WALLET_EXECUTOR_SHA256[wallet.id], /^[a-f0-9]{64}$/);
    if (wallet.id === 'near-mobile') {
      assert.equal(wallet.features.signInWithoutAddKey, false, 'ordinary Mobile signIn is not safe');
      assert.equal(wallet.features.signMessage, true);
    } else assert.equal(wallet.features.signInWithoutAddKey, true);
    if (wallet.id === 'intear-wallet') assert.equal(wallet.executor, '/intear-wallet.executor.js');
    else assert.match(wallet.executor, /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}\//);
  }
});

test('shared guest, GitHub Pages and embedded preview never instantiate the wallet connector', async () => {
  const cases = [
    ['https://www.madethis.website/s/abc/', true, ''],
    ['https://owner.github.io/Bouncer/', true, 'https://owner.github.io'],
    ['https://bouncer-testnet.vercel.app/', true, ''],
    ['https://bouncer-near.vercel.app/', true, ''],
    ['https://4173-example.e2b.app/', false, ''],
  ];
  for (const [url, top, approved] of cases) {
    const browser = fakeBrowser(url, { top, approved });
    await initWallet({ window: browser.win, document: browser.doc, NearConnector: class { constructor() { throw new Error('must not initialize'); } } });
    assert.ok(browser.options.every(option => option.disabled));
    assert.match(browser.nodes['wallet-status'].textContent, /new tab/);
    assert.equal(browser.nodes['wallet-open-site'].hidden, false);
    await browser.nodes['wallet-connect'].click();
    assert.equal(browser.nodes['wallet-dialog'].open, true, 'the picker explains the safe alternative');
  }
});

test('connects and disconnects a wallet-reported account without requesting a key or signature', async () => {
  const browser = fakeBrowser('http://127.0.0.1:4173/'), config = { browser };
  await initWallet({ window: browser.win, document: browser.doc, NearConnector: connectorClass(config) });
  assert.equal(config.options.network, 'testnet');
  assert.equal(config.options.features.testnet, true);
  assert.equal(config.options.features.signInWithoutAddKey, undefined, 'Mobile uses a separate message-only flow');
  assert.equal(config.options.autoConnect, false);
  assert.equal(browser.nodes['wallet-connect'].disabled, false);
  // An injected wallet replacing a trusted ID is filtered rather than selected.
  config.instance.wallets.unshift({ manifest: { ...WALLET_MANIFEST.wallets.find(w => w.id === 'meteor-wallet') } });
  config.instance.wallets.unshift({ manifest: WALLET_MANIFEST.wallets.find(w => w.id === 'meteor-wallet') });
  config.instance.events['selector:walletsChanged']();
  assert.equal(config.instance.wallets.length, 6, 'even a forged object using a curated manifest is rejected');
  await browser.nodes['wallet-connect'].click();
  assert.equal(browser.nodes['wallet-dialog'].open, true);
  assert.equal(config.input, undefined, 'opening the picker does not connect');
  assert.ok(browser.options.filter(option => option.dataset.walletId !== 'wallet-connect').every(option => !option.disabled));
  assert.equal(browser.options.find(option => option.dataset.walletId === 'wallet-connect').disabled, true, 'WalletConnect needs configuration');
  await browser.options[0].click();
  assert.deepEqual(config.input, { walletId: 'meteor-wallet' });
  assert.equal(config.dialogWasOpen, false, 'wallet iframe is not blocked behind our dialog');
  assert.match(browser.nodes['wallet-status'].textContent, /Connected: alice\.testnet \(wallet-reported\)/);
  assert.equal(browser.nodes['wallet-options'].hidden, true);
  assert.equal(browser.nodes['wallet-disconnect'].hidden, false);
  assert.deepEqual(browser.labels.map(node => node.textContent), ['Connected', 'Connected', 'Connected']);
  assert.ok(browser.openers.every(button => button.dataset.walletState === 'connected'));
  assert.ok(browser.openers.every(button => button.attributes['aria-label'] === 'Connected: alice.testnet. Manage wallet'));
  assert.equal(browser.nodes['wallet-title-text'].textContent, 'Wallet connected');
  assert.match(browser.nodes['wallet-dialog-description'].textContent, /connected/);
  await browser.nodes['wallet-connect'].click();
  await browser.nodes['wallet-disconnect'].click();
  assert.equal(config.disconnected, 'meteor-wallet');
  assert.match(browser.nodes['wallet-status'].textContent, /disconnected/i);
  assert.deepEqual(browser.labels.map(node => node.textContent), ['Connect wallet', 'Connect wallet', 'Connect wallet']);
  assert.ok(browser.openers.every(button => button.dataset.walletState === 'disconnected'));
  assert.ok(browser.openers.every(button => button.attributes['aria-label'] === 'Connect wallet'));
  assert.equal(browser.nodes['wallet-title-text'].textContent, 'Connect a wallet');
  assert.match(browser.nodes['wallet-dialog-description'].textContent, /login message/);
});

test('CLI requires a fresh off-chain signature, verifies testnet Full Access, and disconnects locally', async () => {
  const browser = fakeBrowser('http://127.0.0.1:4173/'), config = {};
  await initWallet({ window: browser.win, document: browser.doc, NearConnector: connectorClass(config) });
  await browser.nodes['wallet-connect'].click();
  await browser.options.find(option => option.dataset.walletId === 'near-cli').click();
  assert.equal(config.cliStorageCleared, true);
  assert.equal(config.cliParams.network, 'testnet');
  assert.equal(config.cliParams.addFunctionCallKey, undefined);
  assert.equal(config.cliParams.messageParams.nonce.length, 32);
  assert.match(config.cliParams.messageParams.message, /does not approve a transaction/);
  assert.match(browser.nodes['wallet-status'].textContent, /Connected: cli\.testnet \(CLI login verified against testnet\)/);
  assert.equal(browser.nodes['wallet-disconnect'].hidden, false);
  assert.ok(browser.openers.every(button => button.dataset.walletState === 'connected'));
  await browser.nodes['wallet-disconnect'].click();
  assert.equal(config.disconnected, 'near-cli');
  assert.ok(browser.openers.every(button => button.dataset.walletState === 'disconnected'));
});

test('CLI cannot show connected after a bad signature, a limited key, or a cancelled request', async () => {
  for (const config of [{ badSignature: true }, {}, { fail: true }]) {
    const browser = fakeBrowser('http://127.0.0.1:4173/');
    if (Object.keys(config).length === 0) browser.win.cliKeyPermission = { FunctionCall: {} };
    await initWallet({ window: browser.win, document: browser.doc, NearConnector: connectorClass(config) });
    await browser.nodes['wallet-connect'].click();
    await browser.options.find(option => option.dataset.walletId === 'near-cli').click();
    assert.doesNotMatch(browser.nodes['wallet-status'].textContent, /^Connected:/);
    assert.equal(browser.nodes['wallet-disconnect'].hidden, true);
    assert.equal(browser.nodes['wallet-dialog'].open, true);
    assert.ok(browser.openers.every(button => button.dataset.walletState === 'disconnected'));
  }
});

test('a legacy manually entered CLI account is not restored or accepted as verified', async () => {
  const browser = fakeBrowser('http://127.0.0.1:4173/'), config = {};
  browser.data.set('bouncer:near-connect:selected-wallet', 'near-cli');
  await initWallet({ window: browser.win, document: browser.doc, NearConnector: connectorClass(config) });
  assert.match(browser.nodes['wallet-status'].textContent, /requires a new login message/);
  assert.equal(browser.data.has('bouncer:near-connect:selected-wallet'), false);
  const wallet = config.instance.wallets.find(candidate => candidate.manifest.id === 'near-cli');
  config.instance.events['wallet:signIn']({ wallet, accounts: [{ accountId: 'anyone.testnet' }] });
  assert.equal(browser.nodes['wallet-disconnect'].hidden, true);
  assert.ok(browser.openers.every(button => button.dataset.walletState === 'disconnected'));
});

test('the dedicated Vercel origin can connect; implicit IDs use the fixed testnet network', async () => {
  for (const account of ['greatmujey.testnet', 'a'.repeat(64)]) {
    const browser = fakeBrowser('https://bouncer-near.vercel.app/', { approved: 'https://bouncer-near.vercel.app' }), config = { account };
    await initWallet({ window: browser.win, document: browser.doc, NearConnector: connectorClass(config) });
    await browser.nodes['wallet-connect'].click();
    await browser.options[0].click();
    assert.match(browser.nodes['wallet-status'].textContent, new RegExp(`^Connected: ${account}`));
    assert.equal(config.options.network, 'testnet');
  }
});

test('wallet errors and named mainnet accounts fail closed; blocked browser storage falls back to this session', async () => {
  for (const config of [{ fail: true }, { account: 'alice.near' }]) {
    const browser = fakeBrowser('http://127.0.0.1:4173/');
    await initWallet({ window: browser.win, document: browser.doc, NearConnector: connectorClass(config) });
    await browser.nodes['wallet-connect'].click();
    await browser.options[0].click();
    assert.equal(browser.nodes['wallet-disconnect'].hidden, true);
    assert.equal(browser.nodes['wallet-dialog'].open, true, 'the picker reopens after failure');
    assert.doesNotMatch(browser.nodes['wallet-status'].textContent, /^Connected:/);
  }
  const browser = fakeBrowser('http://127.0.0.1:4173/', { storageFails: true }), config = {};
  await initWallet({ window: browser.win, document: browser.doc, NearConnector: connectorClass(config) });
  assert.equal(browser.nodes['wallet-connect'].disabled, false);
  await browser.nodes['wallet-connect'].click();
  await browser.options[0].click();
  assert.match(browser.nodes['wallet-status'].textContent, /Connected: alice\.testnet/);
  assert.equal(browser.nodes['wallet-disconnect'].hidden, false);
  await browser.nodes['wallet-disconnect'].click();
  assert.match(browser.nodes['wallet-status'].textContent, /disconnected/i);
});

test('picker opens from every entry point, returns focus, and only accepts curated wallet IDs', async () => {
  for (const [index, id] of [[1, 'nightly-wallet'], [2, 'ledger']]) {
    const browser = fakeBrowser('http://127.0.0.1:4173/'), config = { browser };
    await initWallet({ window: browser.win, document: browser.doc, NearConnector: connectorClass(config) });
    await browser.openers[index].click();
    assert.equal(browser.nodes['wallet-dialog'].open, true);
    assert.equal(browser.classes.has('wallet-dialog-open'), true);
    await browser.nodes['wallet-close'].click();
    assert.equal(browser.nodes['wallet-dialog'].open, false);
    assert.equal(browser.openers[index].focused, true);
    assert.equal(browser.classes.has('wallet-dialog-open'), false);
    await browser.openers[index].click();
    await browser.options[index].click();
    assert.deepEqual(config.input, { walletId: id });
  }
  const browser = fakeBrowser('http://127.0.0.1:4173/'), config = {};
  await initWallet({ window: browser.win, document: browser.doc, NearConnector: connectorClass(config) });
  await browser.openers[0].click();
  browser.options[0].dataset.walletId = 'untrusted-wallet';
  await browser.options[0].click();
  assert.equal(config.input, undefined);
  assert.equal(browser.nodes['wallet-dialog'].open, true);
});

test('NEAR Mobile uses fresh off-chain testnet messages and never signs in or deletes a key', async () => {
  const browser = fakeBrowser('https://bouncer-near.vercel.app/', { approved: 'https://bouncer-near.vercel.app' });
  const config = { browser };
  await initWallet({ window: browser.win, document: browser.doc, NearConnector: connectorClass(config) });
  const mobile = browser.options.find(option => option.dataset.walletId === 'near-mobile');
  for (let index = 0; index < 2; index++) {
    await browser.nodes['wallet-connect'].click();
    await mobile.click();
    const params = config.messageRequests[index];
    assert.equal(config.input, undefined, 'ordinary Mobile signIn is forbidden');
    assert.equal(params.network, 'testnet');
    assert.equal(params.recipient, 'bouncer-near.vercel.app');
    assert.equal(params.nonce.length, 32);
    assert.match(params.message, /login message does not approve a transaction, transfer funds, or add an access key/i);
    assert.match(browser.nodes['wallet-status'].textContent, /Connected: mobile\.testnet/);
    assert.equal(browser.data.get('bouncer:near-connect:selected-wallet'), undefined, 'Mobile session is not persisted');
    await browser.nodes['wallet-connect'].click();
    await browser.nodes['wallet-disconnect'].click();
    assert.equal(config.disconnected, undefined, 'Mobile adapter signOut must never be called');
    assert.match(browser.nodes['wallet-status'].textContent, /disconnected/i);
  }
  assert.notDeepEqual([...config.messageRequests[0].nonce], [...config.messageRequests[1].nonce]);
});

test('NEAR Mobile rejects missing signed data and named mainnet accounts', async () => {
  for (const messageResult of [
    { accountId: 'mobile.testnet', publicKey: '', signature: '' },
    { accountId: 'alice.near', publicKey: 'ed25519:public', signature: 'test-signature' },
  ]) {
    const browser = fakeBrowser('https://bouncer-near.vercel.app/', { approved: 'https://bouncer-near.vercel.app' });
    const config = { messageResult };
    await initWallet({ window: browser.win, document: browser.doc, NearConnector: connectorClass(config) });
    await browser.nodes['wallet-connect'].click();
    await browser.options.find(option => option.dataset.walletId === 'near-mobile').click();
    assert.equal(browser.nodes['wallet-disconnect'].hidden, true);
    assert.equal(browser.nodes['wallet-dialog'].open, true);
    assert.doesNotMatch(browser.nodes['wallet-status'].textContent, /^Connected:/);
    assert.equal(config.input, undefined);
  }
});

test('executor loader verifies bytes, rejects tampering and ignores the shared cached executor', async () => {
  const wallet = WALLET_MANIFEST.wallets.find(entry => entry.id === 'intear-wallet');
  const good = fs.readFileSync(new URL('../web/intear-wallet.executor.js', import.meta.url));
  let request;
  const fetch = async (url, options) => {
    request = { url, options };
    return new Response(good, { status: 200, headers: { 'content-length': String(good.length) } });
  };
  const context = { fetch, crypto: webcrypto, location: { origin: 'https://bouncer-near.vercel.app' } };
  assert.equal(await loadVerifiedExecutor(wallet, context), good.toString('utf8'));
  assert.equal(request.url, 'https://bouncer-near.vercel.app/intear-wallet.executor.js');
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.redirect, 'error');
  await assert.rejects(loadVerifiedExecutor(wallet, { ...context, fetch: async () => new Response('malicious cached code') }), /integrity check failed/);
  await assert.rejects(loadVerifiedExecutor(wallet, { ...context, fetch: async () => new Response('x', { headers: { 'content-length': '5000000' } }) }), /too large/);
  await assert.rejects(loadVerifiedExecutor({ ...wallet, executor: 'https://evil.example/executor.js' }, context), /Unapproved/);
  await assert.rejects(loadVerifiedExecutor(wallet, { ...context, fetch: async () => { throw new Error('offline'); } }), /offline/);

  const browser = fakeBrowser('https://bouncer-near.vercel.app/', { approved: 'https://bouncer-near.vercel.app' }), config = {};
  browser.win.fetch = fetch;
  await initWallet({ window: browser.win, document: browser.doc, NearConnector: connectorClass(config) });
  const protectedWallet = config.instance.wallets.find(entry => entry.manifest.id === 'intear-wallet');
  config.instance.db.getItem = async () => 'malicious cached code';
  assert.equal(await protectedWallet.executor.loadCode(), good.toString('utf8'), 'custom loader never asks the connector cache');
  browser.win.fetch = async () => new Response('malicious cached code');
  await assert.rejects(protectedWallet.executor.loadCode(), /integrity check failed/);
});

test('Intear fails clearly on browsers without native Ed25519 support', async () => {
  const browser = fakeBrowser('http://127.0.0.1:4173/'), config = {};
  browser.win.crypto = { subtle: { generateKey: async () => { throw new Error('unsupported algorithm'); } } };
  await initWallet({ window: browser.win, document: browser.doc, NearConnector: connectorClass(config) });
  await browser.nodes['wallet-connect'].click();
  await browser.options.find(option => option.dataset.walletId === 'intear-wallet').click();
  assert.match(browser.nodes['wallet-status'].textContent, /newer browser.*Ed25519/);
  assert.equal(browser.nodes['wallet-disconnect'].hidden, true);
  assert.equal(config.input, undefined);
});

test('configured WalletConnect opens a private QR pairing and connects only the reported testnet account', async () => {
  const projectId = '1234567890abcdef1234567890abcdef';
  const uri = `wc:${'a'.repeat(64)}@2?relay-protocol=irn&symKey=${'b'.repeat(64)}`;
  const browser = fakeBrowser('http://127.0.0.1:4173/', { walletConnectProjectId: projectId });
  const config = { browser }; let resolveApproval, request, disconnected = 0, rendered = '';
  const module = {
    async renderPairingCode(canvas, value) { canvas.width = canvas.height = 240; rendered = value; },
    async connect(options) {
      request = options; await options.onUri(uri);
      return new Promise(resolve => { resolveApproval = resolve; });
    },
  };
  await initWallet({ window: browser.win, document: browser.doc, NearConnector: connectorClass(config), loadWalletConnect: async () => module });
  await new Promise(resolve => setImmediate(resolve));
  const button = browser.options.find(option => option.dataset.walletId === 'wallet-connect');
  assert.equal(button.disabled, false);
  assert.match(browser.nodes['walletconnect-caption'].textContent, /NEAR testnet/);
  await browser.nodes['wallet-connect'].click();
  const attempt = button.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(request.projectId, projectId); assert.equal(request.origin, 'http://127.0.0.1:4173');
  assert.equal(rendered, uri);
  assert.equal(browser.nodes['wallet-options'].hidden, true);
  assert.equal(browser.nodes['walletconnect-pairing'].hidden, false);
  assert.equal(browser.nodes['walletconnect-open'].attributes.href, uri);
  await browser.nodes['walletconnect-copy'].click(); assert.equal(browser.win.clipboard, uri);
  resolveApproval({ accountId: 'alice.testnet', async disconnect() { disconnected++; } });
  await attempt;
  assert.match(browser.nodes['wallet-status'].textContent, /alice\.testnet \(wallet-reported\)/);
  assert.ok(browser.openers.every(button => button.dataset.walletState === 'connected'));
  assert.ok(browser.labels.every(node => node.textContent === 'Connected'));
  assert.equal(browser.nodes['wallet-dialog'].open, false);
  assert.equal(browser.nodes['walletconnect-open'].attributes.href, undefined);
  assert.equal(config.input, undefined, 'NEAR Connect is not asked to add a key or sign');
  await browser.nodes['wallet-disconnect'].click();
  assert.equal(disconnected, 1);
  assert.match(browser.nodes['wallet-status'].textContent, /disconnected/i);
  assert.ok(browser.openers.every(button => button.dataset.walletState === 'disconnected'));
});

test('closing WalletConnect aborts an in-flight pairing and clears the QR/link', async () => {
  const browser = fakeBrowser('http://127.0.0.1:4173/', { walletConnectProjectId: '1234567890abcdef1234567890abcdef' });
  let aborted = false;
  const module = {
    async renderPairingCode(canvas) { canvas.width = canvas.height = 240; },
    async connect({ onUri, signal }) {
      await onUri(`wc:${'a'.repeat(64)}@2?relay-protocol=irn&symKey=${'b'.repeat(64)}`);
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled')); }, { once: true }));
    },
  };
  await initWallet({ window: browser.win, document: browser.doc, NearConnector: connectorClass(), loadWalletConnect: async () => module });
  await new Promise(resolve => setImmediate(resolve));
  await browser.nodes['wallet-connect'].click();
  const attempt = browser.options.find(option => option.dataset.walletId === 'wallet-connect').click();
  await new Promise(resolve => setImmediate(resolve));
  await browser.nodes['wallet-close'].click(); await attempt;
  assert.equal(aborted, true);
  assert.equal(browser.nodes['walletconnect-open'].attributes.href, undefined);
  assert.equal(browser.nodes['walletconnect-pairing'].hidden, true);
  assert.match(browser.nodes['wallet-status'].textContent, /cancelled/);
});

const nextTick = () => new Promise(resolve => setImmediate(resolve));
const fixtureUri = char => `wc:${char.repeat(64)}@2?relay-protocol=irn&symKey=${'b'.repeat(64)}`;

test('a stalled WalletConnect download displays an actionable error and retry succeeds', async () => {
  const browser = fakeBrowser('http://127.0.0.1:4173/', { walletConnectProjectId: '1234567890abcdef1234567890abcdef' });
  let loads = 0, resolveOld, resolveApproval, oldConnects = 0;
  const oldBundle = new Promise(resolve => { resolveOld = resolve; });
  const module = {
    async renderPairingCode(canvas) { canvas.width = canvas.height = 240; },
    async connect({ onUri }) {
      await onUri(fixtureUri('a'));
      return new Promise(resolve => { resolveApproval = resolve; });
    },
  };
  await initWallet({ window: browser.win, document: browser.doc, NearConnector: connectorClass(),
    walletConnectStartTimeoutMs: 30, loadWalletConnect: () => ++loads === 1 ? oldBundle : Promise.resolve(module) });
  await nextTick();
  await browser.nodes['wallet-connect'].click();
  const firstAttempt = browser.options.find(option => option.dataset.walletId === 'wallet-connect').click();
  await nextTick();
  assert.equal(browser.nodes['walletconnect-loading'].hidden, false);
  assert.equal(browser.nodes['walletconnect-qr'].hidden, true, 'no pretend QR is shown');
  await firstAttempt;
  assert.equal(browser.nodes['walletconnect-pairing'].hidden, false);
  assert.equal(browser.nodes['walletconnect-error'].hidden, false);
  assert.equal(browser.nodes['walletconnect-retry'].hidden, false);
  assert.match(browser.nodes['walletconnect-error-detail'].textContent, /connection.*retry/i);
  assert.equal(browser.nodes['walletconnect-open'].attributes.href, undefined);
  assert.equal(browser.nodes['walletconnect-retry'].focused, true);
  const retry = browser.nodes['walletconnect-retry'].click();
  await nextTick();
  assert.equal(browser.nodes['walletconnect-qr'].hidden, false);
  assert.equal(browser.nodes['walletconnect-error'].hidden, true);
  assert.equal(browser.nodes['walletconnect-open'].attributes.href, fixtureUri('a'));
  resolveOld({ async connect() { oldConnects++; } });
  await nextTick(); assert.equal(oldConnects, 0, 'a late download cannot start an abandoned pairing');
  resolveApproval({ accountId: 'alice.testnet', async disconnect() {} });
  await retry;
  assert.match(browser.nodes['wallet-status'].textContent, /Connected: alice\.testnet/);
});

test('a stalled relay is bounded and a late approved session is disconnected', async () => {
  const browser = fakeBrowser('http://127.0.0.1:4173/', { walletConnectProjectId: '1234567890abcdef1234567890abcdef' });
  let request, resolveLate, disconnects = 0;
  const module = { async renderPairingCode() {}, connect(options) { request = options; return new Promise(resolve => { resolveLate = resolve; }); } };
  await initWallet({ window: browser.win, document: browser.doc, NearConnector: connectorClass(),
    walletConnectStartTimeoutMs: 25, loadWalletConnect: async () => module });
  await nextTick(); await browser.nodes['wallet-connect'].click();
  await browser.options.find(option => option.dataset.walletId === 'wallet-connect').click();
  assert.equal(request.signal.aborted, true);
  assert.equal(browser.nodes['walletconnect-error'].hidden, false);
  assert.equal(browser.nodes['walletconnect-qr'].hidden, true);
  resolveLate({ accountId: 'late.testnet', async disconnect() { disconnects++; } });
  await nextTick(); await nextTick();
  assert.equal(disconnects, 1, 'late approval must not leave an active session');
  assert.doesNotMatch(browser.nodes['wallet-status'].textContent, /^Connected:/);
  await browser.nodes['walletconnect-cancel'].click();
  assert.equal(browser.nodes['walletconnect-pairing'].hidden, true);
  assert.equal(browser.nodes['wallet-options'].hidden, false);
});

test('late QR rendering from an expired attempt cannot replace the retry QR', async () => {
  const browser = fakeBrowser('http://127.0.0.1:4173/', { walletConnectProjectId: '1234567890abcdef1234567890abcdef' });
  let releaseFirst, attempts = 0, releaseSecond;
  const firstRender = new Promise(resolve => { releaseFirst = resolve; });
  const module = {
    async renderPairingCode(canvas, uri) { if (uri === fixtureUri('a')) await firstRender; canvas.width = canvas.height = 240; canvas.uri = uri; },
    async connect({ onUri }) {
      const attempt = ++attempts;
      const uri = fixtureUri(attempt === 1 ? 'a' : 'c');
      await onUri(uri);
      return new Promise(resolve => { if (attempt === 2) releaseSecond = resolve; });
    },
  };
  await initWallet({ window: browser.win, document: browser.doc, NearConnector: connectorClass(),
    walletConnectStartTimeoutMs: 30, loadWalletConnect: async () => module });
  await nextTick(); await browser.nodes['wallet-connect'].click();
  const firstAttempt = browser.options.find(option => option.dataset.walletId === 'wallet-connect').click();
  await nextTick();
  assert.equal(browser.nodes['walletconnect-open'].attributes.href, fixtureUri('a'), 'a valid link is available even while QR drawing is pending');
  await browser.nodes['walletconnect-cancel'].click(); await firstAttempt;
  const retry = browser.options.find(option => option.dataset.walletId === 'wallet-connect').click();
  await nextTick();
  assert.equal(browser.nodes['walletconnect-open'].attributes.href, fixtureUri('c'));
  assert.equal(browser.nodes['walletconnect-canvas'].renderedCanvas.uri, fixtureUri('c'));
  releaseFirst(); await nextTick();
  assert.equal(browser.nodes['walletconnect-open'].attributes.href, fixtureUri('c'));
  assert.equal(browser.nodes['walletconnect-canvas'].renderedCanvas.uri, fixtureUri('c'));
  releaseSecond({ accountId: 'alice.testnet', async disconnect() {} }); await retry;
  assert.match(browser.nodes['wallet-status'].textContent, /Connected: alice\.testnet/);
});

test('a QR rendering failure preserves a valid open-or-copy pairing link', async () => {
  const browser = fakeBrowser('http://127.0.0.1:4173/', { walletConnectProjectId: '1234567890abcdef1234567890abcdef' });
  let resolveApproval;
  const module = {
    async renderPairingCode() { throw new Error('canvas unavailable'); },
    async connect({ onUri }) { await onUri(fixtureUri('a')); return new Promise(resolve => { resolveApproval = resolve; }); },
  };
  await initWallet({ window: browser.win, document: browser.doc, NearConnector: connectorClass(), loadWalletConnect: async () => module });
  await nextTick(); await browser.nodes['wallet-connect'].click();
  const attempt = browser.options.find(option => option.dataset.walletId === 'wallet-connect').click();
  await nextTick();
  assert.equal(browser.nodes['walletconnect-qr'].hidden, true);
  assert.equal(browser.nodes['walletconnect-error'].hidden, false);
  assert.match(browser.nodes['walletconnect-error-detail'].textContent, /open your wallet app or copy/i);
  assert.equal(browser.nodes['walletconnect-open'].attributes.href, fixtureUri('a'));
  assert.equal(browser.nodes['walletconnect-copy'].hidden, false);
  await browser.nodes['walletconnect-copy'].click();
  assert.equal(browser.win.clipboard, fixtureUri('a'));
  resolveApproval({ accountId: 'alice.testnet', async disconnect() {} }); await attempt;
  assert.match(browser.nodes['wallet-status'].textContent, /Connected: alice\.testnet/);
});

test('Mobile sign-in events cannot bypass the verified message-only path', async () => {
  const browser = fakeBrowser('https://bouncer-near.vercel.app/', { approved: 'https://bouncer-near.vercel.app' });
  const config = {};
  await initWallet({ window: browser.win, document: browser.doc, NearConnector: connectorClass(config) });
  const wallet = config.instance.wallets.find(item => item.manifest.id === 'near-mobile');
  config.instance.events['wallet:signIn']({ wallet, accounts: [{ accountId: 'mobile.testnet' }] });
  assert.doesNotMatch(browser.nodes['wallet-status'].textContent, /^Connected:/);
  assert.equal(browser.nodes['wallet-disconnect'].hidden, true);
  await browser.nodes['wallet-connect'].click();
  await browser.options.find(option => option.dataset.walletId === 'near-mobile').click();
  assert.match(browser.nodes['wallet-status'].textContent, /Connected: mobile\.testnet \(NEAR Mobile login verified against testnet\)/);
  assert.ok(browser.openers.every(button => button.dataset.walletState === 'connected'));
});
