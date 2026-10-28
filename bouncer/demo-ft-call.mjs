// LIVE TESTNET ONLY. Acquire a tiny amount of test USDC.e from an independent
// Ref pool as owner setup; then use a restricted key to move a capped amount
// from Bouncer to OutLayer's prepaid balance via the owner-pinned NEP-141 call.
// A prepaid deposit is NOT a purchased/delivered API service. Circle USDC is a
// different token and is not used here. Never retry an ambiguous payment.
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
import { validateRpcEndpoint } from './shared/rpc-endpoint.mjs';

const { KeyPair, KeyPairSigner, providers, transactions } = nearApi;
const RPC = validateRpcEndpoint(process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com');
const provider = new providers.JsonRpcProvider({ url: RPC });
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ONE = 10n ** 24n, TGAS = 10n ** 12n;
const TOKEN = 'usdc.fakes.testnet', WRAP = 'wrap.testnet', REF = 'ref-finance-101.testnet', OUTLAYER = 'outlayer.testnet';
const MSG = '{"action":"deposit_balance"}', USD_AMOUNT = 15_000n, REFUND_AMOUNT = 10n ** 20n;
const accountFor = (id, key) => new MonotonicAccount(id, provider, new KeyPairSigner(key));
const view = (id, method, args = {}) => provider.callFunction(id, method, args, { finality: 'final' });
const txUrl = hash => `https://testnet.nearblocks.io/txns/${hash}`;

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
  return accountFor(id, key);
}
function expected(goal) { return { policy_id: goal.policy_id, payee: goal.payee, amount: goal.amount, expected_token: goal.token,
  expected_msg: goal.msg, expected_policy_revision: goal.policy_revision, expected_route_revision: goal.route_revision }; }

async function main() {
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  if (await view(OUTLAYER, 'get_payment_token_contract') !== TOKEN) throw new Error('OutLayer no longer accepts the explicitly pinned fake test token');
  const meta = await view(TOKEN, 'ft_metadata');
  if (meta?.decimals !== 6) throw new Error('unexpected test token decimals');
  const contractKey = KeyPair.fromRandom('ed25519'), ownerKey = KeyPair.fromRandom('ed25519');
  const agentKey = KeyPair.fromRandom('ed25519'), attackKey = KeyPair.fromRandom('ed25519');
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
  if (await view(contractId, 'contract_version') !== 'bouncer-agent-v6' || await view(contractId, 'get_owner') !== ownerId) throw new Error('stale contract or unexpected owner');

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
    completed = true;
  } finally {
    journal.close();
    if (completed) fs.rmSync(dir, { recursive: true, force: true });
    else console.error(`Unresolved public testnet evidence preserved: ${dir}. Reconcile journal hashes; never resend automatically.`);
  }
  console.log('Evidence scope: independent provider accepted a prepaid fake test-token balance; no paid API/storage delivery was demonstrated.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
