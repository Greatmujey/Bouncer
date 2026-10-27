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
import { createResourceProvider } from './services/resource-provider.mjs';
import { httpResourceProvider, runResourceAgent } from './agent/resource-agent.mjs';

const { Account, KeyPair, KeyPairSigner, providers, transactions } = nearApi;
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
const provider = new providers.JsonRpcProvider({ url: RPC });
const account = (id, key) => new Account(id, provider, new KeyPairSigner(key));
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
  saveKey(id, key);
  return account(id, key);
}
function assertReceipts(result, action) {
  if (!Array.isArray(result.receipts_outcome) || !result.receipts_outcome.length) throw new Error(`${action}: no receipt outcomes`);
  const failure = result.receipts_outcome.find(item => item.outcome?.status?.Failure);
  if (failure) throw new Error(`${action}: receipt failed: ${JSON.stringify(failure.outcome.status.Failure)}`);
}
async function call(signer, contractId, methodName, args, deposit = 0n, gas = GAS100) {
  const result = await signer.callFunctionRaw({ contractId, methodName, args, deposit, gas, waitUntil: 'FINAL' });
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
  const suffix = crypto.randomBytes(4).toString('hex');
  const bid = `bouncer-${suffix}.testnet`;
  const funderId = `bouncer-ft-${suffix}.testnet`;
  const userId = `user.${bid}`;
  const vendorIds = { compute: `compute.${bid}`, storage: `storage.${bid}`, api: `api.${bid}` };
  const bouncerKey = KeyPair.fromRandom('ed25519');
  const funderKey = KeyPair.fromRandom('ed25519');
  console.log(`=== 1) Create funded Bouncer ${bid} and test-token funder ===`);
  const bouncer = await createFunded(bid, bouncerKey);
  const funder = await createFunded(funderId, funderKey);
  fs.writeFileSync(path.join(os.homedir(), '.bouncer_id'), bid);
  const deploy = await bouncer.deployContract(fs.readFileSync(wasmPath));
  assertReceipts(deploy, 'deploy');
  console.log(`    ✅ deploy ${txUrl(deploy.transaction_outcome.id)}`);
  await call(bouncer, bid, 'new', { owner: bid });
  if (await view(bid, 'contract_version', {}) !== 'bouncer-agent-v3') throw new Error('stale wasm: wait for CI and git pull');

  console.log('\n=== 2) Create funded user and three vendor accounts ===');
  const userKey = KeyPair.fromRandom('ed25519');
  saveKey(userId, userKey);
  const createdUser = await bouncer.createAccount(userId, userKey.getPublicKey(), 4n * N);
  assertReceipts(createdUser, 'create user');
  console.log(`    ✅ ${userId} ${txUrl(createdUser.transaction_outcome.id)}`);
  const user = account(userId, userKey);
  for (const [kind, id] of Object.entries(vendorIds)) {
    const key = KeyPair.fromRandom('ed25519');
    saveKey(id, key);
    const created = await bouncer.createAccount(id, key.getPublicKey(), N / 5n);
    assertReceipts(created, `create ${kind} vendor`);
    console.log(`    ✅ ${id} ${txUrl(created.transaction_outcome.id)}`);
  }

  console.log('\n=== 3) Create two separate 6-decimal testnet credit tokens ===');
  const storageSymbol = `BS${suffix}`.toUpperCase();
  const apiSymbol = `BA${suffix}`.toUpperCase();
  const storageToken = await createToken(funder, userId, storageSymbol, 'Bouncer Test Storage Credits');
  const apiToken = await createToken(funder, userId, apiSymbol, 'Bouncer Test API Credits');

  console.log('\n=== 4) Register vault and corresponding vendors with all three FTs ===');
  await call(user, WNEAR, 'storage_deposit', { account_id: userId }, STORAGE_WNEAR, GAS50);
  await call(bouncer, WNEAR, 'storage_deposit', { account_id: bid }, STORAGE_WNEAR, GAS50);
  await call(bouncer, WNEAR, 'storage_deposit', { account_id: vendorIds.compute }, STORAGE_WNEAR, GAS50);
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
  const agentFile = saveKey(bid, agentKey, 'agent');
  const added = await bouncer.signAndSendTransaction({
    receiverId: bid, waitUntil: 'FINAL',
    actions: [transactions.addKey(agentKey.getPublicKey(), transactions.functionCallAccessKey(bid, ['execute'], N))],
  });
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
    await call(bouncer, bid, 'set_policy', { policy_id: r.policy, token: r.token,
      per_tx_cap: r.per.toString(), daily_cap: r.daily.toString() }, 1n);
    await call(bouncer, bid, 'allow_payee', { policy_id: r.policy, payee: r.vendor }, 1n);
    await call(bouncer, bid, 'grant_agent_key', { policy_id: r.policy, public_key: agentKey.getPublicKey().toString() }, 1n);
  }

  console.log('\n=== 7) Quote, pay and fulfill three orders with the resource agent ===');
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  const planFile = path.join(RUN_DIR, `${bid}.plan.json`);
  const journalPath = path.join(RUN_DIR, `${bid}.bouncer-journal.json`);
  console.log(`    Plan: ${planFile}\n    Journal: ${journalPath}\n    Agent key: ${agentFile}`);
  const products = Object.fromEntries(resources.map(r => [r.resource, {
    policy_id: r.policy, token: r.token, payee: r.vendor, amount: r.payment.toString(),
  }]));
  const goals = resources.map(r => ({
    id: `${r.resource}-1`, resource: r.resource, input: r.input,
    policy_id: r.policy, token: r.token, payee: r.vendor, max_amount: r.payment.toString(),
  }));
  const dataDir = path.join(RUN_DIR, `${bid}.provider`);
  const providerFile = path.join(RUN_DIR, `${bid}.provider.json`);
  const goalsFile = path.join(RUN_DIR, `${bid}.goals.json`);
  const providerConfig = { contract_id: bid, data_dir: dataDir, port: 8787, products };
  const goalsConfig = { contract_id: bid, owner_account_id: bid, provider_url: 'http://127.0.0.1:8787', journal_path: journalPath, goals };
  for (const [file, config] of [[providerFile, providerConfig], [goalsFile, goalsConfig]]) {
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }
  console.log(`    Provider config: ${providerFile}\n    Goals config: ${goalsFile}`);
  const devProvider = createResourceProvider({ rpcProvider: provider, contractId: bid, products, dataDir });
  await new Promise((resolve, reject) => {
    devProvider.server.once('error', reject);
    devProvider.server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${devProvider.server.address().port}`;
  const client = httpResourceProvider(baseUrl);
  let journal;
  let proof;
  try {
    journal = new FileJournal(journalPath, bid, bid);
    const runner = {
      contractId: bid, ownerAccountId: bid, goals, getQuote: client.getQuote, fulfill: client.fulfill,
      onPlan: plan => {
        fs.writeFileSync(planFile, JSON.stringify(plan, null, 2) + '\n', { mode: 0o600 });
        fs.chmodSync(planFile, 0o600);
      },
      provider, account: account(bid, agentKey), publicKey: agentKey.getPublicKey(), journal, execute: true,
    };
    const first = await runResourceAgent(runner);
    if (first.payments.paid !== 3 || first.payments.blocked || first.payments.skipped || first.deliveries.length !== 3) {
      throw new Error(`unexpected agent result: ${JSON.stringify(first)}`);
    }
    const second = await runResourceAgent(runner);
    if (second.payments.skipped !== 3 || second.payments.paid || JSON.stringify(second.deliveries) !== JSON.stringify(first.deliveries)) {
      throw new Error(`duplicate-run protection failed: ${JSON.stringify(second)}`);
    }

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
  } finally {
    journal?.close();
    await new Promise(resolve => devProvider.server.close(resolve));
  }
  console.log('\n✅ Three real testnet FT payments and self-hosted resource services verified.');
  console.log('Services are development examples, not commercial vendors or production infrastructure.');
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::notice title=Testnet multi-resource proof::contract=${bid}; ${proof}`);
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
