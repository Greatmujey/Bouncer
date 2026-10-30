/**
 * Quote -> guarded payment -> fulfillment orchestration for supplied goals.
 * This runner handles supplied or separately model-proposed testnet goals.
 * The caller pins policies, tokens, payees and maximum prices; selected
 * provider routes and quotes can also be pinned. It is not a public vendor
 * marketplace, and batch preflight is a non-atomic preview.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime, FileJournal, normalizeProviderRoute, requestFingerprint, runProcurement, validatePlan } from './procurement.mjs';
import { reservePreview } from './preflight.mjs';
import { readBoundedBytes, readBoundedJson } from '../shared/bounded-json.mjs';
import { validateProviderOrigin } from '../shared/provider-origin.mjs';
import { normalizeOrder, orderMemo, startConfiguredProvider } from '../services/resource-provider.mjs';
import { checkDeliveryRecord, createDeliveryReceipt, deliveryResultHash, verifyDelivery } from './verify-delivery.mjs';

function positiveAmount(value, label) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || BigInt(value) > (1n << 128n) - 1n) throw new Error(`${label} must be a positive U128 string`);
  return BigInt(value);
}
function validText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value;
}

/** Fetch a quote for each goal and validate it against owner-pinned constraints. */
export async function planFromQuotes({ contractId, ownerAccountId, goals, getQuote, journal }) {
  if (!Array.isArray(goals) || !goals.length || typeof getQuote !== 'function') throw new Error('goals and a quote source are required');
  const requests = [];
  for (const goal of goals) {
    if (!goal || typeof goal !== 'object') throw new Error('invalid goal');
    const { id, resource, policy_id: policyId, token, payee } = goal;
    for (const [key, value] of Object.entries({ id, resource, policyId, token, payee })) validText(value, key);
    const max = positiveAmount(goal.max_amount, `${id} max_amount`);
    const selectedAmount = goal.quote_amount === undefined ? undefined : positiveAmount(goal.quote_amount, `${id} selected quote amount`);
    if (selectedAmount !== undefined && selectedAmount > max) throw new Error(`${id}: selected quote exceeds the owner-approved maximum`);
    const input = normalizeOrder(resource, goal.input);
    const memo = orderMemo(resource, input);
    const previous = journal?.get(id);
    if (previous && previous.status !== 'completed') throw new Error(`${id}: unresolved pending payment; inspect the chain and journal before retrying`);
    if (previous?.request !== undefined) {
      const raw = previous.request;
      const expectedKeys = ['id', 'resource', 'policy_id', 'token', 'payee', 'amount', 'memo'];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== expectedKeys.length ||
          Object.keys(raw).some(key => !expectedKeys.includes(key))) throw new Error(`${id}: invalid recorded payment request`);
      const request = validatePlan({ contract_id: contractId, owner_account_id: ownerAccountId, requests: [raw] }).requests[0];
      if (request.id !== id || request.resource !== resource || request.policy_id !== policyId || request.token !== token ||
          request.payee !== payee || request.memo !== memo || requestFingerprint(request) !== previous.fingerprint ||
          BigInt(request.amount) > max || (selectedAmount !== undefined && BigInt(request.amount) !== selectedAmount)) {
        throw new Error(`${id}: recorded payment does not match the reviewed goal`);
      }
      requests.push(request);
      continue;
    }
    // Legacy journals without a recorded request still require the old exact
    // quote/fingerprint check. Context never goes in the provider request body.
    const quote = await getQuote({ resource, input }, { goalId: id });
    if (!quote || quote.resource !== resource || quote.policy_id !== policyId || quote.token !== token || quote.payee !== payee) {
      throw new Error(`${id}: quote does not match the permitted resource, policy, token, or payee`);
    }
    const amount = positiveAmount(quote.amount, `${id} quote amount`);
    if (amount > max) throw new Error(`${id}: quote exceeds the owner-approved maximum`);
    if (selectedAmount !== undefined && amount !== selectedAmount) throw new Error(`${id}: selected quote changed; review and reselect before payment`);
    if (quote.memo !== memo) throw new Error(`${id}: quote is not bound to this exact order`);
    requests.push({ id, resource, policy_id: policyId, token, payee, amount: amount.toString(), memo });
  }
  return validatePlan({ contract_id: contractId, owner_account_id: ownerAccountId, requests });
}

