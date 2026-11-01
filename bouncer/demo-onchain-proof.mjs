// Explicit one-shot TESTNET interoperability check. A fresh Bouncer v9 vault
// pays Circle TESTNET USDC (no real value) to our OWN local SDK-backed seller.
// The SDK is independently published but the seller is not independent. Ref
// acquisition/funding are separate owner setup; no guarded swap is claimed.
// Journals retain the original hashes; no ambiguous payment is ever retried.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import util from 'node:util';
import { fileURLToPath } from 'node:url';
import nearApi from 'near-api-js';
import { MonotonicAccount, PaymentRpcProvider } from './agent/near-account.mjs';
import { openConfiguredFileJournal, validateConfiguredFileJournalKey } from './agent/procurement.mjs';
import { submitOwnerSetupOnce } from './agent/testnet-owner-setup.mjs';
import { runOnchainProofLiveProof } from './agent/onchain-proof-live-proof.mjs';
import { loadPipRailTestSdk } from './scripts/piprail-test-adapter.mjs';
import { validateRpcEndpoint } from './shared/rpc-endpoint.mjs';
import { waitForNewTestnetKey } from './shared/testnet-ready.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN, WRAP_TESTNET as WRAP, REF_TESTNET as REF, OWNER_SETUP_INPUT,
  OWNER_SETUP_MAX_OUTPUT, DEMO_RESOURCE_PRICE as PRICE, selectOwnerSetupQuote } from './scripts/circle-testnet-setup.mjs';

