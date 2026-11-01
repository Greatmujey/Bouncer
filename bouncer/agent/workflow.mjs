#!/usr/bin/env node
/**
 * Owner-reviewed, ordered testnet resource workflow. One paid OutLayer result
 * or x402 seller response may be passed as bounded JSON to later compute,
 * storage and text-API inputs. Payment verification does not prove data truth.
 * Outputs never select financial authority. This is a non-atomic prototype,
 * not a distributed workflow engine.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { openConfiguredFileJournal, runProcurement, validatePlan } from './procurement.mjs';
import { MonotonicAccount, PaymentRpcProvider } from './near-account.mjs';
import { reservePreview } from './preflight.mjs';
import { runOutlayerGoal, recoverOutlayerGoal, validateOutlayerGoal } from './outlayer.mjs';
import { runOracleGoal, recoverOracleGoal, validateOracleGoal, assertOracleFreshForUse } from './oracle-outlayer.mjs';
import { runProjectGoal, recoverProjectGoal, validateProjectGoal, expectedBurnChecksum } from './outlayer-project.mjs';
import { validateOnchainProofGoal } from './onchain-proof.mjs';
import { validateOnchainProofOutput, validateOnchainProofProjection, assertOnchainProofResponseFresh, runOnchainProofWorkflowSource,
  recoverOnchainProofWorkflowSource } from './onchain-proof-workflow.mjs';
import { runResourceAgent, routedResourceProvider } from './resource-agent.mjs';
import { recoverResourceDelivery } from './recover-direct-payment.mjs';
import { normalizeOrder, challengeFromOrderMemo, challengeFromOrderMemoV3, startConfiguredProvider } from '../services/resource-provider.mjs';
import { validateProviderOrigin } from '../shared/provider-origin.mjs';
import { isTestnetAccount, isTestnetToken } from '../shared/account-id.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

const U128_MAX = (1n << 128n) - 1n;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function keys(value, required, optional = []) {
  return plain(value) && required.every(k => Object.hasOwn(value, k)) &&
    Object.keys(value).every(k => required.includes(k) || optional.includes(k));
}
function id(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Error(`invalid ${label}`);
  return value;
}
function positive(value, label) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,38}$/.test(value) || BigInt(value) > U128_MAX) throw new Error(`${label} must be a canonical positive U128 string`);
  return value;
}
function unsigned(value, label) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,38})$/.test(value) || BigInt(value) > U128_MAX) throw new Error(`invalid ${label}`);
  return BigInt(value);
}
async function projectCreditAvailable(provider, goal) {
  const credit = await provider.callFunction('outlayer.testnet', 'get_user_stablecoin_balance',
    { account_id: goal.contract_id }, { finality: 'final' });
  return unsigned(credit, 'provider-held testnet credit') >= BigInt(goal.route.project.attached_usd);
}
function slot(value, earlier) {
  if (typeof value === 'string') return value;
  if (!keys(value, ['from']) || typeof value.from !== 'string' || !earlier.has(value.from)) throw new Error('input binding must reference an earlier verified step');
  return { from: value.from };
}
function normalizeTemplate(resource, input, earlier) {
  if (!plain(input)) throw new Error('invalid workflow input');
  let normalized, example;
  if (resource === 'compute' && keys(input, ['text', 'rounds'])) {
    normalized = { text: slot(input.text, earlier), rounds: input.rounds };
    example = { text: typeof normalized.text === 'string' ? normalized.text : 'preview', rounds: normalized.rounds };
  } else if (resource === 'storage' && keys(input, ['name', 'content'])) {
    normalized = { name: input.name, content: slot(input.content, earlier) };
    example = { name: normalized.name, content: typeof normalized.content === 'string' ? normalized.content : 'preview' };
  } else if (resource === 'api' && keys(input, ['text'])) {
    normalized = { text: slot(input.text, earlier) };
    example = { text: typeof normalized.text === 'string' ? normalized.text : 'preview' };
  } else if (resource === 'api' && keys(input, ['repo']) && typeof input.repo === 'string') {
    normalized = normalizeOrder('api', input); example = normalized;
  } else throw new Error('unsupported workflow input or dynamic field');
  // Validate fixed literals and all resource-specific CPU/name/byte limits now;
  // the actual derived bytes are checked again after the source is verified.
  normalizeOrder(resource, example);
  return normalized;
}
function freezeDeep(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freezeDeep(child); Object.freeze(value); }
  return value;
}

/** A strict owner-reviewed manifest; no model/provider can add payment fields. */
export function validateWorkflow(raw) {
  if (!keys(raw, ['version', 'id', 'source', 'provider_url', 'steps']) || raw.version !== 1 || !plain(raw.source) ||
      !['random', 'oracle', 'project', 'onchain-proof'].includes(raw.source.kind) ||
      !(raw.source.kind === 'onchain-proof' ? keys(raw.source, ['kind', 'goal', 'output']) : keys(raw.source, ['kind', 'goal']))) {
    throw new Error('invalid workflow manifest');
  }
  const workflowId = id(raw.id, 'workflow id');
  validateProviderOrigin(raw.provider_url);
  const kind = raw.source.kind;
  const sourceGoal = kind === 'oracle' ? validateOracleGoal(raw.source.goal) : kind === 'project' ? validateProjectGoal(raw.source.goal) :
    kind === 'onchain-proof' ? validateOnchainProofGoal(raw.source.goal) : validateOutlayerGoal(raw.source.goal);
  const output = kind === 'onchain-proof' ? validateOnchainProofOutput(raw.source.output) : undefined;
  id(sourceGoal.id, 'source id');
  if (!Array.isArray(raw.steps) || !raw.steps.length || raw.steps.length > 10) throw new Error('workflow requires 1 to 10 ordered resource steps');
  const earlier = new Set([sourceGoal.id]);
  const steps = raw.steps.map(step => {
    if (!keys(step, ['id', 'resource', 'policy_id', 'token', 'payee', 'max_amount', 'input'], ['quote_amount', 'provider_id', 'provider_url', 'order_binding'])) {
      throw new Error('workflow step must contain only reviewed resource and payment fields');
    }
    const stepId = id(step.id, 'step id');
    if (earlier.has(stepId)) throw new Error('workflow source and step ids must be distinct');
    if (!['compute', 'storage', 'api'].includes(step.resource)) throw new Error('unsupported workflow resource');
    if (!isTestnetAccount(step.payee) || !isTestnetToken(step.token)) throw new Error('workflow payee and token must be approved testnet accounts');
    const amount = positive(step.max_amount, `${stepId} max_amount`);
    const exact = step.quote_amount === undefined ? undefined : positive(step.quote_amount, `${stepId} quote_amount`);
    if (exact !== undefined && BigInt(exact) > BigInt(amount)) throw new Error('selected quote exceeds the owner maximum');
    if (step.provider_id !== undefined && (typeof step.provider_id !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(step.provider_id))) throw new Error('invalid provider id');
    if (step.provider_url !== undefined) validateProviderOrigin(step.provider_url);
    if (step.order_binding !== undefined && !['seller-v2', 'seller-v3'].includes(step.order_binding)) throw new Error('unsupported owner-reviewed order binding');
    const input = normalizeTemplate(step.resource, step.input, earlier);
    const result = { id: stepId, resource: step.resource, policy_id: step.policy_id, token: step.token, payee: step.payee,
      max_amount: amount, input, ...(exact === undefined ? {} : { quote_amount: exact }),
      ...(step.provider_id === undefined ? {} : { provider_id: step.provider_id }), ...(step.provider_url === undefined ? {} : { provider_url: step.provider_url }),
      ...(step.order_binding === undefined ? {} : { order_binding: step.order_binding }) };
    // Reuse the payment runner's account, amount, policy and memo validation.
    validatePlan({ contract_id: sourceGoal.contract_id, owner_account_id: sourceGoal.owner_account_id,
      requests: [{ id: stepId, resource: step.resource, policy_id: step.policy_id, token: step.token, payee: step.payee, amount: exact ?? amount }] });
    earlier.add(stepId);
    return result;
  });
  return freezeDeep({ version: 1, id: workflowId, source: { kind, goal: sourceGoal, ...(output === undefined ? {} : { output }) },
    provider_url: raw.provider_url, steps });
}

