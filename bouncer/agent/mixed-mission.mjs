#!/usr/bin/env node
/**
 * One owner-controlled mission can buy a bounded independent OutLayer task
 * (native NEAR) and ordinary FT-backed resources from approved providers. The
 * model can supply the existing FT goals, but never chooses this mission's
 * financial authority or the separately pinned OutLayer program. Preview is
 * non-atomic; a paid resource cannot be rolled back if a later step fails.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { FileJournal } from './procurement.mjs';
import { MonotonicAccount } from './near-account.mjs';
import { runOutlayerGoal, recoverOutlayerGoal, validateOutlayerGoal } from './outlayer.mjs';
import { runOracleGoal, recoverOracleGoal, validateOracleGoal, assertOracleFreshForUse } from './oracle-outlayer.mjs';
import { runResourceAgent, routedResourceProvider } from './resource-agent.mjs';
import { startConfiguredProvider } from '../services/resource-provider.mjs';
import { validateRpcEndpoint } from '../shared/rpc-endpoint.mjs';

/**
 * Read-only preview of both asset paths before any new payment, then verify
 * the independent compute before the FT batch. Prior unresolved FT deliveries
 * block a NEW independent payment; once the independent payment is already
 * verified, the FT runner may recover its own previous delivery before paying
 * subsequent resources. Uses a shared local journal, not distributed locking.
 * The optional runners are dependency injection for offline tests, not an
 * authorization boundary; callers must use the real trusted implementations.
 */
export async function runMixedMission({ outlayer, resources, provider, journal, execute = false, log = console.log, runners = {} }) {
  const kind = outlayer?.kind ?? 'random';
  if (!['random', 'oracle'].includes(kind)) throw new Error('unsupported independent mission kind');
  const goal = kind === 'oracle' ? validateOracleGoal(outlayer?.goal) : validateOutlayerGoal(outlayer?.goal);
  if (!resources || resources.contractId !== goal.contract_id || resources.ownerAccountId !== goal.owner_account_id ||
      !Array.isArray(resources.goals) || !resources.goals.length) throw new Error('both mission paths must share the reviewed contract and owner');
  if (resources.beforePayment !== undefined && typeof resources.beforePayment !== 'function') throw new Error('invalid pre-payment guard');
  const ids = resources.goals.map(item => item?.id);
  if (ids.some(id => typeof id !== 'string' || !id || id === goal.id) || new Set(ids).size !== ids.length) {
    throw new Error('mission goal IDs must be distinct across both paths');
  }
  if (execute && (!journal || typeof journal.get !== 'function' || typeof journal.put !== 'function')) throw new Error('live mission requires a shared journal');
  if (journal && (typeof journal.get !== 'function' || typeof journal.put !== 'function')) throw new Error('invalid mission journal');
  const runExternal = runners.outlayer ?? (kind === 'oracle' ? runOracleGoal : runOutlayerGoal);
  const recoverExternal = runners.recover ?? (kind === 'oracle' ? recoverOracleGoal : recoverOutlayerGoal);
  const runFT = runners.resources ?? runResourceAgent;
  if ([runExternal, recoverExternal, runFT].some(fn => typeof fn !== 'function')) throw new Error('invalid mission runner');

  const previous = journal?.get(goal.id);
  if (!previous && journal) {
    for (const id of ids) {
      const entry = journal.get(id);
      if (entry && (entry.status !== 'completed' || entry.delivery?.status !== 'verified')) {
        throw new Error(`${id}: recover the earlier FT payment and delivery before a new independent payment`);
      }
    }
  }
  // A previously signed OutLayer transaction is always resolved by its same
  // hash, without a signing key. No paid work follows an unverified result.
  let independent;
  if (previous) {
    independent = await recoverExternal({ goal, provider, journal, update: execute, log });
    if (independent.status !== 'REUSED' || !independent.delivery) throw new Error('independent recovery did not verify delivery');
  } else {
    independent = await runExternal({ goal, provider, account: outlayer.account, publicKey: outlayer.publicKey, execute: false, log });
    if (independent.status === 'BLOCKED') return { status: 'BLOCKED', stage: 'independent-preflight', independent };
    if (independent.status !== 'READY') throw new Error('invalid independent preflight result');
  }

  const common = { ...resources, provider, journal, log };
  const preview = await runFT({ ...common, execute: false });
  if (!preview?.payments || !Number.isSafeInteger(preview.payments.blocked) || preview.payments.blocked < 0) throw new Error('invalid FT batch preview');
  if (preview.payments.blocked) return { status: 'BLOCKED', stage: 'ft-preflight', independent, resources: preview };
  if (!execute) return { status: 'READY', independent, resources: preview };
  if (!previous) {
    independent = await runExternal({ goal, provider, account: outlayer.account, publicKey: outlayer.publicKey, journal, execute: true, log });
    if (independent.status === 'BLOCKED') return { status: 'BLOCKED', stage: 'independent-execution', independent, resources: preview };
    if (!['FULFILLED', 'REUSED'].includes(independent.status) || !independent.delivery) throw new Error('independent delivery was not verified');
  }
  // Recovery establishes a historical payment, not freshness today. Refuse to
  // continue an oracle-led mission with an expired or future worker timestamp.
  // This still cannot establish that the external market data was accurate.
  if (kind === 'oracle') assertOracleFreshForUse(independent.delivery);
  // runResourceAgent repeats its non-atomic preview, recovers prior FT
  // deliveries first, and checks each paid result before the next FT payment.
  // A batch may take long enough for the oracle result to expire in between:
  // recheck it immediately before EACH new payment, including after any custom
  // async guard. This is an off-chain timing check, not authenticated market
  // freshness or an on-chain constraint.
  const delivered = await runFT({ ...common, execute: true, beforePayment: async request => {
    if (kind === 'oracle') assertOracleFreshForUse(independent.delivery);
    if (resources.beforePayment) await resources.beforePayment(request);
    if (kind === 'oracle') assertOracleFreshForUse(independent.delivery);
  } });
  if (!delivered?.payments || !Array.isArray(delivered.deliveries)) throw new Error('invalid FT batch result');
  const complete = !delivered.payments.blocked && !delivered.payments.deferred && delivered.deliveries.length === ids.length;
  return { status: complete ? 'FULFILLED' : 'INCOMPLETE', independent, resources: delivered };
}

