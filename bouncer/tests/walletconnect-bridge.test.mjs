import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createRelayBridge, validateRelayURL, BRIDGE_PATH, BRIDGE_ORIGIN, BRIDGE_READY, BRIDGE_ERROR, UPSTREAM_RELAY } from '../walletconnect/relay-bridge.mjs';
import { WebSocket as InjectedWebSocket, registerBridgeToken } from '../walletconnect/relay-transport.mjs';

const requireWallet = createRequire(new URL('../walletconnect/package.json', import.meta.url));
const { WebSocket, WebSocketServer } = requireWallet('ws');
const { generateKeyPair, signJWT } = requireWallet('@walletconnect/relay-auth');
const PROJECT = '1234567890abcdef1234567890abcdef';
const fixtureURL = async (aud = UPSTREAM_RELAY, timestamp) => {
  const token = await signJWT('synthetic', aud, 60, generateKeyPair(), timestamp);
  const url = new URL(UPSTREAM_RELAY);
  url.searchParams.set('auth', token); url.searchParams.set('projectId', PROJECT); url.searchParams.set('ua', 'wc-2/js-test');
  return url.toString();
};
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const closeServer = server => new Promise(resolve => server.close(() => resolve()));
const opened = socket => new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
const message = socket => new Promise((resolve, reject) => { socket.once('message', data => resolve(data.toString())); socket.once('error', reject); });
const rejectedUpgrade = (url, origin = BRIDGE_ORIGIN) => new Promise(resolve => {
  const socket = new WebSocket(url, { origin });
  socket.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); });
  socket.once('error', () => resolve(0));
  socket.once('open', () => { socket.close(); resolve(101); });
});

test('bridge validates canonical audience, issuer signature, time, path, project and query whitelist', async () => {
  const valid = await fixtureURL();
  assert.equal(await validateRelayURL(valid, PROJECT), valid);
  for (const change of [
    u => { u.hostname = 'attacker.invalid'; },
    u => { u.pathname = '/other'; },
    u => { u.hash = '#secret'; },
    u => { u.searchParams.set('projectId', '0'.repeat(32)); },
    u => { u.searchParams.append('auth', 'duplicate'); },
    u => { u.searchParams.set('symKey', 'secret'); },
    u => { u.searchParams.set('auth', (u.searchParams.get('auth') || '').slice(0, -8) + 'AAAAAAAA'); },
  ]) {
    const bad = new URL(valid); change(bad);
    await assert.rejects(validateRelayURL(bad.toString(), PROJECT), /^Error: invalid$/);
  }
  await assert.rejects(validateRelayURL(await fixtureURL('wss://attacker.invalid'), PROJECT), /^Error: invalid$/);
  await assert.rejects(validateRelayURL(await fixtureURL(UPSTREAM_RELAY, Math.floor(Date.now() / 1000) - 1000), PROJECT), /^Error: invalid$/);
  await assert.rejects(validateRelayURL(await fixtureURL(UPSTREAM_RELAY, Math.floor(Date.now() / 1000) + 1000), PROJECT), /^Error: invalid$/);
});

test('bridge rejects other origins, request paths and any token in its URL', async t => {
  const server = createRelayBridge({ projectId: PROJECT }); const port = await listen(server);
  t.after(() => closeServer(server));
  const url = `ws://127.0.0.1:${port}${BRIDGE_PATH}`;
  assert.equal(await rejectedUpgrade(url, 'https://evil.example'), 403);
  assert.equal(await rejectedUpgrade(url + '?auth=secret'), 403);
  assert.equal(await rejectedUpgrade(`ws://127.0.0.1:${port}/other`), 403);
  assert.equal(await rejectedUpgrade(url, ''), 403);
});

test('bridge forwards only encrypted relay frames to the fixed upstream after signed authentication', async t => {
  const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(resolve => upstream.once('listening', resolve));
  const upstreamPort = upstream.address().port;
  let routed = '', origin = '', frames = 0;
  upstream.on('connection', (socket, request) => { origin = request.headers.origin; socket.on('message', (data, binary) => { frames++; socket.send(data, { binary }); }); });
  const server = createRelayBridge({ projectId: PROJECT, upstreamFactory: (url, options) => {
    routed = new URL(url).origin;
    return new WebSocket(`ws://127.0.0.1:${upstreamPort}`, { origin: options.origin });
  } });
  const port = await listen(server);
  t.after(async () => { upstream.clients.forEach(socket => socket.terminate()); await closeServer(server); await closeServer(upstream); });
  const socket = new WebSocket(`ws://127.0.0.1:${port}${BRIDGE_PATH}`, { origin: BRIDGE_ORIGIN });
  await opened(socket);
  const relayURL = await fixtureURL();
  let reply = message(socket); socket.send(JSON.stringify({ type: 'connect', url: relayURL }));
  assert.equal(await reply, BRIDGE_READY);
  assert.equal(routed, UPSTREAM_RELAY); assert.equal(origin, BRIDGE_ORIGIN);
  reply = message(socket); socket.send('{"jsonrpc":"2.0","payload":"synthetic ciphertext"}');
  assert.equal(await reply, '{"jsonrpc":"2.0","payload":"synthetic ciphertext"}'); assert.equal(frames, 1);
  socket.close();
});

