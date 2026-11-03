import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { connectWalletConnect, createMemoryStorage, isTestnetAccount, isWalletConnectProjectId, pairingTopic, walletConnectAccount, WC_CHAIN, WC_METHOD } from '../web-src/walletconnect-core.mjs';

const PROJECT = '1234567890abcdef1234567890abcdef'; // synthetic; never contacts Reown
const PAIRING = 'a'.repeat(64), SESSION = 'b'.repeat(64);
const URI = `wc:${PAIRING}@2?relay-protocol=irn&symKey=${'c'.repeat(64)}`;
const session = (overrides = {}) => ({
  topic: SESSION, expiry: Math.floor(Date.now() / 1000) + 60,
  namespaces: { near: { accounts: ['near:testnet:alice.testnet'], methods: ['near_getAccounts'], events: [] } },
  ...overrides,
});
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fakeClient({ approval = Promise.resolve(session()), opening } = {}) {
  const client = new EventEmitter();
  const calls = { connect: [], disconnect: [], pairing: [], close: 0, stop: 0, request: 0 };
  client.connect = async input => { calls.connect.push(input); return opening ? opening.promise : { uri: URI, approval: () => approval }; };
  client.disconnect = async input => { calls.disconnect.push(input); };
  client.request = async () => { calls.request++; throw new Error('RPC requests are forbidden'); };
  client.core = { pairing: { async disconnect(input) { calls.pairing.push(input); } },
    relayer: { async transportClose() { calls.close++; } }, heartbeat: { stop() { calls.stop++; } } };
  return { client, calls };
}
function options(client, extra = {}) {
  return { projectId: PROJECT, origin: 'https://bouncer-near.vercel.app', createClient: async () => client, onUri: () => {}, ...extra };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('project identifiers and testnet account IDs are validated', () => {
  assert.equal(isWalletConnectProjectId(PROJECT), true);
  for (const invalid of ['', 'not-a-key', '0'.repeat(31), 'z'.repeat(32), 'https://x.invalid', null]) assert.equal(isWalletConnectProjectId(invalid), false);
  assert.equal(isTestnetAccount('alice.testnet'), true);
  assert.equal(isTestnetAccount('1'.repeat(64)), true);
  for (const invalid of ['alice.near', 'testnet', 'Alice.testnet', 'a..b.testnet', 'a'.repeat(65), 'near:testnet:alice.testnet']) assert.equal(isTestnetAccount(invalid), false);
});

test('WalletConnect storage is tab-memory only', async () => {
  const first = createMemoryStorage(), second = createMemoryStorage();
  await first.setItem('secret', { symKey: 'do-not-persist' });
  assert.deepEqual(await first.getKeys(), ['secret']);
  assert.deepEqual(await first.getEntries(), [['secret', { symKey: 'do-not-persist' }]]);
  assert.equal(await second.getItem('secret'), undefined);
  await first.removeItem('secret'); assert.equal(await first.getItem('secret'), undefined);
  await first.setItem('key', 'value'); first.clear(); assert.deepEqual(await first.getKeys(), []);
});

test('only valid v2 pairing URIs are exposed', () => {
  assert.equal(pairingTopic(URI), PAIRING);
  for (const invalid of ['https://evil.invalid', `wc:${PAIRING}@1?relay-protocol=irn&symKey=${'c'.repeat(64)}`, `wc:${PAIRING}@2?relay-protocol=irn&symKey=no`, `wc:${PAIRING}@2?relay-protocol=other&symKey=${'c'.repeat(64)}`]) {
    assert.throws(() => pairingTopic(invalid), /Invalid/);
  }
});

test('approved namespace must grant only NEAR testnet account display', () => {
  assert.equal(walletConnectAccount(session()), 'alice.testnet');
  assert.equal(walletConnectAccount(session({ namespaces: { 'near:testnet': { accounts: [`near:testnet:${'1'.repeat(64)}`], methods: [WC_METHOD], events: [] } } })), '1'.repeat(64));
  const invalid = [
    session({ expiry: Math.floor(Date.now() / 1000) - 1 }),
    session({ topic: 'invalid' }),
    session({ namespaces: { near: { accounts: ['near:testnet:alice.testnet'], methods: [WC_METHOD, 'near_signIn'] } } }),
    session({ namespaces: { near: { accounts: ['near:testnet:alice.testnet'], methods: [WC_METHOD, 'near_signAndSendTransaction'] } } }),
    session({ namespaces: { near: { accounts: ['near:testnet:alice.testnet'], methods: [] } } }),
    session({ namespaces: { near: { accounts: ['near:mainnet:alice.near'], methods: [WC_METHOD] } } }),
    session({ namespaces: { near: { accounts: ['near:testnet:alice.testnet', 'near:mainnet:alice.near'], methods: [WC_METHOD] } } }),
    session({ namespaces: { near: { accounts: ['near:testnet:alice.near'], methods: [WC_METHOD] } } }),
    session({ namespaces: { near: { accounts: ['near:testnet:alice.testnet'], methods: [WC_METHOD], chains: ['near:testnet', 'near:mainnet'] } } }),
    session({ namespaces: { near: { accounts: ['near:testnet:alice.testnet'], methods: [WC_METHOD] }, eip155: { accounts: ['eip155:1:0xabc'], methods: ['eth_sendTransaction'] } } }),
  ];
  for (const value of invalid) assert.throws(() => walletConnectAccount(value));
});

test('connect proposes only getAccounts, never invokes RPC, and disconnects both session and pairing', async () => {
  const { client, calls } = fakeClient(); let configuration, shown;
  const handle = await connectWalletConnect(options(client, {
    createClient: async value => { configuration = value; return client; }, onUri: value => { shown = value; },
  }));
  assert.equal(shown, URI);
  assert.equal(configuration.projectId, PROJECT);
  assert.equal(configuration.telemetryEnabled, false);
  assert.deepEqual(configuration.metadata, { name: 'Bouncer', description: 'NEAR testnet account display', url: 'https://bouncer-near.vercel.app', icons: ['https://bouncer-near.vercel.app/favicon.svg'] });
  assert.deepEqual(calls.connect, [{ requiredNamespaces: { near: { chains: [WC_CHAIN], methods: [WC_METHOD], events: [] } } }]);
  assert.equal(handle.accountId, 'alice.testnet');
  assert.equal(calls.request, 0);
  await handle.disconnect(); await handle.disconnect();
  assert.deepEqual(calls.disconnect, [{ topic: SESSION, reason: { code: 6000, message: 'User disconnected.' } }]);
  assert.deepEqual(calls.pairing, [{ topic: PAIRING }]);
  assert.equal(calls.close, 1); assert.equal(calls.stop, 1);
  assert.equal((await configuration.storage.getKeys()).length, 0);
});

test('an overprivileged approval is disconnected and never returned to the UI', async () => {
  const broad = session({ namespaces: { near: { accounts: ['near:testnet:alice.testnet'], methods: [WC_METHOD, 'near_signIn'] } } });
  const { client, calls } = fakeClient({ approval: Promise.resolve(broad) });
  await assert.rejects(connectWalletConnect(options(client)), /additional permissions/);
  assert.equal(calls.disconnect[0].topic, SESSION);
  assert.equal(calls.pairing[0].topic, PAIRING);
  assert.equal(calls.request, 0);
});

test('remote disconnect and unsafe session updates immediately clear the local session', async () => {
  for (const kind of ['delete', 'expire', 'update-permissions', 'update-account']) {
    const { client, calls } = fakeClient(); let message = '';
    await connectWalletConnect(options(client, { onEnded: value => { message = value; } }));
    if (kind === 'delete') client.emit('session_delete', { topic: SESSION });
    if (kind === 'expire') client.emit('session_expire', { topic: SESSION });
    if (kind === 'update-permissions') client.emit('session_update', { topic: SESSION, params: { namespaces: { near: { accounts: ['near:testnet:alice.testnet'], methods: [WC_METHOD, 'near_signIn'] } } } });
    if (kind === 'update-account') client.emit('session_update', { topic: SESSION, params: { namespaces: { near: { accounts: ['near:testnet:bob.testnet'], methods: [WC_METHOD] } } } });
    await tick();
    assert.match(message, /disconnect|expired|changed/i);
    assert.equal(calls.close, 1); assert.equal(calls.pairing.length, 1);
    assert.equal(calls.disconnect.length, kind.startsWith('update') ? 1 : 0);
    assert.equal(calls.request, 0);
  }
});

test('cancelled pairing is cleaned up; late approval never connects the UI', async () => {
  const approval = deferred(), abort = new AbortController(), { client, calls } = fakeClient({ approval: approval.promise });
  let shown = false;
  const pending = connectWalletConnect(options(client, { signal: abort.signal, onUri: () => { shown = true; } }));
  await tick(); assert.equal(shown, true); abort.abort();
  await assert.rejects(pending, /cancelled/);
  assert.deepEqual(calls.pairing, [{ topic: PAIRING }]); assert.equal(calls.close, 1);
  approval.resolve(session()); await tick();
  assert.equal(calls.disconnect[0].topic, SESSION); assert.equal(calls.request, 0);
});

test('cancellation while constructing a client closes a late client', async () => {
  const creating = deferred(), abort = new AbortController(), { client, calls } = fakeClient();
  const pending = connectWalletConnect(options(client, { signal: abort.signal, createClient: () => creating.promise }));
  await tick(); abort.abort(); await assert.rejects(pending, /cancelled/);
  creating.resolve(client); await tick();
  assert.equal(calls.close, 1); assert.equal(calls.stop, 1); assert.equal(calls.connect.length, 0);
});

test('invalid configuration is rejected before any client or network can start', async () => {
  let called = false;
  await assert.rejects(connectWalletConnect({ projectId: 'bad', origin: 'https://bouncer-near.vercel.app', createClient: () => { called = true; }, onUri() {} }), /project ID/);
  await assert.rejects(connectWalletConnect({ projectId: PROJECT, origin: 'http://untrusted.example', createClient: () => { called = true; }, onUri() {} }), /Invalid site origin/);
  assert.equal(called, false);
});

test('cancellation during proposal creation removes a late pairing', async () => {
  const opening = deferred(), abort = new AbortController(), { client, calls } = fakeClient({ opening });
  const pending = connectWalletConnect(options(client, { signal: abort.signal }));
  await tick(); assert.equal(calls.connect.length, 1);
  abort.abort(); await assert.rejects(pending, /cancelled/);
  opening.resolve({ uri: URI, approval: async () => session() }); await tick();
  assert.deepEqual(calls.pairing, [{ topic: PAIRING }]);
  assert.equal(calls.close, 1); assert.equal(calls.request, 0);
});

test('unchanged identity-only session updates are accepted without wallet RPC calls', async () => {
  const { client, calls } = fakeClient(); let ended = false;
  const handle = await connectWalletConnect(options(client, { onEnded: () => { ended = true; } }));
  client.emit('session_update', { topic: SESSION, params: { namespaces: session().namespaces } });
  await tick(); assert.equal(ended, false); assert.equal(calls.request, 0);
  await handle.disconnect(); assert.equal(calls.disconnect.length, 1);
});

test('approval is armed before displaying the URI so an immediate wallet response is not lost', async () => {
  const { client } = fakeClient(); let armed = false;
  client.connect = async () => ({ uri: URI, approval() { armed = true; return Promise.resolve(session()); } });
  const handle = await connectWalletConnect(options(client, { onUri() { assert.equal(armed, true); } }));
  assert.equal(handle.accountId, 'alice.testnet'); await handle.disconnect();
});
