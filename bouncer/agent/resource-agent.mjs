/**
 * Quote -> guarded payment -> fulfillment orchestration for supplied goals.
 * This is a deterministic testnet agent, not an AI or a vendor marketplace.
 * The caller explicitly pins each trusted policy, token, payee and max price.
 */
import { runProcurement, validatePlan } from './procurement.mjs';
import { normalizeOrder, orderMemo } from '../services/resource-provider.mjs';

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
    const input = normalizeOrder(resource, goal.input);
    const quote = await getQuote({ resource, input });
    if (!quote || quote.resource !== resource || quote.policy_id !== policyId || quote.token !== token || quote.payee !== payee) {
      throw new Error(`${id}: quote does not match the permitted resource, policy, token, or payee`);
    }
    const amount = positiveAmount(quote.amount, `${id} quote amount`);
    if (amount > max) throw new Error(`${id}: quote exceeds the owner-approved maximum`);
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
  provider, account, publicKey, journal, execute = false, log = console.log }) {
  if (execute && (typeof fulfill !== 'function' || !journal)) throw new Error('live execution requires a journal and fulfillment source');
  const plan = await planFromQuotes({ contractId, ownerAccountId, goals, getQuote });
  await onPlan(plan);
  const payments = await runProcurement({ plan, provider, account, publicKey, journal, execute, log });
  const deliveries = [];
  if (execute) {
    for (const goal of goals) {
      const entry = journal.get(goal.id);
      if (!entry || entry.status !== 'completed' || !entry.tx_hash) continue;
      const result = await fulfill({ tx_hash: entry.tx_hash, resource: goal.resource, input: normalizeOrder(goal.resource, goal.input) });
      if (!result || result.type !== goal.resource) throw new Error(`${goal.id}: invalid fulfillment response`);
      log(`[resource-agent] FULFILLED ${goal.id} (${goal.resource})`);
      deliveries.push({ id: goal.id, result });
    }
  }
  return { plan, payments, deliveries };
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
    const data = await response.json();
    if (!response.ok || data?.ok !== true) throw new Error(`provider ${route} failed: ${data?.error || response.status}`);
    return data;
  }
  return {
    async getQuote(order) { return (await post('/quote', order)).quote; },
    async fulfill(order) { return (await post('/redeem', order)).result; },
  };
}
