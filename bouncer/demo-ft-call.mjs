// LIVE TESTNET ONLY. Acquire a tiny amount of test USDC.e from an independent
// Ref pool as owner setup; then use a restricted key to move a capped amount
// from Bouncer to OutLayer's prepaid balance via an owner-pinned NEP-141 call,
// then buy one pinned independent fetch or diagnostic burn execution under
// separate native and prepaid policies. Circle USDC is a different token and
// is not used here. This is a test connector, not a commercial service. Never
// retry an ambiguous payment.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import util from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import nearApi from 'near-api-js';
import { MonotonicAccount } from './agent/near-account.mjs';
import { FileJournal } from './agent/procurement.mjs';
import { runFtCallGoal, recoverFtCallGoal } from './agent/ft-call.mjs';
import { assertProjectRegistry, runProjectGoal, recoverProjectGoal } from './agent/outlayer-project.mjs';
import { runPaidProjectMission } from './agent/paid-mission.mjs';
import { createResourceProvider } from './services/resource-provider.mjs';
import { httpResourceProvider } from './agent/resource-agent.mjs';
import { validateRpcEndpoint } from './shared/rpc-endpoint.mjs';
import { waitForNewTestnetKey } from './shared/testnet-ready.mjs';

const { KeyPair, KeyPairSigner, providers, transactions } = nearApi;
const RPC = validateRpcEndpoint(process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com');
const provider = new providers.JsonRpcProvider({ url: RPC });
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ONE = 10n ** 24n, TGAS = 10n ** 12n;
const TOKEN = 'usdc.fakes.testnet', WRAP = 'wrap.testnet', REF = 'ref-finance-101.testnet', OUTLAYER = 'outlayer.testnet';
const PROBE = process.env.BOUNCER_PAID_PROBE || 'fetch';
if (!['fetch', 'burn'].includes(PROBE)) throw new Error('BOUNCER_PAID_PROBE must be fetch or burn');
const PROBE_INPUT = PROBE === 'burn' ? '{"operation":"burn","rounds":50}' : '{"operation":"fetch"}';
const PROBE_SHARE_BP = PROBE === 'burn' ? 3333 : 10_000;
const MSG = '{"action":"deposit_balance"}', USD_AMOUNT = PROBE === 'burn' ? 10_000n : 15_000n, REFUND_AMOUNT = 10n ** 20n;
const PROJECT = 'connectors.outlayer.testnet/connector-probe';
// Published version and author reviewed via the live read-only catalog; never
// silently follow the mutable active version or reprice after approval.
const PROJECT_VERSION = '2d406ed8005a422c38aec0616990989970e2c444c1386d4f09d54cce59468fb9';
const PROJECT_AUTHOR = 'zavodil.testnet';
const PROJECT_NATIVE_MAX = ONE / 10n, PROJECT_NATIVE_FUNDING = 3n * PROJECT_NATIVE_MAX;
const PROJECT_LIMITS = { max_instructions: PROBE === 'burn' ? 5_000_000_000 : 1_000_000_000,
  max_memory_mb: 256, max_execution_seconds: 60 };
const accountFor = (id, key) => new MonotonicAccount(id, provider, new KeyPairSigner(key));
const view = (id, method, args = {}) => provider.callFunction(id, method, args, { finality: 'final' });
const txUrl = hash => `https://testnet.nearblocks.io/txns/${hash}`;

// Check live published terms before acquiring or depositing test tokens, then
// again immediately before the guarded deposit. These non-atomic views are not
// an attestation and cannot prevent the provider changing terms afterward.
async function assertProviderTerms() {
  const [token, project, version, pricing, estimate] = await Promise.all([
    view(OUTLAYER, 'get_payment_token_contract'), view(OUTLAYER, 'get_project', { project_id: PROJECT }),
    view(OUTLAYER, 'get_version', { project_id: PROJECT, version_key: PROJECT_VERSION }),
    view(OUTLAYER, 'get_project_pricing', { project_id: PROJECT }),
    view(OUTLAYER, 'estimate_execution_cost', { resource_limits: PROJECT_LIMITS, input_len: Buffer.byteLength(PROBE_INPUT) }),
  ]);
  assertProjectRegistry({ project: { project_id: PROJECT, version_key: PROJECT_VERSION, token: TOKEN,
    attached_usd: USD_AMOUNT.toString(), input_data: PROBE_INPUT }, expectedAuthor: PROJECT_AUTHOR,
    configuredToken: token, pricing, versionInfo: version, registry: project, estimate, maximumNative: PROJECT_NATIVE_MAX.toString() });
}
function probeSummary(result) {
  if (result?.operation === 'burn') return `operation=burn; rounds=${result.rounds_done}; hashes=${result.hashes}; checksum_u64=${result.checksum}`;
  if (result?.operation === 'fetch') return `operation=fetch; http_status=${result.http_status}`;
  throw new Error('unexpected verified probe result');
}

function receiptsOk(result, label) {
  if (result.final_execution_status !== 'FINAL' || !Array.isArray(result.receipts_outcome) || !result.receipts_outcome.length ||
      result.receipts_outcome.some(r => r.outcome?.status?.Failure)) throw new Error(`${label}: missing final successful receipts`);
}
async function setupAttempt(label, operation) {
  try { return await operation(); }
  catch (error) {
    if (error?.type !== 'Expired' || error.transaction_outcome !== undefined) throw error;
    console.warn(`    Setup ${label}: explicit pre-admission expiry; retrying once.`);
    return operation();
  }
}
async function call(account, contract, method, args, deposit = 0n, gas = 100n * TGAS, setup = true) {
  const operation = () => account.callFunctionRaw({ contractId: contract, methodName: method, args, deposit, gas, waitUntil: 'FINAL' });
  // The Ref swap is not retried, even for expiry. All other retried calls are
  // setup only and retry exclusively on explicit pre-admission Expired.
  const result = setup ? await setupAttempt(method, operation) : await operation();
  receiptsOk(result, method);
  console.log(`    ✅ ${method}: ${txUrl(result.transaction_outcome.id)}`);
  return result;
}
async function register(account, token, id) {
  if ((await view(token, 'storage_balance_of', { account_id: id })) !== null) return;
  const bounds = await view(token, 'storage_balance_bounds');
  if (!bounds || !/^\d+$/.test(String(bounds.min))) throw new Error(`invalid storage minimum for ${token}`);
  await call(account, token, 'storage_deposit', { account_id: id, registration_only: true }, BigInt(bounds.min), 50n * TGAS);
}
async function addKey(owner, contract, key, methods) {
  const result = await setupAttempt('install restricted key', () => owner.signAndSendTransaction({ receiverId: owner.accountId, waitUntil: 'FINAL',
    actions: [transactions.addKey(key.getPublicKey(), transactions.functionCallAccessKey(contract, methods, ONE / 2n))] }));
  receiptsOk(result, 'install restricted key');
  const permission = (await provider.viewAccessKey(owner.accountId, key.getPublicKey(), { finality: 'final' })).permission?.FunctionCall;
  if (permission?.receiver_id !== contract || JSON.stringify(permission.method_names) !== JSON.stringify(methods)) throw new Error('restricted key scope mismatch');
}
async function expectRejection(label, pattern, operation) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await operation(); }
    catch (error) {
      if (attempt === 0 && error?.type === 'Expired' && !error.transaction_outcome) continue;
      const detail = `${error.message || ''} ${util.inspect(error, { depth: 8 })}`;
      if (!pattern.test(detail)) throw new Error(`${label}: unexpected rejection ${detail}`, { cause: error });
      console.log(`    ✅ ${label}: rejected`); return;
    }
    throw new Error(`${label}: unexpectedly succeeded`);
  }
  throw new Error(`${label}: repeated setup expiry`);
}
async function createFunded(id, key) {
  const response = await fetch('https://helper.testnet.near.org/account', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newAccountId: id, newAccountPublicKey: key.getPublicKey().toString() }), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`testnet helper HTTP ${response.status}`);
  await waitForNewTestnetKey(provider, id, key.getPublicKey());
  return accountFor(id, key);
}
function expected(goal) { return { policy_id: goal.policy_id, payee: goal.payee, amount: goal.amount, expected_token: goal.token,
  expected_msg: goal.msg, expected_policy_revision: goal.policy_revision, expected_route_revision: goal.route_revision }; }

