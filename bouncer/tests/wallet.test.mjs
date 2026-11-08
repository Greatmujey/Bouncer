import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { KeyPair } from '@near-js/crypto';
import { IDBFactory } from 'fake-indexeddb';
import { nep413Payload } from '../web-src/cli-login.mjs';
import { setupAuthAction } from '../web-src/witnessed-setup-auth.mjs';
import fs from 'node:fs';
import { initWallet as bootWallet, walletOriginAllowed, nativeSetupOriginAllowed } from '../web-src/wallet-core.mjs';
import { WALLET_MANIFEST } from '../web-src/wallet-manifest.mjs';
import { encodeBase58 } from '../web-src/native-oracle-transaction.mjs';
import { DIRECT_DEPOSIT, DIRECT_VERSION, DIRECT_PROJECT, DIRECT_UUID } from '../web-src/direct-outlayer-testnet.mjs';
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
  async signAndSendTransaction(params) {
    this.config.transactionRequests ??= [];
    this.config.transactionRequests.push(params);
    if (this.config.transactionResult instanceof Error) throw this.config.transactionResult;
    return this.config.transactionResult;
  }
  async signMessage(params) {
    this.config.messageRequests ??= [];
    this.config.messageRequests.push(params);
    if (this.config.fail) throw new Error('cancelled');
    if (this.config.messageWait) await this.config.messageWait;
    if (this.config.signConnectedMessage) {
      const pair = this.config.cliKey || KeyPair.fromRandom('ed25519');
      const hash = createHash('sha256').update(nep413Payload(params)).digest();
      const publicKey = pair.getPublicKey().toString();
      return { accountId: this.config.account || 'alice.testnet', publicKey,
        signature: Buffer.from(pair.sign(hash).signature).toString('base64') };
    }
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
function fakeBrowser(url, { top = true, storageFails = false, approved = '' } = {}) {
  const ids = ['wallet-connect', 'wallet-disconnect', 'wallet-status', 'wallet-open-site', 'wallet-dialog', 'wallet-close', 'wallet-options', 'wallet-dialog-status', 'wallet-title-text', 'wallet-dialog-description', 'wallet-banner', 'wallet-safety',
    'wallet-account-entry', 'wallet-account-form', 'wallet-account-id', 'wallet-account-error', 'wallet-account-back', 'wallet-cli-verify',
    'wallet-account-view', 'wallet-account-name', 'wallet-account-badge', 'wallet-account-warning', 'wallet-account-near', 'wallet-account-usdc', 'wallet-account-balance-status', 'wallet-account-use-wallet', 'wallet-account-refresh', 'wallet-owner-verify', 'wallet-owner-status',
    'wallet-direct-outlayer-open', 'wallet-direct-outlayer-panel', 'wallet-direct-outlayer-status', 'wallet-direct-outlayer-hash',
    'wallet-direct-outlayer-result', 'wallet-direct-outlayer-review', 'wallet-direct-outlayer-send', 'wallet-direct-outlayer-check',
    'wallet-direct-outlayer-recover', 'wallet-direct-outlayer-original', 'wallet-direct-outlayer-recover-original',
    'wallet-buffer-readiness', 'wallet-buffer-readiness-status', 'wallet-buffer-setup-start', 'wallet-buffer-setup-panel',
    'wallet-buffer-setup-terms', 'wallet-buffer-setup-reserve', 'wallet-buffer-setup-approve', 'wallet-buffer-setup-status',
    'wallet-setup-recovery', 'wallet-setup-recovery-status',
    'wallet-setup-recovery-form', 'wallet-setup-original', 'wallet-setup-check-original', 'wallet-setup-record-original',
    'wallet-ethereum-info', 'wallet-ethereum-continue', 'wallet-ethereum-back'];
  const nodes = Object.fromEntries(ids.map(id => [id, new Element()]));
  nodes['wallet-open-site'].hidden = true;
  const options = ['meteor-wallet', 'nightly-wallet', 'ledger', 'near-mobile', 'intear-wallet', 'near-cli', 'ethereum-wallets'].map(walletId => new Element({ walletId }));
  const openers = [nodes['wallet-connect'], new Element(), new Element()];
  const data = new Map(), labels = [new Element(), new Element(), new Element()];
  const win = { location: { ...location(url), href: url }, crypto: webcrypto,
    fetch: async target => {
      if (String(target) === 'https://test.rpc.fastnear.com') return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 'bouncer-cli-login', result: { permission: win.cliKeyPermission || 'FullAccess' } }) };
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

test('native setup is restricted to the dedicated top-level site or its test preview', () => {
  assert.equal(nativeSetupOriginAllowed(location('https://bouncer-near.vercel.app/'), true), true);
  assert.equal(nativeSetupOriginAllowed(location('https://4173-example.e2b.app/'), true), true);
  assert.equal(nativeSetupOriginAllowed(location('https://bouncer-near.vercel.app/'), false), false);
  assert.equal(nativeSetupOriginAllowed(location('https://other.vercel.app/'), true), false);
  assert.equal(nativeSetupOriginAllowed(location('https://4174-example.e2b.app/'), true), false);
  assert.equal(nativeSetupOriginAllowed(location('http://4173-example.e2b.app/'), true), false);
  assert.equal(nativeSetupOriginAllowed(location('http://127.0.0.1:4173/'), true), false);
});

test('preview mode explains the setup gate without ruling out wallet onboarding', async () => {
  const browser = fakeBrowser('http://127.0.0.1:4173/');
  await initWallet({ window: browser.win, document: browser.doc, NearConnector: connectorClass({}) });
  assert.match(browser.nodes['wallet-status'].textContent, /Preview mode: Bouncer spending setup is read-only/i);
  assert.equal(browser.nodes['wallet-dialog-status'].textContent, browser.nodes['wallet-status'].textContent);
  assert.match(browser.nodes['wallet-status'].textContent, /Some wallets may request their own setup/i);
  assert.doesNotMatch(browser.nodes['wallet-status'].textContent, /no wallet transaction or key request is sent/i);
});

test('wallet manifests are curated testnet choices with pinned, integrity-checked executors', () => {
  assert.deepEqual(WALLET_MANIFEST.wallets.map(w => w.id).sort(), ['ethereum-wallets', 'intear-wallet', 'ledger', 'meteor-wallet', 'near-cli', 'near-mobile', 'nightly-wallet']);
  for (const wallet of WALLET_MANIFEST.wallets) {
    assert.equal(wallet.features.testnet, true);
    assert.equal(wallet.permissions?.walletConnect, undefined);
    assert.match(WALLET_EXECUTOR_SHA256[wallet.id], /^[a-f0-9]{64}$/);
    if (wallet.id === 'near-mobile') {
      assert.equal(wallet.features.signInWithoutAddKey, false, 'ordinary Mobile signIn is not safe');
      assert.equal(wallet.features.signMessage, true);
    } else assert.equal(wallet.features.signInWithoutAddKey, true);
    if (wallet.id === 'intear-wallet') assert.equal(wallet.executor, '/intear-wallet.executor.js');
    else if (wallet.id === 'ethereum-wallets') {
      assert.equal(wallet.executor, '/ethereum-wallet.executor.js');
      assert.deepEqual(wallet.permissions.allowsOpen, ['https://evm-on-near.dev/']);
      assert.equal(wallet.metadata.signPageURL, 'https://evm-on-near.dev/');
      assert.equal(wallet.features.signMessage, false);
      assert.equal(wallet.features.signInWithFunctionCallKey, false);
      assert.equal(wallet.features.mainnet, undefined);
    } else assert.match(wallet.executor, /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}\//);
  }
});

test('vendored Ethereum executor bytes match the pinned digest and its license is staged', () => {
  const bytes = fs.readFileSync(new URL('../web/ethereum-wallet.executor.js', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), WALLET_EXECUTOR_SHA256['ethereum-wallets']);
  assert.match(fs.readFileSync(new URL('../web/ethereum-wallet-NOTICE.txt', import.meta.url), 'utf8'), /MIT License/);
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
  assert.equal(config.instance.wallets.length, 7, 'even a forged object using a curated manifest is rejected');
  await browser.nodes['wallet-connect'].click();
  assert.equal(browser.nodes['wallet-dialog'].open, true);
  assert.equal(config.input, undefined, 'opening the picker does not connect');
  assert.ok(browser.options.every(option => !option.disabled));
  assert.equal(config.options.walletConnect, undefined, 'no QR relay or project ID is configured');
  await browser.options[0].click();
  assert.deepEqual(config.input, { walletId: 'meteor-wallet' });
  assert.equal(config.dialogWasOpen, false, 'wallet iframe is not blocked behind our dialog');
  assert.match(browser.nodes['wallet-status'].textContent, /Connected: alice\.testnet \(wallet-reported\)/);
  assert.equal(browser.nodes['wallet-options'].hidden, true);
  assert.equal(browser.nodes['wallet-disconnect'].hidden, false);
  assert.deepEqual(browser.labels.map(node => node.textContent), ['Connected', 'Connected', 'Connected']);
  assert.ok(browser.openers.every(button => button.dataset.walletState === 'connected'));
  assert.ok(browser.openers.every(button => button.attributes['aria-label'] === 'Connected: alice.testnet. Manage accounts'));
  assert.equal(browser.nodes['wallet-title-text'].textContent, 'Wallet connected');
  assert.match(browser.nodes['wallet-dialog-description'].textContent, /connected/);
  await browser.nodes['wallet-connect'].click();
  await browser.nodes['wallet-disconnect'].click();
  assert.equal(config.disconnected, 'meteor-wallet');
  assert.match(browser.nodes['wallet-status'].textContent, /disconnected/i);
  assert.deepEqual(browser.labels.map(node => node.textContent), ['Connect wallet', 'Connect wallet', 'Connect wallet']);
  assert.ok(browser.openers.every(button => button.dataset.walletState === 'disconnected'));
  assert.ok(browser.openers.every(button => button.attributes['aria-label'] === 'Connect wallet or Google account'));
  assert.equal(browser.nodes['wallet-title-text'].textContent, 'Connect an account');
  assert.match(browser.nodes['wallet-dialog-description'].textContent, /Google/);
});

test('direct OutLayer control is shown only for the named Meteor session on the dedicated preview', async () => {
  for (const [url, approved, account, walletId, visible] of [
    ['https://4173-example.e2b.app/', '', 'great_mujey.testnet', 'meteor-wallet', true],
    ['https://4173-example.e2b.app/', '', 'alice.testnet', 'meteor-wallet', false],
    ['https://4173-example.e2b.app/', '', 'great_mujey.testnet', 'intear-wallet', false],
    ['https://bouncer-near.vercel.app/', 'https://bouncer-near.vercel.app', 'great_mujey.testnet', 'meteor-wallet', false],
    ['http://127.0.0.1:4173/', '', 'great_mujey.testnet', 'meteor-wallet', false],
  ]) {
    const browser=fakeBrowser(url,{approved}), config={account};
    await initWallet({window:browser.win,document:browser.doc,NearConnector:connectorClass(config)});
    await browser.options.find(option=>option.dataset.walletId===walletId).click();
    assert.equal(browser.nodes['wallet-direct-outlayer-open'].hidden,!visible);
    assert.equal(browser.nodes['wallet-direct-outlayer-panel'].hidden,true);
    assert.equal(config.transactionRequests,undefined,'connecting never starts the direct transaction');
  }
});

test('direct preview review is read-only and one explicit tap invokes only the fixed wallet action', async () => {
  const browser=fakeBrowser('https://4173-example.e2b.app/'), txHash=encodeBase58(new Uint8Array(32).fill(7));
  const config={account:'great_mujey.testnet',transactionResult:{transaction:{hash:txHash},transaction_outcome:{id:txHash}}};
  browser.win.indexedDB=new IDBFactory();browser.win.navigator.storage={persist:async()=>true,persisted:async()=>true};
  const prior=browser.win.fetch, block=encodeBase58(new Uint8Array(32).fill(9));
  const source={WasmUrl:{url:`https://wasmhub.testnet.fastfs.io/fastfs.testnet/${DIRECT_VERSION}.wasm`,hash:DIRECT_VERSION,build_target:'wasm32-wasip2'}};
  browser.win.fetch=async(url,options={})=>{
    if(url!=='https://rpc.testnet.near.org')return prior(url,options);
    const q=JSON.parse(options.body);let result;
    if(q.method==='status')result={chain_id:'testnet'};
    else if(q.method==='block')result={header:{hash:block,height:123,timestamp_nanosec:String(BigInt(Date.now())*1000000n)}};
    else if(q.method==='EXPERIMENTAL_protocol_config')result={chain_id:'testnet',runtime_config:{storage_amount_per_byte:'10000000000000000000'}};
    else if(q.method==='query'){
      if(q.params.request_type==='view_account')result={block_hash:block,amount:'22000000000000000000000000',storage_usage:1024};
      else if(q.params.request_type==='view_access_key_list')result={block_hash:block,keys:[{access_key:{permission:'FullAccess'}}]};
      else {const value=q.params.method_name==='get_project'?{project_id:DIRECT_PROJECT,uuid:DIRECT_UUID,owner:'zavodil2.testnet'}:
        q.params.method_name==='get_version'?{wasm_hash:DIRECT_VERSION,source}:null;
        result={block_hash:block,result:[...Buffer.from(JSON.stringify(value))]};}
    }
    return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result}),{headers:{'content-type':'application/json'}});
  };
  await initWallet({window:browser.win,document:browser.doc,NearConnector:connectorClass(config)});
  await browser.options.find(option=>option.dataset.walletId==='meteor-wallet').click();
  await browser.nodes['wallet-direct-outlayer-open'].click();
  assert.equal(browser.nodes['wallet-direct-outlayer-panel'].hidden,false);
  assert.equal(browser.nodes['wallet-direct-outlayer-send'].hidden,false);
  assert.equal(config.transactionRequests,undefined,'checking readiness does not prompt');
  await browser.nodes['wallet-direct-outlayer-send'].click();
  for(let i=0;i<50 && !config.transactionRequests;i++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(config.transactionRequests.length,1);
  assert.equal(config.transactionRequests[0].signerId,'great_mujey.testnet');
  assert.equal(config.transactionRequests[0].receiverId,'outlayer.testnet');
  assert.equal(config.transactionRequests[0].actions[0].params.deposit,DIRECT_DEPOSIT);
  for(let i=0;i<50 && browser.nodes['wallet-direct-outlayer-hash'].hidden;i++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.match(browser.nodes['wallet-direct-outlayer-hash'].textContent,new RegExp(txHash));
  assert.equal(browser.nodes['wallet-direct-outlayer-send'].hidden,true);
  assert.equal(browser.nodes['wallet-direct-outlayer-check'].hidden,false);
  await browser.nodes['wallet-direct-outlayer-send'].click();
  assert.equal(config.transactionRequests.length,1);
});

