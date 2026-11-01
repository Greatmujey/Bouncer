// Explicit opt-in TESTNET-only integration. One independent OutLayer oracle
// execution is paid with native testnet NEAR through a v9 exact Project route.
// Its single-source price is included in three development-resource orders,
// which are paid with canonical Circle TESTNET USDC (no real value). Ref is an
// owner-only setup swap, not a guarded agent trade. The FT provider is local
// development software, not an independent/commercial service. No ambiguous
// payment is retried; public recovery evidence is retained on failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import util from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import nearApi from 'near-api-js';
import { MonotonicAccount, PaymentRpcProvider } from './agent/near-account.mjs';
import { openConfiguredFileJournal, validateConfiguredFileJournalKey } from './agent/procurement.mjs';
import { submitOwnerSetupOnce } from './agent/testnet-owner-setup.mjs';
import { runOracleGoal, recoverOracleGoal, assertOracleFreshForUse, assertOracleProjectRegistry,
  ORACLE_TESTNET_PROJECT } from './agent/oracle-outlayer.mjs';
import { runMixedMission } from './agent/mixed-mission.mjs';
import { makeOracleDependentWorkflow, runDependentLiveProof, verifySellerV2ProofState, verifySellerV3ProofState,
  verifySellerV3AccessControls } from './agent/dependent-live-proof.mjs';
import { httpResourceProvider } from './agent/resource-agent.mjs';
import { createResourceProvider } from './services/resource-provider.mjs';
import { validateRpcEndpoint } from './shared/rpc-endpoint.mjs';
import { waitForNewTestnetKey } from './shared/testnet-ready.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN, WRAP_TESTNET as WRAP, REF_TESTNET as REF, OWNER_SETUP_INPUT,
  OWNER_SETUP_MAX_OUTPUT, DEMO_RESOURCE_PRICE as PRICE, selectOwnerSetupQuote } from './scripts/circle-testnet-setup.mjs';