test('invalid or tampered authentication does not create an upstream socket', async t => {
  let connections = 0;
  const server = createRelayBridge({ projectId: PROJECT, upstreamFactory: () => { connections++; throw new Error('must not connect'); } });
  const port = await listen(server); t.after(() => closeServer(server));
  const socket = new WebSocket(`ws://127.0.0.1:${port}${BRIDGE_PATH}`, { origin: BRIDGE_ORIGIN });
  await opened(socket);
  const reply = message(socket); socket.send(JSON.stringify({ type: 'connect', url: 'wss://attacker.invalid/?auth=secret' }));
  assert.equal(await reply, `${BRIDGE_ERROR}:INVALID`); assert.equal(connections, 0);
});

test('per-instance limits refuse parallel and burst connections; handshake times out', async t => {
  const server = createRelayBridge({ projectId: PROJECT, maxPerIp: 1, maxPerMinute: 1, handshakeTimeoutMs: 80 });
  const port = await listen(server); t.after(() => closeServer(server));
  const url = `ws://127.0.0.1:${port}${BRIDGE_PATH}`;
  const first = new WebSocket(url, { origin: BRIDGE_ORIGIN }); await opened(first);
  const timeoutMessage = message(first);
  assert.equal(await rejectedUpgrade(url), 429);
  assert.equal(await timeoutMessage, `${BRIDGE_ERROR}:TIMEOUT`);
  await new Promise(resolve => first.once('close', resolve));
  assert.equal(await rejectedUpgrade(url), 429);
});

test('only a specifically registered JWT uses the bridge, and open waits for upstream readiness', async () => {
  const original = globalThis.WebSocket, oldLocation = globalThis.location;
  const sockets = [];
  class Native {
    constructor(url, protocols) { this.url = String(url); this.protocols = protocols; this.readyState = 0; this.bufferedAmount = 0; sockets.push(this); }
    send(data) { (this.sent ||= []).push(data); }
    close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
    open() { this.readyState = 1; this.onopen?.({ type: 'open' }); }
    receive(data) { this.onmessage?.({ data }); }
  }
  globalThis.WebSocket = Native; globalThis.location = new URL('https://bouncer-near.vercel.app/');
  try {
    const url = await fixtureURL(); const token = new URL(url).searchParams.get('auth');
    const direct = new InjectedWebSocket(url); assert.equal(direct.url, url);
    registerBridgeToken(token);
    const bridge = new InjectedWebSocket(url); const raw = sockets.at(-1);
    assert.equal(raw.url, 'wss://bouncer-near.vercel.app/api/wc-relay');
    assert.doesNotMatch(raw.url, /auth|symKey/);
    let open = false, received = '';
    bridge.onopen = () => { open = true; }; bridge.onmessage = event => { received = event.data; };
    raw.open(); assert.equal(open, false, 'gateway open alone is not relay open');
    assert.deepEqual(JSON.parse(raw.sent[0]), { type: 'connect', url });
    assert.throws(() => bridge.send('before ready'), /not open/);
    raw.receive(BRIDGE_READY); assert.equal(open, true); assert.equal(bridge.readyState, 1);
    bridge.send('ciphertext'); raw.receive('reply'); assert.equal(received, 'reply');
    assert.equal(new InjectedWebSocket(url).url, url, 'the registration is single-use');
    bridge.close(); assert.equal(bridge.readyState, 3);
    const cancelledURL = await fixtureURL(), controller = new AbortController();
    registerBridgeToken(new URL(cancelledURL).searchParams.get('auth'), controller.signal);
    controller.abort();
    assert.throws(() => new InjectedWebSocket(cancelledURL), /cancelled/, 'a late aborted attempt cannot open a direct socket');
  } finally { globalThis.WebSocket = original; globalThis.location = oldLocation; }
});