test('connected phone-wallet accounts can verify a fresh identity message without approving spending', async () => {
  for (const id of ['meteor-wallet', 'intear-wallet', 'nightly-wallet', 'ledger']) {
    const browser = fakeBrowser('http://127.0.0.1:4173/'), config = { account: 'great_mujey.testnet', signConnectedMessage: true };
    await initWallet({ window: browser.win, document: browser.doc, NearConnector: connectorClass(config) });
    await browser.nodes['wallet-connect'].click();
    await browser.options.find(option => option.dataset.walletId === id).click();
    assert.equal(browser.nodes['wallet-owner-verify'].hidden, false);
    assert.equal(browser.nodes['wallet-account-badge'].textContent, 'CONNECTED');
    assert.equal(config.messageRequests, undefined, 'connecting alone does not sign a message');
    await browser.nodes['wallet-connect'].click();
    await browser.nodes['wallet-owner-verify'].click();
    assert.equal(config.messageRequests.length, 1);
    assert.equal(config.messageRequests[0].signerId, 'great_mujey.testnet');
    assert.equal(config.messageRequests[0].network, 'testnet');
    assert.equal(browser.nodes['wallet-account-badge'].textContent, 'OWNER VERIFIED');
    assert.match(browser.nodes['wallet-account-warning'].textContent, /does not approve transactions.*spending access/);
    assert.match(browser.nodes['wallet-owner-status'].textContent, /not spending permission/);
    assert.equal(browser.nodes['wallet-dialog'].open, true);
    await browser.nodes['wallet-disconnect'].click();
    assert.equal(browser.nodes['wallet-owner-verify'].hidden, true);
    assert.equal(browser.nodes['wallet-owner-status'].hidden, true);
    assert.equal(browser.nodes['wallet-owner-status'].textContent, '');
  }
});