// Continue the settled independent paid connector with three guarded
// development resources in ONE journal. A locally corrupted delivery must
// stop later payments; recovery must reuse every prior transaction hash.
async function provePaidMission({ contract, contractId, owner, ownerId, fundingAgent, fundingKey, projectAgent, projectKey,
  fundingGoal, projectGoal, journal, dir }) {
  // Stage the next goals only after the independent delivery was recovered and
  // verified. Store the exact sanitized result and its transaction ID; storage
  // delivery still proves only the development provider's one readback.
  const verifiedProbe = journal.get(projectGoal.id);
  if (verifiedProbe?.status !== 'completed' || verifiedProbe.delivery?.tx_hash !== verifiedProbe.tx_hash ||
      !['burn', 'fetch'].includes(verifiedProbe.delivery?.result?.operation)) throw new Error('verified independent delivery is required before constructing dependent resource goals');
  const artifact = JSON.stringify({ provider: verifiedProbe.delivery.provider, project: verifiedProbe.delivery.project,
    tx_hash: verifiedProbe.tx_hash, result: verifiedProbe.delivery.result });
  const price = 100_000_000_000_000_000_000n; // 0.0001 testnet wNEAR per resource
  const policy = 'development-resources', vendorId = `vendor.${contractId}`;
  const vendorKey = KeyPair.fromRandom('ed25519'), resourceKey = KeyPair.fromRandom('ed25519');
  const created = await setupAttempt('create development provider account', () => contract.signAndSendTransaction({ receiverId: vendorId,
    actions: [transactions.createAccount(), transactions.transfer(ONE / 10n), transactions.addKey(vendorKey.getPublicKey(), transactions.fullAccessKey())], waitUntil: 'FINAL' }));
  receiptsOk(created, 'create development provider account');
  await register(owner, WRAP, vendorId);
  await call(owner, WRAP, 'ft_transfer_call', { receiver_id: contractId, amount: (3n * price).toString(), memo: 'paid-mission resources', msg: '' }, 1n, 200n * TGAS);
  if (BigInt(await view(contractId, 'vault_balance', { token: WRAP })) !== 3n * price) throw new Error('development resource vault setup mismatch');
  await call(owner, contractId, 'set_policy', { policy_id: policy, token: WRAP, per_tx_cap: price.toString(), daily_cap: (3n * price).toString() }, 1n);
  await call(owner, contractId, 'allow_payee', { policy_id: policy, payee: vendorId }, 1n);
  await call(owner, contractId, 'grant_agent_key', { public_key: resourceKey.getPublicKey().toString(), policy_id: policy }, 1n);
  await addKey(owner, contractId, resourceKey, ['execute']);
  const resourceAgent = accountFor(ownerId, resourceKey);
  const products = Object.fromEntries(['compute', 'storage', 'api'].map(resource => [resource,
    { policy_id: policy, token: WRAP, payee: vendorId, amount: price.toString() }]));
  const goals = [
    { id: 'paid-mission-compute', resource: 'compute', input: { text: 'independent paid mission', rounds: 25 } },
    { id: 'paid-mission-storage', resource: 'storage', input: { name: 'paid-mission', content: artifact } },
    { id: 'paid-mission-api', resource: 'api', input: { text: 'paid multi resource mission' } },
  ].map(goal => ({ ...goal, policy_id: policy, token: WRAP, payee: vendorId, max_amount: price.toString() }));
  fs.writeFileSync(path.join(dir, 'resource-goals.json'), JSON.stringify(goals, null, 2), { mode: 0o600 });
  const service = createResourceProvider({ rpcProvider: provider, contractId, ownerAccountId: ownerId, products,
    dataDir: path.join(dir, 'development-provider') });
  await new Promise((resolve, reject) => { service.server.once('error', reject); service.server.listen(0, '127.0.0.1', resolve); });
  try {
    const client = httpResourceProvider(`http://127.0.0.1:${service.server.address().port}`);
    const initialFundingHash = journal.get(fundingGoal.id)?.tx_hash, initialProjectHash = journal.get(projectGoal.id)?.tx_hash;
    const common = { provider, journal, execute: true, log: console.log,
      funding: { goal: fundingGoal, account: fundingAgent, publicKey: fundingKey.getPublicKey() },
      project: { goal: projectGoal, account: projectAgent, publicKey: projectKey.getPublicKey() },
      resources: { contractId, ownerAccountId: ownerId, goals, account: resourceAgent, publicKey: resourceKey.getPublicKey(), durablePayment: true,
        getQuote: client.getQuote, readStorage: client.readStorage } };
    let injected = false;
    try {
      await runPaidProjectMission({ ...common, resources: { ...common.resources, fulfill: async order => {
        const result = await client.fulfill(order);
        if (!injected && order.resource === 'compute') { injected = true; return { ...result, result: '0'.repeat(64) }; }
        throw new Error('later fulfillment ran before recovery');
      } } });
      throw new Error('bad compute delivery unexpectedly passed');
    } catch (error) {
      if (!/verification failed after confirmed payment/.test(error.message)) throw error;
      console.log('    ✅ bad compute delivery blocked subsequent mission payments');
    }
    const compute = journal.get(goals[0].id), computeHash = compute?.tx_hash;
    if (!injected || !computeHash || compute.delivery?.status !== 'unverified' || journal.get(goals[1].id) || journal.get(goals[2].id) ||
        BigInt(await view(WRAP, 'ft_balance_of', { account_id: vendorId })) !== price) throw new Error('verify-before-next-payment gate failed');
    const result = await runPaidProjectMission({ ...common, resources: { ...common.resources, fulfill: client.fulfill } });
    if (result.status !== 'FULFILLED' || result.resources.deliveries.length !== 3 ||
        journal.get(fundingGoal.id)?.tx_hash !== initialFundingHash || journal.get(projectGoal.id)?.tx_hash !== initialProjectHash ||
        journal.get(goals[0].id)?.tx_hash !== computeHash || goals.some(goal => journal.get(goal.id)?.delivery?.status !== 'verified') ||
        BigInt(await view(WRAP, 'ft_balance_of', { account_id: vendorId })) !== 3n * price) {
      throw new Error('paid multi-resource mission recovery or delivery mismatch');
    }
    const hashes = goals.map(goal => `${goal.resource}:${journal.get(goal.id).tx_hash}`).join('; ');
    console.log(`::notice title=Paid-provider and FT multi-resource recovery proof::contract=${contractId}; funding_tx=${initialFundingHash}; paid_probe_tx=${initialProjectHash}; ${hashes}; first_compute_hash_reused=true; later_payments_blocked_until_verified=true; ${probeSummary(result.independent.delivery.result)}; stored_probe_result=true; resources=self-hosted-development-wNEAR; mission=non-atomic`);
  } finally { await service.close(); }
}

