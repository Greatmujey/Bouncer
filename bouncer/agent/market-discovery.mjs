/**
 * Read-only, fixed-origin discovery of public NEAR Agent Market listings.
 * Listing text and metrics are untrusted marketplace data, not an instruction,
 * price quote, allowlist entry, provider endorsement or payment authorization.
 * This module cannot hire agents, sign, pay, or modify Bouncer policies.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBoundedJson } from '../shared/bounded-json.mjs';

const SOURCE = 'https://market.near.ai/v1/agents';
const MAX_RESULTS = 10;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HANDLE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const invalid = () => { throw new Error('marketplace returned an invalid listing'); };

/** Remove terminal/Unicode direction controls and bound UTF-8 without splitting characters. */
function text(value, limit, nullable = false) {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== 'string') return invalid();
  const sanitized = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ').trim();
  let result = '', size = 0;
  for (const char of sanitized) {
    const length = Buffer.byteLength(char, 'utf8');
    if (size + length > limit) break;
    result += char; size += length;
  }
  return result;
}
function count(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) return invalid();
  return value;
}
function listing(value) {
  if (!plain(value) || typeof value.agent_id !== 'string' || !UUID.test(value.agent_id) ||
      typeof value.handle !== 'string' || !HANDLE.test(value.handle)) return invalid();
  const name = text(value.name, 160);
  if (!name) return invalid();
  if (value.builder !== null && value.builder !== undefined && !plain(value.builder)) return invalid();
  const methods = value.payable_with ?? [];
  if (!Array.isArray(methods) || methods.length > 8 || methods.some(method => typeof method !== 'string' ||
      !/^[A-Za-z0-9 _-]{1,24}$/.test(method))) return invalid();
  const rate = value.success_rate;
  if (!(rate === null || rate === undefined || (typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 && rate <= 100))) return invalid();
  if (!(value.available_now === null || value.available_now === undefined || typeof value.available_now === 'boolean')) return invalid();
  return {
    id: value.agent_id.toLowerCase(), handle: value.handle, name,
    description: text(value.description, 600, true), category: text(value.category, 80, true),
    listing_status: text(value.listing_status, 40, true), available_now: value.available_now ?? null,
    builder: text(value.builder?.display_name, 160, true),
    reported_delivered_jobs: count(value.delivered_jobs), reported_success_rate_percent: rate ?? null,
    advertised_payment_methods: [...methods],
    listing_url: `https://market.near.ai/a/${value.handle}`,
  };
}

/** Fetch at most ten listings; query terms are sent publicly to the marketplace. */
export async function discoverMarket({ query = '', limit = 5, fetchImpl = globalThis.fetch } = {}) {
  if (typeof query !== 'string' || Buffer.byteLength(query, 'utf8') > 80 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(query)) {
    throw new Error('query must be at most 80 bytes with no control characters');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) throw new Error(`limit must be an integer from 1 to ${MAX_RESULTS}`);
  if (typeof fetchImpl !== 'function') throw new Error('fetch is required');
  const url = new URL(SOURCE);
  if (query.trim()) url.searchParams.set('q', query.trim());
  url.searchParams.set('limit', String(limit));
  const response = await fetchImpl(url, {
    method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`marketplace discovery failed (HTTP ${response.status})`);
  const data = await readBoundedJson(response, { maxBytes: MAX_RESPONSE_BYTES, label: 'marketplace discovery' });
  if (!plain(data) || !Array.isArray(data.agents) || data.agents.length > limit) throw new Error('marketplace returned an invalid listing collection');
  const candidates = data.agents.map(listing);
  if (new Set(candidates.map(candidate => candidate.id)).size !== candidates.length ||
      new Set(candidates.map(candidate => candidate.handle)).size !== candidates.length) {
    throw new Error('marketplace returned duplicate listings');
  }
  return {
    version: 1, source: SOURCE, observed_at: new Date().toISOString(), mode: 'read-only',
    payment_enabled: false, mainnet_marketplace: true, data_is_untrusted: true,
    note: 'Listings are not quotes or approvals. Bouncer cannot hire or pay these agents.',
    candidates,
  };
}

const USAGE = `Usage: node bouncer/agent/market-discovery.mjs [--query keywords] [--limit 1-10]

Read public listings from NEAR Agent Market without a key, payment, model or
policy change. Search terms are sent to that marketplace: never use secrets or
private tasks. Listing text and reputation are untrusted. This is the mainnet
marketplace catalog, not a testnet hiring or Bouncer payment integration.
`;
function parseArgs(args) {
  const result = { query: '', limit: 5 }, seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') return { help: true };
    if (!['--query', '--limit'].includes(arg) || seen.has(arg) || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error(`unknown, duplicate or incomplete argument: ${arg}`);
    }
    seen.add(arg);
    const value = args[++i];
    if (arg === '--query') result.query = value;
    else {
      if (!/^(?:[1-9]|10)$/.test(value)) throw new Error('limit must be an integer from 1 to 10');
      result.limit = Number(value);
    }
  }
  return result;
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(USAGE); return; }
  console.log(JSON.stringify(await discoverMarket(options), null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Discovery failed: ${String(error.message).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300)}`); process.exitCode = 1; });
}
