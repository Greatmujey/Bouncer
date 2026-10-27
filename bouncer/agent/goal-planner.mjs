/**
 * Translate a natural-language objective into resource goals. The model is an
 * untrusted proposer: only the owner-controlled catalog supplies contracts,
 * policies, tokens, payees, price ceilings and task budgets. No signing key or
 * catalog financial details are sent to the model.
 */
import fs from 'node:fs';
import path from 'node:path';
import { normalizeOrder } from '../services/resource-provider.mjs';
import { httpResourceProvider } from './resource-agent.mjs';

const RESOURCE_TYPES = ['compute', 'storage', 'api'];
const MAX_TASKS = 10;
const MAX_OBJECTIVE_BYTES = 4000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const U128_MAX = (1n << 128n) - 1n;
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function keysExactly(value, required, optional = []) {
  if (!plainObject(value) || required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) return false;
  return true;
}
function testnetAccount(value) {
  return typeof value === 'string' && value.length <= 64 &&
    /^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*\.testnet$/.test(value);
}
function positiveU128(value, label) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,38}$/.test(value) || BigInt(value) > U128_MAX) {
    throw new Error(`${label} must be a positive U128 decimal string`);
  }
  return BigInt(value);
}
function boundedCount(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TASKS) throw new Error(`${label} must be an integer from 1 to ${MAX_TASKS}`);
  return value;
}

/** Validate and copy the operator's authority, before contacting a model. */
export function validatePlanningConfig(input) {
  if (!keysExactly(input, ['version', 'contract_id', 'owner_account_id', 'provider_url', 'max_tasks', 'resources'], ['required_resources']) || input.version !== 1) {
    throw new Error('invalid owner planning config or version');
  }
  if (!testnetAccount(input.contract_id) || !testnetAccount(input.owner_account_id)) throw new Error('contract and owner must be valid .testnet accounts');
  // Reuse the resource client's origin rules; this constructs no network request.
  if (typeof input.provider_url !== 'string') throw new Error('provider_url is required');
  httpResourceProvider(input.provider_url);
  const maxTasks = boundedCount(input.max_tasks, 'max_tasks');
  if (!plainObject(input.resources)) throw new Error('resources must be an owner-controlled catalog');
  const names = Object.keys(input.resources);
  if (!names.length || names.some(name => !RESOURCE_TYPES.includes(name))) throw new Error('catalog contains an unsupported resource');
  const resources = Object.create(null);
  for (const name of names) {
    const item = input.resources[name];
    if (!keysExactly(item, ['policy_id', 'token', 'payee', 'max_amount', 'max_tasks', 'max_total_amount'])) throw new Error(`invalid ${name} catalog entry`);
    if (typeof item.policy_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(item.policy_id)) throw new Error(`invalid ${name} policy_id`);
    if (!testnetAccount(item.token) || !testnetAccount(item.payee)) throw new Error(`${name} token and payee must be valid .testnet accounts`);
    const maxAmount = positiveU128(item.max_amount, `${name} max_amount`);
    const maxTotal = positiveU128(item.max_total_amount, `${name} max_total_amount`);
    if (maxTotal < maxAmount) throw new Error(`${name} max_total_amount is below its per-task maximum`);
    resources[name] = {
      policy_id: item.policy_id, token: item.token, payee: item.payee,
      max_amount: item.max_amount, max_tasks: boundedCount(item.max_tasks, `${name} max_tasks`), max_total_amount: item.max_total_amount,
    };
  }
  const required = input.required_resources ?? [];
  if (!Array.isArray(required) || required.some(name => typeof name !== 'string' || !Object.hasOwn(resources, name)) || new Set(required).size !== required.length || required.length > maxTasks) {
    throw new Error('required_resources must contain distinct catalog resources within max_tasks');
  }
  return {
    version: 1, contract_id: input.contract_id, owner_account_id: input.owner_account_id,
    provider_url: input.provider_url, max_tasks: maxTasks, resources, required_resources: [...required],
  };
}

export function validateObjective(objective) {
  if (typeof objective !== 'string' || !objective.trim() || Buffer.byteLength(objective, 'utf8') > MAX_OBJECTIVE_BYTES) {
    throw new Error(`objective must be a nonempty string of at most ${MAX_OBJECTIVE_BYTES} bytes`);
  }
  return objective;
}

