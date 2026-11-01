/**
 * Small self-hosted testnet resource provider. It verifies a finalized payment
 * to a configured, trusted Bouncer deployment before fulfilling an order. This
 * is a development service, not a commercial vendor or a production payment
 * verifier. It trusts the configured RPC, Bouncer code and token contracts.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nearApi from 'near-api-js';
import { fetchPublicRepository } from './github-data.mjs';
import { normalizeOrder, orderMemo, orderMemoV2, challengeFromOrderMemo, orderMemoV3, challengeFromOrderMemoV3 } from '../packages/provider-sdk/lib/resource-order.mjs';
export { normalizeOrder, orderMemo, orderMemoV2, challengeFromOrderMemo, orderMemoV3, challengeFromOrderMemoV3 };
import { validateRpcEndpoint } from '../shared/rpc-endpoint.mjs';
import { isTestnetAccount, isTestnetToken } from '../shared/account-id.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { CLAIM_SCHEME, canonicalClaimOrigin, readAndVerifyAuthenticatedProviderPayment, readAndVerifyProviderPayment,
  verifyClaimAuthorization, verifyProviderPayment } from '../packages/provider-sdk/index.mjs';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);
const bytes = value => Buffer.byteLength(value, 'utf8');
const MAX_IN_FLIGHT_REDEMPTIONS = 8;
// 4096 bytes of input can expand to 24,576 bytes when JSON-escaped (for
// example NUL characters), plus order metadata. Keep HTTP bounded without
// rejecting otherwise valid maximally escaped normalized inputs.
const MAX_HTTP_ORDER_BYTES = 32 * 1024;
// Never evict a quote automatically: an apparently unpaid quote may already
// have an unresolved broadcast. The local prototype fails closed at capacity.
export const MAX_SELLER_QUOTES = 1024;
const RESOURCES = ['compute', 'storage', 'api'];
const CHALLENGE = /^[a-f0-9]{32}$/;
const exactKeys = (obj, keys) => plainObject(obj) && Object.keys(obj).length === keys.length && keys.every(key => Object.hasOwn(obj, key));
function validEd25519Key(value) {
  if (typeof value !== 'string' || !value.startsWith('ed25519:')) return false;
  try { const key = nearApi.utils.PublicKey.from(value); return key.keyType === 0 && key.toString() === value; }
  catch { return false; }
}
function validProduct(p) {
  return exactKeys(p, ['policy_id', 'token', 'payee', 'amount']) && typeof p.policy_id === 'string' && p.policy_id.trim() &&
    bytes(p.policy_id) <= 128 && isTestnetToken(p.token) && isTestnetAccount(p.payee) && typeof p.amount === 'string' &&
    /^[1-9][0-9]{0,38}$/.test(p.amount) && BigInt(p.amount) <= (1n << 128n) - 1n;
}
function savedMemoChallenge(resource, memo) {
  if (!RESOURCES.includes(resource) || typeof memo !== 'string') throw new Error('invalid redemption memo');
  if (new RegExp(`^bouncer-order-v1:${resource}:[a-f0-9]{64}$`).test(memo)) return null;
  const match = /^bouncer-order-v[23]:(compute|storage|api):([a-f0-9]{32}):[a-f0-9]{64}$/.exec(memo);
  if (!match || match[1] !== resource) throw new Error('invalid redemption memo');
  return match[2];
}

/** Seller-pinned order evidence; trusted RPC, Bouncer and token, not a light-client proof. */
function expectation({ txHash, contractId, ownerAccountId = contractId, product, resource, input, memo }) {
  if (!plainObject(product)) throw new Error('invalid seller product');
  if (memo !== undefined) {
    if (memo.startsWith('bouncer-order-v3:')) challengeFromOrderMemoV3(resource, input, memo);
    else challengeFromOrderMemo(resource, input, memo);
  }
  return { tx_hash: txHash, contract_id: contractId, owner_account_id: ownerAccountId, policy_id: product.policy_id,
    token: product.token, payee: product.payee, amount: product.amount, memo: memo ?? orderMemo(resource, input) };
}
export function verifyPayment(outcome, args) {
  return verifyProviderPayment(outcome, expectation(args));
}