function fingerprint(workflow) { return crypto.createHash('sha256').update(`bouncer-workflow-v1\0${JSON.stringify(workflow)}`).digest('hex'); }
function manifestId(workflow) { return `workflow:${workflow.id}`; } // colon cannot occur in a payable goal ID
function checkManifest(workflow, journal) {
  const record = journal?.get(manifestId(workflow)), fp = fingerprint(workflow);
  if (record && (record.kind !== 'workflow-intent-v1' || !['pending', 'completed'].includes(record.status) ||
      record.fingerprint !== fp || !isDeepStrictEqual(record.workflow, workflow))) throw new Error('workflow journal does not match the reviewed manifest');
  const existing = [workflow.source.goal.id, ...workflow.steps.map(step => step.id)].some(stepId => journal?.get(stepId));
  if (!record && existing) throw new Error('original workflow manifest is missing; reconcile existing payments before starting a new workflow');
  return { record, fp };
}
function inspectPrefix(workflow, journal) {
  const entries = workflow.steps.map(step => journal?.get(step.id));
  let stopped = false;
  for (const entry of entries) {
    if (!entry) { stopped = true; continue; }
    if (stopped || !['pending', 'completed'].includes(entry.status)) throw new Error('workflow journal contains out-of-order resource payments');
    if (entry.status !== 'completed' || entry.delivery?.status !== 'verified') stopped = true;
  }
  if (!journal?.get(workflow.source.goal.id) && entries.some(Boolean)) throw new Error('resource payment exists without the original independent source');
  return entries;
}
function projectedSource(kind, goal, delivery, output) {
  if (!isTransactionHash(delivery?.tx_hash) || !plain(delivery.result)) throw new Error('source delivery lacks a valid transaction and result');
  const r = delivery.result;
  if (kind === 'onchain-proof') return validateOnchainProofProjection(r, output);
  if (kind === 'random') {
    if (!Number.isSafeInteger(r.random_number) || r.random_number < goal.input.min || r.random_number > goal.input.max) throw new Error('invalid independent random result');
    return { random_number: r.random_number };
  }
  if (kind === 'oracle') {
    const input = JSON.parse(goal.route.project.input_data), expectedSource = typeof input.source === 'string' ? input.source : 'custom';
    if (r.success !== true || r.token_id !== input.token_id || r.source !== expectedSource || typeof r.price_usd !== 'number' ||
        !Number.isFinite(r.price_usd) || r.price_usd <= 0 || !Number.isSafeInteger(r.timestamp) || r.timestamp <= 0) throw new Error('invalid independent oracle result');
    // Deliberately omit untrusted free-form warnings and any extra fields.
    return { token_id: r.token_id, source: r.source, price_usd: r.price_usd, timestamp: r.timestamp };
  }
  const input = JSON.parse(goal.route.project.input_data);
  if (input.operation === 'fetch') {
    if (r.operation !== 'fetch' || !Number.isSafeInteger(r.http_status) || r.http_status < 100 || r.http_status > 599) throw new Error('invalid connector result');
    return { operation: 'fetch', http_status: r.http_status };
  }
  if (r.operation !== 'burn' || r.rounds_done !== input.rounds || r.hashes !== input.rounds * 1_000 || r.checksum !== expectedBurnChecksum(input.rounds)) {
    throw new Error('invalid diagnostic compute result');
  }
  return { operation: 'burn', rounds_done: r.rounds_done, hashes: r.hashes, checksum: r.checksum };
}
function artifact(kind, stepId, txHash, result) {
  if (!isTransactionHash(txHash) || !plain(result)) throw new Error('verified artifact requires a transaction and canonical result');
  const value = JSON.stringify({ version: 1, kind, goal_id: stepId, tx_hash: txHash, result });
  if (Buffer.byteLength(value) > 4096) throw new Error('verified artifact exceeds the workflow size limit');
  return value;
}
export function materializeWorkflowStep(step, artifacts) {
  if (!(artifacts instanceof Map)) throw new Error('verified artifacts are required');
  const resolve = value => {
    if (typeof value === 'string') return value;
    if (!keys(value, ['from']) || !artifacts.has(value.from) || typeof artifacts.get(value.from) !== 'string') throw new Error('required verified artifact is unavailable');
    return artifacts.get(value.from);
  };
  const input = step.resource === 'compute' ? { text: resolve(step.input.text), rounds: step.input.rounds } :
    step.resource === 'storage' ? { name: step.input.name, content: resolve(step.input.content) } :
    Object.hasOwn(step.input, 'repo') ? { repo: step.input.repo } : { text: resolve(step.input.text) };
  // Dynamic bytes cannot bypass the provider's resource bounds.
  return { ...step, input: normalizeOrder(step.resource, input) };
}