const { KeyPair, KeyPairSigner, transactions } = nearApi;
const RPC = validateRpcEndpoint(process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com');
const provider = new PaymentRpcProvider(RPC);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ONE = 10n ** 24n, TGAS = 10n ** 12n, MAX_NATIVE = ONE / 10n;
const OUTLAYER = 'outlayer.testnet', NATIVE_POLICY = 'independent-price', FT_POLICY = 'circle-resources';
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
  // Only non-payment setup can retry an explicit pre-admission Expired.
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
function notice(title, data) {
  const text = JSON.stringify(data).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::notice title=${title}::${text.slice(0, 3800)}`);
}

async function main() {
  validateConfiguredFileJournalKey(); // Before any live setup, funding or network request.
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !['--dependent-workflow', '--seller-v2-workflow', '--seller-v3-workflow', '--seller-v3-fresh'].includes(args[0]))) {
    throw new Error('optional argument: --dependent-workflow, --seller-v2-workflow, --seller-v3-workflow or --seller-v3-fresh');
  }
  const sellerV2 = args[0] === '--seller-v2-workflow';
  const sellerV3Fresh = args[0] === '--seller-v3-fresh';
  const sellerV3 = args[0] === '--seller-v3-workflow' || sellerV3Fresh;
  const dependent = sellerV2 || sellerV3 || args[0] === '--dependent-workflow';
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const meta = await view(TOKEN, 'ft_metadata');
  if (meta?.spec !== 'ft-1.0.0' || meta?.symbol !== 'USDC' || meta?.decimals !== 6) throw new Error('unexpected Circle testnet USDC metadata');
  await assertOracleProjectRegistry(provider); // read-only; verify real UUID, version, hash and pricing before setup
  const quote = await selectOwnerSetupQuote(provider); // read-only; no transaction
  const project = { ...ORACLE_TESTNET_PROJECT }, input = project.input_data;
  const estimate = BigInt(await view(OUTLAYER, 'estimate_execution_cost', { resource_limits: {
    max_instructions: project.max_instructions, max_memory_mb: project.max_memory_mb, max_execution_seconds: project.max_execution_seconds,
  }, input_len: Buffer.byteLength(input) }));
  if (estimate <= 0n || estimate > MAX_NATIVE) throw new Error('provider estimate exceeds the native maximum');
  const wasm = fs.readFileSync(path.join(ROOT, 'bouncer.wasm'));
  if (!wasm.includes(Buffer.from('bouncer-agent-v9'))) throw new Error('demo requires the fresh v9 artifact; marker is not attestation');
  const contractKey = KeyPair.fromRandom('ed25519'), ownerKey = KeyPair.fromRandom('ed25519'), vendorKey = KeyPair.fromRandom('ed25519');
  const oracleKey = KeyPair.fromRandom('ed25519'), resourceKey = KeyPair.fromRandom('ed25519'), attackKey = KeyPair.fromRandom('ed25519');
  const suffix = crypto.randomBytes(4).toString('hex'), contractId = `bouncer-oracle-${suffix}.testnet`;
  const ownerId = `owner.${contractId}`, vendorId = `vendor.${contractId}`;
  console.log(`Independent oracle + Circle TESTNET ${sellerV3 ? 'seller-v3 authenticated workflow' : sellerV2 ? 'seller-v2 dependent workflow' : dependent ? 'dependent workflow' : 'resource mission'}: contract=${contractId}; no real value; FT provider=self-hosted development`);
  const contract = await createFunded(contractId, contractKey);
  const deployed = await setupAttempt('deploy', () => contract.signAndSendTransaction({ receiverId: contractId,
    actions: [transactions.deployContract(wasm)], waitUntil: 'FINAL' }));
  receiptsOk(deployed, 'deploy');
  for (const [id, key, amount] of [[ownerId, ownerKey, 3n * ONE], [vendorId, vendorKey, ONE / 10n]]) {
    const created = await setupAttempt('create subaccount', () => contract.signAndSendTransaction({ receiverId: id,
      actions: [transactions.createAccount(), transactions.transfer(amount), transactions.addKey(key.getPublicKey(), transactions.fullAccessKey())], waitUntil: 'FINAL' }));
    receiptsOk(created, 'create subaccount');
  }
  const owner = accountFor(ownerId, ownerKey), oracleAgent = accountFor(ownerId, oracleKey), ftAgent = accountFor(ownerId, resourceKey);
  const attacker = accountFor(ownerId, attackKey);
  await call(contract, contractId, 'new', { owner: ownerId });
  if (await view(contractId, 'contract_version') !== 'bouncer-agent-v9' || await view(contractId, 'get_owner') !== ownerId) throw new Error('stale contract or wrong owner');

  // Prepare Circle testnet USDC as the full-access OWNER, before any agent
  // purchase. The swap and vault funding are each sent once, never retried.
  for (const [token, id] of [[WRAP, ownerId], [TOKEN, ownerId], [TOKEN, contractId], [TOKEN, vendorId]]) await register(owner, token, id);
  await call(owner, WRAP, 'near_deposit', {}, OWNER_SETUP_INPUT, 50n * TGAS);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), sellerV3Fresh ? 'bouncer-seller-v3-fresh-' : sellerV3 ? 'bouncer-seller-v3-live-' :
    sellerV2 ? 'bouncer-seller-v2-live-' : dependent ? 'bouncer-dependent-live-' : 'bouncer-oracle-'));
  const setupJournal = openConfiguredFileJournal(path.join(dir, 'setup-journal.json'), contractId, ownerId);
  let swap, funding;
  try {
    const before = BigInt(await view(TOKEN, 'ft_balance_of', { account_id: ownerId }));
    // These owner-only setup transfers are not guarded agent swaps. Persist
    // each exact signed hash before a single send, including on timeout.
    swap = await submitOwnerSetupOnce({ id: 'owner-ref-swap', account: owner, publicKey: ownerKey.getPublicKey(), token: WRAP,
      args: { receiver_id: REF, amount: quote.input_amount, msg: quote.msg }, gas: 300n * TGAS, provider, journal: setupJournal });
    console.log(`    owner Ref swap: ${url(swap.transaction_outcome.id)}`);
    const acquired = BigInt(await view(TOKEN, 'ft_balance_of', { account_id: ownerId })) - before;
    if (acquired < BigInt(quote.min_output) || acquired > OWNER_SETUP_MAX_OUTPUT) throw new Error('owner setup swap did not meet output bounds');
    funding = await submitOwnerSetupOnce({ id: 'owner-vault-funding', account: owner, publicKey: ownerKey.getPublicKey(), token: TOKEN,
      args: { receiver_id: contractId, amount: (3n * PRICE).toString(), msg: 'fund' }, gas: 200n * TGAS, provider, journal: setupJournal });
    console.log(`    owner vault funding: ${url(funding.transaction_outcome.id)}`);
    if (BigInt(await view(contractId, 'vault_balance', { token: TOKEN })) !== 3n * PRICE ||
        BigInt(await view(TOKEN, 'ft_balance_of', { account_id: contractId })) !== 3n * PRICE ||
        BigInt(await view(TOKEN, 'ft_balance_of', { account_id: vendorId })) !== 0n) throw new Error('Circle vault setup mismatch');
  } catch (error) {
    console.error(`Public testnet setup evidence retained in ${dir}; reconcile any recorded hash, never resend automatically.`);
    throw error;
  } finally { setupJournal.close(); }
  await call(owner, contractId, 'set_policy', { policy_id: FT_POLICY, token: TOKEN, per_tx_cap: PRICE.toString(), daily_cap: (3n * PRICE).toString() }, 1n);
  await call(owner, contractId, 'allow_payee', { policy_id: FT_POLICY, payee: vendorId }, 1n);
  await call(owner, contractId, 'grant_agent_key', { policy_id: FT_POLICY, public_key: resourceKey.getPublicKey().toString() }, 1n);
  await addKey(owner, contractId, resourceKey, ['execute']);

  // Separately authorize a native-NEAR policy and an exact, owner-pinned lookup.
  await call(owner, contractId, 'deposit_native', {}, 2n * MAX_NATIVE);
  await call(owner, contractId, 'set_policy', { policy_id: NATIVE_POLICY, token: 'native', per_tx_cap: MAX_NATIVE.toString(), daily_cap: MAX_NATIVE.toString() }, 1n);
  await call(owner, contractId, 'allow_payee', { policy_id: NATIVE_POLICY, payee: OUTLAYER }, 1n);
  await call(owner, contractId, 'set_outlayer_native_project', { policy_id: NATIVE_POLICY, project }, 1n);
  await call(owner, contractId, 'grant_agent_key', { policy_id: NATIVE_POLICY, public_key: oracleKey.getPublicKey().toString() }, 1n);
  await addKey(owner, contractId, oracleKey, ['execute_outlayer_native_project']);
  await addKey(owner, contractId, attackKey, ['set_outlayer_native_project']);
  const route = await view(contractId, 'get_outlayer_native_project', { policy_id: NATIVE_POLICY });
  const goal = { id: 'independent-near-price', contract_id: contractId, owner_account_id: ownerId,
    policy_id: NATIVE_POLICY, amount: MAX_NATIVE.toString(), route, max_age_seconds: 900 };
  await expectRejection('zero-deposit project escalation guard', /owner-only method requires exactly 1 yoctoNEAR/, () => attacker.callFunctionRaw({
    contractId, methodName: 'set_outlayer_native_project', args: { policy_id: NATIVE_POLICY, project }, deposit: 0n, gas: 100n * TGAS, waitUntil: 'FINAL' }));
  await expectRejection('one-yocto project escalation blocked by NEAR', /DepositWithFunctionCall|deposit with a function call action is not allowed with a function call access key/i, () => attacker.callFunctionRaw({
    contractId, methodName: 'set_outlayer_native_project', args: { policy_id: NATIVE_POLICY, project }, deposit: 1n, gas: 100n * TGAS, waitUntil: 'FINAL' }));
  const altered = { ...route, project: { ...route.project, input_data: '{"command":"arbitrary"}' } };
  await expectRejection('on-chain request substitution', /native project route changed since review/, () => oracleAgent.callFunctionRaw({
    contractId, methodName: 'execute_outlayer_native_project', args: { policy_id: NATIVE_POLICY, amount: MAX_NATIVE.toString(), expected_route: altered },
    deposit: 0n, gas: 300n * TGAS, waitUntil: 'FINAL' }));
  await expectRejection('native per-transaction cap', /amount exceeds per-tx cap/, () => oracleAgent.callFunctionRaw({
    contractId, methodName: 'execute_outlayer_native_project', args: { policy_id: NATIVE_POLICY, amount: (MAX_NATIVE + 1n).toString(), expected_route: route },
    deposit: 0n, gas: 300n * TGAS, waitUntil: 'FINAL' }));

  const state = path.join(dir, 'journal.json'), goalPath = path.join(dir, 'oracle-goal.json');
  fs.writeFileSync(goalPath, JSON.stringify(goal, null, 2) + '\n', { mode: 0o600 });
  let journal = openConfiguredFileJournal(state, contractId, ownerId), success = false, service;
  try {
    if (dependent) {
      // One manifest is frozen before the first workflow payment. Each data
      // binding refers only to the previous verified output; financial routes
      // remain owner-pinned. The provider is local development code, not an
      // independent FT merchant.
      const products = Object.fromEntries(['compute', 'storage', 'api'].map(resource => [resource,
        { policy_id: FT_POLICY, token: TOKEN, payee: vendorId, amount: PRICE.toString() }]));
      const config = { contract_id: contractId, owner_account_id: ownerId, products,
        data_dir: path.join(dir, 'development-provider'), port: 0, ...(sellerV3 ? { seller_origin: 'http://127.0.0.1:0' } : {}) };
      const configPath = path.join(dir, 'provider-config.json'), workflowPath = path.join(dir, 'workflow.json');
      const ordersPath = path.join(dir, 'derived-orders.json');
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      const workflow = makeOracleDependentWorkflow({ goal, token: TOKEN, payee: vendorId,
        policyId: FT_POLICY, price: PRICE.toString(), providerUrl: 'http://127.0.0.1:0',
        ...(sellerV3 ? { orderBinding: 'seller-v3' } : sellerV2 ? { orderBinding: 'seller-v2' } : {}) });
      fs.writeFileSync(workflowPath, JSON.stringify(workflow, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      let client;
      const startService = async () => {
        service = createResourceProvider({ rpcProvider: provider, contractId, ownerAccountId: ownerId,
          products, dataDir: config.data_dir, sellerOrigin: config.seller_origin });
        await new Promise((resolve, reject) => { service.server.once('error', reject); service.server.listen(0, '127.0.0.1', resolve); });
        client = httpResourceProvider(`http://127.0.0.1:${service.server.address().port}`);
      };
      await startService();
      const derivedOrders = [];
      const resources = { account: ftAgent, publicKey: resourceKey.getPublicKey(),
        getQuote: async (order, context) => {
          derivedOrders.push({ goal_id: context.goalId, ...structuredClone(order) });
          fs.writeFileSync(ordersPath, JSON.stringify(derivedOrders, null, 2) + '\n', { mode: 0o600 });
          return client.getQuote(order);
        },
        fulfill: (order, context) => client.fulfill(order, context),
        readStorage: (objectId, context) => client.readStorage(objectId, context),
      };
      const recoverWithCli = async ({ hash, next }) => {
        // Stop both exclusive owners before launching a completely separate
        // CLI process, with no key files or signer arguments. It may only
        // reconcile the original hash; it cannot send another transaction.
        await service.close(); service = undefined;
        journal.close(); journal = undefined;
        let recovered = false;
        try {
          const cli = await util.promisify(execFile)(process.execPath, [path.join(ROOT, 'bouncer/agent/workflow.mjs'),
            '--workflow', workflowPath, '--journal', state, '--rpc', RPC, '--local-provider', configPath, '--recover-only'],
          { timeout: 120_000, maxBuffer: 128 * 1024, env: { ...process.env, NEAR_TESTNET_RPC: RPC } });
          if (!cli.stdout.includes('[workflow] RECOVERED') || !cli.stdout.includes(`Next unpaid step: ${next}`) ||
              !cli.stdout.includes(hash)) throw new Error('key-free workflow CLI did not recover the recorded hash');
          console.log(cli.stdout.trim()); recovered = true;
        } finally {
          journal = openConfiguredFileJournal(state, contractId, ownerId, { requireExisting: true });
          if (recovered) await startService();
        }
        return { status: 'RECOVERED', next, new_payments: 0 };
      };
      const proof = await runDependentLiveProof({ workflow, provider, source: { account: oracleAgent, publicKey: oracleKey.getPublicKey() },
        resources, getJournal: () => journal, log: console.log,
        ...(sellerV3Fresh ? { recoverSourceWithoutKeys: ({ sourceHash }) => recoverWithCli({ hash: sourceHash, next: 'dependent-compute' }) } : {}),
        recoverWithoutKeys: ({ firstHash }) => recoverWithCli({ hash: firstHash, next: 'dependent-storage' }) });
      const sellerState = sellerV2 || sellerV3 ? JSON.parse(fs.readFileSync(path.join(config.data_dir, 'redemptions.json'), 'utf8')) : undefined;
      const sellerClaims = sellerV3 ? verifySellerV3ProofState({ workflow, proof, journal, state: sellerState })
        : sellerV2 ? verifySellerV2ProofState({ workflow, proof, journal, state: sellerState }) : undefined;
      const accessControls = sellerV3 ? await verifySellerV3AccessControls({ workflow, proof, journal,
        fulfill: client.fulfill, readStorage: client.readStorage }) : undefined;
      const nativeBalance = BigInt(await view(contractId, 'vault_balance', { token: 'native' }));
      const nativeSpent = BigInt(await view(contractId, 'daily_spent', { policy_id: NATIVE_POLICY }));
      const ftBalance = BigInt(await view(contractId, 'vault_balance', { token: TOKEN }));
      const ftSpent = BigInt(await view(contractId, 'daily_spent', { policy_id: FT_POLICY }));
      const vendorBalance = BigInt(await view(TOKEN, 'ft_balance_of', { account_id: vendorId }));
      if (nativeBalance !== MAX_NATIVE || nativeSpent !== MAX_NATIVE || ftBalance !== 0n || ftSpent !== 3n * PRICE || vendorBalance !== 3n * PRICE) {
        throw new Error('dependent workflow final vault, recipient or rolling-budget mismatch');
      }
      const observation = proof.result.independent.delivery.result;
      const hashes = Object.fromEntries(workflow.steps.map(step => [step.resource, journal.get(step.id).tx_hash]));
      const evidence = { contract: contractId, owner: ownerId, vendor: vendorId, token: TOKEN,
        oracle_tx: proof.sourceHash, resource_transactions: hashes, single_source_usd: observation.price_usd,
        worker_timestamp: observation.timestamp, owner_setup_pool: quote.pool_id, owner_setup_swap: swap.transaction_outcome.id,
        owner_vault_funding: funding.transaction_outcome.id, micro_usdc_per_resource: PRICE.toString(),
        workflow: 'verified oracle -> compute -> storage -> api', exact_data_dependencies_checked: true,
        source_broadcasts: proof.sourceBroadcasts, resource_broadcasts: proof.resourceBroadcasts,
        source_response_recovered_with_key_free_cli: proof.sourceRecovered,
        lost_ft_response_recovered_with_key_free_cli: true, first_ft_hash_reused: true,
        order_binding: sellerV3 ? 'seller-v3' : sellerV2 ? 'seller-v2' : 'legacy-v1', resource_memos: proof.quoteMemos,
        ...(sellerClaims ? { persisted_seller_claims: sellerClaims } : {}),
        ...(accessControls ?? {}),
        independent_execution: 'OutLayer; native testnet NEAR', ft_provider: 'self-hosted development',
        owner_swap_guarded: false, testnet_tokens_have_no_real_value: true,
        trust: 'single-source Coinbase data through OutLayer; no market-truth or TEE proof' };
      fs.writeFileSync(path.join(dir, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      notice(sellerV3 ? 'Seller-v3 authenticated testnet workflow' : sellerV2 ? 'Seller-v2 dependent testnet workflow' : 'Dependent testnet workflow', evidence);
      success = true;
      return;
    }
    if ((await runOracleGoal({ goal, provider, account: oracleAgent, publicKey: oracleKey.getPublicKey(), journal })).status !== 'READY') throw new Error('oracle preflight was not ready');
    let broadcasts = 0;
    const lossy = new Proxy(provider, { get(target, property) {
      if (property === 'sendTransactionUntil') return async (...args) => {
        broadcasts++; const result = await target.sendTransactionUntil(...args);
        if (broadcasts === 1) throw new Error('injected lost response after actual broadcast');
        return result;
      };
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    try {
      await runOracleGoal({ goal, provider: lossy, account: oracleAgent, publicKey: oracleKey.getPublicKey(), journal, execute: true });
      throw new Error('lost response injection unexpectedly completed');
    } catch (error) {
      if (!/payment\/delivery unresolved.*injected lost response/.test(error.message)) throw error;
    }
    const tx = journal.get(goal.id)?.tx_hash;
    if (!tx || broadcasts !== 1 || journal.get(goal.id)?.status !== 'pending') throw new Error('oracle signed hash was not recorded before broadcast');
    // This is chain data only and is useful if the independent API returned a
    // real failure; it is not treated as a successful or verified delivery.
    const observed = await provider.txStatusReceipts(tx, ownerId, 'FINAL');
    let output;
    try { output = JSON.parse(Buffer.from(observed?.status?.SuccessValue || '', 'base64').toString('utf8')); } catch { output = null; }
    notice('Independent oracle raw outcome (not yet verified)', { contract: contractId, tx, output });
    journal.close();
    const cli = await util.promisify(execFile)(process.execPath, [path.join(ROOT, 'bouncer/agent/oracle-outlayer.mjs'),
      '--goal', goalPath, '--state', state, '--rpc', RPC, '--recover'], { timeout: 90_000, maxBuffer: 64 * 1024 });
    if (!cli.stdout.includes('REUSED') || !cli.stdout.includes(tx)) throw new Error('key-free oracle recovery did not reuse the transaction');
    journal = openConfiguredFileJournal(state, contractId, ownerId, { requireExisting: true });
    const recovered = await recoverOracleGoal({ goal, provider, journal });
    assertOracleFreshForUse(recovered.delivery);
    if (recovered.delivery.tx_hash !== tx || broadcasts !== 1 || journal.get(goal.id)?.status !== 'completed') throw new Error('oracle recovery mismatch');
    const nativeBalance = BigInt(await view(contractId, 'vault_balance', { token: 'native' }));
    const nativeSpent = BigInt(await view(contractId, 'daily_spent', { policy_id: NATIVE_POLICY }));
    const blocked = await view(contractId, 'check', { policy_id: NATIVE_POLICY, payee: OUTLAYER, amount: '1' });
    if (nativeBalance !== MAX_NATIVE || nativeSpent !== MAX_NATIVE || blocked?.[0] !== false || !String(blocked[1]).includes('daily cap')) throw new Error('native maximum reservation or rolling cap mismatch');
    notice('Guarded independent price delivery', { contract: contractId, owner: ownerId, tx, result: recovered.delivery.result,
      native_charge_yocto: recovered.delivery.charged_yocto, owner_refund_yocto: recovered.delivery.refunded_to_owner_yocto,
      max_budget_reserved_yocto: nativeSpent.toString(), signed_hash_recovered_without_key: true, broadcasts,
      scope: 'pinned Coinbase public price via independent paid execution; output labels source custom; no TEE or price accuracy proof' });

    // Bind the actual independently returned value into subsequent resource
    // inputs; do not fabricate or replace it. The three paid FT products are
    // supplied only by a local development provider.
    const observation = recovered.delivery.result;
    const report = `OutLayer single-source Coinbase ${observation.token_id}/USD=${observation.price_usd}; worker timestamp=${observation.timestamp}; tx=${tx}; unverified market data.`;
    const products = Object.fromEntries(['compute', 'storage', 'api'].map(resource => [resource,
      { policy_id: FT_POLICY, token: TOKEN, payee: vendorId, amount: PRICE.toString() }]));
    const goals = [
      { id: 'price-compute', resource: 'compute', input: { text: report, rounds: 25 } },
      { id: 'price-storage', resource: 'storage', input: { name: 'oracle-price-report', content: report } },
      { id: 'price-api', resource: 'api', input: { text: report } },
    ].map(item => ({ ...item, policy_id: FT_POLICY, token: TOKEN, payee: vendorId, max_amount: PRICE.toString() }));
    fs.writeFileSync(path.join(dir, 'resource-goals.json'), JSON.stringify(goals, null, 2) + '\n', { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'provider-config.json'), JSON.stringify({ contractId, ownerAccountId: ownerId, products }, null, 2) + '\n', { mode: 0o600 });
    service = createResourceProvider({ rpcProvider: provider, contractId, ownerAccountId: ownerId, products, dataDir: path.join(dir, 'development-provider') });
    await new Promise((resolve, reject) => { service.server.once('error', reject); service.server.listen(0, '127.0.0.1', resolve); });
    const client = httpResourceProvider(`http://127.0.0.1:${service.server.address().port}`);
    let reviewedPlan;
    const common = { provider, journal, execute: true, log: console.log,
      outlayer: { kind: 'oracle', goal, account: oracleAgent, publicKey: oracleKey.getPublicKey() },
      resources: { contractId, ownerAccountId: ownerId, goals, account: ftAgent, publicKey: resourceKey.getPublicKey(),
        durablePayment: true, getQuote: client.getQuote, readStorage: client.readStorage,
        onPlan: plan => {
          if (!reviewedPlan) { reviewedPlan = plan; fs.writeFileSync(path.join(dir, 'resource-plan.json'), JSON.stringify(plan, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); }
          else if (JSON.stringify(plan) !== JSON.stringify(reviewedPlan)) throw new Error('reviewed resource plan changed');
        } } };
    let injected = false;
    try {
      await runMixedMission({ ...common, resources: { ...common.resources, fulfill: async order => {
        const result = await client.fulfill(order);
        if (!injected && order.resource === 'compute') { injected = true; return { ...result, result: '0'.repeat(64) }; }
        throw new Error('later fulfillment ran before recovery');
      } } });
      throw new Error('corrupt compute delivery unexpectedly passed');
    } catch (error) { if (!/verification failed after confirmed payment/.test(error.message)) throw error; }
    const first = journal.get(goals[0].id), firstHash = first?.tx_hash;
    if (!injected || !firstHash || first.delivery?.status !== 'unverified' || journal.get(goals[1].id) || journal.get(goals[2].id) ||
        BigInt(await view(TOKEN, 'ft_balance_of', { account_id: vendorId })) !== PRICE) throw new Error('verify-before-next-payment gate failed');
    const result = await runMixedMission({ ...common, resources: { ...common.resources, fulfill: client.fulfill } });
    if (result.status !== 'FULFILLED' || result.independent.delivery.tx_hash !== tx || journal.get(goals[0].id)?.tx_hash !== firstHash ||
        goals.some(item => journal.get(item.id)?.delivery?.status !== 'verified') || result.resources.deliveries.length !== 3 ||
        BigInt(await view(TOKEN, 'ft_balance_of', { account_id: vendorId })) !== 3n * PRICE ||
        BigInt(await view(contractId, 'vault_balance', { token: TOKEN })) !== 0n ||
        BigInt(await view(contractId, 'daily_spent', { policy_id: FT_POLICY })) !== 3n * PRICE) throw new Error('oracle-led Circle mission delivery or recovery mismatch');
    const hashes = Object.fromEntries(goals.map(item => [item.resource, journal.get(item.id).tx_hash]));
    notice('Oracle-led Circle testnet multi-resource mission', { contract: contractId, owner: ownerId, vendor: vendorId, token: TOKEN,
      oracle_tx: tx, worker_timestamp: observation.timestamp, source: 'Coinbase via pinned custom URL', single_source_usd: observation.price_usd, owner_setup_pool: quote.pool_id,
      owner_setup_swap: swap.transaction_outcome.id, owner_vault_funding: funding.transaction_outcome.id, resource_transactions: hashes,
      units_per_resource: PRICE.toString(), oracle_output_used_in_resource_inputs: true, independent_hash_reused: true,
      corrupt_delivery_stopped_later_payments: true, first_ft_hash_reused: true, independent_execution: 'OutLayer',
      ft_provider: 'self-hosted development', owner_swap_guarded: false, testnet_usdc_has_no_real_value: true });
    success = true;
  } finally {
    journal?.close();
    if (service) await service.close();
    if (success && !dependent) fs.rmSync(dir, { recursive: true, force: true });
    else if (success) console.log(`${sellerV3 ? 'Private' : 'Public'} testnet workflow evidence retained in ${dir}; it contains no keys${sellerV3 ? ' but contains bearer claim signatures' : ''}.`);
    else console.error(`${sellerV3 ? 'Private' : 'Public'} testnet recovery evidence retained in ${dir}; reconcile the recorded hash, never resend automatically.`);
  }
}
main().catch(error => { console.error(`[oracle-mission] ERROR: ${error.stack || error}`); process.exitCode = 1; });