function syncDirectory(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function ensureDirectory(dir) {
  const missing = [];
  for (let current = dir; !fs.existsSync(current); current = path.dirname(current)) {
    missing.push(current);
    if (path.dirname(current) === current) throw new Error('cannot find an existing directory ancestor');
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // fsyncing a directory does not itself persist its name in its parent.
  for (const created of missing.reverse()) syncDirectory(path.dirname(created));
}

// On a local filesystem that honours fsync/rename, a completed state transition
// survives an ordinary process/OS crash. It is not a replication guarantee.
function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    syncDirectory(path.dirname(file));
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function durableObject(file, content) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file));
}

// Never steal a lock based on PID/time: another host may be using the same
// filesystem, and a PID can be recycled. A crash leaves an explicit stale
// lock requiring an operator to confirm all writers are stopped and reconcile.
function acquireStoreLock(root) {
  const file = path.join(root, 'provider.lock');
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('provider data directory is locked; stop other writers or manually reconcile a confirmed stale lock');
    throw error;
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }) + '\n');
    fs.fsyncSync(fd);
    syncDirectory(root);
  } catch (error) {
    fs.closeSync(fd);
    try { fs.unlinkSync(file); } catch { /* fail closed if cleanup itself fails */ }
    throw error;
  }
  function check() {
    if (fd === null) throw new Error('provider store is closed');
    try {
      const held = fs.fstatSync(fd), visible = fs.lstatSync(file);
      if (!visible.isFile() || held.dev !== visible.dev || held.ino !== visible.ino) throw new Error();
    } catch { throw new Error('provider lock disappeared or changed; stop and reconcile manually'); }
  }
  function release() {
    if (fd === null) return;
    // Do not remove another process's replacement lock.
    let same = false;
    try { check(); same = true; } finally {
      const current = fd; fd = null;
      fs.closeSync(current);
    }
    if (same) { fs.unlinkSync(file); syncDirectory(root); }
  }
  return { check, release };
}

async function fulfill(resource, input, txHash, storageDir, dataFetch) {
  if (resource === 'compute') {
    let value = Buffer.from(input.text, 'utf8');
    for (let i = 0; i < input.rounds; i++) value = crypto.createHash('sha256').update(value).digest();
    return { type: 'compute', algorithm: 'sha256-iterated', rounds: input.rounds, result: value.toString('hex') };
  }
  if (resource === 'storage') {
    const objectId = digest(`${txHash}:${input.name}`);
    durableObject(path.join(storageDir, objectId), input.content);
    return { type: 'storage', object_id: objectId, sha256: digest(input.content), bytes: bytes(input.content) };
  }
  if (Object.hasOwn(input, 'repo')) return fetchPublicRepository(input.repo, dataFetch);
  const words = input.text.trim() ? input.text.trim().split(/\s+/u).length : 0;
  return { type: 'api', operation: 'text-statistics', words, bytes: bytes(input.text) };
}

/**
 * Serve one local development provider per data directory. The exclusive lock
 * prevents another process from redeeming from the same directory concurrently;
 * it is not distributed replay protection across independent directories/hosts.
 */
