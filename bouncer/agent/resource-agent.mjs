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
import { createRuntime, FileJournal, runProcurement, validatePlan } from './procurement.mjs';
import { reservePreview } from './preflight.mjs';
import { readBoundedJson } from '../shared/bounded-json.mjs';
import { normalizeOrder, orderMemo, startConfiguredProvider } from '../services/resource-provider.mjs';

function positiveAmount(value, label) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || BigInt(value) > (1n << 128n) - 1n) throw new Error(`${label} must be a positive U128 string`);
  return BigInt(value);
}
function validText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value;
}

/** Fetch a quote for each goal and validate it against owner-pinned constraints. */
export async function planFromQuotes({ contractId, ownerAccountId, goals, getQuote }) {
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
    // Context is local routing metadata, not part of the provider request body.
    const quote = await getQuote({ resource, input }, { goalId: id });
    if (!quote || quote.resource !== resource || quote.policy_id !== policyId || quote.token !== token || quote.payee !== payee) {
      throw new Error(`${id}: quote does not match the permitted resource, policy, token, or payee`);
    }
    const amount = positiveAmount(quote.amount, `${id} quote amount`);
    if (amount > max) throw new Error(`${id}: quote exceeds the owner-approved maximum`);
    if (selectedAmount !== undefined && amount !== selectedAmount) throw new Error(`${id}: selected quote changed; review and reselect before payment`);
    const memo = orderMemo(resource, input);
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
export async function runResourceAgent({ contractId, ownerAccountId, goals, getQuote, fulfill, onPlan = () => {},
  provider, account, publicKey, runtimeFactory, journal, execute = false, log = console.log }) {
  if (execute && (typeof fulfill !== 'function' || !journal)) throw new Error('live execution requires a journal and fulfillment source');
  const plan = await planFromQuotes({ contractId, ownerAccountId, goals, getQuote });
  await onPlan(plan);
  if (runtimeFactory) ({ provider, account, publicKey } = await runtimeFactory(plan));
  // Complete a read-only preflight for the ENTIRE batch before the first new
  // payment, including tentative shared-budget and shared-vault reservations.
  // The views are non-atomic: the contract still decides each real payment,
  // and another actor can change state after this preview.
  const checks = [], blockedReasons = new Map();
  const preview = await runProcurement({ plan, provider, account, publicKey, journal, execute: false, log: () => {}, onCheck: check => {
    checks.push({ id: check.id, status: check.status });
    if (check.status === 'BLOCKED') blockedReasons.set(check.id, typeof check.reason === 'string' ? check.reason.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200) : 'Policy rejected the request.');
  } });
  const summary = await reservePreview(provider, plan, checks, preview);
  let payments;
  if (execute && !summary.blocked) {
    log('[resource-agent] Batch preflight passed; these non-atomic views are not a guarantee.');
    payments = await runProcurement({ plan, provider, account, publicKey, journal, execute: true, log });
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
  const deliveries = [];
  if (execute) {
    for (const goal of goals) {
      const entry = journal.get(goal.id);
      if (!entry || entry.status !== 'completed' || !entry.tx_hash) continue;
      const result = await fulfill({ tx_hash: entry.tx_hash, resource: goal.resource, input: normalizeOrder(goal.resource, goal.input) }, { goalId: goal.id });
      if (!result || result.type !== goal.resource) throw new Error(`${goal.id}: invalid fulfillment response`);
      log(`[resource-agent] FULFILLED ${goal.id} (${goal.resource})`);
      deliveries.push({ id: goal.id, result });
    }
  }
  return { plan, payments, deliveries, checks };
}

/** HTTP helper: HTTPS for remote providers, or HTTP on loopback for this demo. */
export function httpResourceProvider(baseUrl, fetchImpl = globalThis.fetch) {
  const url = new URL(baseUrl);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('provider must use HTTPS or loopback HTTP');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('provider URL must be a bare origin without credentials');
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
  };
}

const USAGE = `Usage: node bouncer/agent/resource-agent.mjs --goals goals.json --key agent-key.json [--journal journal.json] [--local-provider provider.json] [--execute]

Quote configured providers and preflight owner-pinned resource goals.
Default is read-only; --execute sends real testnet payments and requests fulfillment.
Use a function-call access key scoped only to the Bouncer execute method.
Amounts are strings in each token's smallest units. Never use real funds.
`;
function parseCli(args) {
  const options = { execute: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') return { help: true };
    if (arg === '--execute') { options.execute = true; continue; }
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
      contractId: config.contract_id, ownerAccountId: config.owner_account_id, goals: config.goals,
      getQuote: client.getQuote, fulfill: client.fulfill, journal, execute: options.execute,
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
