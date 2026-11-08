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
import { openConfiguredFileJournal } from './procurement.mjs';
import { MonotonicAccount, PaymentRpcProvider } from './near-account.mjs';
import { runOutlayerGoal, recoverOutlayerGoal, validateOutlayerGoal } from './outlayer.mjs';
import { runOracleGoal, recoverOracleGoal, validateOracleGoal, assertOracleFreshForUse } from './oracle-outlayer.mjs';
import { runNativeStorageGoal, recoverNativeStorageGoal, validateNativeStorageGoal } from './native-storage.mjs';
import { runResourceAgent, routedResourceProvider } from './resource-agent.mjs';
import { startConfiguredProvider } from '../services/resource-provider.mjs';
import { withExclusiveJournalOperation } from './journal-operation.mjs';
import { assertJournalScope } from './journal-write.mjs';
import { readNativeJournal } from './synchronous-native-journal.mjs';

/**
 * One independent native-NEAR resource without an FT prerequisite. This is a
 * partial resource result, NOT a completed compute/storage/API mission. It
 * inherits the runner's one-shot original-hash journal and trusted-RPC/provider
 * assumptions. The journal must be the existing exclusive local journal;
 * this wrapper is not a distributed fence or a phone/device-key integration.
 */
export async function runNativeResource(options = {}) {
  return withExclusiveJournalOperation(options?.journal, scope => runNativeResourceUnlocked(options, scope), options?.exclusiveJournalScope);
}
async function runNativeResourceUnlocked({ outlayer, provider, journal, execute = false, log = console.log, beforeBroadcast, runners = {} }, operationScope) {
  if (journal?.sharedDirectV3 === true) throw new Error('shared buyer journal does not coordinate OutLayer payments');
  if (typeof execute !== 'boolean' || typeof log !== 'function' || (beforeBroadcast !== undefined && typeof beforeBroadcast !== 'function') ||
      !outlayer || !provider || !runners || typeof runners !== 'object') {
    throw new Error('invalid native resource request');
  }
  if (journal && (typeof journal.get !== 'function' || typeof journal.put !== 'function')) throw new Error('invalid native resource journal');
  if (execute && !journal) throw new Error('native execution requires the exclusive original-hash journal');
  const kind = outlayer.kind ?? 'random';
  if (!['random','oracle','storage'].includes(kind)) throw new Error('unsupported native resource kind');
  const goal = kind === 'oracle' ? validateOracleGoal(outlayer.goal) :
    kind === 'storage' ? validateNativeStorageGoal(outlayer.goal) : validateOutlayerGoal(outlayer.goal);
  assertJournalScope(journal, goal.contract_id, goal.owner_account_id);
  const defaultRun = kind === 'oracle' ? runOracleGoal : kind === 'storage' ? runNativeStorageGoal : runOutlayerGoal;
  const defaultRecover = kind === 'oracle' ? recoverOracleGoal : kind === 'storage' ? recoverNativeStorageGoal : recoverOutlayerGoal;
  const run = runners.outlayer ?? defaultRun, recover = runners.recover ?? defaultRecover;
  if (typeof run !== 'function' || typeof recover !== 'function') throw new Error('invalid native resource runner');
  // The private operation scope is passed only to built-in participants, never
  // to injected runners, providers, wallets or arbitrary callbacks.
  const runGuarded = args => run(run === defaultRun && args.journal != null ? { ...args, exclusiveJournalScope: operationScope } : args);
  const recoverGuarded = args => recover(recover === defaultRecover && args.journal != null ? { ...args, exclusiveJournalScope: operationScope } : args);
  const scope = kind === 'storage'
    ? 'One PUBLIC, self-hosted NEAR on-chain object; not an independent storage purchase or permanence proof.'
    : 'One independent native testnet resource only; not a full compute, storage and API/data mission.';
  const previous = journal ? readNativeJournal(journal, goal.id) : undefined;
  if (previous) {
    const independent = await recoverGuarded({goal,provider,journal,publicKey:outlayer.recoveryPublicKey,update:execute,log});
    if (independent?.status !== 'REUSED' || !independent.delivery) throw new Error('original native resource delivery is unresolved; never resend');
    let freshForUse = null;
    if (kind === 'oracle') { try { assertOracleFreshForUse(independent.delivery); freshForUse = true; } catch { freshForUse = false; } }
    return {status:'NATIVE_RESOURCE_REUSED',independent,resources:null,scope,oracle_fresh_for_use:freshForUse};
  }
  const args = {goal,provider,account:outlayer.account,publicKey:outlayer.publicKey,log,beforeBroadcast};
  const preview = await runGuarded({...args,execute:false});
  if (preview?.status === 'BLOCKED') return {status:'BLOCKED',stage:'native-preflight',independent:preview,resources:null,scope};
  if (preview?.status !== 'READY') throw new Error('invalid native resource preflight');
  if (!execute) return {status:'READY',independent:preview,resources:null,scope};
  // Recheck after the async preview. A newly recorded original must be
  // reconciled, not replaced with another signature or broadcast.
  if (readNativeJournal(journal, goal.id)) throw new Error('native original appeared during preflight; recover it, never resend');
  const independent = await runGuarded({...args,journal,execute:true});
  if (independent?.status === 'BLOCKED') return {status:'BLOCKED',stage:'native-execution',independent,resources:null,scope};
  if (!['FULFILLED','REUSED'].includes(independent?.status) || !independent.delivery) throw new Error('native delivery was not verified');
  let freshForUse = null;
  if (kind === 'oracle') { try { assertOracleFreshForUse(independent.delivery); freshForUse = true; } catch { freshForUse = false; } }
  return {status:independent.status === 'REUSED' ? 'NATIVE_RESOURCE_REUSED' : 'NATIVE_RESOURCE_FULFILLED',
    independent,resources:null,scope,oracle_fresh_for_use:freshForUse};
}