/**
 * No payment or fulfillment unless execute is true. If an earlier payment was
 * completed but delivery failed, rerunning reuses that payment and requests the
 * same order again. The provider must implement its own replay protection.
 */
export async function runResourceAgent({ contractId, ownerAccountId, goals, getQuote, fulfill, readStorage, repositoryLookup, providerUrl, onPlan = () => {},
  beforePayment = async () => {}, provider, account, publicKey, runtimeFactory, journal, execute = false, durablePayment = false, log = console.log }) {
  if (execute && (typeof fulfill !== 'function' || typeof journal?.get !== 'function' || typeof journal?.put !== 'function')) {
    throw new Error('live execution requires a readable/writable journal and fulfillment source');
  }
  if (journal !== undefined && journal !== null && typeof journal.get !== 'function') throw new Error('invalid journal');
  if (typeof beforePayment !== 'function') throw new Error('invalid pre-payment guard');
  if (repositoryLookup !== undefined && typeof repositoryLookup !== 'function') throw new Error('invalid GitHub reference lookup');
  if (execute && Array.isArray(goals) && goals.some(goal => goal?.resource === 'storage') && typeof readStorage !== 'function') {
    throw new Error('live storage execution requires provider readback before payment');
  }
  // Receipt routing metadata is owner-supplied, never provider- or model-chosen.
  // Validate it before quotes or payments; it is a local label, not attestation.
  if (providerUrl !== undefined) {
    if (typeof providerUrl !== 'string') throw new Error('invalid default provider origin');
    httpResourceProvider(providerUrl);
  }
  const journalRoutes = new Map();
  for (const goal of Array.isArray(goals) ? goals : []) {
    if (goal?.provider_url !== undefined) {
      if (typeof goal.provider_url !== 'string') throw new Error('invalid goal provider origin');
      httpResourceProvider(goal.provider_url);
    }
    if (goal?.provider_id !== undefined && (typeof goal.provider_id !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(goal.provider_id))) {
      throw new Error('invalid goal provider id');
    }
    const route = normalizeProviderRoute({ provider_id: goal?.provider_id ?? null, provider_origin: goal?.provider_url ?? providerUrl ?? null });
    journalRoutes.set(goal?.id, route);
    const previous = journal?.get(goal?.id);
    if (previous?.provider_route !== undefined && JSON.stringify(normalizeProviderRoute(previous.provider_route)) !== JSON.stringify(route)) {
      throw new Error(`${goal.id}: recorded provider route does not match the reviewed goal`);
    }
  }
  const plan = await planFromQuotes({ contractId, ownerAccountId, goals, getQuote, journal });
  // Reject corrupted or mismatched prior receipts before paying another goal.
  for (let i = 0; i < plan.requests.length; i++) {
    const request = plan.requests[i], goal = goals[i], entry = journal?.get(request.id);
    if (entry?.status !== 'completed') continue;
    if (typeof entry.tx_hash !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(entry.tx_hash)) throw new Error(`${request.id}: invalid recorded payment hash`);
    checkDeliveryRecord({ delivery: entry.delivery, contractId, ownerAccountId, request, txHash: entry.tx_hash,
      providerId: goal.provider_id, providerOrigin: goal.provider_url ?? providerUrl, input: goal.input });
  }
  await onPlan(plan);
  if (runtimeFactory) ({ provider, account, publicKey } = await runtimeFactory(plan));
  // Complete a read-only preflight for the ENTIRE batch before the first new
  // payment, including tentative shared-budget and shared-vault reservations.
  // The views are non-atomic: the contract still decides each real payment,
  // and another actor can change state after this preview.
  const checks = [], blockedReasons = new Map();
  const preview = await runProcurement({ plan, provider, account, publicKey, journal, journalRoutes, execute: false, log: () => {}, onCheck: check => {
    checks.push({ id: check.id, status: check.status });
    if (check.status === 'BLOCKED') blockedReasons.set(check.id, typeof check.reason === 'string' ? check.reason.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200) : 'Policy rejected the request.');
  } });
  const summary = await reservePreview(provider, plan, checks, preview);
  const delivered = new Map();
  async function deliverPaid(i, required = false, expectedTx = null) {
    const goal = goals[i], request = plan.requests[i];
    if (!goal || !request) throw new Error('missing goal for confirmed payment');
    const entry = journal.get(goal.id);
    if (!entry || entry.status !== 'completed' || !entry.tx_hash) {
      if (required) throw new Error(`${goal.id}: confirmed payment is missing from the journal; stop and reconcile manually`);
      return;
    }
    if (entry.fingerprint !== requestFingerprint(request) || (expectedTx && entry.tx_hash !== expectedTx) ||
        (entry.provider_route !== undefined && JSON.stringify(normalizeProviderRoute(entry.provider_route)) !== JSON.stringify(journalRoutes.get(goal.id)))) {
      throw new Error(`${goal.id}: confirmed payment journal entry changed; stop and reconcile manually`);
    }
    const input = normalizeOrder(goal.resource, goal.input), context = { goalId: goal.id };
    let stage = 'fulfillment', verified;
    try {
      const result = await fulfill({ tx_hash: entry.tx_hash, resource: goal.resource, input }, context);
      stage = 'verification';
      verified = await verifyDelivery({ resource: goal.resource, input, result, txHash: entry.tx_hash,
        readStorage: readStorage && (objectId => readStorage(objectId, context)), repositoryLookup });
    } catch (error) {
      // Preserve a successful receipt if a later replay fails. Otherwise mark
      // only the delivery unverified: the completed payment remains final and
      // is never sent again by this journal. Do not persist untrusted errors.
      if (entry.delivery?.status !== 'verified') journal.put(goal.id, { ...entry,
        delivery: { status: 'unverified', stage, attempted_at: new Date().toISOString() } });
      const message = String(error?.message || 'delivery failed').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200);
      throw new Error(`${goal.id}: ${stage} failed after confirmed payment ${entry.tx_hash}; no automatic repayment: ${message}`, { cause: error });
    }
    const providerId = goal.provider_id, providerOrigin = goal.provider_url ?? providerUrl;
    let receipt = entry.delivery?.receipt;
    if (receipt) {
      if (receipt.result_sha256 !== deliveryResultHash(verified.result)) {
        throw new Error(`${goal.id}: replayed delivery differs from the existing receipt; reconcile manually`);
      }
    } else {
      receipt = createDeliveryReceipt({ contractId, ownerAccountId, request, txHash: entry.tx_hash,
        providerId, providerOrigin, result: verified.result, verification: verified.verification });
      journal.put(goal.id, { ...entry, delivery: { status: 'verified', receipt } });
    }
    log(`[resource-agent] FULFILLED ${goal.id} (${goal.resource}); checked ${verified.verification.scope}; receipt in journal`);
    delivered.set(goal.id, { id: goal.id, result: verified.result, receipt });
  }
  // Recheck/recover already-paid deliveries before spending on any new goal.
  // A bad or unavailable earlier delivery aborts this run without new payments.
  if (execute) {
    for (let i = 0; i < checks.length; i++) if (checks[i].status === 'SKIPPED') await deliverPaid(i, true);
  }
  let payments;
  if (execute && !summary.blocked) {
    log('[resource-agent] Batch preflight passed; these non-atomic views are not a guarantee.');
    const indexById = new Map(plan.requests.map((request, index) => [request.id, index]));
    payments = await runProcurement({ plan, provider, account, publicKey, journal, journalRoutes, execute: true, durablePayment, log, stopOnBlocked: true,
      beforePayment,
      onCheck: check => {
        if (check.status === 'BLOCKED' || check.status === 'DEFERRED') {
          const index = indexById.get(check.id);
          checks[index] = { id: check.id, status: check.status,
            reason: String(check.reason || 'Policy rejected the request.').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200) };
        }
      },
      onPaid: async ({ id, tx_hash }) => { await deliverPaid(indexById.get(id), true, tx_hash); },
    });
  } else {
    for (let i = 0; i < checks.length; i++) {
      const check = checks[i], request = plan.requests[i];
      if (check.status === 'READY') log(`[procurement] READY ${request.id} (${request.resource}): ${request.amount} ${request.token} → ${request.payee} (dry run)`);
      else if (check.status === 'BLOCKED') log(`[procurement] BLOCKED ${request.id} (${request.resource}): ${check.reason || blockedReasons.get(check.id) || 'Policy rejected the request.'}`);
      else log(`[procurement] SKIP ${request.id}: already paid`);
    }
    if (execute && summary.blocked) log('[resource-agent] Batch preflight blocked: no new payments were submitted.');
    payments = summary;
  }
  if (execute) {
    for (let i = 0; i < goals.length; i++) if (!delivered.has(goals[i].id)) await deliverPaid(i);
  }
  const deliveries = goals.map(goal => delivered.get(goal.id)).filter(Boolean);
  return { plan, payments, deliveries, checks };
}