/** Conservative maximum-cost, non-atomic policy/vault preview, without quotes. */
export async function previewWorkflowBudget({ workflow, remaining, provider, account, publicKey, includeSource = false }) {
  if (!remaining.length) return { checks: [], payments: { paid: 0, blocked: 0, skipped: 0, ready: 0 } };
  const goal = workflow.source.goal;
  const plan = validatePlan({ contract_id: goal.contract_id, owner_account_id: goal.owner_account_id,
    requests: remaining.map(step => ({ id: step.id, resource: step.resource, policy_id: step.policy_id, token: step.token, payee: step.payee,
      amount: step.quote_amount ?? step.max_amount, memo: `bouncer-workflow-preview:${step.id}` })) });
  const checks = [];
  const summary = await runProcurement({ plan, provider, account, publicKey, execute: false, log: () => {},
    onCheck: ({ id: stepId, status, reason }) => checks.push({ id: stepId, status,
      ...(reason ? { reason: String(reason).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200) } : {}) }) });
  // A prepaid project consumes its FT policy's daily allowance, even though
  // its funds were already moved to provider custody and do not debit the
  // current FT vault a second time. Include that future spend if the source has
  // not run yet and a resource step shares its policy.
  const project = includeSource && workflow.source.kind === 'project' ? goal.route.project : null;
  const x402 = includeSource && workflow.source.kind === 'onchain-proof' ? goal : null;
  const policyReservations = project ? [{ policy_id: project.usd_policy_id, token: project.token, amount: project.attached_usd }] :
    x402 ? [{ policy_id: x402.policy_id, token: x402.token, amount: x402.max_amount }] : [];
  // An x402 source is a future vault transfer, not provider-held credit. Use
  // its owner maximum for both shared daily and shared-token vault previews.
  const vaultReservations = x402 ? [{ token: x402.token, amount: x402.max_amount }] : [];
  const payments = await reservePreview(provider, plan, checks, summary, { policyReservations, vaultReservations });
  return { checks, payments };
}