test('phone recovery checks and records a matching original without submitting a transaction', async () => {
  const browser = fakeBrowser('https://4173-example.e2b.app/');
  const config = {account:'great_mujey.testnet',signConnectedMessage:true,cliKey:KeyPair.fromRandom('ed25519')};
  const ownerKey = String(config.cliKey.getPublicKey()), calls = [], stage = 'create_keyless_vault', originalHash = '7'.repeat(44);
  const identity = {owner:config.account,owner_public_key:ownerKey,operation_id:'1'.repeat(32),review_sha256:'2'.repeat(64),
    stages:['create_keyless_vault','register_vault_circle','fund_vault_circle'].map((stage_id,i)=>({stage_id,action_commitment_sha256:String(i+3).repeat(64)}))};
  const review = {owner:config.account,review_sha256:identity.review_sha256,
    vault:'vault.great_mujey.testnet',vault_wasm_sha256:'3'.repeat(64),fixed_product_price_atoms:'20000000',
    stages:identity.stages.map((stage,index)=>({id:stage.stage_id,action_commitment_sha256:stage.action_commitment_sha256,
      actions:index===0?[{type:'transfer',deposit_yocto:'6000000000000000000000000'}]
        :index===1?[{type:'function_call',deposit_yocto:'1250000000000000000000'}]
          :[{type:'function_call',args:{amount:'20000000'}}]}))};
  const originalFetch = browser.win.fetch, reply = value => new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
  browser.win.fetch = async (url, options={}) => {
    calls.push(url);
    if (url === '/api/wallet-setup/config') return reply({enabled:true,network:'testnet',owner:config.account});
    if (url === '/api/read-only/config') return reply({relay_url:'https://bouncer-testnet-readonly-relay-tau.vercel.app/api/read'});
    if (url === '/api/read-only/pending') return reply({jobs:[]});
    if (url === '/api/wallet-setup/inspect-challenge' || url === '/api/wallet-setup/original-challenge' || url === '/api/wallet-setup/reconcile-challenge') {
      const recording = url.endsWith('/original-challenge'), reconciling = url.endsWith('/reconcile-challenge');
      const context = recording ? {purpose:'record_original_hash',owner:config.account,ownerPublicKey:ownerKey,identity,stageId:stage,originalHash}
        : reconciling ? {purpose:'reconcile_setup_original',owner:config.account,ownerPublicKey:ownerKey,identity,stageId:stage,originalHash}
          : {purpose:'inspect',owner:config.account,ownerPublicKey:ownerKey};
      const action = setupAuthAction(context), what = recording ? 'Record the original transaction hash'
        : reconciling ? `Reconcile original: ${stage}` : 'Inspect the retained prompt';
      const digest = createHash('sha256').update(JSON.stringify(action)).digest('hex'), issued = Date.now(), expires = issued + 120_000;
      return reply({challenge_id:'a'.repeat(32),nonce_base64:Buffer.alloc(32,7).toString('base64'),
        recipient:browser.win.location.host,expires_at_ms:expires,
        message:`Bouncer testnet owner authentication\n${what}\nAccount: ${config.account}\nPublic key: ${ownerKey}\n` +
          `Action SHA-256: ${digest}\nSite: ${browser.win.location.origin}\nIssued: ${new Date(issued).toISOString()}\nExpires: ${new Date(expires).toISOString()}\n` +
          'This message is not a transaction and does not itself approve spending.'});
    }
    if (url === '/api/wallet-setup/inspect') return reply({status:'WITNESSED',identity,review,witnessed_records:[{event:'claim',stage_id:stage}]});
    if (url === '/api/wallet-setup/preview-original') return reply({status:'FINAL_SETUP_RECEIPT_MATCH',tx_hash:originalHash,stage_id:stage,original_recorded:false});
    if (url === '/api/wallet-setup/original') return reply({status:'ORIGINAL_RECORDED',original_hash:originalHash,stage_id:stage});
    if (url === '/api/wallet-setup/reconcile') return reply({status:'FINAL_SETUP_RECEIPT_MATCH',original_hash:originalHash,stage_id:stage});
    return originalFetch(url,options);
  };
  await initWallet({window:browser.win,document:browser.doc,NearConnector:connectorClass(config)});
  assert.equal(browser.nodes['wallet-setup-recovery'].hidden,true);
  await browser.options.find(option=>option.dataset.walletId==='meteor-wallet').click();
  await browser.nodes['wallet-owner-verify'].click();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(browser.nodes['wallet-setup-recovery'].hidden,false);
  await browser.nodes['wallet-setup-recovery'].click();
  assert.match(browser.nodes['wallet-setup-recovery-status'].textContent,/claimed.*Do not repeat.*wallet history/i);
  assert.equal(browser.nodes['wallet-setup-recovery-form'].hidden,false);
  await browser.nodes['wallet-setup-check-original'].click();
  assert.match(browser.nodes['wallet-setup-recovery-status'].textContent,/Paste the original/);
  assert.equal(config.messageRequests.length,2, 'an invalid hash never prompts');
  browser.nodes['wallet-setup-original'].value = originalHash;
  await browser.nodes['wallet-setup-check-original'].click();
  assert.match(browser.nodes['wallet-setup-recovery-status'].textContent,/matches the reviewed testnet receipt.*No payment or delivery/);
  assert.equal(browser.nodes['wallet-setup-record-original'].hidden,false);
  await browser.nodes['wallet-setup-record-original'].click();
  assert.match(browser.nodes['wallet-setup-recovery-status'].textContent,/reconciled at FINAL.*next setup stage/i);
  assert.equal(browser.nodes['wallet-buffer-setup-approve'].hidden,false);
  assert.equal(browser.nodes['wallet-setup-recovery-form'].hidden,true);
  assert.equal(browser.nodes['wallet-dialog'].open,true);
  assert.equal(config.messageRequests.length,5);
  assert.match(config.messageRequests[0].message,/does not approve a transaction/);
  assert.ok(config.messageRequests.slice(1).every(p=>/not a transaction/.test(p.message)));
  assert.ok(!calls.some(url=>/wallet-setup\/(claim|reserve|broadcast)/.test(url)));
  await browser.nodes['wallet-disconnect'].click();
  assert.equal(browser.nodes['wallet-setup-recovery'].hidden,true);
  assert.equal(browser.nodes['wallet-setup-recovery-status'].textContent,'');
});

