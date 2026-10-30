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
import { fetchPublicRepository, normalizeRepository } from './github-data.mjs';
import { validateRpcEndpoint } from '../shared/rpc-endpoint.mjs';
import { isTestnetAccount, isTestnetToken } from '../shared/account-id.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { readAndVerifyProviderPayment, verifyProviderPayment } from '../packages/provider-sdk/index.mjs';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);
const bytes = value => Buffer.byteLength(value, 'utf8');
const MAX_IN_FLIGHT_REDEMPTIONS = 8;

/** Validate and normalize input so the on-chain memo binds the exact order. */
export function normalizeOrder(resource, input) {
  if (!plainObject(input)) throw new Error('resource input must be an object');
  if (resource === 'compute') {
    if (typeof input.text !== 'string' || bytes(input.text) > 1024 || !Number.isInteger(input.rounds) || input.rounds < 1 || input.rounds > 20_000 || Object.keys(input).length !== 2) {
      throw new Error('compute needs text (max 1024 bytes) and rounds (1-20000)');
    }
    return { text: input.text, rounds: input.rounds };
  }
  if (resource === 'storage') {
    if (typeof input.name !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(input.name) || typeof input.content !== 'string' || bytes(input.content) > 4096 || Object.keys(input).length !== 2) {
      throw new Error('storage needs a safe name and content (max 4096 bytes)');
    }
    return { name: input.name, content: input.content };
  }
  if (resource === 'api') {
    if (Object.keys(input).length === 1 && Object.hasOwn(input, 'repo')) return { repo: normalizeRepository(input.repo) };
    if (typeof input.text !== 'string' || bytes(input.text) > 4096 || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'text')) {
      throw new Error('api needs text (max 4096 bytes) or a public GitHub owner/repository');
    }
    return { text: input.text };
  }
  throw new Error('unsupported resource');
}

/** The memo commits to the resource and normalized payload, not just a label. */
export function orderMemo(resource, input) {
  const normalized = normalizeOrder(resource, input);
  return `bouncer-order-v1:${resource}:${digest(JSON.stringify(normalized))}`;
}

