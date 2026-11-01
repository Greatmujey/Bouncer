/**
 * Experimental multi-worker seller-v3 reference service. Independent workers
 * coordinate through one PostgreSQL primary; no buyer key, payment broadcast,
 * automatic pending-order takeover, TLS listener or commercial hosting here.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nearApi from 'near-api-js';
import pg from 'pg';
import { fetchPublicRepository } from './github-data.mjs';
import { openPostgresSellerStore, SellerStoreError } from './postgres-seller-store.mjs';
import { CLAIM_SCHEME, normalizeOrder, orderMemoV3, challengeFromOrderMemoV3,
  readAndVerifyAuthenticatedProviderPayment, verifyClaimAuthorization } from '../packages/provider-sdk/index.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { validateRpcEndpoint } from '../shared/rpc-endpoint.mjs';

const resources = ['compute', 'storage', 'api'];
const productFields = ['policy_id', 'token', 'payee', 'amount'];
const exact = (v, keys) => v !== null && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const bytes = value => Buffer.byteLength(value, 'utf8');
const invalid = message => new SellerStoreError('INVALID', message);
const pending = () => new SellerStoreError('PENDING', 'paid order is pending; reconcile manually before any retry of work');
const MAX_BODY = 32 * 1024, MAX_IN_FLIGHT = 32;

async function fulfill(resource, input, txHash, dataFetch) {
  if (resource === 'compute') {
    let value = Buffer.from(input.text, 'utf8');
    for (let i = 0; i < input.rounds; i++) value = crypto.createHash('sha256').update(value).digest();
    return { result: { type: 'compute', algorithm: 'sha256-iterated', rounds: input.rounds, result: value.toString('hex') } };
  }
  if (resource === 'storage') {
    const objectId = digest(`${txHash}:${input.name}`);
    return { result: { type: 'storage', object_id: objectId, sha256: digest(input.content), bytes: bytes(input.content) },
      objectId, objectContent: Buffer.from(input.content, 'utf8') };
  }
  if (Object.hasOwn(input, 'repo')) return { result: await fetchPublicRepository(input.repo, dataFetch) };
  const words = input.text.trim() ? input.text.trim().split(/\s+/u).length : 0;
  return { result: { type: 'api', operation: 'text-statistics', words, bytes: bytes(input.text) } };
}

/**
 * Store and RPC are injected for tests and self-hosted operators. The store's
 * pool belongs to the caller. All calls remain testnet-only and require v3.
 */
