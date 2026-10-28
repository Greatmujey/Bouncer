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
import { assertFinalPaymentReceipts } from '../shared/final-payment.mjs';
import { isTestnetAccount, isTestnetToken } from '../shared/account-id.mjs';

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

/**
 * Validate a FINAL NEAR tx response from a trusted RPC. This verifies the
 * Bouncer's execute arguments and receipts; it depends on trusted contract/token
 * code and is NOT a trustless or generic FT payment verifier.
 */
export function verifyPayment(outcome, { txHash, contractId, ownerAccountId = contractId, product, resource, input }) {
  const tx = outcome?.transaction;
  if (typeof ownerAccountId !== 'string' || !ownerAccountId || tx?.hash !== txHash ||
      tx.signer_id !== ownerAccountId || tx.receiver_id !== contractId) throw new Error('transaction is not from the trusted Bouncer owner and contract');
  assertFinalPaymentReceipts(outcome, product.token);
  if (!Array.isArray(tx.actions) || tx.actions.length !== 1 || !tx.actions[0].FunctionCall) throw new Error('transaction must contain exactly one function call');
  const action = tx.actions[0].FunctionCall;
  if (action.method_name !== 'execute' || String(action.deposit) !== '0' || typeof action.args !== 'string') throw new Error('transaction is not a zero-deposit execute');
  let args;
  try { args = JSON.parse(Buffer.from(action.args, 'base64').toString('utf8')); } catch { throw new Error('invalid execute arguments'); }
  if (!plainObject(args) || args.policy_id !== product.policy_id || args.expected_token !== product.token ||
      args.payee !== product.payee || args.amount !== product.amount || args.memo !== orderMemo(resource, input)) {
    throw new Error('payment does not match this order');
  }

}

function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

async function fulfill(resource, input, txHash, storageDir, dataFetch) {
  if (resource === 'compute') {
    let value = Buffer.from(input.text, 'utf8');
    for (let i = 0; i < input.rounds; i++) value = crypto.createHash('sha256').update(value).digest();
    return { type: 'compute', algorithm: 'sha256-iterated', rounds: input.rounds, result: value.toString('hex') };
  }
  if (resource === 'storage') {
    const objectId = digest(`${txHash}:${input.name}`);
    fs.writeFileSync(path.join(storageDir, objectId), input.content, { mode: 0o600, flag: 'wx' });
    return { type: 'storage', object_id: objectId, sha256: digest(input.content), bytes: bytes(input.content) };
  }
  if (Object.hasOwn(input, 'repo')) return fetchPublicRepository(input.repo, dataFetch);
  const words = input.text.trim() ? input.text.trim().split(/\s+/u).length : 0;
  return { type: 'api', operation: 'text-statistics', words, bytes: bytes(input.text) };
}

/**
 * Serve a single-process development provider. `products` pins each resource's
 * expected policy, token, payee and exact amount. Data/receipts persist locally;
 * no authentication, transport security or multi-process locking is provided.
 */