const inputSchema = (resource, properties, required) => ({
  type: 'object', additionalProperties: false, required: ['resource', 'input'], properties: {
    resource: { type: 'string', enum: [resource] },
    input: { type: 'object', additionalProperties: false, properties, required },
  },
});
// Constrained generation is a convenience, not a security boundary. The result
// is always revalidated locally, even if the server claims strict JSON output.
export const TASK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['tasks'], properties: {
    tasks: { type: 'array', items: { anyOf: [
      inputSchema('compute', { text: { type: 'string' }, rounds: { type: 'integer' } }, ['text', 'rounds']),
      inputSchema('storage', { name: { type: 'string' }, content: { type: 'string' } }, ['name', 'content']),
      inputSchema('api', { text: { type: 'string' } }, ['text']),
      inputSchema('api', { repo: { type: 'string' } }, ['repo']),
    ] } },
  },
};

/** Independently reject unknown fields, duplicate work, bad inputs and budgets. */
export function goalsFromModel(raw, ownerConfig) {
  const config = validatePlanningConfig(ownerConfig);
  if (!keysExactly(raw, ['tasks']) || !Array.isArray(raw.tasks) || !raw.tasks.length || raw.tasks.length > config.max_tasks) {
    throw new Error('model must return a nonempty tasks array within the owner task limit, with no extra fields');
  }
  const counts = Object.create(null);
  const seen = new Set();
  const goals = raw.tasks.map(task => {
    if (!keysExactly(task, ['resource', 'input']) || typeof task.resource !== 'string' || !Object.hasOwn(config.resources, task.resource)) {
      throw new Error('model proposed an unsupported resource or unauthorized field');
    }
    const { resource } = task;
    const limits = config.resources[resource];
    const inputKeys = resource === 'compute' ? ['text', 'rounds'] : resource === 'storage' ? ['name', 'content'] :
      (plainObject(task.input) && Object.hasOwn(task.input, 'repo') ? ['repo'] : ['text']);
    if (!keysExactly(task.input, inputKeys)) throw new Error('model proposed invalid or unauthorized input fields');
    // normalizeOrder enforces the provider's byte/CPU/name limits.
    const input = normalizeOrder(resource, task.input);
    const identity = JSON.stringify([resource, input]);
    if (seen.has(identity)) throw new Error('model proposed duplicate resource work');
    seen.add(identity);
    const count = (counts[resource] || 0) + 1;
    counts[resource] = count;
    if (count > limits.max_tasks) throw new Error(`${resource} exceeds the owner task limit`);
    // Reserve the worst-case approved quote for every task, not just the
    // model's suggested price (the model is not allowed to suggest one).
    if (BigInt(count) * BigInt(limits.max_amount) > BigInt(limits.max_total_amount)) {
      throw new Error(`${resource} exceeds the owner aggregate maximum`);
    }
    return { id: `${resource}-${count}`, resource, input, policy_id: limits.policy_id,
      token: limits.token, payee: limits.payee, max_amount: limits.max_amount };
  });
  if (config.required_resources.some(resource => !counts[resource])) throw new Error('model omitted an owner-required resource');
  return { contract_id: config.contract_id, owner_account_id: config.owner_account_id, provider_url: config.provider_url, goals };
}

function modelEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('a valid model endpoint is required'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('model endpoint must use HTTPS or loopback HTTP');
  if (url.username || url.password || url.search || url.hash || !url.pathname || url.pathname === '/') throw new Error('model endpoint must be a path without credentials, query or fragment');
  return url;
}

