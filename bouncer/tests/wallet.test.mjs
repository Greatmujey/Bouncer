import test from 'node:test';
import assert from 'node:assert/strict';
import { initWallet, walletOriginAllowed } from '../web-src/wallet-core.mjs';
import { WALLET_MANIFEST } from '../web-src/wallet-manifest.mjs';

const location = url => { const u = new URL(url); return { hostname: u.hostname, protocol: u.protocol, origin: u.origin }; };
class Element {
  constructor(dataset = {}) { this.listeners = {}; this.dataset = dataset; this.hidden = false; this.disabled = false; this.textContent = ''; this.open = false; this.attributes = {}; this.focused = false; }
  addEventListener(event, callback) { this.listeners[event] = callback; }
  setAttribute(name, value) { this.attributes[name] = value; }
  async click() { if (!this.disabled) await this.listeners.click?.({ target: this }); }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.close?.(); }
  getBoundingClientRect() { return { left: 0, right: 100, top: 0, bottom: 100 }; }
}
function fakeBrowser(url, { top = true, storageFails = false, approved = '' } = {}) {
  const ids = ['wallet-connect', 'wallet-disconnect', 'wallet-status', 'wallet-open-site', 'wallet-dialog', 'wallet-close', 'wallet-options', 'wallet-dialog-status', 'wallet-banner'];
  const nodes = Object.fromEntries(ids.map(id => [id, new Element()]));
  nodes['wallet-open-site'].hidden = true;
  const options = ['meteor-wallet', 'nightly-wallet', 'ledger'].map(walletId => new Element({ walletId }));
  const openers = [nodes['wallet-connect'], new Element(), new Element()];
  const data = new Map(), labels = [new Element(), new Element(), new Element()];
  const win = { location: { ...location(url), href: url }, localStorage: {
    getItem(key) { if (storageFails) throw new Error('storage disabled'); return data.get(key) ?? null; },
    setItem(key, value) { if (storageFails) throw new Error('storage disabled'); data.set(key, value); },
    removeItem(key) { if (storageFails) throw new Error('storage disabled'); data.delete(key); },
  } };
  win.self = {}; win.top = top ? win.self : {};
  const classes = new Set();
  const doc = { body: { classList: { add: value => classes.add(value), remove: value => classes.delete(value) } },
    querySelector(sel) { if (sel === 'meta[name="bouncer-wallet-origin"]') return { content: approved }; return nodes[sel.slice(1)]; },
    querySelectorAll(sel) { return sel === '[data-wallet-label]' ? labels : sel === '[data-wallet-id]' ? options : sel === '[data-wallet-open]' ? openers : []; } };
  return { win, doc, nodes, options, openers, data, labels, classes };
}
function connectorClass(config = {}) {
  return class FakeConnector {
    constructor(options) {
      config.options = options; config.instance = this;
      this.events = {}; this.wallets = options.manifest.wallets.map(manifest => ({ manifest }));
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

test('wallet manifests are curated testnet, no-add-key choices with immutable executor URLs', () => {
  assert.deepEqual(WALLET_MANIFEST.wallets.map(w => w.id).sort(), ['ledger', 'meteor-wallet', 'nightly-wallet']);
  for (const wallet of WALLET_MANIFEST.wallets) {
    assert.equal(wallet.features.testnet, true);
    assert.equal(wallet.features.signInWithoutAddKey, true);
    assert.match(wallet.executor, /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}\//);
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
  assert.equal(config.options.features.signInWithoutAddKey, true);
  assert.equal(config.options.autoConnect, false);
  assert.equal(browser.nodes['wallet-connect'].disabled, false);
  // An injected wallet replacing a trusted ID is filtered rather than selected.
  config.instance.wallets.unshift({ manifest: { ...WALLET_MANIFEST.wallets.find(w => w.id === 'meteor-wallet') } });
  config.instance.events['selector:walletsChanged']();
  assert.equal(config.instance.wallets.length, 3);
  await browser.nodes['wallet-connect'].click();
  assert.equal(browser.nodes['wallet-dialog'].open, true);
  assert.equal(config.input, undefined, 'opening the picker does not connect');
  assert.ok(browser.options.every(option => !option.disabled));
  await browser.options[0].click();
  assert.deepEqual(config.input, { walletId: 'meteor-wallet' });
  assert.equal(config.dialogWasOpen, false, 'wallet iframe is not blocked behind our dialog');
  assert.match(browser.nodes['wallet-status'].textContent, /Connected: alice\.testnet \(wallet-reported\)/);
  assert.equal(browser.nodes['wallet-options'].hidden, true);
  assert.equal(browser.nodes['wallet-disconnect'].hidden, false);
  assert.deepEqual(browser.labels.map(node => node.textContent), ['Account connected', 'Account connected', 'Account connected']);
  await browser.nodes['wallet-connect'].click();
  await browser.nodes['wallet-disconnect'].click();
  assert.equal(config.disconnected, 'meteor-wallet');
  assert.match(browser.nodes['wallet-status'].textContent, /disconnected/i);
  assert.deepEqual(browser.labels.map(node => node.textContent), ['Connect wallet', 'Connect wallet', 'Connect wallet']);
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