/**
 * Read-only preview of both asset paths before any new payment, then verify
 * the independent compute before the FT batch. Prior unresolved FT deliveries
 * block a NEW independent payment; once the independent payment is already
 * verified, the FT runner may recover its own previous delivery before paying
 * subsequent resources. Uses a shared local journal, not distributed locking.
 * The optional runners are dependency injection for offline tests, not an
 * authorization boundary; callers must use the real trusted implementations.
 */
export async function runMixedMission(options) {
  return withExclusiveJournalOperation(options?.journal, scope => runMixedMissionUnlocked(options, scope), options?.exclusiveJournalScope);
}
async function runMixedMissionUnlocked({ outlayer, resources, provider, journal, execute = false, log = console.log, runners = {} }, operationScope) {
  if (journal?.sharedDirectV3 === true) throw new Error('shared buyer journal does not coordinate mixed missions or OutLayer payments');
  const kind = outlayer?.kind ?? 'random';
  if (!['random', 'oracle'].includes(kind)) throw new Error('unsupported independent mission kind');
  const goal = kind === 'oracle' ? validateOracleGoal(outlayer?.goal) : validateOutlayerGoal(outlayer?.goal);
  assertJournalScope(journal, goal.contract_id, goal.owner_account_id);
  if (!resources || resources.contractId !== goal.contract_id || resources.ownerAccountId !== goal.owner_account_id ||
      !Array.isArray(resources.goals) || !resources.goals.length) throw new Error('both mission paths must share the reviewed contract and owner');
  resources = { ...resources, goals: structuredClone(resources.goals) };
  // The independent leg must not be paid only to discover later that the FT
  // leg cannot safely journal its seller-issued challenges.
  if (execute && resources.durablePayment !== true) {
    if (resources.goals.some(item => item?.order_binding === 'seller-v2')) throw new Error('seller-v2 mission execution requires durable signed-hash journaling');
    if (resources.goals.some(item => item?.order_binding === 'seller-v3')) throw new Error('seller-v3 mission execution requires durable signed-hash journaling');
  }
  if (resources.beforePayment !== undefined && typeof resources.beforePayment !== 'function') throw new Error('invalid pre-payment guard');
  const ids = resources.goals.map(item => item?.id);
  if (ids.some(id => typeof id !== 'string' || !id || id === goal.id) || new Set(ids).size !== ids.length) {
    throw new Error('mission goal IDs must be distinct across both paths');
  }
  if (execute && (!journal || typeof journal.get !== 'function' || typeof journal.put !== 'function')) throw new Error('live mission requires a shared journal');
  if (journal && (typeof journal.get !== 'function' || typeof journal.put !== 'function')) throw new Error('invalid mission journal');
  const defaultRun = kind === 'oracle' ? runOracleGoal : runOutlayerGoal;
  const defaultRecover = kind === 'oracle' ? recoverOracleGoal : recoverOutlayerGoal;
  const runExternal = runners.outlayer ?? defaultRun, recoverExternal = runners.recover ?? defaultRecover;
  const runFT = runners.resources ?? runResourceAgent;
  if ([runExternal, recoverExternal, runFT].some(fn => typeof fn !== 'function')) throw new Error('invalid mission runner');
  const callExternal = args => runExternal(runExternal === defaultRun && args.journal != null ? { ...args, exclusiveJournalScope: operationScope } : args);
  const callRecover = args => recoverExternal(recoverExternal === defaultRecover && args.journal != null ? { ...args, exclusiveJournalScope: operationScope } : args);
  const callFT = args => runFT(runFT === runResourceAgent && args.journal != null ? { ...args, exclusiveJournalScope: operationScope } : args);

  const previous = journal ? readNativeJournal(journal, goal.id) : undefined;
  if (!previous && journal) {
    for (const id of ids) {
      const entry = readNativeJournal(journal, id);
      if (entry && (entry.status !== 'completed' || entry.delivery?.status !== 'verified')) {
        throw new Error(`${id}: recover the earlier FT payment and delivery before a new independent payment`);
      }
    }
  }
  // A previously signed OutLayer transaction is always resolved by its same
  // hash, without a signing key. No paid work follows an unverified result.
  let independent;
  if (previous) {
    independent = await callRecover({ goal, provider, journal, update: execute, log });
    if (independent.status !== 'REUSED' || !independent.delivery) throw new Error('independent recovery did not verify delivery');
  } else {
    independent = await callExternal({ goal, provider, account: outlayer.account, publicKey: outlayer.publicKey, execute: false, log });
    if (independent.status === 'BLOCKED') return { status: 'BLOCKED', stage: 'independent-preflight', independent };
    if (independent.status !== 'READY') throw new Error('invalid independent preflight result');
  }

  const common = { ...resources, provider, journal, log };
  const preview = await callFT({ ...common, execute: false });
  if (!preview?.payments || !Number.isSafeInteger(preview.payments.blocked) || preview.payments.blocked < 0) throw new Error('invalid FT batch preview');
  if (preview.payments.blocked) return { status: 'BLOCKED', stage: 'ft-preflight', independent, resources: preview };
  if (!execute) return { status: 'READY', independent, resources: preview };
  if (!previous) {
    independent = await callExternal({ goal, provider, account: outlayer.account, publicKey: outlayer.publicKey, journal, execute: true, log });
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
  const delivered = await callFT({ ...common, execute: true, beforePayment: async request => {
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
    else if (arg === '--recover-only') options.recoverOnly = true;
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
    console.log('Usage: node bouncer/agent/mixed-mission.mjs --mission MISSION.json --outlayer-key COMPUTE_KEY.json [--ft-key FT_KEY.json] [--journal JOURNAL.json] [--rpc URL] [--local-provider CONFIG.json] [--execute] [--durable] | --mission MISSION.json --recover-only [--journal JOURNAL.json] [--rpc URL]');
    console.log('FT key is required only when the mission includes FT resources. Native-only is one resource, not a full mission.');
    console.log('--recover-only is native-only and reads the original journal without signing keys or new payments.');
    console.log('Default: non-atomic dry-run preflight. --execute spends testnet funds; --durable records direct FT hashes before broadcast.');
    return;
  }
  if (!options.mission || (!options.recoverOnly && !options['outlayer-key'])) throw new Error('--mission and --outlayer-key are required');
  if (options.recoverOnly && (options.execute || options.durable || options['ft-key'] || options['outlayer-key'] || options['local-provider'])) {
    throw new Error('--recover-only must run without signing keys, execution or local provider');
  }
  const missionPath = path.resolve(expandHome(options.mission));
  const config = JSON.parse(fs.readFileSync(missionPath, 'utf8'));
  const kind = config?.outlayer_kind ?? 'random';
  if (!['random', 'oracle'].includes(kind)) throw new Error('unsupported independent mission kind');
  const goal = kind === 'oracle' ? validateOracleGoal(config?.outlayer_goal) : validateOutlayerGoal(config?.outlayer_goal);
  const resources = config?.resources;
  if (resources !== undefined && (!resources || resources.contract_id !== goal.contract_id ||
      resources.owner_account_id !== goal.owner_account_id || !Array.isArray(resources.goals) || !resources.goals.length)) {
    throw new Error('mission resources must name the same contract and owner as the OutLayer goal');
  }
  if (options.recoverOnly && resources) throw new Error('--recover-only currently supports native-only missions');
  if (resources && !options['ft-key']) throw new Error('--ft-key is required when the mission includes FT resources');
  if (!resources && (options['ft-key'] || options['local-provider'] || options.durable)) {
    throw new Error('FT and local-provider options require mission resources');
  }
  const provider = new PaymentRpcProvider(options.rpc || process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com');
  const ft = resources ? accountFromFile(options['ft-key'], goal.owner_account_id, provider) : null;
  const outlayer = options.recoverOnly ? {} : accountFromFile(options['outlayer-key'], goal.owner_account_id, provider);
  const journalPath = path.resolve(expandHome(options.journal || config.journal_path || `${missionPath}.bouncer-journal.json`));
  // Validate all remote origins before starting a local service.
  if (resources) routedResourceProvider({ providerUrl: resources.provider_url, goals: resources.goals });
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
    const client = resources ? routedResourceProvider({ providerUrl: resources.provider_url, goals: resources.goals, overrides }) : null;
    if (options.recoverOnly && !fs.existsSync(journalPath)) throw new Error('original journal not found; no payment was sent');
    if (options.execute || fs.existsSync(journalPath)) {
      journal = openConfiguredFileJournal(journalPath, goal.contract_id, goal.owner_account_id, { requireExisting: !options.execute });
    }
    if (options.recoverOnly && !journal?.get(goal.id)) throw new Error('native original not found in journal; no payment was sent');
    const common = {outlayer: { kind, goal, ...outlayer }, provider, journal, execute: options.execute};
    const result = resources ? await runMixedMission({ ...common,
      resources: { contractId: resources.contract_id, ownerAccountId: resources.owner_account_id, providerUrl: resources.provider_url,
        goals: resources.goals, getQuote: client.getQuote, fulfill: client.fulfill, readStorage: client.readStorage, durablePayment: options.durable === true, ...ft },
    }) : await runNativeResource(common);
    console.log(`[mission] ${result.status}; non-atomic testnet mission; journal ${journalPath}`);
    if (result.independent?.delivery) console.log(`[mission] Independent delivery: ${JSON.stringify(result.independent.delivery)}`);
    if (result.resources) console.log(`[mission] FT batch: ${JSON.stringify(result.resources.payments)}; deliveries=${result.resources.deliveries.length}`);
    if (result.scope) console.log(`[mission] ${result.scope}`);
    if (result.status === 'BLOCKED' || result.status === 'INCOMPLETE') process.exitCode = 2;
  } finally {
    journal?.close();
    if (local) await local.close();
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`[mission] ERROR: ${error.message}`); process.exitCode = 1; });
}