async function boundedBody(response) {
  const contentLength = response.headers?.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && BigInt(contentLength) > BigInt(MAX_RESPONSE_BYTES)) throw new Error('model response is too large');
  if (!response.body) throw new Error('model returned no response body');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('model response is too large'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

/** OpenAI-compatible chat-completions client; never follows redirects. */
export function createModelClient({ endpoint, model, apiKey, fetchImpl = globalThis.fetch, timeoutMs = 120_000 }) {
  const url = modelEndpoint(endpoint);
  if (typeof model !== 'string' || !model.trim() || Buffer.byteLength(model) > 128) throw new Error('a model name is required');
  if (apiKey !== undefined && (typeof apiKey !== 'string' || !apiKey || /[\r\n]/.test(apiKey))) throw new Error('invalid model API key');
  if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error('invalid model client configuration');
  return async ({ objective, allowedResources }) => {
    validateObjective(objective);
    if (!Array.isArray(allowedResources) || !allowedResources.length || allowedResources.some(name => !RESOURCE_TYPES.includes(name))) throw new Error('invalid available resource types');
    const examples = [];
    if (allowedResources.includes('compute')) examples.push({ resource: 'compute', input: { text: 'sample text', rounds: 5 } });
    if (allowedResources.includes('storage')) examples.push({ resource: 'storage', input: { name: 'sample', content: 'sample note' } });
    if (allowedResources.includes('api')) {
      // This only selects an illustrative shape; it neither selects the task
      // nor grants authority, and all model output is independently validated.
      const repoHint = /\b(?:github|repo|repository)\b/i.test(objective);
      examples.push(repoHint ? { resource: 'api', input: { repo: 'sample-org/sample-project' } } : { resource: 'api', input: { text: 'sample words' } });
    }
    const system = [
      'Translate the objective into resource tasks. Return only JSON matching the schema.',
      'Make a separate task for each supported action actually requested; do not omit requested tasks.',
      'Use only the listed resource types and only requested tasks; return an empty tasks array if unable to plan.',
      'compute hashes input.text using input.rounds SHA-256 rounds (1 to 20000).',
      'storage stores input.content under input.name (lowercase letters, digits, hyphen or underscore).',
      'api counts words and bytes in input.text OR fetches public GitHub repository metadata with input.repo as owner/name; choose one field only.',
      'Preserve requested literal text and repository names exactly.',
      'Never add accounts, policy, payee, price, token, commands, URLs, or other fields.',
      `Available resource types: ${allowedResources.join(', ')}.`,
      `Task shape examples, not the objective: ${JSON.stringify({ tasks: examples })}.`,
    ].join(' ');
    const branches = TASK_SCHEMA.properties.tasks.items.anyOf.filter(branch => allowedResources.includes(branch.properties.resource.enum[0]));
    const schema = { ...TASK_SCHEMA, properties: { tasks: { ...TASK_SCHEMA.properties.tasks, items: { anyOf: branches } } } };
    const headers = { 'content-type': 'application/json' };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: objective }],
          temperature: 0, max_tokens: 900, stream: false,
          response_format: { type: 'json_schema', json_schema: { name: 'bouncer_resource_tasks', strict: true, schema } } }),
      });
    } catch { throw new Error('model request failed or timed out'); }
    if (!response.ok) throw new Error(`model request failed (HTTP ${response.status})`);
    let envelope;
    try { envelope = JSON.parse(await boundedBody(response)); } catch (error) {
      if (error.message === 'model response is too large') throw error;
      throw new Error('model returned an invalid response');
    }
    if (!Array.isArray(envelope?.choices) || envelope.choices.length !== 1 || envelope.choices[0]?.finish_reason !== 'stop') {
      throw new Error('model response was incomplete or ambiguous');
    }
    const message = envelope.choices[0].message;
    if (!plainObject(message) || message.role !== 'assistant' || typeof message.content !== 'string' || message.refusal || message.tool_calls) {
      throw new Error('model response did not contain a completed JSON plan');
    }
    try { return JSON.parse(message.content); } catch { throw new Error('model plan is not valid JSON'); }
  };
}

/** The model receives only the objective and available resource names. */
export async function planObjective({ objective, config: rawConfig, modelClient }) {
  const config = validatePlanningConfig(rawConfig);
  validateObjective(objective);
  if (typeof modelClient !== 'function') throw new Error('a model client is required');
  const proposed = await modelClient({ objective, allowedResources: Object.keys(config.resources) });
  return goalsFromModel(proposed, config);
}

/** Never overwrite a previously reviewed plan; keep generated inputs private. */
export function saveGoals(file, goals) {
  const target = path.resolve(file);
  const withJournal = { ...goals, journal_path: `${target}.bouncer-journal.json` };
  fs.writeFileSync(target, JSON.stringify(withJournal, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return target;
}