test('Buffer setup review is backend-gated and remains read-only until the owner continues', async () => {
  const browser = fakeBrowser('https://4173-preview.e2b.app/');
  const config = { account:'great_mujey.testnet', signConnectedMessage:true, cliKey:KeyPair.fromRandom('ed25519') }, calls = [];
  const snapshot = { owner:config.account, signed:false, sent:false };
  const review = { owner:config.account, signing_or_broadcast_authorized:false, wallet_approval_obtained:false,
    fixed_product_price_atoms:'20000000', vault:'vault.great_mujey.testnet', vault_wasm_sha256:'3'.repeat(64),
    stages:[{actions:[{type:'transfer',deposit_yocto:'6000000000000000000000000'}]},
      {actions:[{type:'function_call',deposit_yocto:'1250000000000000000000'}]},
      {actions:[{type:'function_call',args:{amount:'20000000'}}]}] };
  const originalFetch = browser.win.fetch, reply = value => new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
  browser.win.fetch = async (url, options={}) => {
    calls.push([url,options.method || 'GET']);
    if (url === '/api/wallet-setup/config') return reply({enabled:true,network:'testnet',owner:config.account});
    if (url === '/api/read-only/config') return reply({relay_url:'https://bouncer-testnet-readonly-relay-tau.vercel.app/api/read'});
    if (url === '/api/read-only/owner-key') return reply({full_access:true});
    if (url === '/api/read-only/review' && options.method === 'POST') return reply({task_id:'a'.repeat(32)});
    if (url === '/api/read-only/pending') return reply({jobs:[]});
    if (url === `/api/read-only/review/${'a'.repeat(32)}`) return reply({state:'complete',snapshot,review});
    return originalFetch(url,options);
  };
  await initWallet({window:browser.win,document:browser.doc,NearConnector:connectorClass(config)});
  assert.equal(browser.nodes['wallet-buffer-setup-start'].hidden,true);
  await browser.options.find(option=>option.dataset.walletId==='meteor-wallet').click();
  await browser.nodes['wallet-owner-verify'].click();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(browser.nodes['wallet-buffer-setup-start'].hidden,false);
  await browser.nodes['wallet-buffer-setup-start'].click();
  assert.match(browser.nodes['wallet-buffer-setup-terms'].textContent,/6 NEAR.*20 test USDC into the vault, not to Buffer.*separate later payment/);
  assert.equal(browser.nodes['wallet-buffer-setup-reserve'].hidden,false);
  assert.equal(browser.nodes['wallet-buffer-setup-approve'].hidden,true);
  assert.equal(config.messageRequests.length,1,'preparing a review asks for no additional wallet message');
  assert.ok(!calls.some(([url])=>/wallet-setup\/(reserve|claim|broadcast)$/.test(url)));
});