export function createResourceProvider({ rpcProvider, contractId, ownerAccountId = contractId, products, dataDir, dataFetch = globalThis.fetch }) {
  if (!rpcProvider || typeof rpcProvider.viewTransactionStatus !== 'function' || typeof contractId !== 'string' || !contractId ||
      typeof ownerAccountId !== 'string' || !ownerAccountId || !plainObject(products)) throw new Error('provider configuration is invalid');
  for (const name of ['compute', 'storage', 'api']) {
    const p = products[name];
    if (!plainObject(p) || !['policy_id', 'token', 'payee', 'amount'].every(key => typeof p[key] === 'string' && p[key]) || !/^[1-9][0-9]*$/.test(p.amount)) throw new Error(`invalid ${name} product`);
  }
  const root = path.resolve(dataDir);
  const storageDir = path.join(root, 'objects');
  fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });
  const statePath = path.join(root, 'redemptions.json');
  let redemptions = Object.create(null);
  if (fs.existsSync(statePath)) {
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!plainObject(saved) || saved.version !== 1 || !plainObject(saved.redemptions)) throw new Error('invalid redemption state');
    redemptions = Object.assign(Object.create(null), saved.redemptions);
  }
  let stateFailed = false;
  function persist() {
    if (stateFailed) throw new Error('provider state persistence failed; stop and reconcile manually');
    try { atomicJson(statePath, { version: 1, redemptions }); }
    catch (error) {
      stateFailed = true;
      throw new Error('provider state persistence failed; stop and reconcile manually', { cause: error });
    }
  }
  // Independent transactions can make progress concurrently, but a payment
  // hash has only one in-process redemption. No multi-process locking is
  // implied. Reject excess work rather than growing an unbounded queue.
  const inFlight = new Map();
  function singleFlight(txHash, resource, memo, fn) {
    if (stateFailed) throw new Error('provider state persistence failed; stop and reconcile manually');
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
    if (!plainObject(order) || typeof order.tx_hash !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(order.tx_hash)) throw new Error('invalid transaction hash');
    const { tx_hash: txHash, resource } = order;
    const input = normalizeOrder(resource, order.input);
    const memo = orderMemo(resource, input);
    const product = products[resource];
    if (!product) throw new Error('unknown product');
    return singleFlight(txHash, resource, memo, async () => {
      if (stateFailed) throw new Error('provider state persistence failed; stop and reconcile manually');
      const prior = Object.hasOwn(redemptions, txHash) ? redemptions[txHash] : undefined;
      if (prior) {
        if (prior.memo !== memo || prior.resource !== resource) throw new Error('transaction already belongs to a different order');
        if (prior.status !== 'completed') throw new Error('redemption pending: manual reconciliation required');
        return prior.result;
      }
      const outcome = await rpcProvider.viewTransactionStatus(txHash, ownerAccountId, 'FINAL');
      verifyPayment(outcome, { txHash, contractId, ownerAccountId, product, resource, input });
      // A public GitHub GET is read-only and safe to repeat after an outage or
      // crash; do not leave it irrecoverably pending before the GET succeeds.
      // Compute and storage keep the stricter pending-before-side-effect rule.
      const readOnlyData = resource === 'api' && Object.hasOwn(input, 'repo');
      if (!readOnlyData) {
        redemptions[txHash] = { status: 'pending', resource, memo };
        persist();
      }
      const result = await fulfill(resource, input, txHash, storageDir, dataFetch);
      redemptions[txHash] = { status: 'completed', resource, memo, result };
      persist();
      return result;
    });
  }
  const server = http.createServer(async (request, response) => {
    try {
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
  return { server, redeem };
}


const USAGE = `Usage: node bouncer/services/resource-provider.mjs --config provider.json

Starts the development resource provider on 127.0.0.1 only, with local storage.
The config pins a testnet contract_id, optional owner_account_id (defaulting
to contract_id), three products, data_dir and port. No authentication, TLS,
distributed replay protection or commercial hosting is provided. Do not use real funds.
`;
export async function startConfiguredProvider(config) {
  if (!plainObject(config) || !isTestnetAccount(config.contract_id) ||
      (config.owner_account_id !== undefined && !isTestnetAccount(config.owner_account_id)) ||
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
    ownerAccountId: config.owner_account_id ?? config.contract_id, products: config.products, dataDir: config.data_dir });
  await new Promise((resolve, reject) => {
    provider.server.once('error', reject);
    provider.server.listen(port, '127.0.0.1', resolve);
  });
  return { ...provider, url: `http://127.0.0.1:${provider.server.address().port}` };
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(USAGE); return; }
  if (args.length !== 2 || args[0] !== '--config') throw new Error('provide --config FILE or --help');
  const config = JSON.parse(fs.readFileSync(args[1], 'utf8'));
  const provider = await startConfiguredProvider(config);
  console.log(`[resource-provider] Listening on ${provider.url} (development only)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`[resource-provider] ERROR: ${error.message}`); process.exitCode = 1; });
}