/** HTTP helper: HTTPS for remote providers, or HTTP on loopback for this demo. */
export function httpResourceProvider(baseUrl, fetchImpl = globalThis.fetch) {
  const url = validateProviderOrigin(baseUrl);
  async function post(route, body) {
    const response = await fetchImpl(new URL(route, url), {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    });
    const data = await readBoundedJson(response, { label: 'provider' });
    if (!response.ok || data?.ok !== true) {
      const message = typeof data?.error === 'string' ? data.error.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200) : response.status;
      throw new Error(`provider ${route} failed: ${message}`);
    }
    return data;
  }
  return {
    async getQuote(order) { return (await post('/quote', order)).quote; },
    async fulfill(order) { return (await post('/redeem', order)).result; },
    async readStorage(objectId) {
      if (typeof objectId !== 'string' || !/^[a-f0-9]{64}$/.test(objectId)) throw new Error('invalid storage object id');
      const response = await fetchImpl(new URL(`/storage/${objectId}`, url), {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`provider storage readback failed (HTTP ${response.status})`);
      return readBoundedBytes(response, { maxBytes: 4096, label: 'provider storage' });
    },
  };
}

/** Route each goal only to the origin pinned in its reviewed goals file. */
export function routedResourceProvider({ providerUrl, goals, overrides = new Map(), fetchImpl = globalThis.fetch }) {
  if (!Array.isArray(goals) || !goals.length || !(overrides instanceof Map)) throw new Error('valid goals and provider routes are required');
  // Validate the default and every goal-specific origin before any HTTP calls.
  httpResourceProvider(providerUrl, fetchImpl);
  const routes = new Map();
  for (const goal of goals) {
    if (!goal || typeof goal !== 'object') throw new Error('invalid goal route');
    const id = validText(goal.id, 'goal id');
    if (routes.has(id)) throw new Error(`duplicate goal route: ${id}`);
    const origin = goal.provider_url === undefined ? providerUrl : goal.provider_url;
    if (typeof origin !== 'string') throw new Error(`${id}: invalid provider origin`);
    httpResourceProvider(origin, fetchImpl);
    const replacement = overrides.get(new URL(origin).origin);
    const actual = replacement === undefined ? origin : replacement;
    routes.set(id, httpResourceProvider(actual, fetchImpl));
  }
  function route(context) {
    const client = routes.get(context?.goalId);
    if (!client) throw new Error('missing approved goal provider route');
    return client;
  }
  return {
    getQuote: (order, context) => route(context).getQuote(order),
    fulfill: (order, context) => route(context).fulfill(order),
    readStorage: (objectId, context) => route(context).readStorage(objectId),
  };
}