export async function createSharedResourceProvider({ pool, rpcProvider, sellerId, contractId, ownerAccountId = contractId,
  sellerOrigin, products, maxQuotes, dataFetch = globalThis.fetch }) {
  if (!rpcProvider || typeof rpcProvider.viewNodeStatus !== 'function' || typeof rpcProvider.txStatusReceipts !== 'function' ||
      typeof dataFetch !== 'function') throw new Error('invalid shared seller RPC or data transport');
  const store = await openPostgresSellerStore({ pool, sellerId, contractId, ownerAccountId, sellerOrigin, products, maxQuotes });
  const cfg = store.config, active = new Set();
  let closing = false, activeRedemptions = 0, finished;

  function track(fn, isRedemption = false) {
    if (closing) return Promise.reject(new SellerStoreError('BUSY', 'seller is shutting down'));
    if (isRedemption && activeRedemptions >= MAX_IN_FLIGHT) return Promise.reject(new SellerStoreError('BUSY', 'seller is busy; retry the same claim later'));
    if (isRedemption) activeRedemptions++;
    const promise = Promise.resolve().then(fn);
    active.add(promise);
    promise.finally(() => { active.delete(promise); if (isRedemption) activeRedemptions--; }).catch(() => {});
    return promise;
  }
  function validateRow(row, challenge, resource, memo) {
    if (!row || row.challenge !== challenge || row.resource !== resource || row.memo !== memo ||
        !resources.includes(resource) || !exact(row.product, productFields) ||
        productFields.some(field => row.product[field] !== cfg.products[resource][field]) ||
        !['issued', 'pending', 'completed'].includes(row.status)) {
      throw invalid('unknown or mismatched seller-v3 quote');
    }
    return row;
  }
  function claimTerms(row, txHash) {
    return { network: cfg.network, contract_id: cfg.contract_id, owner_account_id: cfg.owner_account_id,
      seller_origin: cfg.seller_origin, resource: row.resource, policy_id: row.product.policy_id, token: row.product.token,
      payee: row.product.payee, amount: row.product.amount, memo: row.memo, tx_hash: txHash };
  }
  function authorize(terms, authorization, key) {
    try { verifyClaimAuthorization(terms, authorization, key); }
    catch { throw invalid('invalid claim authorization for the transaction key'); }
  }
  function settled(row, txHash, authorization) {
    if (row.tx_hash !== txHash) throw new SellerStoreError('CONFLICT', 'seller quote was already claimed by another payment');
    authorize(claimTerms(row, txHash), authorization, row.agent_public_key);
    if (row.status === 'pending') throw pending();
    if (row.status !== 'completed' || !row.result || typeof row.result !== 'object' || Array.isArray(row.result)) {
      throw new SellerStoreError('CONFLICT', 'seller state needs manual reconciliation');
    }
    return row.result;
  }

  const quote = order => track(async () => {
    if (!exact(order, ['resource', 'input', 'order_binding']) || order.order_binding !== 'seller-v3' || !resources.includes(order.resource)) {
      throw invalid('shared seller requires a seller-v3 resource order');
    }
    let input;
    try { input = normalizeOrder(order.resource, order.input); } catch { throw invalid('invalid bounded resource order'); }
    const product = cfg.products[order.resource];
    for (let attempt = 0; attempt < 4; attempt++) {
      const challenge = crypto.randomBytes(16).toString('hex'), memo = orderMemoV3(order.resource, input, challenge);
      try {
        await store.issue({ challenge, resource: order.resource, memo, product });
        return { resource: order.resource, ...product, memo, seller_origin: cfg.seller_origin, auth_scheme: CLAIM_SCHEME };
      } catch (error) {
        if (error instanceof SellerStoreError && error.code === 'CHALLENGE_COLLISION') continue;
        throw error;
      }
    }
    throw new SellerStoreError('CONFLICT', 'unable to issue a unique seller challenge');
  });

  const redeem = order => track(async () => {
    if (!exact(order, ['tx_hash', 'resource', 'input', 'memo', 'authorization']) || !isTransactionHash(order.tx_hash) ||
        !resources.includes(order.resource)) throw invalid('invalid seller-v3 redemption');
    let input, challenge;
    try { input = normalizeOrder(order.resource, order.input); challenge = challengeFromOrderMemoV3(order.resource, input, order.memo); }
    catch { throw invalid('seller-v3 quote does not bind this exact order'); }
    let row = validateRow(await store.find(challenge), challenge, order.resource, order.memo);
    const terms = claimTerms(row, order.tx_hash);
    // Reject malformed or forged signatures before consuming RPC capacity.
    authorize(terms, order.authorization, order.authorization?.public_key);
    if (row.status !== 'issued') return settled(row, order.tx_hash, order.authorization);
    const expectation = { tx_hash: order.tx_hash, contract_id: cfg.contract_id, owner_account_id: cfg.owner_account_id,
      policy_id: row.product.policy_id, token: row.product.token, payee: row.product.payee, amount: row.product.amount, memo: row.memo };
    let verified;
    try { verified = await readAndVerifyAuthenticatedProviderPayment({ provider: rpcProvider, expectation, terms, authorization: order.authorization }); }
    catch { throw invalid('FINAL payment or transaction-key claim verification failed'); }
    const executionToken = crypto.randomBytes(32).toString('hex');
    // This must return after COMMIT acknowledgment before any fulfillment. An
    // ambiguous commit returns an error; a later caller will see pending or
    // issued, never blindly execute based on this failed attempt.
    const claimed = await store.claim({ challenge, resource: order.resource, memo: order.memo, product: row.product, txHash: order.tx_hash,
      agentPublicKey: verified.agent_public_key, executionToken });
    if (!claimed) {
      row = validateRow(await store.find(challenge), challenge, order.resource, order.memo);
      return settled(row, order.tx_hash, order.authorization);
    }
    let delivery;
    try { delivery = await fulfill(order.resource, input, order.tx_hash, dataFetch); }
    catch { throw pending(); }
    // Storage bytes and result commit in one row. If this commit's reply is
    // lost the side effect is never repeated: retry reads completed or pending.
    try {
      await store.complete({ challenge, txHash: order.tx_hash, executionToken, ...delivery });
    } catch { throw pending(); }
    return delivery.result;
  }, true);

  const readStorage = order => track(async () => {
    if (!exact(order, ['tx_hash', 'object_id', 'authorization']) || !isTransactionHash(order.tx_hash) ||
        typeof order.object_id !== 'string' || !/^[a-f0-9]{64}$/.test(order.object_id)) throw invalid('invalid storage request');
    const row = await store.storage(order.tx_hash, order.object_id);
    if (!row) throw invalid('unknown authenticated storage object');
    validateRow(row, row.challenge, 'storage', row.memo);
    authorize(claimTerms(row, order.tx_hash), order.authorization, row.agent_public_key);
    if (!Buffer.isBuffer(row.object_content) || row.object_content.length > 4096 || row.result?.type !== 'storage' ||
        row.result.object_id !== order.object_id || row.result.bytes !== row.object_content.length ||
        row.result.sha256 !== digest(row.object_content)) {
      throw new SellerStoreError('CONFLICT', 'storage state needs manual reconciliation');
    }
    return row.object_content;
  });

  const server = http.createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    try {
      if (request.method !== 'POST' || !['/quote', '/redeem', '/storage-read'].includes(request.url)) {
        response.writeHead(404).end('not found'); return;
      }
      let size = 0; const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY) throw invalid('request too large');
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw invalid('invalid JSON request'); }
      if (request.url === '/storage-read') {
        const content = await readStorage(body);
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(content); return;
      }
      if (request.url === '/quote') {
        const offered = await quote(body);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, quote: offered })); return;
      }
      const result = await redeem(body);
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
    } catch (error) {
      if (response.headersSent || response.destroyed) { response.destroy(); return; }
      const known = error instanceof SellerStoreError;
      const code = known && error.code === 'INVALID' ? 400 : known && ['PENDING', 'CONFLICT'].includes(error.code) ? 409 : 503;
      // Unknown DB/RPC exceptions may contain connection details. Never send or
      // log them, authorization signatures, or storage contents over HTTP.
      const message = known ? error.message : 'seller temporarily unavailable; reconcile before retrying work';
      response.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: message }));
    }
  });
  // Upstream TLS, authentication, rate limiting and network timeouts are still
  // required; these bounds only keep a slow local client from holding a socket indefinitely.
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  async function close() {
    if (!finished) {
      closing = true;
      finished = (async () => {
        if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await Promise.allSettled([...active]);
      })();
    }
    return finished;
  }
  return { server, quote, redeem, readStorage, status: store.status, close };
}

