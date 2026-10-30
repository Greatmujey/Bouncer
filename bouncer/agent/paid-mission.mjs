#!/usr/bin/env node
/**
 * Testnet mission: an exact owner-pinned OutLayer prepaid deposit, a narrowly
 * pinned paid connector-probe, then verified FT compute/storage/API resources.
 * Every stage uses its own restricted key and one journal. Preflights are
 * non-atomic; later failures cannot undo earlier payments. This is not a
 * commercial API, Circle USDC, distributed transaction or agent swarm.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { FileJournal } from './procurement.mjs';
import { MonotonicAccount } from './near-account.mjs';
import { runFtCallGoal, recoverFtCallGoal, validateFtCallGoal } from './ft-call.mjs';
import { runProjectGoal, recoverProjectGoal, validateProjectGoal } from './outlayer-project.mjs';
import { runResourceAgent, routedResourceProvider } from './resource-agent.mjs';
import { startConfiguredProvider } from '../services/resource-provider.mjs';
import { validateRpcEndpoint } from '../shared/rpc-endpoint.mjs';

const OUTLAYER = 'outlayer.testnet', DEPOSIT = '{"action":"deposit_balance"}';
function validateMission(funding, project, resources) {
  const fund = validateFtCallGoal(funding?.goal), paid = validateProjectGoal(project?.goal);
  if (fund.contract_id !== paid.contract_id || fund.owner_account_id !== paid.owner_account_id || fund.payee !== OUTLAYER ||
      fund.token !== paid.route.project.token || fund.msg !== DEPOSIT || BigInt(fund.amount) > BigInt(paid.route.project.attached_usd)) {
    throw new Error('funding must match the reviewed project owner, token, provider and deposit action, and cannot exceed the fee');
  }
  if (!resources || resources.contractId !== paid.contract_id || resources.ownerAccountId !== paid.owner_account_id ||
      !Array.isArray(resources.goals) || !resources.goals.length) throw new Error('resource goals must share the mission contract and owner');
  const ids = [fund.id, paid.id, ...resources.goals.map(g => g?.id)];
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw new Error('mission goal IDs must be distinct');
  return { fund, paid, resourceIds: ids.slice(2) };
}
function validSettlement(result, goal) {
  return ['SETTLED', 'REUSED'].includes(result?.status) && result.settlement?.token === goal.token &&
    result.settlement?.receiver === goal.payee && result.settlement?.requested === goal.amount &&
    result.settlement?.used === goal.amount && result.settlement?.unused === '0';
}
async function providerCredit(provider, contractId) {
  const value = await provider.callFunction(OUTLAYER, 'get_user_stablecoin_balance', { account_id: contractId }, { finality: 'final' });
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,38})$/.test(value) || BigInt(value) > (1n << 128n) - 1n) return null;
  return BigInt(value);
}

/** Reusable testnet path; injected runners exist only for offline tests. */
export async function runPaidProjectMission({ funding, project, resources, provider, journal, execute = false, log = console.log, runners = {} }) {
  const { fund, paid, resourceIds } = validateMission(funding, project, resources);
  if (execute && (!journal || typeof journal.get !== 'function' || typeof journal.put !== 'function')) throw new Error('live mission requires the original shared journal');
  if (journal && (typeof journal.get !== 'function' || typeof journal.put !== 'function')) throw new Error('invalid mission journal');
  const runFunding = runners.funding ?? runFtCallGoal, recoverFunding = runners.recoverFunding ?? recoverFtCallGoal;
  const runProject = runners.project ?? runProjectGoal, recoverProject = runners.recoverProject ?? recoverProjectGoal;
  const runResources = runners.resources ?? runResourceAgent;
  if ([runFunding, recoverFunding, runProject, recoverProject, runResources].some(fn => typeof fn !== 'function')) throw new Error('invalid mission runner');
  const prevFunding = journal?.get(fund.id), prevProject = journal?.get(paid.id);
  // Do not initiate new independent payments when an earlier development
  // resource payment/delivery is unresolved. Project recovery is read-only.
  if (!prevProject && journal) for (const id of resourceIds) {
    const entry = journal.get(id);
    if (entry && (entry.status !== 'completed' || entry.delivery?.status !== 'verified')) throw new Error(`${id}: recover the earlier FT payment and delivery before independent payment`);
  }
  let funded = null, independent = null;
  if (prevFunding) {
    funded = await recoverFunding({ goal: fund, provider, journal, update: execute, log });
    if (!validSettlement(funded, fund)) return { status: 'BLOCKED', stage: 'funding-settlement', funding: funded };
  }
  if (prevProject) {
    independent = await recoverProject({ goal: paid, provider, journal, update: execute, log });
    if (independent?.status !== 'REUSED' || !independent.delivery) throw new Error('project recovery did not verify delivery');
  } else {
    independent = await runProject({ goal: paid, provider, account: project.account, publicKey: project.publicKey, execute: false, log });
    if (independent?.status === 'BLOCKED') return { status: 'BLOCKED', stage: 'project-preflight', independent };
    if (!['READY', 'FUNDING_REQUIRED'].includes(independent?.status)) throw new Error('invalid project preflight');
    // Compare both the conservative Bouncer ledger and the independent
    // provider's actual view BEFORE sending any top-up. A discrepancy may
    // reflect a provider-held refund; never create excess stranded credit.
    const credit = await providerCredit(provider, paid.contract_id);
    if (credit === null) return { status: 'BLOCKED', stage: 'provider-credit', independent };
    const fee = BigInt(paid.route.project.attached_usd), actualShortfall = credit < fee ? fee - credit : 0n;
    if (independent.status === 'FUNDING_REQUIRED') {
      if (prevFunding) return { status: 'BLOCKED', stage: 'provider-credit', funding: funded, independent };
      if (typeof independent.shortfall !== 'string' || !/^[1-9][0-9]{0,38}$/.test(independent.shortfall) ||
          BigInt(independent.shortfall) !== BigInt(fund.amount)) {
        return { status: 'BLOCKED', stage: 'funding-plan-mismatch', independent };
      }
      if (actualShortfall !== BigInt(fund.amount)) return { status: 'BLOCKED', stage: 'provider-credit-mismatch', independent };
      funded = await runFunding({ goal: fund, provider, account: funding.account, publicKey: funding.publicKey, execute: false, log });
      if (funded?.status === 'BLOCKED') return { status: 'BLOCKED', stage: 'funding-preflight', funding: funded, independent };
      if (funded?.status !== 'READY') throw new Error('invalid funding preflight');
    } else if (actualShortfall !== 0n) return { status: 'BLOCKED', stage: 'provider-credit', independent };
  }
  const common = { ...resources, provider, journal, log };
  const preview = await runResources({ ...common, execute: false });
  if (!preview?.payments || !Number.isSafeInteger(preview.payments.blocked) || preview.payments.blocked < 0) throw new Error('invalid resource preflight');
  if (preview.payments.blocked) return { status: 'BLOCKED', stage: 'resource-preflight', funding: funded, independent, resources: preview };
  if (!execute) return { status: 'READY', funding: funded, independent, resources: preview, note: 'project may still require the explicitly planned funding; previews do not reserve funds' };
  if (!prevProject) {
    if (independent.status === 'FUNDING_REQUIRED') {
      funded = await runFunding({ goal: fund, provider, account: funding.account, publicKey: funding.publicKey, journal, execute: true, log });
      if (funded?.status === 'BLOCKED') return { status: 'BLOCKED', stage: 'funding-execution', funding: funded, independent, resources: preview };
      if (!validSettlement(funded, fund)) return { status: 'BLOCKED', stage: 'funding-settlement', funding: funded, independent, resources: preview };
    }
    // A final view is evidence that the independent provider reports enough
    // credit, not a reservation; the provider can still change afterward.
    const balance = await providerCredit(provider, paid.contract_id);
    if (balance === null || balance < BigInt(paid.route.project.attached_usd)) {
      return { status: 'BLOCKED', stage: 'provider-credit', funding: funded, independent, resources: preview };
    }
    independent = await runProject({ goal: paid, provider, account: project.account, publicKey: project.publicKey, journal, execute: true, log });
    if (independent?.status === 'BLOCKED') return { status: 'BLOCKED', stage: 'project-execution', funding: funded, independent, resources: preview };
    if (!['FULFILLED', 'REUSED'].includes(independent?.status) || !independent.delivery) throw new Error('independent project delivery was not verified');
  }
  const delivered = await runResources({ ...common, execute: true });
  if (!delivered?.payments || !Array.isArray(delivered.deliveries)) throw new Error('invalid resource execution result');
  const complete = !delivered.payments.blocked && !delivered.payments.deferred && delivered.deliveries.length === resourceIds.length;
  return { status: complete ? 'FULFILLED' : 'INCOMPLETE', funding: funded, independent, resources: delivered };
}

