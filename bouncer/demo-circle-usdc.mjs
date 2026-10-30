// LIVE TESTNET ONLY. Demonstrates three Bouncer-guarded purchases with Circle's
// canonical NEAR testnet USDC. This token has NO REAL VALUE. Ref acquisition is
// owner setup, not agent-guarded trading; the provider is self-hosted demo code,
// not a commercial service. Never automatically retry an ambiguous payment.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import util from 'node:util';
import { fileURLToPath } from 'node:url';
import nearApi from 'near-api-js';
import { MonotonicAccount } from './agent/near-account.mjs';
import { FileJournal } from './agent/procurement.mjs';
import { runResourceAgent, httpResourceProvider } from './agent/resource-agent.mjs';
import { recoverDirectPayment } from './agent/recover-direct-payment.mjs';
import { createResourceProvider } from './services/resource-provider.mjs';
import { validateRpcEndpoint } from './shared/rpc-endpoint.mjs';
import { waitForNewTestnetKey } from './shared/testnet-ready.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN, WRAP_TESTNET as WRAP, REF_TESTNET as REF, OWNER_SETUP_INPUT,
  OWNER_SETUP_MAX_OUTPUT, DEMO_RESOURCE_PRICE as PRICE, selectOwnerSetupQuote } from './scripts/circle-testnet-setup.mjs';