/** Reject plaintext remote DB connections and URL parameters that override the reviewed host. */
export function validateSellerDatabaseUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 8192) throw new Error('seller database URL is required');
  let url;
  try { url = new URL(value); } catch { throw new Error('invalid seller database URL'); }
  const allowed = new Set(['sslmode', 'sslrootcert']);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname || url.pathname === '/' || url.hash ||
      [...url.searchParams.keys()].some(k => !allowed.has(k) || url.searchParams.getAll(k).length !== 1)) {
    throw new Error('invalid seller database URL');
  }
  const sslmode = url.searchParams.get('sslmode'), loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((!loopback && sslmode !== 'verify-full') || (loopback && sslmode !== null && !['disable', 'verify-full'].includes(sslmode))) {
    throw new Error('remote seller databases require TLS with sslmode=verify-full');
  }
  return value;
}

const USAGE = `Usage: node bouncer/services/shared-resource-provider.mjs --config provider.json

Testnet-only seller-v3 worker backed by one shared PostgreSQL primary.
Set BOUNCER_SELLER_DATABASE_URL in the environment, not in provider.json.
The config pins seller_id, contract_id, owner_account_id, seller_origin,
products, optional max_quotes and port. Workers bind 127.0.0.1; use a trusted
HTTPS reverse proxy. All workers must share the same database and identity.
No automatic lease takeover; pending work needs manual reconciliation.
Not audited, not an independent seller, and not for real funds.
`;
export async function startConfiguredSharedProvider(config) {
  const allowed = ['seller_id', 'contract_id', 'owner_account_id', 'seller_origin', 'products', 'max_quotes', 'port', 'host'];
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => !allowed.includes(key)) ||
      (config.host !== undefined && config.host !== '127.0.0.1')) throw new Error('invalid shared seller configuration or loopback host');
  const port = config.port ?? 8788;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid shared seller port');
  const connectionString = validateSellerDatabaseUrl(process.env.BOUNCER_SELLER_DATABASE_URL);
  let pool;
  try { pool = new pg.Pool({ connectionString, max: 8, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 }); }
  catch { throw new Error('cannot initialize verified database TLS settings'); }
  // Do not print the driver's error: it may contain endpoint credentials.
  pool.on('error', () => { console.error('[shared-resource-provider] idle database connection lost; requests fail closed'); });
  let provider;
  try {
    const rpcProvider = new nearApi.providers.JsonRpcProvider({ url: validateRpcEndpoint(process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com') });
    if ((await rpcProvider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('provider RPC must report NEAR testnet');
    provider = await createSharedResourceProvider({ pool, rpcProvider, sellerId: config.seller_id, contractId: config.contract_id,
      ownerAccountId: config.owner_account_id ?? config.contract_id, sellerOrigin: config.seller_origin,
      products: config.products, maxQuotes: config.max_quotes });
    await new Promise((resolve, reject) => { provider.server.once('error', reject); provider.server.listen(port, '127.0.0.1', resolve); });
    return { ...provider, url: `http://127.0.0.1:${provider.server.address().port}`, async close() { await provider.close(); await pool.end(); } };
  } catch (error) {
    if (provider) await provider.close();
    await pool.end();
    // Postgres and RPC errors may contain endpoint credentials. Startup output
    // deliberately does not echo arbitrary errors or connection strings.
    throw new Error('shared seller startup failed; check testnet, database, seller configuration and primary health');
  }
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(USAGE); return; }
  if (args.length !== 2 || args[0] !== '--config') throw new Error('provide --config FILE or --help');
  let config;
  try { config = JSON.parse(fs.readFileSync(args[1], 'utf8')); } catch { throw new Error('cannot read valid seller config'); }
  const provider = await startConfiguredSharedProvider(config);
  console.log(`[shared-resource-provider] Listening on ${provider.url} (testnet only)`);
  const shutdown = async () => { await provider.close(); };
  process.once('SIGINT', () => { shutdown().catch(() => { process.exitCode = 1; }); });
  process.once('SIGTERM', () => { shutdown().catch(() => { process.exitCode = 1; }); });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`[shared-resource-provider] ERROR: ${error.message}`); process.exitCode = 1; });
}