function home(value) { return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value; }
function parseArgs(args) {
  const options = { execute: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') options.help = true;
    else if (args[i] === '--execute') options.execute = true;
    else if (args[i] === '--durable') options.durable = true;
    else if (['--mission', '--funding-key', '--project-key', '--ft-key', '--journal', '--rpc', '--local-provider'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) {
      const name = args[i].slice(2); if (options[name]) throw new Error(`duplicate ${args[i]}`); options[name] = args[++i];
    } else throw new Error(`unknown or incomplete argument: ${args[i]}`);
  }
  return options;
}
function accountFromFile(file, owner, provider) {
  const credentials = JSON.parse(fs.readFileSync(home(file), 'utf8'));
  if (credentials.account_id !== owner || typeof credentials.private_key !== 'string') throw new Error('agent key file does not match the owner');
  const key = nearApi.KeyPair.fromString(credentials.private_key);
  return { account: new MonotonicAccount(owner, provider, new nearApi.KeyPairSigner(key)), publicKey: key.getPublicKey() };
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node bouncer/agent/paid-mission.mjs --mission MISSION.json --funding-key KEY.json --project-key KEY.json --ft-key KEY.json [--journal JOURNAL.json] [--rpc URL] [--local-provider CONFIG.json] [--execute] [--durable]');
    console.log('Testnet only; default is a non-atomic dry run. --durable records direct FT hashes before broadcast. Independent probe is not a commercial API.'); return;
  }
  if (!options.mission || !options['funding-key'] || !options['project-key'] || !options['ft-key']) throw new Error('provide --mission, --funding-key, --project-key and --ft-key');
  const missionPath = path.resolve(home(options.mission)), config = JSON.parse(fs.readFileSync(missionPath, 'utf8'));
  const paid = validateProjectGoal(config?.project_goal), fund = validateFtCallGoal(config?.funding_goal), resources = config?.resources;
  if (!resources || resources.contract_id !== paid.contract_id || resources.owner_account_id !== paid.owner_account_id || !Array.isArray(resources.goals)) throw new Error('mission resources must name the same contract and owner');
  const provider = new nearApi.providers.JsonRpcProvider({ url: validateRpcEndpoint(options.rpc || process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com') });
  const funding = accountFromFile(options['funding-key'], paid.owner_account_id, provider);
  const project = accountFromFile(options['project-key'], paid.owner_account_id, provider);
  const ft = accountFromFile(options['ft-key'], paid.owner_account_id, provider);
  const journalPath = path.resolve(home(options.journal || config.journal_path || `${missionPath}.bouncer-journal.json`));
  routedResourceProvider({ providerUrl: resources.provider_url, goals: resources.goals });
  let journal, local;
  try {
    const overrides = new Map();
    if (options['local-provider']) {
      const localConfig = JSON.parse(fs.readFileSync(home(options['local-provider']), 'utf8'));
      if (localConfig.contract_id !== paid.contract_id || (localConfig.owner_account_id ?? localConfig.contract_id) !== paid.owner_account_id) throw new Error('local provider must match contract and owner');
      local = await startConfiguredProvider(localConfig);
      const original = new URL(resources.provider_url).origin;
      const ephemeral = localConfig.port === 0 && original === 'http://127.0.0.1:0';
      if (original !== local.url && !ephemeral) throw new Error('local provider URL does not match the reviewed mission');
      overrides.set(original, local.url);
    }
    const client = routedResourceProvider({ providerUrl: resources.provider_url, goals: resources.goals, overrides });
    if (options.execute || fs.existsSync(journalPath)) journal = new FileJournal(journalPath, paid.contract_id, paid.owner_account_id);
    const result = await runPaidProjectMission({ funding: { goal: fund, ...funding }, project: { goal: paid, ...project }, provider, journal, execute: options.execute,
      resources: { contractId: resources.contract_id, ownerAccountId: resources.owner_account_id, providerUrl: resources.provider_url,
        goals: resources.goals, getQuote: client.getQuote, fulfill: client.fulfill, readStorage: client.readStorage, durablePayment: options.durable === true, ...ft } });
    console.log(`[paid-mission] ${result.status}; non-atomic testnet mission; journal ${journalPath}`);
    if (result.independent?.delivery) console.log(`[paid-mission] Independent probe: ${JSON.stringify(result.independent.delivery)}`);
    if (result.resources) console.log(`[paid-mission] FT batch: ${JSON.stringify(result.resources.payments)}; deliveries=${result.resources.deliveries.length}`);
    if (result.status !== 'READY' && result.status !== 'FULFILLED') process.exitCode = 2;
  } finally { journal?.close(); if (local) await new Promise(resolve => local.server.close(resolve)); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`[paid-mission] ERROR: ${error.message}`); process.exitCode = 1; });
}
