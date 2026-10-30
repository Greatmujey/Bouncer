// Live independent compute integration: fresh testnet deployment, distinct
// owner, restricted key, on-chain native policy, pinned OutLayer program,
// actual provider charge/refund, injected verification fault and recovery.
// Never use mainnet funds. No paid execution is automatically retried.
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
import { runOutlayerGoal, recoverOutlayerGoal, RANDOM_TESTNET_PROGRAM } from './agent/outlayer.mjs';
import { validateRpcEndpoint } from './shared/rpc-endpoint.mjs';
import { waitForNewTestnetKey } from './shared/testnet-ready.mjs';

const { KeyPair, KeyPairSigner, providers, transactions } = nearApi;
const RPC = validateRpcEndpoint(process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com');
const provider = new providers.JsonRpcProvider({ url: RPC });
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ONE = 10n ** 24n, TGAS = 10n ** 12n;
const amount = ONE / 10n, funding = 3n * amount;
const program = RANDOM_TESTNET_PROGRAM;
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
    // Setup only. This is a pre-admission rejection, not an ambiguous send.
    if (error?.type !== 'Expired' || error.transaction_outcome !== undefined) throw error;
    console.warn(`    Setup ${label}: explicit expired transaction; retrying once.`);
    return operation();
  }
}
async function setupCall(account, contract, method, args, deposit = 0n, gas = 100n * TGAS) {
  const result = await setupAttempt(method, () => account.callFunctionRaw({ contractId: contract, methodName: method, args, deposit, gas, waitUntil: 'FINAL' }));
  receiptsOk(result, method);
  console.log(`    ✅ ${method}: ${txUrl(result.transaction_outcome.id)}`);
  return result;
}
async function addKey(owner, contract, key, methods) {
  const result = await setupAttempt('install restricted key', () => owner.signAndSendTransaction({ receiverId: owner.accountId, waitUntil: 'FINAL',
    actions: [transactions.addKey(key.getPublicKey(), transactions.functionCallAccessKey(contract, methods, ONE / 2n))] }));
  receiptsOk(result, 'install restricted key');
  const access = await provider.viewAccessKey(owner.accountId, key.getPublicKey(), { finality: 'final' });
  const permission = access.permission?.FunctionCall;
  if (permission?.receiver_id !== contract || JSON.stringify(permission.method_names) !== JSON.stringify(methods)) throw new Error('unexpected restricted key scope');
}
async function expectRejection(label, pattern, operation) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await operation(); }
    catch (error) {
      if (attempt === 0 && error?.type === 'Expired' && !error.transaction_outcome) continue; // deliberately invalid test, never payment
      const detail = `${error.message || ''} ${util.inspect(error, { depth: 8 })}`;
      if (!pattern.test(detail)) throw new Error(`${label}: unexpected rejection ${detail}`, { cause: error });
      console.log(`    ✅ ${label}: rejected`);
      return;
    }
    throw new Error(`${label}: unexpectedly succeeded`);
  }
  throw new Error(`${label}: repeated testnet expiry`);
}
async function createFunded(id, key) {
  const response = await fetch('https://helper.testnet.near.org/account', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newAccountId: id, newAccountPublicKey: key.getPublicKey().toString() }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`testnet helper HTTP ${response.status}`);
  await waitForNewTestnetKey(provider, id, key.getPublicKey());
  return accountFor(id, key);
}

// Never destroy the only local copy of an unresolved testnet payment. The
// failure artifact contains just the synthetic goal and public journal, not keys.
export function finishDemoEvidence({ journal, directory, journalPath, goalPath, completed, log = console.error }) {
  journal.close();
  if (completed) fs.rmSync(directory, { recursive: true, force: true });
  else log(`Unresolved testnet evidence preserved: goal=${goalPath}; journal=${journalPath}. Reconcile the recorded hash; never resend automatically.`);
}

