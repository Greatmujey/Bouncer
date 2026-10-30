// Optional REAL NEAR testnet multi-token integration check. It creates two
// synthetic testnet credit tokens with the NEAR FT factory plus wNEAR, and
// sends payments to three vendor accounts through the procurement runner.
// Tokens and transfers are on-chain. A self-hosted development provider delivers
// simple compute, local storage and a text API; it is not a commercial vendor.
// This is not a stablecoin or mainnet demo.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import nearApi from 'near-api-js';
import { FileJournal } from './agent/procurement.mjs';
import { createResourceProvider, orderMemo } from './services/resource-provider.mjs';
import { fetchPublicRepository } from './services/github-data.mjs';
import { httpResourceProvider, routedResourceProvider, runResourceAgent } from './agent/resource-agent.mjs';
import { createModelClient, goalsFromModel, planObjective } from './agent/goal-planner.mjs';
import { compareApprovedQuotes } from './agent/quote-comparison.mjs';
import { validateRpcEndpoint } from './shared/rpc-endpoint.mjs';
import { waitForNewTestnetKey } from './shared/testnet-ready.mjs';
import { MonotonicAccount } from './agent/near-account.mjs';
import { RANDOM_TESTNET_PROGRAM } from './agent/outlayer.mjs';
import { runMixedMission } from './agent/mixed-mission.mjs';

const { KeyPair, KeyPairSigner, providers, transactions } = nearApi;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY_DIR = path.join(os.homedir(), '.near-credentials', 'testnet');
const RUN_DIR = path.join(os.homedir(), '.bouncer', 'testnet');
const RPC = process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com';
const HELPER = 'https://helper.testnet.near.org/account';
const FACTORY = 'token.primitives.testnet';
const WNEAR = 'wrap.testnet';
const N = 10n ** 24n;
const CREDIT = 10n ** 6n;
const T = 10n ** 12n;
const GAS50 = 50n * T;
const GAS100 = 100n * T;
const GAS200 = 200n * T;
const GAS300 = 300n * T;
const STORAGE_WNEAR = 1_250_000_000_000_000_000_000n;
const ICON = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const provider = new providers.JsonRpcProvider({ url: validateRpcEndpoint(RPC) });
const account = (id, key) => new MonotonicAccount(id, provider, new KeyPairSigner(key));
const txUrl = hash => `https://testnet.nearblocks.io/txns/${hash}?network=testnet`;
const view = (id, method, args) => provider.callFunction(id, method, args, { finality: 'final' });