test('NEAR Mobile owner verification targets the connected account and performs no transaction', async () => {
  const browser = fakeBrowser('http://127.0.0.1:4173/'), config = { account: 'great_mujey.testnet', signConnectedMessage: true };
  await initWallet({ window: browser.win, document: browser.doc, NearConnector: connectorClass(config) });
  await browser.options.find(option => option.dataset.walletId === 'near-mobile').click();
  assert.equal(config.messageRequests.length, 1, 'the connection uses a message only');
  await browser.nodes['wallet-owner-verify'].click();
  assert.equal(config.messageRequests.length, 2);
  assert.equal(config.messageRequests[1].signerId, 'great_mujey.testnet');
  assert.equal(config.messageRequests[1].accountId, 'great_mujey.testnet', 'pinned Mobile adapter requires its accountId option');
  assert.equal(browser.nodes['wallet-account-badge'].textContent, 'OWNER VERIFIED');
  assert.match(browser.nodes['wallet-account-warning'].textContent, /does not approve transactions.*spending access/);
});

test('a restricted key or a late wallet result cannot mark the connected account as verified', async () => {
  const browser = fakeBrowser('http://127.0.0.1:4173/'), config = { signConnectedMessage: true };
  await initWallet({ window: browser.win, document: browser.doc, NearConnector: connectorClass(config) });
  await browser.options[0].click();
  browser.win.cliKeyPermission = { FunctionCall: {} };
  await browser.nodes['wallet-owner-verify'].click();
  assert.equal(browser.nodes['wallet-account-badge'].textContent, 'CONNECTED');
  assert.match(browser.nodes['wallet-owner-status'].textContent, /not a current testnet Full Access key/);
  browser.win.cliKeyPermission = 'FullAccess';
  let release;
  config.messageWait = new Promise(resolve => { release = resolve; });
  const pending = browser.nodes['wallet-owner-verify'].click();
  config.instance.events['wallet:signOut']();
  release(); await pending;
  assert.equal(browser.nodes['wallet-account-view'].hidden, true);
  assert.equal(browser.nodes['wallet-owner-verify'].hidden, true);
  assert.equal(browser.nodes['wallet-owner-status'].textContent, '');
  assert.equal(browser.nodes['wallet-dialog'].open, false);
});