/** Seller-pinned order evidence; trusted RPC, Bouncer and token, not a light-client proof. */
function expectation({ txHash, contractId, ownerAccountId = contractId, product, resource, input }) {
  if (!plainObject(product)) throw new Error('invalid seller product');
  return { tx_hash: txHash, contract_id: contractId, owner_account_id: ownerAccountId, policy_id: product.policy_id,
    token: product.token, payee: product.payee, amount: product.amount, memo: orderMemo(resource, input) };
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
  dataFetch = globalThis.fetch, adoptLegacyState = false }) {
  if (!rpcProvider || typeof rpcProvider.viewNodeStatus !== 'function' || typeof rpcProvider.txStatusReceipts !== 'function' ||
      !isTestnetAccount(contractId) || !isTestnetAccount(ownerAccountId) || !plainObject(products) ||
      typeof dataDir !== 'string' || !dataDir || typeof adoptLegacyState !== 'boolean') throw new Error('provider configuration is invalid');
  for (const name of ['compute', 'storage', 'api']) {
    const p = products[name];
    if (!plainObject(p) || typeof p.policy_id !== 'string' || !p.policy_id.trim() || bytes(p.policy_id) > 128 ||
        !isTestnetToken(p.token) || !isTestnetAccount(p.payee) || typeof p.amount !== 'string' ||
        !/^[1-9][0-9]{0,38}$/.test(p.amount) || BigInt(p.amount) > (1n << 128n) - 1n) throw new Error(`invalid ${name} product`);
  }
  const root = path.resolve(dataDir);
  const storageDir = path.join(root, 'objects');
  ensureDirectory(root);
  const lock = acquireStoreLock(root);
  const statePath = path.join(root, 'redemptions.json');
  let redemptions = Object.create(null);
  try {
    fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });
    // Make new object-directory entries durable before any redemption.
    syncDirectory(root);
    if (fs.existsSync(statePath)) {
      const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (!plainObject(saved) || ![1, 2].includes(saved.version) || !plainObject(saved.redemptions)) throw new Error('invalid redemption state');
      if (saved.version === 2 && (saved.contract_id !== contractId || saved.owner_account_id !== ownerAccountId || saved.network !== 'testnet')) {
        throw new Error('redemption state belongs to a different contract, owner or network');
      }
      if (saved.version === 1 && Object.keys(saved.redemptions).length && !adoptLegacyState) {
        throw new Error('legacy redemption state is not bound to an owner/contract; stop all old writers, review it and explicitly adopt it');
      }
      for (const [hash, item] of Object.entries(saved.redemptions)) {
        if (!isTransactionHash(hash) || !plainObject(item) || !['pending', 'completed'].includes(item.status) ||
            !['compute', 'storage', 'api'].includes(item.resource) || typeof item.memo !== 'string' ||
            !new RegExp(`^bouncer-order-v1:${item.resource}:[a-f0-9]{64}$`).test(item.memo) ||
            (item.status === 'completed' && !plainObject(item.result))) throw new Error('invalid redemption entry');
      }
      redemptions = Object.assign(Object.create(null), saved.redemptions);
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
    try { atomicJson(statePath, { version: 2, network: 'testnet', contract_id: contractId, owner_account_id: ownerAccountId, redemptions }); }
    catch (error) {
      stateFailed = true;
      throw new Error('provider state persistence failed; stop and reconcile manually', { cause: error });
    }
  }
  // Independent transactions can make progress concurrently, but a payment
  // hash has only one in-process redemption. A store lock excludes other
  // processes using this same directory. Excess work fails instead of queuing.
  const inFlight = new Map();
  function singleFlight(txHash, resource, memo, fn) {
    if (closing) throw new Error('provider is closing');
    assertStore();
    const existing = inFlight.get(txHash);
    if (existing) {
      if (existing.resource !== resource || existing.memo !== memo) throw new Error('transaction already belongs to a different order');
      return existing.promise;
    }
    if (inFlight.size >= MAX_IN_FLIGHT_REDEMPTIONS) throw new Error('provider busy: too many redemptions in flight');
    const promise = Promise.resolve().then(fn);
    const entry = { resource, memo, promise };
    inFlight.set(txHash, entry);
    const clear = () => { if (inFlight.get(txHash) === entry) inFlight.delete(txHash); };
    promise.then(clear, clear);
    return promise;
  }
  async function redeem(order) {
    if (!plainObject(order) || !isTransactionHash(order.tx_hash)) throw new Error('invalid transaction hash');
    const { tx_hash: txHash, resource } = order;
    const input = normalizeOrder(resource, order.input);
    const memo = orderMemo(resource, input);
    const product = products[resource];
    if (!product) throw new Error('unknown product');
    return singleFlight(txHash, resource, memo, async () => {
      assertStore();
      const prior = Object.hasOwn(redemptions, txHash) ? redemptions[txHash] : undefined;
      if (prior) {
        if (prior.memo !== memo || prior.resource !== resource) throw new Error('transaction already belongs to a different order');
        if (prior.status !== 'completed') throw new Error('redemption pending: manual reconciliation required');
        return prior.result;
      }
      await readAndVerifyProviderPayment({ provider: rpcProvider,
        expectation: expectation({ txHash, contractId, ownerAccountId, product, resource, input }) });
      assertStore();
      // A public GitHub GET is read-only and safe to repeat after an outage or
      // crash; do not leave it irrecoverably pending before the GET succeeds.
      // Compute and storage keep the stricter pending-before-side-effect rule.
      const readOnlyData = resource === 'api' && Object.hasOwn(input, 'repo');
      if (!readOnlyData) {
        redemptions[txHash] = { status: 'pending', resource, memo };
        persist();
      }
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
  const server = http.createServer(async (request, response) => {
    try {
      if (closing) { response.writeHead(503).end('provider is closing'); return; }
      assertStore();
      if (request.method === 'GET' && /^\/storage\/[a-f0-9]{64}$/.test(request.url)) {
        const file = path.join(storageDir, request.url.slice('/storage/'.length));
        if (!fs.existsSync(file)) { response.writeHead(404).end('not found'); return; }
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(fs.readFileSync(file));
        return;
      }
      if (request.method !== 'POST' || !['/quote', '/redeem'].includes(request.url)) { response.writeHead(404).end('not found'); return; }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 12_000) throw new Error('request too large');
        chunks.push(chunk);
      }
      const order = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (request.url === '/quote') {
        if (!plainObject(order) || !Object.hasOwn(products, order.resource)) throw new Error('unknown product');
        const memo = orderMemo(order.resource, order.input);
        const quote = { resource: order.resource, ...products[order.resource], memo };
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, quote }));
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
  return { server, redeem, close };
}


const USAGE = `Usage: node bouncer/services/resource-provider.mjs --config provider.json

Starts the development resource provider on 127.0.0.1 only, with local storage.
The config pins a testnet contract_id, optional owner_account_id (defaulting
to contract_id), three products, data_dir and port. A local exclusive lock and
fsync-backed writes protect one shared directory, not different machines or
directories. No authentication, TLS or commercial hosting. Do not use real funds.
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
    adoptLegacyState: config.adopt_legacy_state === true });
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