function saveKey(id, key, label = '') {
  fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(KEY_DIR, `${id}${label ? `.${label}` : ''}.json`);
  fs.writeFileSync(file, JSON.stringify({ account_id: id, public_key: key.getPublicKey().toString(), private_key: key.toString() }, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}
async function createFunded(id, key) {
  const response = await fetch(HELPER, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newAccountId: id, newAccountPublicKey: key.getPublicKey().toString() }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`testnet helper ${response.status}: ${await response.text()}`);
  await response.json();
  await waitForNewTestnetKey(provider, id, key.getPublicKey());
  saveKey(id, key);
  return account(id, key);
}
function assertReceipts(result, action) {
  if (!Array.isArray(result.receipts_outcome) || !result.receipts_outcome.length) throw new Error(`${action}: no receipt outcomes`);
  const failure = result.receipts_outcome.find(item => item.outcome?.status?.Failure);
  if (failure) throw new Error(`${action}: receipt failed: ${JSON.stringify(failure.outcome.status.Failure)}`);
}
// This wrapper is used ONLY while constructing fresh testnet demo accounts,
// tokens and policies. An explicit Expired RPC error means pre-admission
// rejection. Never retry timeouts, receipt outcomes, or procurement payments.
async function setupAttempt(description, operation) {
  try { return await operation(); }
  catch (error) {
    if (error?.type !== 'Expired' || error.transaction_outcome !== undefined) throw error;
    console.warn(`    Testnet demo setup ${description}: explicit expired transaction; retrying once.`);
    return operation();
  }
}
async function call(signer, contractId, methodName, args, deposit = 0n, gas = GAS100) {
  const result = await setupAttempt(methodName, () => signer.callFunctionRaw({ contractId, methodName, args, deposit, gas, waitUntil: 'FINAL' }));
  assertReceipts(result, methodName);
  console.log(`    ✅ ${methodName}  ${txUrl(result.transaction_outcome.id)}`);
  return result;
}
function exact(actual, expected, label) {
  if (BigInt(actual) !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}
async function register(signer, tokenId, accountId) {
  const bounds = await view(tokenId, 'storage_balance_bounds', {});
  if (!bounds?.min) throw new Error(`${tokenId} did not return storage bounds`);
  await call(signer, tokenId, 'storage_deposit', { account_id: accountId, registration_only: true }, BigInt(bounds.min), GAS50);
}
async function createToken(funder, ownerId, symbol, name) {
  const args = { owner_id: ownerId, total_supply: (1_000n * CREDIT).toString(), metadata: {
    spec: 'ft-1.0.0', name, symbol, icon: ICON, decimals: 6,
  } };
  const required = await view(FACTORY, 'get_required', { args });
  if (!/^[0-9]+$/.test(String(required)) || BigInt(required) <= 0n) throw new Error('FT factory returned an invalid deposit quote');
  const tokenId = `${symbol.toLowerCase()}.${FACTORY}`;
  console.log(`\n    Create test token ${tokenId}; deposit ${required} yoctoNEAR`);
  await call(funder, FACTORY, 'create_token', { args }, BigInt(required), GAS300);
  const metadata = await view(tokenId, 'ft_metadata', {});
  if (metadata?.symbol !== symbol || metadata?.decimals !== 6) throw new Error(`unexpected metadata for ${tokenId}`);
  exact(await view(tokenId, 'ft_balance_of', { account_id: ownerId }), 1_000n * CREDIT, `${symbol} initial supply`);
  return tokenId;
}

async function main() {
  console.log('BOUNCER — REAL testnet multi-token payment check');
  console.log('wNEAR + two synthetic test tokens; fulfillment uses a self-hosted development provider, not commercial vendors.\n');
  const wasmPath = path.join(ROOT, 'bouncer.wasm');
  if (!fs.existsSync(wasmPath)) throw new Error('bouncer.wasm missing');
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report the NEAR testnet chain');
  const suffix = crypto.randomBytes(4).toString('hex');
  const bid = `bouncer-${suffix}.testnet`;
  const funderId = `bouncer-ft-${suffix}.testnet`;
  const userId = `user.${bid}`;
  const separateOwnerDemo = process.env.BOUNCER_DEMO_SEPARATE_OWNER === '1';
  const ownerId = separateOwnerDemo ? userId : bid;
  const externalDemo = process.env.BOUNCER_DEMO_OUTLAYER === '1';
  if (externalDemo && !separateOwnerDemo) throw new Error('independent provider mission requires the separate-owner demo');
  const compareDemo = process.env.BOUNCER_DEMO_COMPARE === '1';
  const badDeliveryDemo = process.env.BOUNCER_DEMO_BAD_DELIVERY === '1';
  if (badDeliveryDemo && !compareDemo) throw new Error('delivery verification probe requires provider comparison');
  const vendorIds = { compute: `compute.${bid}`, storage: `storage.${bid}`, api: `api.${bid}`,
    ...(compareDemo ? { computeAlt: `compute-alt.${bid}` } : {}) };
  const storageSymbol = `BS${suffix}`.toUpperCase();
  const apiSymbol = `BA${suffix}`.toUpperCase();
  let aiGoals, aiDataGoal, aiComparisonInput;
  const publicDataDemo = process.env.BOUNCER_DEMO_PUBLIC_DATA === '1';
  if (publicDataDemo && process.env.BOUNCER_DEMO_AI !== '1') throw new Error('public-data demo requires model planning');
  if (process.env.BOUNCER_DEMO_AI === '1') {
    // Do inference and independently check the requested literals BEFORE
    // creating/funding accounts. The model cannot set any financial fields.
    const expectedInputs = {
      compute: { text: 'near-hub compute job', rounds: 1000 },
      storage: { name: 'bouncer-note', content: 'Persisted by the Bouncer testnet provider.' },
      api: { text: 'actual testnet resource API' },
    };
    const limits = [
      ['compute', 'compute-wnear', WNEAR, N / 10n],
      ['storage', 'storage-credit', `${storageSymbol.toLowerCase()}.${FACTORY}`, 3n * CREDIT / 2n],
      ['api', 'api-credit', `${apiSymbol.toLowerCase()}.${FACTORY}`, 2n * CREDIT],
    ];
    const config = { version: 1, contract_id: bid, owner_account_id: ownerId, provider_url: 'http://127.0.0.1:8787',
      max_tasks: 3, required_resources: ['compute', 'storage', 'api'], resources: Object.fromEntries(limits.map(([resource, policyId, token, amount]) => [resource, {
        policy_id: policyId, token, payee: vendorIds[resource], max_amount: amount.toString(), max_tasks: 1, max_total_amount: amount.toString(),
      }])) };
    const objective = 'Perform these three tasks: Hash the text "near-hub compute job" for exactly 1000 SHA-256 rounds. Store the exact content "Persisted by the Bouncer testnet provider." with the name "bouncer-note". Count the words and bytes in "actual testnet resource API".';
    console.log('=== 0) Ask the configured model to plan the three resource tasks ===');
    const localModel = createModelClient({ endpoint: process.env.BOUNCER_LLM_URL, model: process.env.BOUNCER_LLM_MODEL, apiKey: process.env.BOUNCER_LLM_API_KEY || undefined });
    // This demo uses public synthetic text. Exposing its proposed inputs helps
    // diagnose model failures; the general CLI never logs raw model output.
    const modelClient = async request => {
      const proposed = await localModel(request);
      console.log(`    Model proposal for the synthetic demo: ${JSON.stringify(proposed).slice(0, 2000)}`);
      return proposed;
    };
    const result = await planObjective({ objective, config, modelClient });
    for (const goal of result.goals) {
      if (JSON.stringify(goal.input) !== JSON.stringify(expectedInputs[goal.resource])) {
        // The objective and planned inputs in this demo are public synthetic text.
        throw new Error(`model did not reproduce the requested ${goal.resource} inputs: ${JSON.stringify(goal.input)}`);
      }
    }
    aiGoals = result.goals;
    console.log('    ✅ Model proposed the three requested inputs; owner-pinned policies, tokens, payees and budgets remain outside its control.');
    if (publicDataDemo) {
      const dataConfig = { ...config, max_tasks: 1, required_resources: ['api'], resources: { api: config.resources.api } };
      const dataObjective = 'Fetch public GitHub repository metadata. The owner is "near" and the repository name is "near-api-js". The exact owner/name is "near/near-api-js".';
      let dataPlan = await planObjective({ objective: dataObjective, config: dataConfig, modelClient });
      const correct = plan => plan.goals[0].resource === 'api' && JSON.stringify(plan.goals[0].input) === JSON.stringify({ repo: 'near/near-api-js' });
      if (!correct(dataPlan)) {
        // A single model-only correction is safe before account creation. Never
        // retry malformed/unauthorized output or any transaction automatically.
        console.log('    Model selected the wrong repository; requesting one correction before any testnet setup.');
        const correction = `${dataObjective} The previous repository identifier was wrong. Retry: the entire input.repo must be exactly "near/near-api-js".`;
        dataPlan = await planObjective({ objective: correction, config: dataConfig, modelClient });
      }
      const proposed = dataPlan.goals[0];
      if (!correct(dataPlan)) throw new Error(`model did not select the requested public repository: ${JSON.stringify(proposed.input)}`);
      // An owner-assigned ID avoids collision with the earlier API goal in the
      // same journal. The model cannot choose IDs or payment destinations.
      aiDataGoal = { ...proposed, id: 'api-github-1' };
      console.log('    ✅ Model also proposed the requested public GitHub data lookup.');
    }
    if (compareDemo) {
      const comparisonConfig = { ...config, max_tasks: 1, required_resources: ['compute'], resources: { compute: config.resources.compute } };
      const comparisonObjective = 'Hash the exact text "compare development providers" using exactly 3 SHA-256 rounds.';
      const expected = { text: 'compare development providers', rounds: 3 };
      let comparisonPlan = await planObjective({ objective: comparisonObjective, config: comparisonConfig, modelClient });
      const correct = plan => plan.goals[0].resource === 'compute' && JSON.stringify(plan.goals[0].input) === JSON.stringify(expected);
      if (!correct(comparisonPlan)) {
        // A model-only correction is safe before setup; never retry a payment.
        console.log('    Model selected the wrong comparison task; requesting one correction before any testnet setup.');
        comparisonPlan = await planObjective({ objective: `${comparisonObjective} Use input.text exactly "compare development providers" and input.rounds exactly 3.`,
          config: comparisonConfig, modelClient });
      }
      if (!correct(comparisonPlan)) throw new Error(`model did not reproduce the comparison task: ${JSON.stringify(comparisonPlan.goals[0].input)}`);
      aiComparisonInput = comparisonPlan.goals[0].input;
      console.log('    ✅ Model also proposed the comparison compute task before testnet setup.');
    }
  }
  const bouncerKey = KeyPair.fromRandom('ed25519');
  const funderKey = KeyPair.fromRandom('ed25519');
  console.log(`=== 1) Create funded Bouncer ${bid} and test-token funder ===`);
  const bouncer = await createFunded(bid, bouncerKey);
  const funder = await createFunded(funderId, funderKey);
  fs.writeFileSync(path.join(os.homedir(), '.bouncer_id'), bid);
  const deploy = await setupAttempt('deploy', () => bouncer.deployContract(fs.readFileSync(wasmPath)));
  assertReceipts(deploy, 'deploy');
  console.log(`    ✅ deploy ${txUrl(deploy.transaction_outcome.id)}`);
  await call(bouncer, bid, 'new', { owner: ownerId });
  if (await view(bid, 'contract_version', {}) !== 'bouncer-agent-v9') throw new Error('stale wasm: wait for CI and git pull');

  console.log(`\n=== 2) Create funded user and ${compareDemo ? 'four' : 'three'} development vendor accounts ===`);
  const userKey = KeyPair.fromRandom('ed25519');
  saveKey(userId, userKey);
  const createdUser = await setupAttempt('create user', () => bouncer.createAccount(userId, userKey.getPublicKey(), 4n * N));
  assertReceipts(createdUser, 'create user');
  console.log(`    ✅ ${userId} ${txUrl(createdUser.transaction_outcome.id)}`);
  const user = account(userId, userKey);
  const owner = separateOwnerDemo ? user : bouncer;
  if (separateOwnerDemo) console.log(`    Separate policy owner: ${ownerId}; contract: ${bid}`);
  for (const [kind, id] of Object.entries(vendorIds)) {
    const key = KeyPair.fromRandom('ed25519');
    saveKey(id, key);
    const created = await setupAttempt(`create ${kind} vendor`, () => bouncer.createAccount(id, key.getPublicKey(), N / 5n));
    assertReceipts(created, `create ${kind} vendor`);
    console.log(`    ✅ ${id} ${txUrl(created.transaction_outcome.id)}`);
  }

  console.log('\n=== 3) Create two separate 6-decimal testnet credit tokens ===');
  const storageToken = await createToken(funder, userId, storageSymbol, 'Bouncer Test Storage Credits');
  const apiToken = await createToken(funder, userId, apiSymbol, 'Bouncer Test API Credits');

  console.log('\n=== 4) Register vault and corresponding vendors with all three FTs ===');
  await call(user, WNEAR, 'storage_deposit', { account_id: userId }, STORAGE_WNEAR, GAS50);
  await call(bouncer, WNEAR, 'storage_deposit', { account_id: bid }, STORAGE_WNEAR, GAS50);
  await call(bouncer, WNEAR, 'storage_deposit', { account_id: vendorIds.compute }, STORAGE_WNEAR, GAS50);
  if (compareDemo) await call(bouncer, WNEAR, 'storage_deposit', { account_id: vendorIds.computeAlt }, STORAGE_WNEAR, GAS50);
  for (const [token, vendor] of [[storageToken, vendorIds.storage], [apiToken, vendorIds.api]]) {
    await register(bouncer, token, bid);
    await register(bouncer, token, vendor);
  }

  console.log('\n=== 5) Fund three independent token balances ===');
  await call(user, WNEAR, 'near_deposit', {}, 3n * N / 2n, GAS50);
  for (const [token, amount] of [[WNEAR, N], [storageToken, 10n * CREDIT], [apiToken, 10n * CREDIT]]) {
    await call(user, token, 'ft_transfer_call', { receiver_id: bid, amount: amount.toString(), msg: 'fund' }, 1n, GAS200);
    exact(await view(bid, 'vault_balance', { token }), amount, `${token} deposited vault`);
  }

  console.log('\n=== 6) Install one execute-only key and grant it three token policies ===');
  const agentKey = KeyPair.fromRandom('ed25519');
  const agentFile = saveKey(ownerId, agentKey, 'agent');
  const added = await setupAttempt('create agent key', () => owner.signAndSendTransaction({
    receiverId: ownerId, waitUntil: 'FINAL',
    actions: [transactions.addKey(agentKey.getPublicKey(), transactions.functionCallAccessKey(bid, ['execute'], N))],
  }));
  assertReceipts(added, 'create agent key');
  console.log(`    ✅ agent key ${txUrl(added.transaction_outcome.id)}`);
  const resources = [
    { resource: 'compute', policy: 'compute-wnear', token: WNEAR, vendor: vendorIds.compute,
      per: N / 2n, daily: N, payment: N / 10n, input: { text: 'near-hub compute job', rounds: 1000 } },
    { resource: 'storage', policy: 'storage-credit', token: storageToken, vendor: vendorIds.storage,
      per: 5n * CREDIT, daily: 10n * CREDIT, payment: 3n * CREDIT / 2n, input: { name: 'bouncer-note', content: 'Persisted by the Bouncer testnet provider.' } },
    { resource: 'api', policy: 'api-credit', token: apiToken, vendor: vendorIds.api,
      per: 5n * CREDIT, daily: 10n * CREDIT, payment: 2n * CREDIT, input: { text: 'actual testnet resource API' } },
  ];
  for (const r of resources) {
    await call(owner, bid, 'set_policy', { policy_id: r.policy, token: r.token,
      per_tx_cap: r.per.toString(), daily_cap: r.daily.toString() }, 1n);
    await call(owner, bid, 'allow_payee', { policy_id: r.policy, payee: r.vendor }, 1n);
    await call(owner, bid, 'grant_agent_key', { policy_id: r.policy, public_key: agentKey.getPublicKey().toString() }, 1n);
  }
  if (compareDemo) {
    // Both compute offers use the same policy and FT. The owner explicitly
    // allows the second payee with 1 yoctoNEAR before any comparison/payment.
    await call(owner, bid, 'allow_payee', { policy_id: 'compute-wnear', payee: vendorIds.computeAlt }, 1n);
  }

  let externalMission, externalKeyFile;
  if (externalDemo) {
    console.log('\n=== 6b) Owner pins independent OutLayer compute and a separate restricted key ===');
    const externalKey = KeyPair.fromRandom('ed25519');
    externalKeyFile = saveKey(ownerId, externalKey, 'outlayer-agent');
    const installed = await setupAttempt('create OutLayer key', () => owner.signAndSendTransaction({ receiverId: ownerId, waitUntil: 'FINAL',
      actions: [transactions.addKey(externalKey.getPublicKey(), transactions.functionCallAccessKey(bid, ['execute_outlayer'], N / 2n))] }));
    assertReceipts(installed, 'create OutLayer key');
    const cap = N / 10n, policyId = 'independent-compute';
    await call(owner, bid, 'deposit_native', {}, 3n * cap);
    await call(owner, bid, 'set_policy', { policy_id: policyId, token: 'native', per_tx_cap: cap.toString(), daily_cap: cap.toString() }, 1n);
    await call(owner, bid, 'allow_payee', { policy_id: policyId, payee: 'outlayer.testnet' }, 1n);
    await call(owner, bid, 'set_outlayer_program', { policy_id: policyId, program: RANDOM_TESTNET_PROGRAM }, 1n);
    await call(owner, bid, 'grant_agent_key', { policy_id: policyId, public_key: externalKey.getPublicKey().toString() }, 1n);
    externalMission = { goal: { id: 'independent-random-1', contract_id: bid, owner_account_id: ownerId, policy_id: policyId,
      amount: cap.toString(), input: { min: 1, max: 100 }, program: RANDOM_TESTNET_PROGRAM },
      account: account(ownerId, externalKey), publicKey: externalKey.getPublicKey() };
    console.log('    Independent task is owner-selected; the model does not choose its program, price or payee.');
  }

  console.log('\n=== 7) Quote, pay and fulfill three orders with the resource agent ===');
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  const planFile = path.join(RUN_DIR, `${bid}.plan.json`);
  const journalPath = path.join(RUN_DIR, `${bid}.bouncer-journal.json`);
  console.log(`    Plan: ${planFile}\n    Journal: ${journalPath}\n    Agent key: ${agentFile}`);
  const products = Object.fromEntries(resources.map(r => [r.resource, {
    policy_id: r.policy, token: r.token, payee: r.vendor, amount: r.payment.toString(),
  }]));
  const configuredGoals = resources.map(r => ({
    id: `${r.resource}-1`, resource: r.resource, input: r.input,
    policy_id: r.policy, token: r.token, payee: r.vendor, max_amount: r.payment.toString(),
  }));
  // The optional AI path uses the model-generated input and independently
  // checked owner-pinned financial fields. Default mode remains deterministic.
  // The owner-defined order controls execution priority; model output order
  // must not decide which resource gets paid first.
  const goals = aiGoals ? configuredGoals.map(expected => aiGoals.find(goal => goal.id === expected.id)) : configuredGoals;
  if (aiGoals) {
    for (const expected of configuredGoals) {
      const actual = aiGoals.find(goal => goal.id === expected.id);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('AI goal no longer matches the configured testnet authority');
    }
  }
  const dataDir = path.join(RUN_DIR, `${bid}.provider`);
  const providerFile = path.join(RUN_DIR, `${bid}.provider.json`);
  const goalsFile = path.join(RUN_DIR, `${bid}.goals.json`);
  const ownerFile = path.join(RUN_DIR, `${bid}.owner.json`);
  const providerConfig = { contract_id: bid, owner_account_id: ownerId, data_dir: dataDir, port: 8787, products };
  const goalsConfig = { contract_id: bid, owner_account_id: ownerId, provider_url: 'http://127.0.0.1:8787', journal_path: journalPath, goals };
  // A reusable owner catalog for later natural-language tasks; each new run
  // remains constrained by both these maxima and the on-chain policies.
  const ownerConfig = { version: 1, contract_id: bid, owner_account_id: ownerId, provider_url: 'http://127.0.0.1:8787', max_tasks: 3,
    resources: Object.fromEntries(resources.map(r => [r.resource, { policy_id: r.policy, token: r.token, payee: r.vendor,
      max_amount: r.payment.toString(), max_tasks: 1, max_total_amount: r.payment.toString() }])) };
  for (const [file, config] of [[providerFile, providerConfig], [goalsFile, goalsConfig], [ownerFile, ownerConfig]]) {
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }
  console.log(`    Provider config: ${providerFile}\n    Goals config: ${goalsFile}\n    Owner planning config: ${ownerFile}`);
  if (externalMission) {
    const missionFile = path.join(RUN_DIR, `${bid}.mission.json`);
    fs.writeFileSync(missionFile, JSON.stringify({ outlayer_goal: externalMission.goal, resources: goalsConfig, journal_path: journalPath }, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(missionFile, 0o600);
    console.log(`    Mixed mission: ${missionFile}\n    OutLayer-only key: ${externalKeyFile}`);
  }
  const devProvider = createResourceProvider({ rpcProvider: provider, contractId: bid, ownerAccountId: ownerId, products, dataDir });
  await new Promise((resolve, reject) => {
    devProvider.server.once('error', reject);
    devProvider.server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${devProvider.server.address().port}`;
  const client = httpResourceProvider(baseUrl);
  let journal, alternateProvider;
  let proof, comparisonProof, deliveryProof, gatedBatchProof, ownerProof, independentProof;
  try {
    journal = new FileJournal(journalPath, bid, ownerId);
    const runner = {
      // Receipts bind the stable, reviewed origin in the saved goals file;
      // this demo temporarily maps it to an ephemeral in-process server.
      contractId: bid, ownerAccountId: ownerId, providerUrl: goalsConfig.provider_url, goals, getQuote: client.getQuote, fulfill: client.fulfill, readStorage: client.readStorage,
      onPlan: plan => {
        fs.writeFileSync(planFile, JSON.stringify(plan, null, 2) + '\n', { mode: 0o600 });
        fs.chmodSync(planFile, 0o600);
      },
      provider, account: account(ownerId, agentKey), publicKey: agentKey.getPublicKey(), journal, execute: true,
    };
    const launch = async resourceRunner => {
      if (!externalMission) return runResourceAgent(resourceRunner);
      const mixed = await runMixedMission({ outlayer: externalMission, resources: resourceRunner, provider, journal, execute: true });
      if (mixed.status !== 'FULFILLED') throw new Error(`mixed independent/FT mission did not finish: ${mixed.status}`);
      const delivery = mixed.independent.delivery;
      independentProof = `contract=${bid}; owner=${ownerId}; independent_tx=${delivery.tx_hash}; charge_yocto=${delivery.charged_yocto}; owner_refund_yocto=${delivery.refunded_to_owner_yocto}; random=${delivery.result.random_number}`;
      return mixed.resources;
    };
    let first;
    if (badDeliveryDemo) {
      // Inject a local fault after the FIRST real payment, then prove neither
      // later vendor is paid until this delivery has been recovered. This is
      // a transport fault, not evidence of a dishonest provider.
      let injected = 0, rejected = false;
      const faulty = { ...runner, fulfill: async (order, context) => {
        const actual = await client.fulfill(order);
        if (context.goalId !== 'compute-1') throw new Error('later delivery was attempted before the first result was checked');
        injected++;
        return { ...actual, result: '0'.repeat(64) };
      } };
      try { await launch(faulty); }
      catch (error) {
        if (!/verification failed after confirmed payment.*independent recomputation/.test(error.message)) throw error;
        rejected = true;
      }
      const paid = journal.get('compute-1');
      if (!rejected || injected !== 1 || paid?.status !== 'completed' || paid.delivery?.status !== 'unverified' ||
          journal.get('storage-1') || journal.get('api-1')) throw new Error('unverified first delivery did not stop the batch');
      exact(await view(WNEAR, 'ft_balance_of', { account_id: vendorIds.compute }), resources[0].payment, 'first paid compute vendor');
      exact(await view(storageToken, 'ft_balance_of', { account_id: vendorIds.storage }), 0n, 'storage vendor before recovery');
      exact(await view(apiToken, 'ft_balance_of', { account_id: vendorIds.api }), 0n, 'API vendor before recovery');
      const priorTx = paid.tx_hash;
      first = await launch({ ...runner, getQuote: async (order, context) => {
        if (context.goalId === 'compute-1') throw new Error('paid compute must not be requoted');
        return client.getQuote(order);
      } });
      if (journal.get('compute-1').tx_hash !== priorTx) throw new Error('recovery changed the original compute payment');
      gatedBatchProof = `contract=${bid}; first_tx=${priorTx}; injected-bad-result=rejected; later-vendors-before-recovery=0; recovery=same-first-payment-then-verified-rest`;
      console.log('    ✅ First locally corrupted reply stopped the batch before storage/API payments; recovery reused the first payment.');
    } else {
      first = await launch(runner);
    }
    if (first.payments.paid !== (badDeliveryDemo ? 2 : 3) || first.payments.blocked ||
        first.payments.skipped !== (badDeliveryDemo ? 1 : 0) || first.deliveries.length !== 3) {
      throw new Error(`unexpected agent result: ${JSON.stringify(first)}`);
    }
    const second = await runResourceAgent(runner);
    if (second.payments.skipped !== 3 || second.payments.paid || JSON.stringify(second.deliveries) !== JSON.stringify(first.deliveries)) {
      throw new Error(`duplicate-run protection failed: ${JSON.stringify(second)}`);
    }
    const scopes = { compute: 'iterated-sha256', storage: 'single-read-content', api: 'text-statistics' };
    for (const delivery of first.deliveries) {
      const entry = journal.get(delivery.id), receipt = entry?.delivery?.receipt, goal = goals.find(item => item.id === delivery.id);
      const digest = crypto.createHash('sha256').update(`bouncer-delivery-result-v1\0${JSON.stringify(delivery.result)}`).digest('hex');
      if (!goal || entry?.delivery?.status !== 'verified' || receipt?.tx_hash !== entry.tx_hash || receipt.result_sha256 !== digest ||
          receipt.verification.scope !== scopes[delivery.result.type] || receipt.request.memo !== orderMemo(goal.resource, goal.input)) {
        throw new Error(`${delivery.id}: verified journal receipt did not match the payment and result`);
      }
    }
    console.log('    ✅ Private journal receipts bind payments to agent-checked results (storage uses same-provider readback).');

    console.log('\n=== 8) Verify all vault and vendor balances against token contracts ===');
    for (const [r, funded] of [[resources[0], N], [resources[1], 10n * CREDIT], [resources[2], 10n * CREDIT]]) {
      const recorded = await view(bid, 'vault_balance', { token: r.token });
      const actual = await view(r.token, 'ft_balance_of', { account_id: bid });
      const paid = await view(r.token, 'ft_balance_of', { account_id: r.vendor });
      exact(recorded, funded - r.payment, `${r.resource} recorded vault`);
      exact(actual, funded - r.payment, `${r.resource} actual vault`);
      exact(paid, r.payment, `${r.resource} vendor balance`);
      console.log(`    ✅ ${r.resource}: vendor=${paid}, vault=${actual} smallest units (${r.token})`);
    }
    exact(await view(WNEAR, 'ft_balance_of', { account_id: userId }), N / 2n, 'user wNEAR');
    exact(await view(storageToken, 'ft_balance_of', { account_id: userId }), 990n * CREDIT, 'user storage credits');
    exact(await view(apiToken, 'ft_balance_of', { account_id: userId }), 990n * CREDIT, 'user API credits');

    console.log('\n=== 9) Verify local service results and reject changed orders ===');
    for (const item of resources) {
      const result = first.deliveries.find(d => d.id === `${item.resource}-1`)?.result;
      if (!result || result.type !== item.resource) throw new Error(`${item.resource}: missing service delivery`);
      if (item.resource === 'compute') {
        let hash = Buffer.from(item.input.text);
        for (let i = 0; i < item.input.rounds; i++) hash = crypto.createHash('sha256').update(hash).digest();
        if (result.result !== hash.toString('hex')) throw new Error('compute result mismatch');
      } else if (item.resource === 'storage') {
        const stored = await fetch(`${baseUrl}/storage/${result.object_id}`);
        if (!stored.ok || await stored.text() !== item.input.content) throw new Error('stored content did not round-trip');
      } else if (result.words !== 4) throw new Error('API result mismatch');
      console.log(`    ✅ VERIFIED ${item.resource}: delivered local ${result.type} service`);
    }
    let tamperBlocked = false;
    try {
      await client.fulfill({ tx_hash: journal.get('compute-1').tx_hash, resource: 'compute', input: { ...resources[0].input, text: 'different order' } });
    } catch (error) {
      if (!/different order/.test(error.message)) throw error;
      tamperBlocked = true;
    }
    if (!tamperBlocked) throw new Error('provider accepted a changed order with a used payment');
    console.log('    ✅ Provider rejected a changed order using an already redeemed transaction.');
    proof = resources.map(r => `${r.resource}: token=${r.token} tx=${journal.get(`${r.resource}-1`).tx_hash}`).join('; ');
    if (aiDataGoal) {
      console.log('\n=== 10) Pay for and retrieve model-requested public repository data ===');
      const dataGoalsFile = path.join(RUN_DIR, `${bid}.public-data.goals.json`);
      const dataPlanFile = path.join(RUN_DIR, `${bid}.public-data.plan.json`);
      const dataGoalsConfig = { contract_id: bid, owner_account_id: ownerId, provider_url: 'http://127.0.0.1:8787', journal_path: journalPath, goals: [aiDataGoal] };
      fs.writeFileSync(dataGoalsFile, JSON.stringify(dataGoalsConfig, null, 2) + '\n', { mode: 0o600 });
      fs.chmodSync(dataGoalsFile, 0o600);
      const dataRunner = { ...runner, goals: [aiDataGoal], onPlan: plan => {
        fs.writeFileSync(dataPlanFile, JSON.stringify(plan, null, 2) + '\n', { mode: 0o600 });
        fs.chmodSync(dataPlanFile, 0o600);
      } };
      const delivered = await runResourceAgent(dataRunner);
      if (delivered.payments.paid !== 1 || delivered.payments.blocked || delivered.deliveries.length !== 1) throw new Error('public data payment or delivery did not complete');
      const data = delivered.deliveries[0].result;
      const dataReceipt = journal.get('api-github-1')?.delivery?.receipt;
      if (dataReceipt?.verification?.scope !== 'repository-identity-only' || dataReceipt.tx_hash !== journal.get('api-github-1').tx_hash) {
        throw new Error('public data receipt did not accurately describe its verification scope');
      }
      const independentlyRead = await fetchPublicRepository('near/near-api-js');
      if (data.operation !== 'github-repository' || data.repository.toLowerCase() !== 'near/near-api-js' ||
          data.repository_id !== independentlyRead.repository_id) throw new Error('public repository data did not match a fresh GitHub API read');
      exact(await view(apiToken, 'ft_balance_of', { account_id: vendorIds.api }), 4n * CREDIT, 'API vendor after data purchase');
      exact(await view(bid, 'vault_balance', { token: apiToken }), 6n * CREDIT, 'API vault after data purchase');
      exact(await view(apiToken, 'ft_balance_of', { account_id: bid }), 6n * CREDIT, 'actual API vault after data purchase');
      const replay = await runResourceAgent(dataRunner);
      if (replay.payments.skipped !== 1 || replay.payments.paid || JSON.stringify(replay.deliveries) !== JSON.stringify(delivered.deliveries)) {
        throw new Error('public data replay protection failed');
      }
      const hash = journal.get('api-github-1').tx_hash;
      proof += `; public-data: token=${apiToken} tx=${hash} repo=${data.repository} id=${data.repository_id}`;
      console.log(`    ✅ VERIFIED public GitHub data: ${data.repository}, repository ID ${data.repository_id}; no duplicate payment on replay.`);
      console.log(`    Recovery goals: ${dataGoalsFile}`);
    }
    if (compareDemo) {
      console.log('\n=== 10) Compare two owner-approved development providers for the same FT ===');
      const cheaper = 8n * N / 100n;
      const alternativeProducts = { ...products, compute: { ...products.compute, payee: vendorIds.computeAlt, amount: cheaper.toString() } };
      alternateProvider = createResourceProvider({ rpcProvider: provider, contractId: bid, ownerAccountId: ownerId, products: alternativeProducts,
        dataDir: path.join(RUN_DIR, `${bid}.alternative-provider`) });
      await new Promise((resolve, reject) => {
        alternateProvider.server.once('error', reject);
        alternateProvider.server.listen(0, '127.0.0.1', resolve);
      });
      const alternateUrl = `http://127.0.0.1:${alternateProvider.server.address().port}`;
      const comparisonConfig = { version: 1, contract_id: bid, owner_account_id: ownerId, provider_url: baseUrl,
        max_tasks: 1, required_resources: ['compute'], resources: { compute: {
          ...ownerConfig.resources.compute, alternatives: [{ id: 'alternative', provider_url: alternateUrl,
            policy_id: 'compute-wnear', payee: vendorIds.computeAlt, max_amount: resources[0].payment.toString() }],
        } } };
      // In the optional combined mode the model proposed this exact task
      // before setup. Otherwise it is an explicitly supplied deterministic task.
      const input = aiComparisonInput || { text: 'compare development providers', rounds: 3 };
      const proposed = goalsFromModel({ tasks: [{ resource: 'compute', input }] }, comparisonConfig);
      const chosen = await compareApprovedQuotes({ config: comparisonConfig, proposedGoals: proposed });
      const goal = chosen.goals[0];
      if (goal.provider_id !== 'alternative' || goal.payee !== vendorIds.computeAlt || goal.token !== WNEAR || goal.quote_amount !== cheaper.toString() ||
          chosen.quote_comparisons[0].quotes[0].amount !== resources[0].payment.toString()) {
        throw new Error('provider comparison did not select the cheaper owner-approved same-token quote');
      }
      // Owner-assigned ID avoids colliding with the previous compute-1 entry in
      // the same journal; the model/provider never selects payment IDs.
      goal.id = 'compute-market-1';
      chosen.quote_comparisons[0].goal_id = goal.id;
      const comparisonFile = path.join(RUN_DIR, `${bid}.comparison.goals.json`);
      fs.writeFileSync(comparisonFile, JSON.stringify({ ...chosen, journal_path: journalPath }, null, 2) + '\n', { mode: 0o600 });
      fs.chmodSync(comparisonFile, 0o600);
      const routes = routedResourceProvider({ providerUrl: chosen.provider_url, goals: chosen.goals });
      const comparisonRunner = { ...runner, goals: chosen.goals, getQuote: routes.getQuote, fulfill: routes.fulfill, readStorage: routes.readStorage, onPlan: () => {} };
      let delivered;
      if (badDeliveryDemo) {
        // This is a deliberately injected local transport fault AFTER a real
        // testnet payment, not a claim that an independent vendor cheated.
        let injected = 0, rejected = false;
        const badRunner = { ...comparisonRunner, fulfill: async (...args) => {
          const actual = await routes.fulfill(...args);
          if (actual.result === '0'.repeat(64)) throw new Error('unexpected test fixture digest');
          injected++;
          return { ...actual, result: '0'.repeat(64) };
        } };
        try { await runResourceAgent(badRunner); }
        catch (error) {
          if (!/verification failed after confirmed payment.*independent recomputation/.test(error.message)) throw error;
          rejected = true;
        }
        const pendingDelivery = journal.get(goal.id);
        if (!rejected || injected !== 1 || pendingDelivery?.status !== 'completed' || pendingDelivery.delivery?.status !== 'unverified' ||
            pendingDelivery.delivery.stage !== 'verification' || !pendingDelivery.request || !pendingDelivery.tx_hash) {
          throw new Error('bad delivery was not safely recorded after the real payment');
        }
        const existingTx = pendingDelivery.tx_hash;
        let requoted = 0;
        delivered = await runResourceAgent({ ...comparisonRunner, getQuote: async () => { requoted++; throw new Error('quote deliberately unavailable'); } });
        if (requoted || delivered.payments.skipped !== 1 || delivered.payments.paid || journal.get(goal.id).tx_hash !== existingTx) {
          throw new Error('verified delivery recovery did not reuse the recorded payment without requoting');
        }
        console.log('    ✅ Injected an incorrect local reply after payment: rejected, then recovered with the same transaction and no requote.');
      } else {
        delivered = await runResourceAgent(comparisonRunner);
      }
      if ((badDeliveryDemo ? delivered.payments.skipped !== 1 : delivered.payments.paid !== 1) ||
          delivered.payments.blocked || delivered.deliveries.length !== 1) throw new Error('selected provider payment or fulfillment failed');
      let hash = Buffer.from(input.text);
      for (let i = 0; i < input.rounds; i++) hash = crypto.createHash('sha256').update(hash).digest();
      if (delivered.deliveries[0].result.result !== hash.toString('hex')) throw new Error('selected provider delivered an incorrect compute result');
      exact(await view(WNEAR, 'ft_balance_of', { account_id: vendorIds.compute }), resources[0].payment, 'original compute payee');
      exact(await view(WNEAR, 'ft_balance_of', { account_id: vendorIds.computeAlt }), cheaper, 'selected compute payee');
      exact(await view(bid, 'vault_balance', { token: WNEAR }), N - resources[0].payment - cheaper, 'compute vault after comparison');
      exact(await view(WNEAR, 'ft_balance_of', { account_id: bid }), N - resources[0].payment - cheaper, 'actual compute vault after comparison');
      exact(await view(bid, 'daily_spent', { policy_id: 'compute-wnear' }), resources[0].payment + cheaper, 'shared compute daily spend');
      const replay = await runResourceAgent(comparisonRunner);
      if (replay.payments.skipped !== 1 || replay.payments.paid || JSON.stringify(replay.deliveries) !== JSON.stringify(delivered.deliveries)) {
        throw new Error('selected provider replay protection failed');
      }
      const tx = journal.get(goal.id).tx_hash;
      const receipt = journal.get(goal.id).delivery?.receipt;
      if (receipt?.tx_hash !== tx || receipt.verification.scope !== 'iterated-sha256' || receipt.request.amount !== cheaper.toString()) {
        throw new Error('recovered delivery receipt did not bind the verified result to the selected payment');
      }
      comparisonProof = `contract=${bid}; planner=${aiComparisonInput ? 'model' : 'deterministic'}; token=${WNEAR}; primary=${resources[0].payment}; selected=${cheaper}; payee=${vendorIds.computeAlt}; tx=${tx}`;
      if (badDeliveryDemo) deliveryProof = `contract=${bid}; tx=${tx}; locally-injected-bad-result=rejected; recovery=same-payment-no-requote; receipt=iterated-sha256; storage=single-read-content; api=text-statistics${aiDataGoal ? '; github=repository-identity-only' : ''}`;
      console.log(`    ✅ VERIFIED owner-approved comparison: ${resources[0].payment} vs ${cheaper} ${WNEAR}; selected payee ${vendorIds.computeAlt}; replay made no second payment.`);
      console.log('    Both compared endpoints are self-hosted development services, not independent commercial vendors.');
    }
    if (externalMission) {
      if (!independentProof || journal.get(externalMission.goal.id)?.status !== 'completed') throw new Error('independent mission delivery was not recorded');
      exact(await view(bid, 'vault_balance', { token: 'native' }), 2n * N / 10n, 'native vault after independent execution');
      exact(await view(bid, 'daily_spent', { policy_id: externalMission.goal.policy_id }), N / 10n, 'independent daily reservation');
      const verdict = await view(bid, 'check', { policy_id: externalMission.goal.policy_id, payee: 'outlayer.testnet', amount: '1' });
      if (verdict?.[0] !== false) throw new Error('independent daily budget did not block another deposit');
      await call(owner, bid, 'withdraw_native', { amount: (2n * N / 10n).toString() }, 1n);
      exact(await view(bid, 'vault_balance', { token: 'native' }), 0n, 'remaining native vault withdrawn');
    }
    if (separateOwnerDemo) {
      const tx = journal.get('compute-1')?.tx_hash;
      const outcome = await provider.viewTransactionStatus(tx, ownerId, 'FINAL');
      if (ownerId === bid || outcome?.final_execution_status !== 'FINAL' || outcome.transaction?.signer_id !== ownerId ||
          outcome.transaction?.receiver_id !== bid || outcome.transaction?.hash !== tx) {
        throw new Error('separate owner transaction did not match the pinned signer and contract');
      }
      ownerProof = `contract=${bid}; owner=${ownerId}; tx=${tx}; signer=separate-owner; provider-verified=yes`;
      console.log('    ✅ Separate owner signed the guarded payment; the local provider verified that owner and the contract.');
    }
  } finally {
    journal?.close();
    if (alternateProvider) await new Promise(resolve => alternateProvider.server.close(resolve));
    await new Promise(resolve => devProvider.server.close(resolve));
  }
  console.log('\n✅ Three real testnet FT payments and self-hosted resource services verified.');
  console.log('Storage, API and FT-backed compute services are self-hosted development examples, not commercial vendors or production infrastructure.');
  if (independentProof) console.log('Independent OutLayer compute was paid in native NEAR; output range checked, TEE/entropy not independently verified.');
  if (aiGoals) console.log('The FT resource inputs were planned by the configured model and checked against the synthetic objective before payment; independent compute was owner-selected.');
  if (process.env.GITHUB_ACTIONS === 'true') {
    const label = aiGoals ? 'AI-planned testnet multi-resource proof' : 'Testnet multi-resource proof';
    console.log(`::notice title=${label}::contract=${bid}; ${proof}`);
    if (comparisonProof) console.log(`::notice title=Owner-approved provider comparison proof::${comparisonProof}`);
    if (deliveryProof) console.log(`::notice title=Delivery verification and recovery proof::${deliveryProof}`);
    if (gatedBatchProof) console.log(`::notice title=Verify-before-next-payment proof::${gatedBatchProof}`);
    if (ownerProof) console.log(`::notice title=Separate owner payment proof::${ownerProof}`);
    if (independentProof) console.log(`::notice title=Unified independent and FT multi-resource mission::${independentProof}; ${proof}`);
  }
  console.log(`Contract: ${bid}`);
  console.log(`Explorer: https://testnet.nearblocks.io/address/${bid}?tab=receipts`);
}

main().catch(error => {
  const detail = error.stack || error.message || String(error);
  console.error(`\n❌ FATAL: ${detail}`);
  if (process.env.GITHUB_ACTIONS === 'true') {
    const escaped = detail.slice(0, 3500).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    console.log(`::error title=Multi-token smoke failed::${escaped}`);
  }
  process.exitCode = 1;
});