test('a connected wallet can load its own public balance without requesting a transaction', async () => {
  const browser = fakeBrowser('http://127.0.0.1:4173/'), config = { account: 'wallet-owner.testnet' };
  const calls = [], block = 'B'.repeat(44);
  browser.win.fetch = async (url, options) => {
    if (String(url) !== 'https://test.rpc.fastnear.com') throw new Error('unexpected network');
    const body = JSON.parse(options.body); calls.push(body);
    const result = body.method === 'block' ? { header: { hash: block, height: 123 } }
      : body.params.request_type === 'view_account'
        ? { block_hash: block, block_height: 123, amount: '16000000000000000000000000' }
        : { block_hash: block, block_height: 123, result: [...Buffer.from('"20000000"')] };
    return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) };
  };
  await initWallet({ window: browser.win, document: browser.doc, NearConnector: connectorClass(config) });
  await browser.nodes['wallet-connect'].click();
  await browser.options[0].click();
  assert.equal(calls.length, 0, 'connecting does not sign or automatically query balances');
  assert.equal(browser.nodes['wallet-account-view'].hidden, false);
  assert.equal(browser.nodes['wallet-account-name'].textContent, 'wallet-owner.testnet');
  assert.equal(browser.nodes['wallet-account-badge'].textContent, 'CONNECTED');
  assert.match(browser.nodes['wallet-account-warning'].textContent, /does not grant Bouncer spending access/);
  assert.equal(browser.nodes['wallet-account-use-wallet'].hidden, true);
  await browser.nodes['wallet-account-refresh'].click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.map(call => call.method === 'block' ? 'block' : call.params.request_type), ['block', 'view_account', 'call_function']);
  assert.equal(calls[1].params.account_id, 'wallet-owner.testnet');
  assert.equal(JSON.parse(Buffer.from(calls[2].params.args_base64, 'base64')).account_id, 'wallet-owner.testnet');
  assert.equal(browser.nodes['wallet-account-near'].textContent, '16');
  assert.equal(browser.nodes['wallet-account-usdc'].textContent, '20');
  assert.match(browser.nodes['wallet-account-balance-status'].textContent, /final block 123/);
  await browser.nodes['wallet-disconnect'].click();
  assert.equal(browser.nodes['wallet-account-view'].hidden, true);
  assert.equal(browser.nodes['wallet-account-name'].textContent, '');
  assert.equal(browser.nodes['wallet-account-usdc'].textContent, '—');
});