/**
 * `runners` exists for offline tests only; production callers must not inject
 * untrusted implementations. recoverOnly reconciles existing work without keys
 * or new sends. Every new FT step uses durable signed-hash journaling.
 */
export async function runWorkflow({ workflow: rawWorkflow, source = {}, resources = {}, provider, journal, execute = false,
  recoverOnly = false, redeemSource = false, log = console.log, runners = {} }) {
  if (journal?.sharedDirectV3 === true) throw new Error('shared buyer journal does not coordinate dependent or x402 workflows');
  const workflow = validateWorkflow(rawWorkflow), goal = workflow.source.goal, kind = workflow.source.kind;
  if (execute && recoverOnly) throw new Error('execute and recoverOnly cannot be combined');
  if (typeof redeemSource !== 'boolean' || (redeemSource && (!recoverOnly || kind !== 'onchain-proof'))) {
    throw new Error('redeemSource is only available for key-free x402 source recovery');
  }
  if ((execute || recoverOnly) && (!journal || typeof journal.get !== 'function' || typeof journal.put !== 'function')) throw new Error('the original shared journal is required');
  if (journal && (typeof journal.get !== 'function' || typeof journal.put !== 'function')) throw new Error('invalid workflow journal');
  if (resources.beforePayment !== undefined && typeof resources.beforePayment !== 'function') throw new Error('invalid pre-payment guard');
  const runSource = runners.source ?? (kind === 'onchain-proof'
    ? options => runOnchainProofWorkflowSource({ ...options, selection: workflow.source.output, fetchImpl: source.fetchImpl })
    : kind === 'oracle' ? runOracleGoal : kind === 'project' ? runProjectGoal : runOutlayerGoal);
  const recoverSource = runners.recoverSource ?? (kind === 'onchain-proof'
    ? options => recoverOnchainProofWorkflowSource({ ...options, selection: workflow.source.output, redeemSource, fetchImpl: source.fetchImpl })
    : kind === 'oracle' ? recoverOracleGoal : kind === 'project' ? recoverProjectGoal : recoverOutlayerGoal);
  const runResource = runners.resource ?? runResourceAgent, recoverResource = runners.recoverResource ?? recoverResourceDelivery;
  const budget = runners.budget ?? previewWorkflowBudget;
  if ([runSource, recoverSource, runResource, recoverResource, budget].some(fn => typeof fn !== 'function')) throw new Error('invalid workflow runner');
  const { record, fp } = checkManifest(workflow, journal), entries = inspectPrefix(workflow, journal);
  const priorSource = journal?.get(goal.id), priorCount = entries.filter(Boolean).length;
  if (record?.status === 'completed' && (!priorSource || priorCount !== workflow.steps.length || entries.some(entry => entry?.delivery?.status !== 'verified'))) {
    throw new Error('completed workflow journal is missing verified stages');
  }
  if (recoverOnly && !priorSource) return { status: 'NOT_STARTED', next: goal.id, new_payments: 0 };
  let independent;
  if (priorSource) {
    independent = await recoverSource({ goal, provider, journal, update: execute || recoverOnly, log });
    if (independent?.status === 'RECOVERY_REQUIRED' && kind === 'onchain-proof') {
      if (priorCount || record?.status === 'completed') throw new Error('workflow has downstream payments without a delivered x402 source; stop');
      return { status: 'RECOVERY_REQUIRED', stage: 'source-redemption', independent, new_payments: 0, note: independent.note };
    }
    if (independent?.status !== 'REUSED' || !independent.delivery) throw new Error('source recovery did not verify delivery');
  } else {
    independent = await runSource({ goal, provider, account: source.account, publicKey: source.publicKey, execute: false, log });
    if (['BLOCKED', 'FUNDING_REQUIRED'].includes(independent?.status)) return { status: 'BLOCKED', stage: 'source-preflight', independent };
    if (independent?.status !== 'READY') throw new Error('invalid independent source preflight');
    if (kind === 'project' && !(await projectCreditAvailable(provider, goal))) {
      return { status: 'BLOCKED', stage: 'source-provider-credit', independent };
    }
  }
  if (!execute && !recoverOnly) {
    if (entries.some(entry => entry && (entry.status !== 'completed' || entry.delivery?.status !== 'verified'))) {
      return { status: 'RECOVERY_REQUIRED', stage: 'resource-recovery', new_payments: 0 };
    }
    const preview = await budget({ workflow, remaining: workflow.steps.filter((_step, i) => !entries[i]), provider,
      account: resources.account, publicKey: resources.publicKey, includeSource: !priorSource });
    if (!Number.isSafeInteger(preview?.payments?.blocked) || preview.payments.blocked < 0) throw new Error('invalid workflow budget preview');
    return { status: preview.payments.blocked ? 'BLOCKED' : 'READY', stage: 'budget-preview', independent, preview,
      note: 'maximum-cost policy preview only; exact downstream inputs and provider quotes are checked after dependencies are verified; no funds are reserved' };
  }
  // With a new source, preview ALL future maximum costs before any payment.
  if (!priorSource) {
    const preview = await budget({ workflow, remaining: workflow.steps, provider, account: resources.account, publicKey: resources.publicKey, includeSource: true });
    if (!Number.isSafeInteger(preview?.payments?.blocked) || preview.payments.blocked < 0) throw new Error('invalid workflow budget preview');
    if (preview.payments.blocked) return { status: 'BLOCKED', stage: 'budget-preview', independent, preview };
    if (kind === 'project' && !(await projectCreditAvailable(provider, goal))) {
      return { status: 'BLOCKED', stage: 'source-provider-credit', independent, preview };
    }
    if (!record) journal.put(manifestId(workflow), { kind: 'workflow-intent-v1', fingerprint: fp, status: 'pending', workflow, started_at: new Date().toISOString() });
    independent = await runSource({ goal, provider, account: source.account, publicKey: source.publicKey, journal, execute: true, log });
    if (independent?.status === 'BLOCKED' || independent?.status === 'FUNDING_REQUIRED') return { status: 'BLOCKED', stage: 'source-execution', independent };
    if (!['FULFILLED', 'REUSED'].includes(independent?.status) || !independent.delivery) throw new Error('independent source delivery was not verified');
  }
  const sourceRecord = journal.get(goal.id);
  if (sourceRecord?.status !== 'completed' || sourceRecord.tx_hash !== independent.delivery?.tx_hash) {
    throw new Error('independent source was not durably recorded under the recovered transaction hash');
  }
  const sourceResult = projectedSource(kind, goal, independent.delivery, workflow.source.output);
  if (record?.status === 'completed' && record.tx_hash !== independent.delivery.tx_hash) throw new Error('completed workflow source hash differs from recovery evidence');
  const artifacts = new Map([[goal.id, artifact(kind, goal.id, independent.delivery.tx_hash, sourceResult)]]), deliveries = [], challenges = new Set();
  const common = { contractId: goal.contract_id, ownerAccountId: goal.owner_account_id, providerUrl: workflow.provider_url,
    provider, journal, fulfill: resources.fulfill, readStorage: resources.readStorage, repositoryLookup: resources.repositoryLookup, log };
  function checkChallenge(stage, request, remember = false) {
    if (!['seller-v2', 'seller-v3'].includes(stage.order_binding)) return;
    const challenge = stage.order_binding === 'seller-v3'
      ? challengeFromOrderMemoV3(stage.resource, stage.input, request?.memo) : challengeFromOrderMemo(stage.resource, stage.input, request?.memo);
    if (challenges.has(challenge)) throw new Error(`${stage.id}: seller challenge was reused in this workflow`);
    if (remember) challenges.add(challenge);
  }
  // Existing paid stages are verified in order before ANY new resource payment.
  for (let i = 0; i < priorCount; i++) {
    const stage = materializeWorkflowStep(workflow.steps[i], artifacts);
    checkChallenge(stage, journal.get(stage.id)?.request, true);
    const delivery = await recoverResource({ ...common, goal: stage });
    if (delivery?.id !== stage.id || !delivery.receipt || !isDeepStrictEqual(delivery.receipt.result, delivery.result)) throw new Error(`${stage.id}: recovered delivery is invalid`);
    artifacts.set(stage.id, artifact(stage.resource, stage.id, delivery.receipt.tx_hash, delivery.result));
    deliveries.push(delivery);
  }
  if (recoverOnly) return { status: 'RECOVERED', independent, deliveries, next: workflow.steps[priorCount]?.id ?? null, new_payments: 0 };
  const remaining = workflow.steps.slice(priorCount);
  if (priorSource && remaining.length) {
    const preview = await budget({ workflow, remaining, provider, account: resources.account, publicKey: resources.publicKey });
    if (!Number.isSafeInteger(preview?.payments?.blocked) || preview.payments.blocked < 0) throw new Error('invalid workflow budget preview');
    if (preview.payments.blocked) return { status: 'BLOCKED', stage: 'budget-preview', independent, deliveries, preview };
  }
  const checkSourceAge = () => {
    if (kind === 'oracle') assertOracleFreshForUse(independent.delivery);
    if (kind === 'onchain-proof') assertOnchainProofResponseFresh(independent.delivery, workflow.source.output);
  };
  for (const template of remaining) {
    // Historical evidence can be replayed, but new purchases require a fresh
    // oracle or a recent local x402 receipt, including immediately before send.
    checkSourceAge();
    const stage = materializeWorkflowStep(template, artifacts);
    const result = await runResource({ ...common, goals: [stage], getQuote: resources.getQuote, account: resources.account, publicKey: resources.publicKey,
      execute: true, durablePayment: true, beforePayment: async request => {
        checkChallenge(stage, request);
        checkSourceAge();
        if (resources.beforePayment) await resources.beforePayment(request);
        checkSourceAge();
      }, beforeBroadcast: checkSourceAge });
    if (!result?.payments || !Array.isArray(result.deliveries)) throw new Error(`${stage.id}: invalid resource execution result`);
    if (result.payments.blocked || result.payments.deferred) return { status: 'BLOCKED', stage: stage.id, independent, deliveries, resource: result };
    const delivery = result.deliveries[0], stored = journal.get(stage.id);
    if (result.payments.paid !== 1 || result.deliveries.length !== 1 || delivery?.id !== stage.id || stored?.status !== 'completed' || stored.delivery?.status !== 'verified' ||
        !isDeepStrictEqual(stored.delivery.receipt, delivery.receipt) || !isDeepStrictEqual(delivery.receipt?.result, delivery.result)) throw new Error(`${stage.id}: resource delivery was not durably verified`);
    checkChallenge(stage, stored.request, true);
    artifacts.set(stage.id, artifact(stage.resource, stage.id, delivery.receipt.tx_hash, delivery.result));
    deliveries.push(delivery);
  }
  const current = journal.get(manifestId(workflow));
  if (!current || current.fingerprint !== fp) throw new Error('workflow intent disappeared; stop and reconcile');
  if (current.status !== 'completed') journal.put(manifestId(workflow), { ...current, status: 'completed', tx_hash: independent.delivery.tx_hash, completed_at: new Date().toISOString() });
  return { status: 'FULFILLED', independent, deliveries, new_source_payments: priorSource ? 0 : 1, new_resource_payments: deliveries.length - priorCount,
    note: 'testnet only; dependent steps are non-atomic and earlier payments cannot be rolled back' };
}