export function createResourceProvider({ rpcProvider, contractId, ownerAccountId = contractId, products, dataDir,
  dataFetch = globalThis.fetch, adoptLegacyState = false, sellerOrigin }) {
  if (!rpcProvider || typeof rpcProvider.viewNodeStatus !== 'function' || typeof rpcProvider.txStatusReceipts !== 'function' ||
      !isTestnetAccount(contractId) || !isTestnetAccount(ownerAccountId) || !plainObject(products) ||
      typeof dataDir !== 'string' || !dataDir || typeof adoptLegacyState !== 'boolean') throw new Error('provider configuration is invalid');
  // Independently configured identity, not the untrusted Host header. It is
  // mandatory for seller-v3 and remains fixed across journal restarts.
  if (sellerOrigin !== undefined) canonicalClaimOrigin(sellerOrigin);
  const pinnedProducts = Object.create(null);
  for (const name of RESOURCES) {
    const p = products[name];
    if (!plainObject(p)) throw new Error(`invalid ${name} product`);
    const product = { policy_id: p.policy_id, token: p.token, payee: p.payee, amount: p.amount };
    if (!validProduct(product)) throw new Error(`invalid ${name} product`);
    // Snapshot a running seller's prices rather than trusting a caller or quote.
    pinnedProducts[name] = Object.freeze(product);
  }
  Object.freeze(pinnedProducts);
  const root = path.resolve(dataDir);
  const storageDir = path.join(root, 'objects');
  ensureDirectory(root);
  const lock = acquireStoreLock(root);
  const statePath = path.join(root, 'redemptions.json');
  let redemptions = Object.create(null), quotes = Object.create(null), stateVersion = 2;
  try {
    fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });
    // Make new object-directory entries durable before any redemption.
    syncDirectory(root);
    if (fs.existsSync(statePath)) {
      const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (!plainObject(saved) || ![1, 2, 3, 4].includes(saved.version) || !plainObject(saved.redemptions) ||
          (saved.version >= 3 && (!plainObject(saved.quotes) || Object.keys(saved.quotes).length > MAX_SELLER_QUOTES)) ||
          (saved.version < 3 && Object.hasOwn(saved, 'quotes'))) throw new Error('invalid redemption state');
      if (saved.version >= 2 && (saved.contract_id !== contractId || saved.owner_account_id !== ownerAccountId || saved.network !== 'testnet')) {
        throw new Error('redemption state belongs to a different contract, owner or network');
      }
      if (saved.version === 1 && Object.keys(saved.redemptions).length && !adoptLegacyState) {
        throw new Error('legacy redemption state is not bound to an owner/contract; stop all old writers, review it and explicitly adopt it');
      }
      if (saved.version >= 3) {
        const claimed = new Set();
        for (const [challenge, quote] of Object.entries(saved.quotes)) {
          const authenticated = typeof quote?.memo === 'string' && quote.memo.startsWith('bouncer-order-v3:');
          const fields = ['resource', 'memo', 'product', 'read_only', 'tx_hash', ...(authenticated ? ['seller_origin', 'agent_public_key'] : [])];
          if (!CHALLENGE.test(challenge) || !exactKeys(quote, fields) || (authenticated && saved.version !== 4) ||
              savedMemoChallenge(quote.resource, quote.memo) !== challenge || !validProduct(quote.product) ||
              typeof quote.read_only !== 'boolean' || (quote.read_only && quote.resource !== 'api') ||
              !(quote.tx_hash === null || isTransactionHash(quote.tx_hash))) throw new Error('invalid saved seller quote');
          if (authenticated && (!sellerOrigin || quote.seller_origin !== sellerOrigin ||
              (quote.tx_hash === null ? quote.agent_public_key !== null : !validEd25519Key(quote.agent_public_key)))) {
            throw new Error('authenticated seller quote has an invalid origin or signing key');
          }
          if (quote.tx_hash !== null) {
            if (claimed.has(quote.tx_hash)) throw new Error('transaction claimed by multiple seller quotes');
            claimed.add(quote.tx_hash);
          }
        }
        quotes = Object.assign(Object.create(null), saved.quotes);
        stateVersion = saved.version;
      }
      for (const [hash, item] of Object.entries(saved.redemptions)) {
        if (!isTransactionHash(hash) || !plainObject(item) || !['pending', 'completed'].includes(item.status) ||
            (item.status === 'completed' && !plainObject(item.result))) throw new Error('invalid redemption entry');
        const challenge = savedMemoChallenge(item.resource, item.memo);
        if (challenge !== null && (saved.version < 3 || !quotes[challenge] || quotes[challenge].tx_hash !== hash ||
            quotes[challenge].resource !== item.resource || quotes[challenge].memo !== item.memo)) throw new Error('redemption does not match its seller quote');
      }
      redemptions = Object.assign(Object.create(null), saved.redemptions);
      for (const quote of Object.values(quotes)) {
        if (quote.tx_hash === null) continue;
        const entry = redemptions[quote.tx_hash];
        if ((!entry && !quote.read_only) || (entry && (entry.resource !== quote.resource || entry.memo !== quote.memo))) {
          throw new Error('seller quote claim does not match redemption state');
        }
      }
      if (saved.version === 1) atomicJson(statePath, { version: 2, network: 'testnet', contract_id: contractId,
        owner_account_id: ownerAccountId, redemptions });
    }
  } catch (error) {
    try { lock.release(); } catch { /* leave a stale lock rather than continue unsafely */ }
    throw error;
  }
  let stateFailed = false, closing = false;
  function assertStore() {
    if (stateFailed) throw new Error('provider state persistence failed; stop and reconcile manually');
    try { lock.check(); } catch (error) {
      stateFailed = true;
      throw new Error('provider state persistence failed; stop and reconcile manually', { cause: error });
    }
  }
  function persist() {
    assertStore();
    try { atomicJson(statePath, { version: stateVersion, network: 'testnet', contract_id: contractId, owner_account_id: ownerAccountId,
      redemptions, ...(stateVersion >= 3 ? { quotes } : {}) }); }
    catch (error) {
      stateFailed = true;
      throw new Error('provider state persistence failed; stop and reconcile manually', { cause: error });
    }
  }
  function quote(order) {
    if (closing) throw new Error('provider is closing');
    assertStore();
    if (!plainObject(order) || !Object.hasOwn(pinnedProducts, order.resource)) throw new Error('unknown product');
    const input = normalizeOrder(order.resource, order.input), product = pinnedProducts[order.resource];
    if (!Object.hasOwn(order, 'order_binding')) return { resource: order.resource, ...product, memo: orderMemo(order.resource, input) };
    if (!['seller-v2', 'seller-v3'].includes(order.order_binding) || !exactKeys(order, ['resource', 'input', 'order_binding'])) {
      throw new Error('unsupported or invalid order binding');
    }
    const authenticated = order.order_binding === 'seller-v3';
    if (authenticated && !sellerOrigin) throw new Error('seller-v3 requires a configured canonical seller origin');
    if (Object.keys(quotes).length >= MAX_SELLER_QUOTES) throw new Error('seller quote capacity reached; stop and reconcile existing orders');
    let challenge;
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = crypto.randomBytes(16).toString('hex');
      if (!Object.hasOwn(quotes, candidate)) { challenge = candidate; break; }
    }
    if (!challenge) throw new Error('could not allocate a unique seller challenge');
    const memo = authenticated ? orderMemoV3(order.resource, input, challenge) : orderMemoV2(order.resource, input, challenge);
    // Persist the seller-owned challenge and exact product BEFORE handing the
    // quote to a buyer. No expiry/automatic deletion: an apparently unpaid
    // order may already have a payment in an unavailable RPC.
    quotes[challenge] = { resource: order.resource, memo, product: { ...product },
      read_only: order.resource === 'api' && Object.hasOwn(input, 'repo'), tx_hash: null,
      ...(authenticated ? { seller_origin: sellerOrigin, agent_public_key: null } : {}) };
    stateVersion = Math.max(stateVersion, authenticated ? 4 : 3);
    persist();
    return { resource: order.resource, ...product, memo,
      ...(authenticated ? { seller_origin: sellerOrigin, auth_scheme: CLAIM_SCHEME } : {}) };
  }
  // Independent transactions can make progress concurrently, but a payment
  // hash has only one in-process redemption. A store lock excludes other
  // processes using this same directory. Excess work fails instead of queuing.
  const inFlight = new Map();
  function singleFlight(txHash, resource, memo, claimKey, fn) {
    if (closing) throw new Error('provider is closing');
    assertStore();
    const existing = inFlight.get(txHash);
    if (existing) {
      // An attacker with a different key must not join a legitimate caller's
      // in-flight promise and receive its authenticated result.
      if (existing.resource !== resource || existing.memo !== memo || existing.claimKey !== claimKey) throw new Error('transaction already belongs to a different order or claimant');
      return existing.promise;
    }
    if (inFlight.size >= MAX_IN_FLIGHT_REDEMPTIONS) throw new Error('provider busy: too many redemptions in flight');
    const promise = Promise.resolve().then(fn);
    const entry = { resource, memo, claimKey, promise };
    inFlight.set(txHash, entry);
    const clear = () => { if (inFlight.get(txHash) === entry) inFlight.delete(txHash); };
    promise.then(clear, clear);
    return promise;
  }
  function termsForQuote(quote, txHash) {
    return { network: 'near:testnet', contract_id: contractId, owner_account_id: ownerAccountId,
      seller_origin: quote.seller_origin, resource: quote.resource, policy_id: quote.product.policy_id,
      token: quote.product.token, payee: quote.product.payee, amount: quote.product.amount, memo: quote.memo, tx_hash: txHash };
  }
  async function redeem(order) {
    if (!plainObject(order) || !isTransactionHash(order.tx_hash)) throw new Error('invalid transaction hash');
    const { tx_hash: txHash, resource } = order;
    const input = Object.freeze(normalizeOrder(resource, order.input)), readOnlyData = resource === 'api' && Object.hasOwn(input, 'repo');
    const unique = Object.hasOwn(order, 'memo');
    const memo = unique ? order.memo : orderMemo(resource, input);
    const authenticated = unique && typeof memo === 'string' && memo.startsWith('bouncer-order-v3:');
    if (unique && !exactKeys(order, ['tx_hash', 'resource', 'input', 'memo', ...(authenticated ? ['authorization'] : [])])) {
      throw new Error('invalid seller-bound redemption');
    }
    if (!unique && Object.hasOwn(order, 'authorization')) throw new Error('legacy orders do not accept claim authorization');
    const challenge = unique ? (authenticated ? challengeFromOrderMemoV3(resource, input, memo) : challengeFromOrderMemo(resource, input, memo)) : null;
    const savedQuote = challenge === null ? null : quotes[challenge];
    if (unique && (!savedQuote || savedQuote.resource !== resource || savedQuote.memo !== memo || savedQuote.read_only !== readOnlyData)) {
      throw new Error('seller quote is missing or does not match this order');
    }
    if (savedQuote?.tx_hash !== null && savedQuote?.tx_hash !== undefined && savedQuote.tx_hash !== txHash) {
      throw new Error('seller quote already claimed by a different transaction');
    }
    const product = savedQuote?.product ?? pinnedProducts[resource];
    if (!product) throw new Error('unknown product');
    const terms = authenticated ? termsForQuote(savedQuote, txHash) : null;
    const authorization = authenticated ? structuredClone(order.authorization) : null;
    if (authenticated) {
      // Validate every request, including cached and concurrent replays. Before
      // the first claim this proves possession, then FINAL receipt verification
      // below anchors that key to the actual transaction.
      verifyClaimAuthorization(terms, authorization, authorization?.public_key);
      if (savedQuote.agent_public_key !== null && authorization.public_key !== savedQuote.agent_public_key) {
        throw new Error('claimant does not match the recorded transaction key');
      }
    }
    const claimKey = authorization?.public_key ?? null;
    return singleFlight(txHash, resource, memo, claimKey, async () => {
      assertStore();
      const prior = Object.hasOwn(redemptions, txHash) ? redemptions[txHash] : undefined;
      if (prior) {
        if (prior.memo !== memo || prior.resource !== resource || (savedQuote && savedQuote.tx_hash !== txHash) ||
            (authenticated && savedQuote.agent_public_key !== claimKey)) {
          throw new Error('transaction already belongs to a different order or claimant');
        }
        if (prior.status !== 'completed') throw new Error('redemption pending: manual reconciliation required');
        return prior.result;
      }
      const expected = expectation({ txHash, contractId, ownerAccountId, product, resource, input, ...(unique ? { memo } : {}) });
      if (authenticated) await readAndVerifyAuthenticatedProviderPayment({ provider: rpcProvider, expectation: expected, terms, authorization });
      else await readAndVerifyProviderPayment({ provider: rpcProvider, expectation: expected });
      assertStore();
      // Different hashes may finish their RPC reads concurrently. Recheck and
      // synchronously persist the quote claim with the pending redemption
      // before either can run a non-repeatable side effect.
      if (savedQuote) {
        if (savedQuote.tx_hash !== null && savedQuote.tx_hash !== txHash) throw new Error('seller quote already claimed by a different transaction');
        if (authenticated && savedQuote.agent_public_key !== null && savedQuote.agent_public_key !== claimKey) throw new Error('seller quote already belongs to a different claimant');
        savedQuote.tx_hash = txHash;
        if (authenticated) savedQuote.agent_public_key = claimKey;
      }
      // Public GitHub GETs can be repeated, but their v2 quote claim must be
      // durable even if the fetch fails before recording a completed result.
      if (!readOnlyData) redemptions[txHash] = { status: 'pending', resource, memo };
      if (!readOnlyData || savedQuote) persist();
      let result;
      try { result = await fulfill(resource, input, txHash, storageDir, dataFetch); }
      catch (error) {
        // A failed/partially synced object write is ambiguous. Keep the
        // pending record and stop this instance instead of serving more work.
        if (resource === 'storage') {
          stateFailed = true;
          throw new Error('provider object persistence failed; stop and reconcile manually', { cause: error });
        }
        throw error;
      }
      redemptions[txHash] = { status: 'completed', resource, memo, result };
      persist();
      return result;
    });
  }
  function storageResult(objectId) {
    const matches = Object.entries(redemptions).filter(([, item]) => item.status === 'completed' && item.resource === 'storage' && item.result?.object_id === objectId);
    return matches.length === 1 ? matches[0] : null;
  }
  function authenticatedStorage(order) {
    if (!exactKeys(order, ['tx_hash', 'object_id', 'authorization']) || !isTransactionHash(order.tx_hash) ||
        typeof order.object_id !== 'string' || !/^[a-f0-9]{64}$/.test(order.object_id)) throw new Error('invalid authenticated storage request');
    const found = storageResult(order.object_id), item = found?.[1];
    if (!found || found[0] !== order.tx_hash || !item.memo.startsWith('bouncer-order-v3:')) throw new Error('authenticated storage object not found');
    const challenge = savedMemoChallenge('storage', item.memo), quote = quotes[challenge];
    if (!quote || quote.tx_hash !== order.tx_hash || !validEd25519Key(quote.agent_public_key)) throw new Error('authenticated storage claim missing');
    verifyClaimAuthorization(termsForQuote(quote, order.tx_hash), order.authorization, quote.agent_public_key);
    return path.join(storageDir, order.object_id);
  }
  const server = http.createServer(async (request, response) => {
    try {
      if (closing) { response.writeHead(503).end('provider is closing'); return; }
      assertStore();
      if (request.method === 'GET' && /^\/storage\/[a-f0-9]{64}$/.test(request.url)) {
        const objectId = request.url.slice('/storage/'.length), found = storageResult(objectId);
        // Never let an unauthenticated legacy GET bypass a v3 claim, including
        // a partially created object whose completed redemption is absent.
        if (!found) { response.writeHead(404).end('not found'); return; }
        if (found[1].memo.startsWith('bouncer-order-v3:')) { response.writeHead(403).end('authenticated read required'); return; }
        const file = path.join(storageDir, objectId);
        if (!fs.existsSync(file)) { response.writeHead(404).end('not found'); return; }
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(fs.readFileSync(file));
        return;
      }
      if (request.method !== 'POST' || !['/quote', '/redeem', '/storage-read'].includes(request.url)) { response.writeHead(404).end('not found'); return; }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_HTTP_ORDER_BYTES) throw new Error('request too large');
        chunks.push(chunk);
      }
      const order = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (request.url === '/storage-read') {
        const file = authenticatedStorage(order);
        if (!fs.existsSync(file)) { response.writeHead(404).end('not found'); return; }
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(fs.readFileSync(file));
        return;
      }
      if (request.url === '/quote') {
        const offered = quote(order);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, quote: offered }));
        return;
      }
      const result = await redeem(order);
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: error.message }));
    }
  });
  let finished;
  function finishClose() {
    if (!finished) {
      closing = true;
      finished = (async () => {
        // Direct callers can have work in flight even when HTTP has stopped.
        await Promise.allSettled([...inFlight.values()].map(item => item.promise));
        lock.release();
      })();
    }
    return finished;
  }
  // Existing callers that close the HTTP server directly still release the
  // lock, but only after all outstanding redemptions have stopped.
  server.once('close', () => { finishClose().catch(error => console.error(`[resource-provider] close failed: ${error.message}`)); });
  async function close() {
    closing = true;
    if (server.listening) {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    await finishClose();
  }
  return { server, quote, redeem, close };
}