test('all four wallet-reported choices connect on testnet and disconnect independently', async () => {
  for (const id of ['meteor-wallet', 'intear-wallet', 'nightly-wallet', 'ledger']) {
    const browser = fakeBrowser('http://127.0.0.1:4173/'), config = {};
    await initWallet({ window: browser.win, document: browser.doc, NearConnector: connectorClass(config) });
    await browser.nodes['wallet-connect'].click();
    await browser.options.find(option => option.dataset.walletId === id).click();
    assert.deepEqual(config.input, { walletId: id });
    assert.equal(config.options.network, 'testnet');
    assert.match(browser.nodes['wallet-status'].textContent, /wallet-reported/);
    await browser.nodes['wallet-disconnect'].click();
    assert.equal(config.disconnected, id);
    assert.match(browser.nodes['wallet-status'].textContent, /disconnected/i);
  }
});

test('Ethereum wallet requires setup disclosure, accepts only an 0x account and never treats its name as a vault', async () => {
  const browser = fakeBrowser('http://127.0.0.1:4173/'), config = { account: `0x${'a'.repeat(40)}` };
  await initWallet({ window: browser.win, document: browser.doc, NearConnector: connectorClass(config) });
  await browser.nodes['wallet-connect'].click();
  await browser.options.find(option => option.dataset.walletId === 'ethereum-wallets').click();
  assert.equal(browser.nodes['wallet-ethereum-info'].hidden, false);
  assert.equal(config.input, undefined, 'disclosure does not open the wallet or request setup');
  await browser.nodes['wallet-ethereum-continue'].click();
  assert.deepEqual(config.input, { walletId: 'ethereum-wallets' });
  assert.equal(config.options.network, 'testnet');
  assert.match(browser.nodes['wallet-status'].textContent, /wallet-reported.*No vault or spending access/);
  assert.ok(browser.openers.every(button => button.dataset.walletState === 'connected'));
  await browser.nodes['wallet-disconnect'].click();
  assert.equal(config.disconnected, 'ethereum-wallets');
  const named = fakeBrowser('http://127.0.0.1:4173/'), wrong = { account: 'alice.testnet' };
  await initWallet({ window: named.win, document: named.doc, NearConnector: connectorClass(wrong) });
  await named.options.find(option => option.dataset.walletId === 'ethereum-wallets').click();
  await named.nodes['wallet-ethereum-continue'].click();
  assert.ok(named.openers.every(button => button.dataset.walletState === 'disconnected'));
});

test('Ethereum wallet connection failure does not claim a setup transaction was unsent', async () => {
  const browser = fakeBrowser('http://127.0.0.1:4173/'), config = { fail: true };
  await initWallet({ window: browser.win, document: browser.doc, NearConnector: connectorClass(config) });
  await browser.options.find(option => option.dataset.walletId === 'ethereum-wallets').click();
  await browser.nodes['wallet-ethereum-continue'].click();
  assert.match(browser.nodes['wallet-status'].textContent, /Setup may have been submitted.*do not retry.*original transaction.*reconciled/);
  assert.doesNotMatch(browser.nodes['wallet-status'].textContent, /No transaction was sent/);
});