const { KeyPair, KeyPairSigner, transactions } = nearApi;
const RPC = validateRpcEndpoint(process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com');
const provider = new PaymentRpcProvider(RPC);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ONE = 10n ** 24n, TGAS = 10n ** 12n, POLICY = 'circle-api';
const accountFor = (id, key) => new MonotonicAccount(id, provider, new KeyPairSigner(key));
const view = (id, method, args = {}) => provider.callFunction(id, method, args, { finality: 'final' });
const url = hash => `https://testnet.nearblocks.io/txns/${hash}`;
function assert(ok, message) { if (!ok) throw new Error(`onchain-proof demo: ${message}`); }
function receiptsOk(result, label) {
  assert(result?.final_execution_status === 'FINAL' && typeof result.status?.SuccessValue === 'string' &&
    Array.isArray(result.receipts_outcome) && result.receipts_outcome.length &&
    !result.receipts_outcome.some(r => r.outcome?.status?.Failure), `${label}: missing final successful receipts`);
}
async function setupAttempt(label, operation) {
  try { return await operation(); }
  catch (error) {
    if (error?.type !== 'Expired' || error.transaction_outcome !== undefined) throw error;
    console.warn(`    Setup ${label}: explicit pre-admission expiry; retrying once.`);
    return operation();
  }
}
async function call(account, contractId, methodName, args, deposit = 0n, gas = 100n * TGAS) {
  const result = await setupAttempt(methodName, () => account.callFunctionRaw({ contractId, methodName, args, deposit, gas, waitUntil: 'FINAL' }));
  receiptsOk(result, methodName);
  console.log(`    ${methodName}: ${url(result.transaction_outcome.id)}`);
  return result;
}
async function register(owner, token, id) {
  if ((await view(token, 'storage_balance_of', { account_id: id })) !== null) return;
  const min = (await view(token, 'storage_balance_bounds'))?.min;
  assert(typeof min === 'string' && /^(?:0|[1-9][0-9]{0,38})$/.test(min) && BigInt(min) <= ONE / 10n, 'invalid token storage minimum');
  await call(owner, token, 'storage_deposit', { account_id: id, registration_only: true }, BigInt(min), 50n * TGAS);
}
async function addKey(owner, contractId, key, methods) {
  const result = await setupAttempt('install restricted key', () => owner.signAndSendTransaction({ receiverId: owner.accountId, waitUntil: 'FINAL',
    actions: [transactions.addKey(key.getPublicKey(), transactions.functionCallAccessKey(contractId, methods, ONE / 2n))] }));
  receiptsOk(result, 'install restricted key');
  const permission = (await provider.viewAccessKey(owner.accountId, key.getPublicKey(), { finality: 'final' })).permission?.FunctionCall;
  assert(permission?.receiver_id === contractId && JSON.stringify(permission.method_names) === JSON.stringify(methods), 'restricted key scope changed');
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
function writePublic(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); }
function notice(title, data) {
  const text = JSON.stringify(data).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::notice title=${title}::${text.slice(0, 3800)}`);
}

async function main() {
  validateConfiguredFileJournalKey(); // Before any live setup, funding or network request.
  assert(process.argv.length === 2, 'no positional arguments are accepted');
  // Validate the independently published SDK before any setup or funding.
  const sdk = await loadPipRailTestSdk(process.env.BOUNCER_PIPRAIL_PACKAGE_ROOT);
  assert((await provider.viewNodeStatus())?.chain_id === 'testnet', 'RPC must report testnet');
  const meta = await view(TOKEN, 'ft_metadata');
  assert(meta?.spec === 'ft-1.0.0' && meta?.symbol === 'USDC' && meta?.decimals === 6, 'unexpected Circle testnet USDC metadata');
  const quote = await selectOwnerSetupQuote(provider); // bounded read-only quote
  const wasm = fs.readFileSync(path.join(ROOT, 'bouncer.wasm'));
  assert(wasm.includes(Buffer.from('bouncer-agent-v9')), 'requires fresh v9 WASM; marker is not attestation');
  const contractKey = KeyPair.fromRandom('ed25519'), ownerKey = KeyPair.fromRandom('ed25519');
  const vendorKey = KeyPair.fromRandom('ed25519'), agentKey = KeyPair.fromRandom('ed25519'), probeKey = KeyPair.fromRandom('ed25519');
  const contractId = `bouncer-proof-${crypto.randomBytes(4).toString('hex')}.testnet`;
  const ownerId = `owner.${contractId}`, vendorId = `vendor.${contractId}`;
  console.log(`Testnet-only PipRail-style proof: ${contractId}; seller is self-hosted SDK software; Circle testnet USDC has no value.`);
  const contract = await createFunded(contractId, contractKey);
  const deployed = await setupAttempt('deploy', () => contract.signAndSendTransaction({ receiverId: contractId,
    actions: [transactions.deployContract(wasm)], waitUntil: 'FINAL' }));
  receiptsOk(deployed, 'deploy');
  for (const [id, key, amount] of [[ownerId, ownerKey, 3n * ONE], [vendorId, vendorKey, ONE / 10n]]) {
    const created = await setupAttempt('create subaccount', () => contract.signAndSendTransaction({ receiverId: id, waitUntil: 'FINAL',
      actions: [transactions.createAccount(), transactions.transfer(amount), transactions.addKey(key.getPublicKey(), transactions.fullAccessKey())] }));
    receiptsOk(created, 'create subaccount');
  }
  const owner = accountFor(ownerId, ownerKey), agent = accountFor(ownerId, agentKey);
  await call(contract, contractId, 'new', { owner: ownerId });
  assert(await view(contractId, 'contract_version') === 'bouncer-agent-v9' && await view(contractId, 'get_owner') === ownerId, 'unexpected deployment');
  for (const [token, id] of [[WRAP, ownerId], [TOKEN, ownerId], [TOKEN, contractId], [TOKEN, vendorId]]) await register(owner, token, id);
  await call(owner, WRAP, 'near_deposit', {}, OWNER_SETUP_INPUT, 50n * TGAS);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-piprail-live-'));
  const setup = openConfiguredFileJournal(path.join(dir, 'setup-journal.json'), contractId, ownerId);
  let journal, server;
  try {
    const before = BigInt(await view(TOKEN, 'ft_balance_of', { account_id: ownerId }));
    const swap = await submitOwnerSetupOnce({ id: 'owner-ref-swap', account: owner, publicKey: ownerKey.getPublicKey(), token: WRAP,
      args: { receiver_id: REF, amount: quote.input_amount, msg: quote.msg }, gas: 300n * TGAS, provider, journal: setup });
    const acquired = BigInt(await view(TOKEN, 'ft_balance_of', { account_id: ownerId })) - before;
    assert(acquired >= BigInt(quote.min_output) && acquired <= OWNER_SETUP_MAX_OUTPUT, 'owner setup swap did not meet bounds');
    const funding = await submitOwnerSetupOnce({ id: 'owner-vault-funding', account: owner, publicKey: ownerKey.getPublicKey(), token: TOKEN,
      args: { receiver_id: contractId, amount: PRICE.toString(), msg: 'fund' }, gas: 200n * TGAS, provider, journal: setup });
    assert(BigInt(await view(contractId, 'vault_balance', { token: TOKEN })) === PRICE &&
      BigInt(await view(TOKEN, 'ft_balance_of', { account_id: vendorId })) === 0n, 'vault funding mismatch');
    await call(owner, contractId, 'set_policy', { policy_id: POLICY, token: TOKEN, per_tx_cap: PRICE.toString(), daily_cap: PRICE.toString() }, 1n);
    await call(owner, contractId, 'allow_payee', { policy_id: POLICY, payee: vendorId }, 1n);
    await call(owner, contractId, 'grant_agent_key', { policy_id: POLICY, public_key: agentKey.getPublicKey().toString() }, 1n);
    await addKey(owner, contractId, agentKey, ['execute']);
    await addKey(owner, contractId, probeKey, ['set_policy']);
    const probe = accountFor(ownerId, probeKey), escalation = { policy_id: POLICY, token: TOKEN, per_tx_cap: '9999999', daily_cap: '9999999' };
    await expectRejection('zero-deposit policy escalation blocked by Bouncer', /owner-only method requires exactly 1 yoctoNEAR/, () =>
      probe.callFunctionRaw({ contractId, methodName: 'set_policy', args: escalation, deposit: 0n, gas: 100n * TGAS, waitUntil: 'FINAL' }));
    await expectRejection('one-yocto policy escalation blocked by NEAR', /DepositWithFunctionCall|deposit with a function call action is not allowed with a function call access key/i, () =>
      probe.callFunctionRaw({ contractId, methodName: 'set_policy', args: escalation, deposit: 1n, gas: 100n * TGAS, waitUntil: 'FINAL' }));

    // The published SDK's NEAR preset is mainnet-only. The explicit test
    // wrapper uses its unmodified verifier against the actual testnet RPC.
    const gate = sdk.createPaymentGate({ chain: 'near', token: { contractId: TOKEN, decimals: 6, symbol: 'USDC' },
      amount: '0.001', payTo: vendorId, rpcUrl: RPC, maxTimeoutSeconds: 600 });
    let sellerCalls = 0;
    const payload = { service: 'self-hosted-piprail-sdk-fixture', network: 'testnet', value: 42 };
    const handler = sdk.toFetchHandler(gate, async () => {
      sellerCalls++; return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
    });
    server = http.createServer(async (req, res) => {
      try {
        if (req.method !== 'GET' || req.url !== '/api') { res.writeHead(404); res.end(); return; }
        const headers = new Headers();
        if (typeof req.headers['payment-signature'] === 'string') headers.set('payment-signature', req.headers['payment-signature']);
        const response = await handler(new Request(`http://127.0.0.1:${server.address().port}/api`, { method: 'GET', headers }));
        const out = Object.fromEntries(response.headers.entries()); out.connection = 'close';
        res.writeHead(response.status, out); res.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) { console.error(`SDK seller error: ${error.message}`); if (!res.headersSent) res.writeHead(500); res.end(); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const goal = { version: 1, id: 'piprail-api', contract_id: contractId, owner_account_id: ownerId, policy_id: POLICY,
      token: TOKEN, payee: vendorId, max_amount: PRICE.toString(), resource_url: `http://127.0.0.1:${server.address().port}/api`,
      max_quote_age_seconds: 120, accept_public_proof_risk: true, accept_unbound_resource_risk: true };
    writePublic(path.join(dir, 'goal.json'), goal);
    const state = path.join(dir, 'journal.json');
    journal = openConfiguredFileJournal(state, contractId, ownerId);
    const proof = await runOnchainProofLiveProof({ goal, provider, account: agent, publicKey: agentKey.getPublicKey(),
      getJournal: () => journal, reopenJournal: () => { journal.close(); journal = openConfiguredFileJournal(state, contractId, ownerId, { requireExisting: true }); }, log: console.log });
    assert(sellerCalls === 1 && JSON.stringify(JSON.parse(Buffer.from(proof.response.body_base64, 'base64').toString())) === JSON.stringify(payload),
      'SDK-backed seller response mismatch');
    assert(BigInt(await view(TOKEN, 'ft_balance_of', { account_id: vendorId })) === PRICE &&
      BigInt(await view(contractId, 'vault_balance', { token: TOKEN })) === 0n &&
      BigInt(await view(contractId, 'daily_spent', { policy_id: POLICY })) === PRICE, 'settled balances or daily budget mismatch');
    const evidence = { contract: contractId, owner: ownerId, vendor: vendorId, token: TOKEN, owner_setup_swap: swap.transaction_outcome.id,
      owner_vault_funding: funding.transaction_outcome.id, payment: proof.tx_hash, nonce: journal.get(goal.id).request.memo,
      amount_micro_usdc: PRICE.toString(), ...proof, sdk: '@piprail/sdk@3.3.0', sdk_testnet_wrapper: true,
      seller: 'self-hosted local SDK gate; not an independent merchant', owner_swap_guarded: false,
      policy_escalation_blocked_at_zero_and_one_yocto: true,
      public_proof_not_order_bound: true, testnet_usdc_has_no_real_value: true };
    writePublic(path.join(dir, 'evidence.json'), evidence);
    notice('One-shot testnet onchain-proof SDK interoperability', evidence);
  } finally {
    journal?.close(); setup.close();
    if (server) await new Promise(resolve => server.close(resolve));
    console.log(`Public testnet recovery evidence retained in ${dir}; never retry an uncertain payment automatically.`);
  }
}
main().catch(error => { console.error(`[onchain-proof-demo] ERROR: ${error.stack || error}`); process.exitCode = 1; });