async function main() {
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const wasm = fs.readFileSync(path.join(ROOT, 'bouncer.wasm'));
  const suffix = crypto.randomBytes(4).toString('hex');
  const contractId = `bouncer-out-${suffix}.testnet`, ownerId = `owner.${contractId}`, policyId = 'external-compute';
  const contractKey = KeyPair.fromRandom('ed25519'), ownerKey = KeyPair.fromRandom('ed25519');
  const agentKey = KeyPair.fromRandom('ed25519'), attackKey = KeyPair.fromRandom('ed25519');
  console.log(`BOUNCER guarded OutLayer integration (testnet only): contract=${contractId}; separate owner=${ownerId}`);

  const contract = await createFunded(contractId, contractKey);
  const deployed = await setupAttempt('deploy', () => contract.signAndSendTransaction({ receiverId: contractId,
    actions: [transactions.deployContract(wasm)], waitUntil: 'FINAL' }));
  receiptsOk(deployed, 'deploy');
  const created = await setupAttempt('create owner', () => contract.signAndSendTransaction({ receiverId: ownerId,
    actions: [transactions.createAccount(), transactions.transfer(3n * ONE), transactions.addKey(ownerKey.getPublicKey(), transactions.fullAccessKey())],
    waitUntil: 'FINAL' }));
  receiptsOk(created, 'create owner');
  const owner = accountFor(ownerId, ownerKey);
  await setupCall(contract, contractId, 'new', { owner: ownerId });
  if (await view(contractId, 'contract_version') !== 'bouncer-agent-v9' || await view(contractId, 'get_owner') !== ownerId) throw new Error('stale contract or wrong owner');

  await setupCall(owner, contractId, 'deposit_native', {}, funding);
  await setupCall(owner, contractId, 'set_policy', { policy_id: policyId, token: 'native', per_tx_cap: amount.toString(), daily_cap: amount.toString() }, 1n);
  await setupCall(owner, contractId, 'allow_payee', { policy_id: policyId, payee: 'outlayer.testnet' }, 1n);
  await setupCall(owner, contractId, 'set_outlayer_program', { policy_id: policyId, program }, 1n);
  await setupCall(owner, contractId, 'grant_agent_key', { policy_id: policyId, public_key: agentKey.getPublicKey().toString() }, 1n);
  await addKey(owner, contractId, agentKey, ['execute_outlayer']);
  await addKey(owner, contractId, attackKey, ['set_outlayer_program']);
  const agent = accountFor(ownerId, agentKey), attacker = accountFor(ownerId, attackKey);

  await expectRejection('1-yocto program escalation guard', /owner-only method requires exactly 1 yoctoNEAR/, () => attacker.callFunctionRaw({
    contractId, methodName: 'set_outlayer_program', args: { policy_id: policyId, program }, deposit: 0n, gas: 100n * TGAS, waitUntil: 'FINAL' }));
  await expectRejection('native per-transaction cap', /amount exceeds per-tx cap/, () => agent.callFunctionRaw({
    contractId, methodName: 'execute_outlayer', args: { policy_id: policyId, amount: (amount + 1n).toString(), input_data: '{"min":1,"max":100}', expected_program: program },
    deposit: 0n, gas: 300n * TGAS, waitUntil: 'FINAL' }));

  const goal = { id: 'external-random', contract_id: contractId, owner_account_id: ownerId, policy_id: policyId,
    amount: amount.toString(), input: { min: 1, max: 100 }, program };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-outlayer-'));
  const journalPath = path.join(dir, 'journal.json'), goalPath = path.join(dir, 'goal.json');
  fs.writeFileSync(goalPath, JSON.stringify(goal, null, 2) + '\n', { mode: 0o600 });
  let journal = new FileJournal(journalPath, contractId, ownerId);
  let sends = 0, inject = true, completed = false;
  const faultProvider = new Proxy(provider, { get(target, property) {
    if (property === 'sendTransactionUntil') return async (...args) => { sends++; return target.sendTransactionUntil(...args); };
    if (property === 'txStatusReceipts') return async (...args) => {
      const result = await target.txStatusReceipts(...args);
      if (!inject) return result;
      inject = false;
      // An injected local verification fault, not a claim the provider failed:
      // remove the raw refund receipt once, after the actual paid transaction.
      return { ...result, receipts: [] };
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  let paidHash;
  try {
    const dry = await runOutlayerGoal({ goal, provider, account: agent, publicKey: agentKey.getPublicKey(), journal, execute: false });
    if (dry.status !== 'READY' || sends !== 0) throw new Error('preflight did not stay read-only');
    try {
      await runOutlayerGoal({ goal, provider: faultProvider, account: agent, publicKey: agentKey.getPublicKey(), journal, execute: true });
      throw new Error('injected verification failure unexpectedly passed');
    } catch (error) {
      if (!/payment\/delivery unresolved/.test(error.message)) throw error;
    }
    paidHash = journal.get(goal.id)?.tx_hash;
    if (!paidHash || sends !== 1 || journal.get(goal.id)?.status !== 'pending') throw new Error('uncertain delivery was not durably journaled');
    console.log(`    ✅ Local evidence fault stopped delivery after one send; recovering ${txUrl(paidHash)}`);
    // Exercise the actual no-key CLI in a fresh process, using the same goal,
    // journal and transaction hash. Release the local lock first; if the CLI
    // fails the evidence directory is retained for manual reconciliation.
    journal.close();
    const cli = await util.promisify(execFile)(process.execPath, [path.join(ROOT, 'bouncer/agent/outlayer.mjs'),
      '--goal', goalPath, '--state', journalPath, '--rpc', RPC, '--recover'], { timeout: 90_000, maxBuffer: 64 * 1024 });
    if (!cli.stdout.includes('REUSED') || !cli.stdout.includes(paidHash)) throw new Error('key-free recovery CLI did not reuse the recorded transaction');
    journal = new FileJournal(journalPath, contractId, ownerId);
    if (journal.get(goal.id)?.status !== 'completed' || journal.get(goal.id)?.tx_hash !== paidHash) throw new Error('key-free CLI did not persist verified recovery');
    console.log('    ✅ A separate key-free recovery CLI verified and persisted the same transaction.');
    const recovered = await recoverOutlayerGoal({ goal, provider, journal });
    if (recovered.status !== 'REUSED' || recovered.delivery.tx_hash !== paidHash || sends !== 1) throw new Error('recovery did not reuse the paid transaction');
    const again = await recoverOutlayerGoal({ goal, provider, journal });
    if (again.status !== 'REUSED' || sends !== 1) throw new Error('completed goal was repaid');
    const balance = BigInt(await view(contractId, 'vault_balance', { token: 'native' }));
    const spent = BigInt(await view(contractId, 'daily_spent', { policy_id: policyId }));
    if (balance !== funding - amount || spent !== amount) throw new Error('maximum exposure was not conservatively reserved');
    const blocked = await view(contractId, 'check', { policy_id: policyId, payee: 'outlayer.testnet', amount: '1' });
    if (blocked?.[0] !== false || !String(blocked[1]).includes('daily cap')) throw new Error('rolling budget did not block another request');
    console.log(`::notice title=Guarded independent OutLayer testnet delivery::contract=${contractId}; owner=${ownerId}; tx=${paidHash}; output=${recovered.delivery.result.random_number}; charged_yocto=${recovered.delivery.charged_yocto}; owner_refund_yocto=${recovered.delivery.refunded_to_owner_yocto}; sends=${sends}; fault=recovered; budget_reserved_yocto=${spent}`);
    console.log('Evidence scope: testnet native NEAR, trusted RPC and OutLayer receipts; output range only. TEE attestation and randomness quality were not independently verified.');
    await setupCall(owner, contractId, 'withdraw_native', { amount: balance.toString() }, 1n);
    if (BigInt(await view(contractId, 'vault_balance', { token: 'native' })) !== 0n) throw new Error('native withdrawal did not clear the tracked vault');
    completed = true;
  } finally {
    finishDemoEvidence({ journal, directory: dir, journalPath, goalPath, completed });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