test('a late WalletConnect configuration cannot erase an uncertain wallet result', async () => {
  const browser = fakeBrowser('http://127.0.0.1:4173/'), config = { fail: true };
  let releaseConfig;
  const configReady = new Promise(resolve => { releaseConfig = resolve; });
  const originalFetch = browser.win.fetch;
  browser.win.fetch = async target => String(target).endsWith('/walletconnect-config.json')
    ? configReady : originalFetch(target);
  await initWallet({ window: browser.win, document: browser.doc, NearConnector: connectorClass(config) });
  await browser.options.find(option => option.dataset.walletId === 'ethereum-wallets').click();
  await browser.nodes['wallet-ethereum-continue'].click();
  const uncertain = browser.nodes['wallet-status'].textContent;
  assert.match(uncertain, /Setup may have been submitted.*do not retry/);
  releaseConfig(new Response(JSON.stringify({ projectId: 'a'.repeat(32) }), { status: 200 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(browser.nodes['wallet-status'].textContent, uncertain);
  assert.equal(browser.nodes['wallet-dialog-status'].textContent, uncertain);
});

test('typed account selects an unverified, view-only account without a CLI, signer, key or transaction', async () => {
  const browser = fakeBrowser('http://127.0.0.1:4173/'), config = {};
  const calls = [], block = 'B'.repeat(44);
  browser.win.fetch = async (url, options) => {
    if (String(url) !== 'https://test.rpc.fastnear.com') throw new Error('unexpected network');
    const body = JSON.parse(options.body); calls.push(body);
    const result = body.method === 'block' ? { header: { hash: block, height: 123 } }
      : body.params.request_type === 'view_account'
        ? { amount: '16019958035075000000000000', block_hash: block, block_height: 123 }
        : { result: [...new TextEncoder().encode('"20000000"')], block_hash: block, block_height: 123 };
    return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) };
  };
  await initWallet({ window: browser.win, document: browser.doc, NearConnector: connectorClass(config) });
  await browser.nodes['wallet-connect'].click();
  await browser.options.find(option => option.dataset.walletId === 'near-cli').click();
  assert.equal(browser.nodes['wallet-account-entry'].hidden, false);
  assert.equal(config.cliParams, undefined);
  browser.nodes['wallet-account-id'].value = 'great_mujey.testnet';
  let prevented = false;
  browser.nodes['wallet-account-form'].listeners.submit({ preventDefault() { prevented = true; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prevented, true);
  assert.equal(config.input, undefined, 'never invokes a wallet connector');
  assert.equal(config.cliParams, undefined, 'never signs a login message');
  assert.equal(browser.data.has('bouncer:near-connect:selected-wallet'), false);
  assert.ok(browser.openers.every(button => button.dataset.walletState === 'view-only'));
  assert.match(browser.nodes['wallet-status'].textContent, /unverified.*No wallet is connected/);
  assert.equal(browser.nodes['wallet-account-name'].textContent, 'great_mujey.testnet');
  assert.equal(browser.nodes['wallet-account-near'].textContent, '≈16.019958');
  assert.equal(browser.nodes['wallet-account-usdc'].textContent, '20');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(request => request.method), ['block', 'query', 'query']);
  await browser.nodes['wallet-connect'].click();
  assert.equal(browser.nodes['wallet-account-view'].hidden, false);
  await browser.nodes['wallet-disconnect'].click();
  assert.match(browser.nodes['wallet-status'].textContent, /removed/);
  assert.ok(browser.openers.every(button => button.dataset.walletState === 'disconnected'));
});

test('closing an account view aborts its public read and a late response cannot repopulate the UI', async () => {
  const browser = fakeBrowser('http://127.0.0.1:4173/');
  let respond, signal;
  browser.win.fetch = (_url, options) => {
    signal = options.signal;
    if (signal.aborted) return Promise.reject(new Error('aborted'));
    return new Promise(resolve => { respond = resolve; }); // simulate the first response ignoring abort
  };
  await initWallet({ window: browser.win, document: browser.doc, NearConnector: connectorClass() });
  await browser.options.find(option => option.dataset.walletId === 'near-cli').click();
  browser.nodes['wallet-account-id'].value = 'alice.testnet';
  browser.nodes['wallet-account-form'].listeners.submit({ preventDefault() {} });
  assert.equal(signal.aborted, false);
  await browser.nodes['wallet-account-use-wallet'].click();
  assert.equal(signal.aborted, true);
  respond({ ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 'bouncer-final-block',
    result: { header: { hash: 'B'.repeat(44), height: 10 } } }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(browser.nodes['wallet-account-name'].textContent, '');
  assert.equal(browser.nodes['wallet-account-near'].textContent, '—');
  assert.equal(browser.nodes['wallet-account-usdc'].textContent, '—');
  assert.ok(browser.openers.every(button => button.dataset.walletState === 'disconnected'));
});

test('account input rejects malformed IDs but does not silently rewrite a .near name', async () => {
  const browser = fakeBrowser('http://127.0.0.1:4173/'), config = {};
  const calls = [];
  browser.win.fetch = async (url, options) => {
    if (String(url) !== 'https://test.rpc.fastnear.com') throw new Error('unexpected network');
    const body = JSON.parse(options.body); calls.push(body); const block = 'B'.repeat(44);
    const reply = body.method === 'block' ? { result: { header: { hash: block, height: 123 } } }
      : body.params.request_type === 'view_account'
        ? { error: { cause: { name: 'UNKNOWN_ACCOUNT', info: { requested_account_id: body.params.account_id, block_hash: block } } } }
        : { result: { result: [...new TextEncoder().encode('"20000000"')], block_hash: block, block_height: 123 } };
    return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, ...reply }) };
  };
  await initWallet({ window: browser.win, document: browser.doc, NearConnector: connectorClass(config) });
  await browser.nodes['wallet-connect'].click();
  await browser.options.find(option => option.dataset.walletId === 'near-cli').click();
  browser.nodes['wallet-account-id'].value = 'BAD/id';
  browser.nodes['wallet-account-form'].listeners.submit({ preventDefault() {} });
  assert.equal(browser.nodes['wallet-account-error'].hidden, false);
  assert.deepEqual(calls, []);
  browser.nodes['wallet-account-id'].value = 'great_mujey.near';
  browser.nodes['wallet-account-form'].listeners.submit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[1].params.account_id, 'great_mujey.near');
  assert.equal(browser.nodes['wallet-account-near'].textContent, '—');
  assert.equal(browser.nodes['wallet-account-usdc'].textContent, '20');
  assert.match(browser.nodes['wallet-account-balance-status'].textContent, /No native account found.*not proof of control or spendability/);
  assert.ok(browser.openers.every(button => button.dataset.walletState === 'view-only'));
  await browser.nodes['wallet-account-use-wallet'].click();
  assert.equal(browser.nodes['wallet-options'].hidden, false);
  assert.match(browser.nodes['wallet-status'].textContent, /cannot sign/);
});

test('optional CLI verification requires a fresh off-chain signature and current testnet Full Access', async () => {
  const browser = fakeBrowser('http://127.0.0.1:4173/'), config = {};
  await initWallet({ window: browser.win, document: browser.doc, NearConnector: connectorClass(config) });
  await browser.nodes['wallet-connect'].click();
  await browser.options.find(option => option.dataset.walletId === 'near-cli').click();
  assert.equal(config.cliParams, undefined, 'opening account entry does not prompt for CLI verification');
  await browser.nodes['wallet-cli-verify'].click();
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
    await browser.nodes['wallet-cli-verify'].click();
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