const { KeyPair, KeyPairSigner, providers, transactions } = nearApi;
const provider = new providers.JsonRpcProvider({ url: validateRpcEndpoint(process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com') });
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ONE = 10n ** 24n, TGAS = 10n ** 12n, POLICY = 'circle-dev-resources';
const accountFor = (id, key) => new MonotonicAccount(id, provider, new KeyPairSigner(key));
const view = (id, method, args = {}) => provider.callFunction(id, method, args, { finality: 'final' });
const url = hash => `https://testnet.nearblocks.io/txns/${hash}`;

function receiptsOk(result, label) {
  if (result?.final_execution_status !== 'FINAL' || typeof result.status?.SuccessValue !== 'string' ||
      !Array.isArray(result.receipts_outcome) || !result.receipts_outcome.length ||
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
async function call(account, contractId, methodName, args, deposit = 0n, gas = 100n * TGAS, setup = true) {
  const operation = () => account.callFunctionRaw({ contractId, methodName, args, deposit, gas, waitUntil: 'FINAL' });
  // Only bounded setup calls may retry an explicit pre-admission expiry. The
  // Ref swap and vault deposit are sent once and never retried automatically.
  const result = setup ? await setupAttempt(methodName, operation) : await operation();
  receiptsOk(result, methodName);
  console.log(`    ${methodName}: ${url(result.transaction_outcome.id)}`);
  return result;
}
async function register(owner, token, id) {
  if ((await view(token, 'storage_balance_of', { account_id: id })) !== null) return;
  const min = (await view(token, 'storage_balance_bounds'))?.min;
  if (typeof min !== 'string' || !/^(?:0|[1-9][0-9]{0,38})$/.test(min) || BigInt(min) > ONE / 10n) throw new Error(`invalid storage minimum for ${token}`);
  await call(owner, token, 'storage_deposit', { account_id: id, registration_only: true }, BigInt(min), 50n * TGAS);
}
async function addKey(owner, contractId, key, methods) {
  const result = await setupAttempt('install restricted key', () => owner.signAndSendTransaction({ receiverId: owner.accountId, waitUntil: 'FINAL',
    actions: [transactions.addKey(key.getPublicKey(), transactions.functionCallAccessKey(contractId, methods, ONE / 2n))] }));
  receiptsOk(result, 'install restricted key');
  const permission = (await provider.viewAccessKey(owner.accountId, key.getPublicKey(), { finality: 'final' })).permission?.FunctionCall;
  if (permission?.receiver_id !== contractId || JSON.stringify(permission.method_names) !== JSON.stringify(methods)) throw new Error('restricted key scope mismatch');
}
async function expectRejection(label, pattern, operation) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await operation(); }
    catch (error) {
      if (attempt === 0 && error?.type === 'Expired' && error.transaction_outcome === undefined) continue;
      const detail = `${error.message || ''} ${util.inspect(error, { depth: 8 })}`;
      if (!pattern.test(detail)) throw new Error(`${label}: unexpected rejection ${detail}`, { cause: error });
      console.log(`    ${label}: rejected`); return;
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

async function main() {
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const metadata = await view(TOKEN, 'ft_metadata');
  if (metadata?.spec !== 'ft-1.0.0' || metadata?.symbol !== 'USDC' || metadata?.decimals !== 6) throw new Error('unexpected Circle testnet USDC metadata');
  const quote = await selectOwnerSetupQuote(provider); // read only, before creating accounts
  const wasm = fs.readFileSync(path.join(ROOT, 'bouncer.wasm'));
  // Avoid using a stale root artifact by mistake. This marker is a sanity
  // check only, NOT proof of deployed contract code integrity.
  if (!wasm.includes(Buffer.from('bouncer-agent-v9'))) throw new Error('demo requires the fresh v9 WASM artifact');
  const contractKey = KeyPair.fromRandom('ed25519'), ownerKey = KeyPair.fromRandom('ed25519');
  const vendorKey = KeyPair.fromRandom('ed25519'), agentKey = KeyPair.fromRandom('ed25519'), attackKey = KeyPair.fromRandom('ed25519');
  const suffix = crypto.randomBytes(4).toString('hex'), contractId = `bouncer-usdc-${suffix}.testnet`;
  const ownerId = `owner.${contractId}`, vendorId = `vendor.${contractId}`;
  console.log(`Circle TESTNET USDC demo: ${TOKEN}; NO REAL VALUE; contract=${contractId}; provider=self-hosted development`);
  const contract = await createFunded(contractId, contractKey);
  const deploy = await setupAttempt('deploy', () => contract.signAndSendTransaction({ receiverId: contractId,
    actions: [transactions.deployContract(wasm)], waitUntil: 'FINAL' }));
  receiptsOk(deploy, 'deploy');
  for (const [id, key, near] of [[ownerId, ownerKey, 3n * ONE], [vendorId, vendorKey, ONE / 10n]]) {
    const result = await setupAttempt('create subaccount', () => contract.signAndSendTransaction({ receiverId: id, waitUntil: 'FINAL',
      actions: [transactions.createAccount(), transactions.transfer(near), transactions.addKey(key.getPublicKey(), transactions.fullAccessKey())] }));
    receiptsOk(result, 'create subaccount');
  }
  const owner = accountFor(ownerId, ownerKey), agent = accountFor(ownerId, agentKey), attacker = accountFor(ownerId, attackKey);
  await call(contract, contractId, 'new', { owner: ownerId });
  if (await view(contractId, 'contract_version') !== 'bouncer-agent-v9' || await view(contractId, 'get_owner') !== ownerId) throw new Error('stale contract or unexpected owner');
  for (const [token, id] of [[WRAP, ownerId], [TOKEN, ownerId], [TOKEN, contractId], [TOKEN, vendorId]]) await register(owner, token, id);
  await call(owner, WRAP, 'near_deposit', {}, OWNER_SETUP_INPUT, 50n * TGAS);
  // This swap is full-access OWNER setup, not controlled by an agent policy.
  // It has a fixed tiny input, pinned pools/pair, output bounds and min-out.
  const before = BigInt(await view(TOKEN, 'ft_balance_of', { account_id: ownerId }));
  const swap = await call(owner, WRAP, 'ft_transfer_call', { receiver_id: REF, amount: quote.input_amount, msg: quote.msg }, 1n, 300n * TGAS, false);
  const acquired = BigInt(await view(TOKEN, 'ft_balance_of', { account_id: ownerId })) - before;
  if (acquired < BigInt(quote.min_output) || acquired > OWNER_SETUP_MAX_OUTPUT) throw new Error('owner setup swap did not meet the approved output bounds');
  console.log(`    OWNER setup acquired ${acquired} micro-USDC on testnet; pool=${quote.pool_id}; not a guarded agent swap`);
  const funding = await call(owner, TOKEN, 'ft_transfer_call', { receiver_id: contractId, amount: (3n * PRICE).toString(), msg: 'fund' }, 1n, 200n * TGAS, false);
  if (BigInt(await view(contractId, 'vault_balance', { token: TOKEN })) !== 3n * PRICE ||
      BigInt(await view(TOKEN, 'ft_balance_of', { account_id: contractId })) !== 3n * PRICE ||
      BigInt(await view(TOKEN, 'ft_balance_of', { account_id: vendorId })) !== 0n) throw new Error('Circle vault setup mismatch');
  await call(owner, contractId, 'set_policy', { policy_id: POLICY, token: TOKEN, per_tx_cap: PRICE.toString(), daily_cap: (3n * PRICE).toString() }, 1n);
  await call(owner, contractId, 'allow_payee', { policy_id: POLICY, payee: vendorId }, 1n);
  await call(owner, contractId, 'grant_agent_key', { policy_id: POLICY, public_key: agentKey.getPublicKey().toString() }, 1n);
  await addKey(owner, contractId, agentKey, ['execute']);
  await addKey(owner, contractId, attackKey, ['set_policy']);
  await expectRejection('1-yocto owner-policy escalation guard', /owner-only method requires exactly 1 yoctoNEAR/, () => attacker.callFunctionRaw({
    contractId, methodName: 'set_policy', args: { policy_id: POLICY, token: TOKEN, per_tx_cap: '9999999', daily_cap: '9999999' },
    deposit: 0n, gas: 100n * TGAS, waitUntil: 'FINAL' }));
  const payArgs = { policy_id: POLICY, payee: vendorId, amount: PRICE.toString(), memo: 'security-probe', expected_token: TOKEN };
  await expectRejection('policy token substitution', /policy token does not match expected token/, () => agent.callFunctionRaw({
    contractId, methodName: 'execute', args: { ...payArgs, expected_token: WRAP }, deposit: 0n, gas: 200n * TGAS, waitUntil: 'FINAL' }));
  await expectRejection('per-transaction cap', /amount exceeds per-tx cap/, () => agent.callFunctionRaw({
    contractId, methodName: 'execute', args: { ...payArgs, amount: (PRICE + 1n).toString() }, deposit: 0n, gas: 200n * TGAS, waitUntil: 'FINAL' }));
  const products = Object.fromEntries(['compute', 'storage', 'api'].map(resource => [resource,
    { policy_id: POLICY, token: TOKEN, payee: vendorId, amount: PRICE.toString() }]));
  const goals = [
    { id: 'usdc-compute', resource: 'compute', input: { text: 'circle testnet multi-resource', rounds: 25 } },
    { id: 'usdc-storage', resource: 'storage', input: { name: 'circle-usdc', content: 'Testnet USDC paid for this verified development resource.' } },
    { id: 'usdc-api', resource: 'api', input: { text: 'circle testnet resource agent' } },
  ].map(goal => ({ ...goal, policy_id: POLICY, token: TOKEN, payee: vendorId, max_amount: PRICE.toString() }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-usdc-'));
  const state = path.join(dir, 'journal.json');
  fs.writeFileSync(path.join(dir, 'goals.json'), JSON.stringify(goals, null, 2) + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'provider-config.json'), JSON.stringify({ contractId, ownerAccountId: ownerId, products }, null, 2) + '\n', { mode: 0o600 });
  const service = createResourceProvider({ rpcProvider: provider, contractId, ownerAccountId: ownerId, products, dataDir: path.join(dir, 'development-provider') });
  await new Promise((resolve, reject) => { service.server.once('error', reject); service.server.listen(0, '127.0.0.1', resolve); });
  let journal = new FileJournal(state, contractId, ownerId), success = false;
  try {
    const client = httpResourceProvider(`http://127.0.0.1:${service.server.address().port}`);
    let reviewedPlan;
    const common = { contractId, ownerAccountId: ownerId, goals, getQuote: client.getQuote, readStorage: client.readStorage,
      provider, account: agent, publicKey: agentKey.getPublicKey(), execute: true, durablePayment: true, log: console.log,
      onPlan: plan => {
        if (!reviewedPlan) {
          reviewedPlan = plan;
          fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        } else if (JSON.stringify(plan) !== JSON.stringify(reviewedPlan)) throw new Error('reviewed resource plan changed');
      } };
    // Broadcast the first real payment exactly once, then simulate the RPC
    // response being lost. Recovery reads FINAL receipts by the pre-saved hash;
    // no signer is passed to recovery and no second payment is broadcast.
    let broadcasts = 0;
    const lossyProvider = new Proxy(provider, { get(target, property) {
      if (property === 'sendTransactionUntil') return async (...args) => {
        broadcasts++;
        const outcome = await target.sendTransactionUntil(...args);
        if (broadcasts === 1) throw new Error('injected lost response after actual broadcast');
        return outcome;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    try {
      await runResourceAgent({ ...common, provider: lossyProvider, journal, fulfill: async () => { throw new Error('delivery before payment recovery'); } });
      throw new Error('lost-response injection unexpectedly completed');
    } catch (error) {
      if (!/payment could not be confirmed.*do not retry automatically.*injected lost response/.test(error.message)) throw error;
      console.log('    Lost response left one signed-hash pending payment; no automatic retry.');
    }
    const pending = journal.get(goals[0].id), firstHash = pending?.tx_hash;
    if (broadcasts !== 1 || pending?.status !== 'pending' || pending.payment_version !== 'direct-signed-v1' || !firstHash ||
        journal.get(goals[1].id) || journal.get(goals[2].id) ||
        BigInt(await view(TOKEN, 'ft_balance_of', { account_id: vendorId })) !== PRICE) throw new Error('lost-response journal or payment mismatch');
    journal.close(); journal = new FileJournal(state, contractId, ownerId);
    const recovered = await recoverDirectPayment({ plan: reviewedPlan, requestId: goals[0].id, provider, journal });
    if (recovered.settlement.tx_hash !== firstHash || journal.get(goals[0].id)?.status !== 'completed') throw new Error('key-free payment recovery mismatch');
    let injected = false;
    try {
      await runResourceAgent({ ...common, journal, fulfill: async order => {
        const result = await client.fulfill(order);
        if (!injected && order.resource === 'compute') { injected = true; return { ...result, result: '0'.repeat(64) }; }
        throw new Error('later fulfillment ran before recovery');
      } });
      throw new Error('corrupt compute delivery unexpectedly passed');
    } catch (error) {
      if (!/verification failed after confirmed payment/.test(error.message)) throw error;
      console.log('    Corrupt delivery blocked all later payments.');
    }
    const first = journal.get(goals[0].id);
    if (!injected || first?.tx_hash !== firstHash || first.delivery?.status !== 'unverified' || journal.get(goals[1].id) || journal.get(goals[2].id) ||
        BigInt(await view(TOKEN, 'ft_balance_of', { account_id: vendorId })) !== PRICE) throw new Error('verify-before-next-payment gate failed');
    journal.close(); journal = new FileJournal(state, contractId, ownerId);
    const result = await runResourceAgent({ ...common, journal, fulfill: client.fulfill });
    if (result.payments.skipped !== 1 || result.payments.paid !== 2 || result.deliveries.length !== 3 ||
        journal.get(goals[0].id)?.tx_hash !== firstHash || goals.some(goal => journal.get(goal.id)?.delivery?.status !== 'verified') ||
        BigInt(await view(TOKEN, 'ft_balance_of', { account_id: vendorId })) !== 3n * PRICE ||
        BigInt(await view(contractId, 'vault_balance', { token: TOKEN })) !== 0n ||
        BigInt(await view(contractId, 'daily_spent', { policy_id: POLICY })) !== 3n * PRICE) throw new Error('Circle mission delivery or recovery mismatch');
    const hashes = Object.fromEntries(goals.map(goal => [goal.resource, journal.get(goal.id).tx_hash]));
    console.log(`::notice title=Circle testnet USDC guarded multi-resource mission::${JSON.stringify({ contract: contractId, owner: ownerId, vendor: vendorId, token: TOKEN,
      pool: quote.pool_id, owner_setup_swap: swap.transaction_outcome.id, owner_vault_funding: funding.transaction_outcome.id, resource_transactions: hashes,
      units_per_resource: PRICE.toString(), total_micro_usdc: (3n * PRICE).toString(), lost_response_recovered_by_hash_without_key: true,
      corrupt_delivery_stopped_later_payments: true, first_hash_reused_on_restart: true, provider: 'self-hosted development',
      testnet_usdc_has_no_real_value: true, owner_swap_guarded: false })}`);
    success = true;
  } finally {
    journal.close();
    await service.close();
    if (success) fs.rmSync(dir, { recursive: true, force: true });
    else console.error(`Public testnet recovery files retained in ${dir}; do not retry an uncertain payment automatically.`);
  }
}
main().catch(error => { console.error(`[circle-usdc-demo] ERROR: ${error.stack || error}`); process.exitCode = 1; });