const USAGE = `Usage: node bouncer/agent/resource-agent.mjs --goals goals.json --key agent-key.json [--journal journal.json] [--local-provider provider.json] [--execute] [--durable]

Quote configured providers and preflight owner-pinned resource goals.
Default is read-only; --execute sends real testnet payments, checks bounded
example deliveries and stores local receipts in the private journal. --durable
records the signed transaction hash before broadcast for key-free recovery.
Checks happen after payment and do not guarantee delivery or refunds. Use a function-call
key scoped only to Bouncer execute. Amounts are token smallest units, not USD.
Never use real funds.
`;
function parseCli(args) {
  const options = { execute: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') return { help: true };
    if (arg === '--execute') { options.execute = true; continue; }
    if (arg === '--durable') { options.durable = true; continue; }
    if (['--goals', '--key', '--journal', '--local-provider'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) {
      const key = arg.slice(2);
      if (options[key]) throw new Error(`duplicate ${arg}`);
      options[key] = args[++i];
    } else throw new Error(`unknown or incomplete argument: ${arg}`);
  }
  if (!options.goals || !options.key) throw new Error('--goals and --key are required');
  return options;
}
async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.help) { console.log(USAGE); return; }
  const config = JSON.parse(fs.readFileSync(options.goals, 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('invalid goals file');
  if (options.durable) console.log('[resource-agent] Durable direct payments enabled: signed hashes are recorded before broadcast.');
  // Validate the configured origin before starting any provider or spending.
  httpResourceProvider(config.provider_url);
  // Check every selected route before starting a development provider.
  routedResourceProvider({ providerUrl: config.provider_url, goals: config.goals });
  let journal, local;
  try {
    let providerUrl = config.provider_url;
    const overrides = new Map();
    if (options['local-provider']) {
      const localConfig = JSON.parse(fs.readFileSync(options['local-provider'], 'utf8'));
      if (localConfig.contract_id !== config.contract_id) throw new Error('local provider contract does not match the goals file');
      if ((localConfig.owner_account_id ?? localConfig.contract_id) !== config.owner_account_id) throw new Error('local provider owner does not match the goals file');
      local = await startConfiguredProvider(localConfig);
      const configured = new URL(providerUrl);
      const ephemeral = localConfig.port === 0 && configured.origin === 'http://127.0.0.1:0';
      if (configured.origin !== local.url && !ephemeral) throw new Error('local provider URL does not match the goals file');
      providerUrl = local.url;
      overrides.set(configured.origin, providerUrl);
      console.log(`[resource-agent] Local development provider: ${providerUrl}`);
    }
    const client = routedResourceProvider({ providerUrl: config.provider_url, goals: config.goals, overrides });
    if (options.execute) {
      const journalPath = options.journal || config.journal_path || `${options.goals}.bouncer-journal.json`;
      journal = new FileJournal(journalPath, config.contract_id, config.owner_account_id);
      console.log(`[resource-agent] Journal: ${path.resolve(journalPath)}`);
    }
    const result = await runResourceAgent({
      contractId: config.contract_id, ownerAccountId: config.owner_account_id, providerUrl: config.provider_url, goals: config.goals,
      getQuote: client.getQuote, fulfill: client.fulfill, readStorage: client.readStorage, journal, execute: options.execute, durablePayment: options.durable === true,
      onPlan: plan => console.log(`[resource-agent] Validated quote plan:\n${JSON.stringify(plan, null, 2)}`),
      runtimeFactory: plan => createRuntime({ plan, keyFile: options.key }),
    });
    console.log(`[resource-agent] ${options.execute ? 'Finished' : 'Dry run only'}: ${JSON.stringify(result.payments)}; deliveries=${result.deliveries.length}`);
    if (result.payments.blocked) process.exitCode = 2;
  } finally {
    journal?.close();
    if (local) await new Promise(resolve => local.server.close(resolve));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`[resource-agent] ERROR: ${error.message}`); process.exitCode = 1; });
}