const USAGE = `Usage: node bouncer/services/resource-provider.mjs --config provider.json

Starts the development resource provider on 127.0.0.1 only, with local storage.
The config pins a testnet contract_id, optional owner_account_id (defaulting
to contract_id), three products, data_dir and port. A local exclusive lock and
fsync-backed writes protect one shared directory, not different machines or
directories. V1/v2 are unauthenticated; v3 uses a replayable bearer signature.
No TLS, general user identity or commercial hosting. Do not use real funds.
`;
export async function startConfiguredProvider(config) {
  if (!plainObject(config) || !isTestnetAccount(config.contract_id) ||
      (config.owner_account_id !== undefined && !isTestnetAccount(config.owner_account_id)) ||
      (config.adopt_legacy_state !== undefined && typeof config.adopt_legacy_state !== 'boolean') ||
      typeof config.data_dir !== 'string' || !config.data_dir || !plainObject(config.products)) {
    throw new Error('config requires testnet contract/owner IDs, data_dir and products');
  }
  for (const resource of ['compute', 'storage', 'api']) {
    const p = config.products[resource];
    if (!plainObject(p) || !isTestnetToken(p.token) || !isTestnetAccount(p.payee)) throw new Error(`${resource} must use testnet token and payee accounts`);
  }
  if (config.host !== undefined && config.host !== '127.0.0.1') throw new Error('development provider only binds to 127.0.0.1');
  const port = config.port ?? 8787;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid provider port');
  const rpcProvider = new nearApi.providers.JsonRpcProvider({ url: validateRpcEndpoint(process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com') });
  if ((await rpcProvider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('provider RPC must report the NEAR testnet chain');
  const provider = createResourceProvider({ rpcProvider, contractId: config.contract_id,
    ownerAccountId: config.owner_account_id ?? config.contract_id, products: config.products, dataDir: config.data_dir,
    adoptLegacyState: config.adopt_legacy_state === true, sellerOrigin: config.seller_origin });
  try {
    await new Promise((resolve, reject) => {
      provider.server.once('error', reject);
      provider.server.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) { await provider.close(); throw error; }
  return { ...provider, url: `http://127.0.0.1:${provider.server.address().port}` };
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(USAGE); return; }
  if (args.length !== 2 || args[0] !== '--config') throw new Error('provide --config FILE or --help');
  const config = JSON.parse(fs.readFileSync(args[1], 'utf8'));
  const provider = await startConfiguredProvider(config);
  console.log(`[resource-provider] Listening on ${provider.url} (development only)`);
  const shutdown = async () => {
    try { await provider.close(); }
    catch (error) { console.error(`[resource-provider] shutdown: ${error.message}`); process.exitCode = 1; }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`[resource-provider] ERROR: ${error.message}`); process.exitCode = 1; });
}