function home(value) { return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value; }
function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') out.help = true;
    else if (arg === '--execute') out.execute = true;
    else if (arg === '--recover-only') out.recoverOnly = true;
    else if (arg === '--redeem-source') out.redeemSource = true;
    else if (['--workflow', '--source-key', '--ft-key', '--journal', '--rpc', '--local-provider'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) {
      const name = arg.slice(2); if (out[name]) throw new Error(`duplicate ${arg}`); out[name] = args[++i];
    } else throw new Error(`unknown or incomplete argument: ${arg}`);
  }
  return out;
}
function accountFromFile(file, owner, provider) {
  const credentials = JSON.parse(fs.readFileSync(home(file), 'utf8'));
  if (credentials.account_id !== owner || typeof credentials.private_key !== 'string') throw new Error('agent key file does not match workflow owner');
  const key = nearApi.KeyPair.fromString(credentials.private_key);
  return { account: new MonotonicAccount(owner, provider, new nearApi.KeyPairSigner(key)), publicKey: key.getPublicKey() };
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node bouncer/agent/workflow.mjs --workflow FILE --journal FILE [--source-key KEY --ft-key KEY] [--rpc URL] [--local-provider CONFIG] [--execute | --recover-only [--redeem-source]]');
    console.log('Dry run by default. --execute spends testnet funds; --recover-only uses the original journal without NEAR signing keys or new payments. No real funds.');
    console.log('Encrypted file journals require their separate BOUNCER_FILE_JOURNAL_KEY_FILE on execution and recovery.');
    console.log('--redeem-source explicitly permits the first, previously unattempted paid x402 seller request; never retries an attempted request.');
    console.log('A source key is required only for a new source; an FT key is required to resume unpaid resource steps.'); return;
  }
  if (!options.workflow || !options.journal || (options.execute && options.recoverOnly) || (options.redeemSource && !options.recoverOnly) ||
      (options.recoverOnly && (options['source-key'] || options['ft-key'])) || (!options.recoverOnly && !options['ft-key'])) {
    throw new Error('provide --workflow and --journal; supply --ft-key except with --recover-only without signing keys or --execute; see --help');
  }
  const workflow = validateWorkflow(JSON.parse(fs.readFileSync(home(options.workflow), 'utf8'))), goal = workflow.source.goal;
  const state = path.resolve(home(options.journal));
  if (options.recoverOnly && !fs.existsSync(state)) throw new Error('original journal not found; recovery cannot create one');
  const provider = new PaymentRpcProvider(options.rpc || process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com');
  let journal, local, source = {}, ft = {};
  try {
    if (options.execute || options.recoverOnly || fs.existsSync(state)) journal = openConfiguredFileJournal(state, goal.contract_id, goal.owner_account_id);
    if (!options.recoverOnly) {
      if (!options['source-key'] && !journal?.get(goal.id)) throw new Error('a source key is required for an unpaid independent source');
      if (options['source-key']) source = accountFromFile(options['source-key'], goal.owner_account_id, provider);
      ft = accountFromFile(options['ft-key'], goal.owner_account_id, provider);
    }
    const overrides = new Map();
    if (options['local-provider']) {
      const config = JSON.parse(fs.readFileSync(home(options['local-provider']), 'utf8'));
      if (config.contract_id !== goal.contract_id || (config.owner_account_id ?? config.contract_id) !== goal.owner_account_id) throw new Error('local provider must match workflow owner and contract');
      local = await startConfiguredProvider(config);
      const configured = new URL(workflow.provider_url).origin;
      if (configured !== local.url && !(config.port === 0 && configured === 'http://127.0.0.1:0')) throw new Error('local provider URL differs from the reviewed workflow');
      overrides.set(configured, local.url);
    }
    const client = routedResourceProvider({ providerUrl: workflow.provider_url, goals: workflow.steps, overrides });
    const result = await runWorkflow({ workflow, source, resources: { ...ft, ...client }, provider, journal,
      execute: !!options.execute, recoverOnly: !!options.recoverOnly, redeemSource: !!options.redeemSource });
    console.log(`[workflow] ${result.status}${result.stage ? ` at ${result.stage}` : ''}; journal ${state}; ${result.note ?? 'no automatic repayment'}`);
    for (const check of result.preview?.checks ?? []) console.log(`[workflow] ${check.status} ${check.id}${check.reason ? `: ${check.reason}` : ''}`);
    if (result.deliveries) console.log(`[workflow] Verified resource steps: ${result.deliveries.map(item => item.id).join(', ') || 'none'}`);
    if (result.status === 'RECOVERED' || result.status === 'NOT_STARTED') console.log(`[workflow] Next unpaid step: ${result.next ?? 'none'}; recovery sent no payments`);
    if (!['READY', 'FULFILLED', 'RECOVERED', 'NOT_STARTED'].includes(result.status)) process.exitCode = 2;
  } finally { journal?.close(); if (local) await local.close(); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`[workflow] ERROR: ${error.message}`); process.exitCode = 1; });
}