function expandHome(value) { return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value; }
function parseArgs(args) {
  const options = { execute: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') options.help = true;
    else if (arg === '--execute') options.execute = true;
    else if (arg === '--durable') options.durable = true;
    else if (['--mission', '--ft-key', '--outlayer-key', '--journal', '--rpc', '--local-provider'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) {
      const name = arg.slice(2);
      if (options[name]) throw new Error(`duplicate ${arg}`);
      options[name] = args[++i];
    } else throw new Error(`unknown or incomplete argument: ${arg}`);
  }
  return options;
}
function accountFromFile(file, owner, provider) {
  const credentials = JSON.parse(fs.readFileSync(expandHome(file), 'utf8'));
  if (credentials.account_id !== owner || typeof credentials.private_key !== 'string') throw new Error('agent key file does not match the mission owner');
  const key = nearApi.KeyPair.fromString(credentials.private_key);
  return { account: new MonotonicAccount(owner, provider, new nearApi.KeyPairSigner(key)), publicKey: key.getPublicKey() };
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node bouncer/agent/mixed-mission.mjs --mission MISSION.json --ft-key FT_KEY.json --outlayer-key COMPUTE_KEY.json [--journal JOURNAL.json] [--rpc URL] [--local-provider CONFIG.json] [--execute] [--durable]');
    console.log('Default: non-atomic dry-run preflight. --execute spends testnet funds; --durable records direct FT hashes before broadcast.');
    return;
  }
  if (!options.mission || !options['ft-key'] || !options['outlayer-key']) throw new Error('--mission, --ft-key and --outlayer-key are required');
  const missionPath = path.resolve(expandHome(options.mission));
  const config = JSON.parse(fs.readFileSync(missionPath, 'utf8'));
  const kind = config?.outlayer_kind ?? 'random';
  if (!['random', 'oracle'].includes(kind)) throw new Error('unsupported independent mission kind');
  const goal = kind === 'oracle' ? validateOracleGoal(config?.outlayer_goal) : validateOutlayerGoal(config?.outlayer_goal);
  const resources = config?.resources;
  if (!resources || resources.contract_id !== goal.contract_id || resources.owner_account_id !== goal.owner_account_id || !Array.isArray(resources.goals)) {
    throw new Error('mission resources must name the same contract and owner as the OutLayer goal');
  }
  const provider = new nearApi.providers.JsonRpcProvider({ url: validateRpcEndpoint(options.rpc || process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com') });
  const ft = accountFromFile(options['ft-key'], goal.owner_account_id, provider);
  const outlayer = accountFromFile(options['outlayer-key'], goal.owner_account_id, provider);
  const journalPath = path.resolve(expandHome(options.journal || config.journal_path || `${missionPath}.bouncer-journal.json`));
  // Validate all remote origins before starting a local service.
  routedResourceProvider({ providerUrl: resources.provider_url, goals: resources.goals });
  let journal, local;
  try {
    const overrides = new Map();
    if (options['local-provider']) {
      const localConfig = JSON.parse(fs.readFileSync(expandHome(options['local-provider']), 'utf8'));
      if (localConfig.contract_id !== goal.contract_id || (localConfig.owner_account_id ?? localConfig.contract_id) !== goal.owner_account_id) {
        throw new Error('local provider must match the mission contract and owner');
      }
      local = await startConfiguredProvider(localConfig);
      const original = new URL(resources.provider_url).origin;
      const ephemeral = localConfig.port === 0 && original === 'http://127.0.0.1:0';
      if (original !== local.url && !ephemeral) throw new Error('local provider URL does not match the reviewed mission');
      overrides.set(original, local.url);
      console.log(`[mission] Local development provider: ${local.url}`);
    }
    const client = routedResourceProvider({ providerUrl: resources.provider_url, goals: resources.goals, overrides });
    if (options.execute || fs.existsSync(journalPath)) journal = new FileJournal(journalPath, goal.contract_id, goal.owner_account_id);
    const result = await runMixedMission({
      outlayer: { kind, goal, ...outlayer }, provider, journal, execute: options.execute,
      resources: { contractId: resources.contract_id, ownerAccountId: resources.owner_account_id, providerUrl: resources.provider_url,
        goals: resources.goals, getQuote: client.getQuote, fulfill: client.fulfill, readStorage: client.readStorage, durablePayment: options.durable === true, ...ft },
    });
    console.log(`[mission] ${result.status}; non-atomic testnet mission; journal ${journalPath}`);
    if (result.independent?.delivery) console.log(`[mission] Independent delivery: ${JSON.stringify(result.independent.delivery)}`);
    if (result.resources) console.log(`[mission] FT batch: ${JSON.stringify(result.resources.payments)}; deliveries=${result.resources.deliveries.length}`);
    if (result.status === 'BLOCKED' || result.status === 'INCOMPLETE') process.exitCode = 2;
  } finally {
    journal?.close();
    if (local) await new Promise(resolve => local.server.close(resolve));
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`[mission] ERROR: ${error.message}`); process.exitCode = 1; });
}