async function main() {
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  await assertProviderTerms();
  const meta = await view(TOKEN, 'ft_metadata');
  if (meta?.decimals !== 6) throw new Error('unexpected test token decimals');
  const contractKey = KeyPair.fromRandom('ed25519'), ownerKey = KeyPair.fromRandom('ed25519');
  const agentKey = KeyPair.fromRandom('ed25519'), attackKey = KeyPair.fromRandom('ed25519'), projectKey = KeyPair.fromRandom('ed25519');
  const suffix = crypto.randomBytes(4).toString('hex'), contractId = `bouncer-ft-${suffix}.testnet`, ownerId = `owner.${contractId}`;
  console.log(`Guarded NEP-141 integration: testnet contract=${contractId}; distinct owner=${ownerId}; fake test asset=${TOKEN}`);
  const contract = await createFunded(contractId, contractKey);
  const deploy = await setupAttempt('deploy', () => contract.signAndSendTransaction({ receiverId: contractId,
    actions: [transactions.deployContract(fs.readFileSync(path.join(ROOT, 'bouncer.wasm')))], waitUntil: 'FINAL' }));
  receiptsOk(deploy, 'deploy');
  const created = await setupAttempt('create owner', () => contract.signAndSendTransaction({ receiverId: ownerId, waitUntil: 'FINAL',
    actions: [transactions.createAccount(), transactions.transfer(3n * ONE), transactions.addKey(ownerKey.getPublicKey(), transactions.fullAccessKey())] }));
  receiptsOk(created, 'create owner');
  const owner = accountFor(ownerId, ownerKey), agent = accountFor(ownerId, agentKey), attacker = accountFor(ownerId, attackKey);
  await call(contract, contractId, 'new', { owner: ownerId });
  if (await view(contractId, 'contract_version') !== 'bouncer-agent-v9' || await view(contractId, 'get_owner') !== ownerId) throw new Error('stale contract or unexpected owner');

  for (const [token, id] of [[WRAP, ownerId], [WRAP, contractId], [WRAP, OUTLAYER], [TOKEN, ownerId], [TOKEN, contractId], [TOKEN, OUTLAYER]]) await register(owner, token, id);
  await call(owner, WRAP, 'near_deposit', {}, ONE / 500n, 50n * TGAS);
  // Owner setup acquires test-only USDC.e; this is not an agent-guarded DeFi
  // swap. Use a tiny fixed input, a live quote and hard output/slippage bounds.
  const input = 10n ** 15n, pools = [54, 477, 596, 624];
  let selected;
  for (const pool_id of pools) {
    try {
      const quote = BigInt(await view(REF, 'get_return', { pool_id, token_in: WRAP, amount_in: input.toString(), token_out: TOKEN }));
      if (quote >= USD_AMOUNT * 2n && quote <= 1_000_000n) { selected = { pool_id, quote }; break; }
    } catch { /* Skip unavailable or changed test pools without sending. */ }
  }
  if (!selected) throw new Error('no bounded Ref pool quote for acquiring the fake test token');
  const beforeFake = BigInt(await view(TOKEN, 'ft_balance_of', { account_id: ownerId }));
  const swapMsg = JSON.stringify({ force: 0, actions: [{ pool_id: selected.pool_id, token_in: WRAP, token_out: TOKEN,
    amount_in: input.toString(), min_amount_out: (selected.quote * 95n / 100n).toString() }] });
  const swap = await call(owner, WRAP, 'ft_transfer_call', { receiver_id: REF, amount: input.toString(), msg: swapMsg }, 1n, 300n * TGAS, false);
  const afterFake = BigInt(await view(TOKEN, 'ft_balance_of', { account_id: ownerId }));
  if (afterFake - beforeFake < USD_AMOUNT || afterFake - beforeFake > 1_100_000n) throw new Error('test-token swap output did not meet the owner setup bounds');
  console.log(`    Owner setup obtained ${(afterFake - beforeFake).toString()} micro-units of fake USDC.e; this was not a guarded agent swap.`);

  await call(owner, TOKEN, 'ft_transfer_call', { receiver_id: contractId, amount: USD_AMOUNT.toString(), msg: 'fund' }, 1n, 200n * TGAS);
  await call(owner, WRAP, 'ft_transfer_call', { receiver_id: contractId, amount: REFUND_AMOUNT.toString(), msg: 'fund' }, 1n, 200n * TGAS);
  if (BigInt(await view(contractId, 'vault_balance', { token: TOKEN })) !== USD_AMOUNT ||
      BigInt(await view(contractId, 'vault_balance', { token: WRAP })) !== REFUND_AMOUNT) throw new Error('vault funding was not accounted');

  for (const [policy_id, token, cap] of [['provider-funding', TOKEN, USD_AMOUNT], ['refund-test', WRAP, REFUND_AMOUNT]]) {
    await call(owner, contractId, 'set_policy', { policy_id, token, per_tx_cap: cap.toString(), daily_cap: cap.toString() }, 1n);
    await call(owner, contractId, 'allow_payee', { policy_id, payee: OUTLAYER }, 1n);
    await call(owner, contractId, 'set_ft_call_message', { policy_id, payee: OUTLAYER, msg: MSG }, 1n);
    await call(owner, contractId, 'grant_agent_key', { policy_id, public_key: agentKey.getPublicKey().toString() }, 1n);
  }
  await addKey(owner, contractId, agentKey, ['execute_ft_call']);
  await addKey(owner, contractId, attackKey, ['set_ft_call_message']);
  const route = await view(contractId, 'get_ft_call_route', { policy_id: 'provider-funding', payee: OUTLAYER });
  if (!route?.active || route.token !== TOKEN || route.msg !== MSG) throw new Error('owner route was not pinned');
  const goal = { id: 'outlayer-test-credit', contract_id: contractId, owner_account_id: ownerId, policy_id: 'provider-funding',
    payee: OUTLAYER, token: TOKEN, amount: USD_AMOUNT.toString(), msg: MSG, policy_revision: route.policy_revision, route_revision: route.route_revision };
  await expectRejection('1-yocto route escalation guard', /owner-only method requires exactly 1 yoctoNEAR/, () => attacker.callFunctionRaw({
    contractId, methodName: 'set_ft_call_message', args: { policy_id: goal.policy_id, payee: OUTLAYER, msg: '{"action":"other"}' }, deposit: 0n, gas: 100n * TGAS, waitUntil: 'FINAL' }));
  await expectRejection('agent-supplied message substitution', /FT call route changed since review/, () => agent.callFunctionRaw({
    contractId, methodName: 'execute_ft_call', args: { ...expected(goal), expected_msg: '{"action":"other"}' }, deposit: 0n, gas: 300n * TGAS, waitUntil: 'FINAL' }));
  await expectRejection('FT per-transaction cap', /amount exceeds per-tx cap/, () => agent.callFunctionRaw({
    contractId, methodName: 'execute_ft_call', args: { ...expected(goal), amount: (USD_AMOUNT + 1n).toString() }, deposit: 0n, gas: 300n * TGAS, waitUntil: 'FINAL' }));
  const beforeProvider = BigInt(await view(OUTLAYER, 'get_user_stablecoin_balance', { account_id: contractId }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-ftcall-'));
  const state = path.join(dir, 'journal.json'), goalPath = path.join(dir, 'goal.json');
  fs.writeFileSync(goalPath, JSON.stringify(goal, null, 2) + '\n', { mode: 0o600 });
  let journal = new FileJournal(state, contractId, ownerId), sends = 0, inject = true, completed = false;
  const faulty = new Proxy(provider, { get(target, property) {
    if (property === 'sendTransactionUntil') return async (...args) => { sends++; return target.sendTransactionUntil(...args); };
    if (property === 'txStatusReceipts') return async (...args) => { const result = await target.txStatusReceipts(...args);
      if (!inject) return result; inject = false; return { ...result, receipts: [] }; };
    const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  try {
    await assertProviderTerms();
    if ((await runFtCallGoal({ goal, provider, account: agent, publicKey: agentKey.getPublicKey(), journal })).status !== 'READY') throw new Error('dry run did not become ready');
    try {
      await runFtCallGoal({ goal, provider: faulty, account: agent, publicKey: agentKey.getPublicKey(), journal, execute: true });
      throw new Error('injected fault unexpectedly passed');
    } catch (error) { if (!/FT call unresolved/.test(error.message)) throw error; }
    const tx = journal.get(goal.id)?.tx_hash;
    if (!tx || sends !== 1 || journal.get(goal.id)?.status !== 'pending') throw new Error('uncertain transfer was not journaled');
    journal.close();
    const cli = await util.promisify(execFile)(process.execPath, [path.join(ROOT, 'bouncer/agent/ft-call.mjs'),
      '--goal', goalPath, '--state', state, '--rpc', RPC, '--recover'], { timeout: 90_000, maxBuffer: 64 * 1024 });
    if (!cli.stdout.includes('REUSED') || !cli.stdout.includes(tx)) throw new Error('separate key-free recovery did not reuse the transaction');
    journal = new FileJournal(state, contractId, ownerId);
    const recovered = await recoverFtCallGoal({ goal, provider, journal });
    if (recovered.settlement.used !== USD_AMOUNT.toString() || recovered.settlement.unused !== '0' || sends !== 1) throw new Error('unexpected FT settlement');
    const afterProvider = BigInt(await view(OUTLAYER, 'get_user_stablecoin_balance', { account_id: contractId }));
    if (afterProvider - beforeProvider !== USD_AMOUNT || BigInt(await view(contractId, 'vault_balance', { token: TOKEN })) !== 0n ||
        BigInt(await view(contractId, 'daily_spent', { policy_id: goal.policy_id })) !== USD_AMOUNT) throw new Error('provider balance and vault did not reconcile');
    console.log(`::notice title=Guarded independent test-token provider funding::contract=${contractId}; owner=${ownerId}; token=${TOKEN}; provider=${OUTLAYER}; tx=${tx}; amount_micro=${USD_AMOUNT}; provider_balance_delta=${afterProvider - beforeProvider}; owner_setup_ref_swap=${swap.transaction_outcome.id}; sends=${sends}; recovery=key-free; scope=prepaid_deposit_not_delivery`);
    if (BigInt(await view(contractId, 'outlayer_prepaid_balance', { token: TOKEN })) !== USD_AMOUNT) throw new Error('conservative prepaid allowance was not recorded');

    // Spend that recorded provider balance on ONE pinned, independently
    // operated test connector. The native compute fee and prepaid test token
    // have independent caps/budgets, plus an owner-reviewed exact project,
    // version, input and fee. Both choices are diagnostics, not commercial services.
    await call(owner, contractId, 'deposit_native', {}, PROJECT_NATIVE_FUNDING);
    for (const [policy_id, token, cap] of [['project-native', 'native', PROJECT_NATIVE_MAX], ['project-token', TOKEN, USD_AMOUNT]]) {
      await call(owner, contractId, 'set_policy', { policy_id, token, per_tx_cap: cap.toString(), daily_cap: cap.toString() }, 1n);
      await call(owner, contractId, 'allow_payee', { policy_id, payee: OUTLAYER }, 1n);
      await call(owner, contractId, 'grant_agent_key', { policy_id, public_key: projectKey.getPublicKey().toString() }, 1n);
    }
    const config = { project_id: PROJECT, version_key: PROJECT_VERSION, usd_policy_id: 'project-token', token: TOKEN,
      attached_usd: USD_AMOUNT.toString(), input_data: PROBE_INPUT, ...PROJECT_LIMITS };
    const estimate = BigInt(await view(OUTLAYER, 'estimate_execution_cost', { resource_limits: { max_instructions: config.max_instructions,
      max_memory_mb: config.max_memory_mb, max_execution_seconds: config.max_execution_seconds }, input_len: Buffer.byteLength(config.input_data) }));
    if (estimate <= 0n || estimate > PROJECT_NATIVE_MAX) throw new Error('provider compute estimate exceeds the owner-approved native maximum');
    await call(owner, contractId, 'set_outlayer_project', { native_policy_id: 'project-native', project: config }, 1n);
    await addKey(owner, contractId, projectKey, ['execute_outlayer_project']);
    const projectAgent = accountFor(ownerId, projectKey), projectRoute = await view(contractId, 'get_outlayer_project', { native_policy_id: 'project-native' });
    const projectGoal = { id: PROBE === 'burn' ? 'paid-diagnostic-compute' : 'paid-connectivity-probe', contract_id: contractId, owner_account_id: ownerId,
      native_policy_id: 'project-native', amount: PROJECT_NATIVE_MAX.toString(), route: projectRoute, expected_author: PROJECT_AUTHOR };
    const badRoute = structuredClone(projectRoute); badRoute.project.input_data = '{"operation":"other"}';
    await expectRejection('agent-supplied project/input substitution', /OutLayer project route changed since review/, () => projectAgent.callFunctionRaw({
      contractId, methodName: 'execute_outlayer_project', args: { native_policy_id: 'project-native', amount: PROJECT_NATIVE_MAX.toString(), expected_route: badRoute },
      deposit: 0n, gas: 300n * TGAS, waitUntil: 'FINAL' }));
    const projectPath = path.join(dir, 'project-goal.json');
    fs.writeFileSync(projectPath, JSON.stringify(projectGoal, null, 2) + '\n', { mode: 0o600 });
    let projectSends = 0, projectInject = true;
    const projectFaulty = new Proxy(provider, { get(target, property) {
      if (property === 'sendTransactionUntil') return async (...args) => { projectSends++; return target.sendTransactionUntil(...args); };
      if (property === 'txStatusReceipts') return async (...args) => { const result = await target.txStatusReceipts(...args);
        if (!projectInject) return result; projectInject = false; return { ...result, receipts: [] }; };
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    if ((await runProjectGoal({ goal: projectGoal, provider, account: projectAgent, publicKey: projectKey.getPublicKey(), journal })).status !== 'READY') throw new Error('paid project preflight did not become ready');
    try {
      await runProjectGoal({ goal: projectGoal, provider: projectFaulty, account: projectAgent, publicKey: projectKey.getPublicKey(), journal, execute: true });
      throw new Error('injected project fault unexpectedly passed');
    } catch (error) { if (!/paid project unresolved/.test(error.message)) throw error; }
    const projectTx = journal.get(projectGoal.id)?.tx_hash;
    if (!projectTx || projectSends !== 1 || journal.get(projectGoal.id)?.status !== 'pending') throw new Error('paid project was not journaled');
    journal.close();
    const projectCli = await util.promisify(execFile)(process.execPath, [path.join(ROOT, 'bouncer/agent/outlayer-project.mjs'),
      '--goal', projectPath, '--state', state, '--rpc', RPC, '--recover'], { timeout: 90_000, maxBuffer: 64 * 1024 });
    if (!projectCli.stdout.includes('REUSED') || !projectCli.stdout.includes(projectTx)) throw new Error('paid project key-free recovery did not reuse the transaction');
    journal = new FileJournal(state, contractId, ownerId);
    const projectResult = await recoverProjectGoal({ goal: projectGoal, provider, journal });
    if (projectResult.delivery.prepaid_charged !== USD_AMOUNT.toString() || projectSends !== 1 ||
        BigInt(await view(contractId, 'outlayer_prepaid_balance', { token: TOKEN })) !== 0n ||
        BigInt(await view(OUTLAYER, 'get_user_stablecoin_balance', { account_id: contractId })) !== beforeProvider ||
        BigInt(await view(contractId, 'daily_spent', { policy_id: 'project-token' })) !== USD_AMOUNT ||
        BigInt(await view(contractId, 'daily_spent', { policy_id: 'project-native' })) !== PROJECT_NATIVE_MAX) throw new Error('paid project budgets, provider balance or result did not reconcile');
    console.log(`::notice title=Guarded independent paid testnet diagnostic::contract=${contractId}; owner=${ownerId}; tx=${projectTx}; project=${PROJECT}; version=${PROJECT_VERSION}; token=${TOKEN}; prepaid_charged=${projectResult.delivery.prepaid_charged}; author=${PROJECT_AUTHOR}; author_share_bp=${PROBE_SHARE_BP}; near_charge=${projectResult.delivery.near_charged}; near_refund=${projectResult.delivery.near_refunded_to_owner}; ${probeSummary(projectResult.delivery.result)}; sends=${projectSends}; recovery=key-free; scope=diagnostic_not_commercial_service`);

    // Independent receiver deliberately rejects wNEAR: NEP-141 must return all
    // unused tokens and the original budget. This verifies a real full refund.
    const refundRoute = await view(contractId, 'get_ft_call_route', { policy_id: 'refund-test', payee: OUTLAYER });
    const refundGoal = { id: 'wnear-refund', contract_id: contractId, owner_account_id: ownerId, policy_id: 'refund-test',
      payee: OUTLAYER, token: WRAP, amount: REFUND_AMOUNT.toString(), msg: MSG,
      policy_revision: refundRoute.policy_revision, route_revision: refundRoute.route_revision };
    fs.writeFileSync(path.join(dir, 'refund-goal.json'), JSON.stringify(refundGoal, null, 2) + '\n', { mode: 0o600 });
    const refunded = await runFtCallGoal({ goal: refundGoal, provider, account: agent, publicKey: agentKey.getPublicKey(), journal, execute: true });
    if (refunded.settlement.used !== '0' || refunded.settlement.unused !== REFUND_AMOUNT.toString() ||
        BigInt(await view(contractId, 'vault_balance', { token: WRAP })) !== REFUND_AMOUNT ||
        BigInt(await view(contractId, 'daily_spent', { policy_id: 'refund-test' })) !== 0n) throw new Error('rejected token was not fully restored');
    console.log(`::notice title=Guarded FT receiver rejection and refund::contract=${contractId}; tx=${refunded.settlement.tx_hash}; token=${WRAP}; used=0; unused=${REFUND_AMOUNT}; budget_restored=true`);
    await call(owner, contractId, 'withdraw', { token: WRAP, amount: REFUND_AMOUNT.toString() }, 1n);
    await provePaidMission({ contract, contractId, owner, ownerId, fundingAgent: agent, fundingKey: agentKey,
      projectAgent, projectKey, fundingGoal: goal, projectGoal, journal, dir });
    await call(owner, contractId, 'withdraw_native', { amount: (PROJECT_NATIVE_FUNDING - PROJECT_NATIVE_MAX).toString() }, 1n);
    completed = true;
  } finally {
    journal.close();
    if (completed) fs.rmSync(dir, { recursive: true, force: true });
    else console.error(`Unresolved public testnet evidence preserved: ${dir}. Reconcile journal hashes; never resend automatically.`);
  }
  console.log('Evidence scope: an independent OutLayer test connector delivered a diagnostic using fake test USDC.e and native NEAR. Later wNEAR resources are self-hosted development services. This is not a commercial compute/API/storage purchase, Circle USDC, or a TEE proof.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
