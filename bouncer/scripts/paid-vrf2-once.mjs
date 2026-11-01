#!/usr/bin/env node
/**
 * Explicit, fresh, one-shot testnet diagnostic. It buys one independently
 * operated OutLayer connector-probe VRF execution with fake test USDC.e plus
 * bounded native NEAR. This is NOT Circle USDC, a commercial service, proof of
 * an unbiased key or TEE, or a multi-resource production purchase.
 *
 * Every signed setup, FT funding and project hash is journaled and emitted
 * before ONE bounded send. An unknown hash stops the run; never resend it.
 * The separate prior burn and VRF setup hashes are never used or revisited.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { FileJournal } from '../agent/procurement.mjs';
import { MonotonicAccount, PaymentRpcProvider } from '../agent/near-account.mjs';
import { submitTestnetProbeSetupOnce } from '../agent/testnet-probe-submit.mjs';
import { redactProbeReceipt } from '../agent/testnet-receipt.mjs';
import { runFtCallGoal, recoverFtCallGoal } from '../agent/ft-call.mjs';
import { assertProjectRegistry, runProjectGoal, recoverProjectGoal } from '../agent/outlayer-project.mjs';
import { sealTestnetCredentials, testnetRecoveryKeyId } from '../agent/testnet-credential-envelope.mjs';
import { waitForNewTestnetKey, waitForFinalTestnetAccount } from '../shared/testnet-ready.mjs';
import { readBoundedJson } from '../shared/bounded-json.mjs';

const { KeyPair, KeyPairSigner, transactions, utils } = nearApi;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ONE = 10n ** 24n, TGAS = 10n ** 12n;
const TOKEN = 'usdc.fakes.testnet', WRAP = 'wrap.testnet', REF = 'ref-finance-101.testnet', OUTLAYER = 'outlayer.testnet';
const PROJECT = 'connectors.outlayer.testnet/connector-probe', AUTHOR = 'zavodil.testnet';
const VERSION = '2d406ed8005a422c38aec0616990989970e2c444c1386d4f09d54cce59468fb9';
const VRF_PIN = 'c0c5aeae1688c2f7cc2350aae1ee3ce96eddc0de84d678db873de48268f8cfa8';
const KEY_ID = '77f3170a5df339b2ef4affeb39e8fa549d3b4ca9ac5579d0a21f9936e927508b';
const WASM_SHA256 = '835f0baa51d08ddf3af6812df0caefb93283480735a63e3d382073e04fbaf8ee';
const AMOUNT = 10_000n, MAX_NATIVE = ONE / 10n, NATIVE_FUND = 3n * MAX_NATIVE, WRAP_FUND = ONE / 500n;
const INPUT_NEAR = 10n ** 15n, MSG = '{"action":"deposit_balance"}';
const LIMITS = { max_instructions: 1_000_000_000, max_memory_mb: 256, max_execution_seconds: 60 };
const notice = (title, value) => console.log(`::notice title=${title}::${JSON.stringify(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);

export function writeFreshEvidence(dir, name, value) {
  if (!/^[a-z0-9-]+\.json$/.test(name)) throw new Error('invalid testnet evidence filename');
  const fd = fs.openSync(path.join(dir, name), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const parent = fs.openSync(dir, 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}

export function assertReviewedVrf2Wasm(wasm) {
  if (!Buffer.isBuffer(wasm) || wasm.length < 8 || wasm.length > 1_000_000 ||
      !wasm.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])) ||
      crypto.createHash('sha256').update(wasm).digest('hex') !== WASM_SHA256 ||
      !wasm.includes(Buffer.from('bouncer-agent-v9'))) throw new Error('reviewed V9 WASM hash or marker changed; no testnet action');
}

async function assertProviderTerms(provider, input) {
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('VRF diagnostic requires testnet');
  const view = (method, args = {}) => provider.callFunction(OUTLAYER, method, args, { finality: 'final' });
  const [token, registry, versionInfo, pricing, estimate, metadata, keyResponse] = await Promise.all([
    view('get_payment_token_contract'), view('get_project', { project_id: PROJECT }),
    view('get_version', { project_id: PROJECT, version_key: VERSION }), view('get_project_pricing', { project_id: PROJECT }),
    view('estimate_execution_cost', { resource_limits: LIMITS, input_len: Buffer.byteLength(input) }),
    provider.callFunction(TOKEN, 'ft_metadata', {}, { finality: 'final' }),
    fetch('https://testnet-api.outlayer.ai/vrf/pubkey', { redirect: 'error', signal: AbortSignal.timeout(15_000) }),
  ]);
  if (!keyResponse.ok) throw new Error(`testnet VRF key endpoint HTTP ${keyResponse.status}`);
  const key = await readBoundedJson(keyResponse, { maxBytes: 4096, label: 'testnet VRF key' });
  if (key?.vrf_public_key_hex !== VRF_PIN || metadata?.decimals !== 6) throw new Error('VRF public key or fake test-token decimals changed');
  assertProjectRegistry({ project: { project_id: PROJECT, version_key: VERSION, token: TOKEN,
    attached_usd: AMOUNT.toString(), input_data: input }, expectedAuthor: AUTHOR, configuredToken: token, pricing,
    versionInfo, registry, estimate, maximumNative: MAX_NATIVE.toString() });
  return { provider: OUTLAYER, token: TOKEN, project: PROJECT, version: VERSION, price: AMOUNT.toString(),
    author: AUTHOR, native_estimate: String(estimate), native_maximum: MAX_NATIVE.toString(), vrf_public_key: VRF_PIN,
    scope: 'read-only, non-atomic provider terms; no deployed-worker attestation or commercial claim' };
}

async function createFundedOnce(provider, dir, label, id, key) {
  const intent = { id, public_key: key.getPublicKey().toString(), scope: 'one public testnet helper POST; no retry on ambiguity' };
  writeFreshEvidence(dir, `helper-${label}-intent.json`, intent); notice('Testnet helper intent before single POST', intent);
  const response = await fetch('https://helper.testnet.near.org/account', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ newAccountId: id, newAccountPublicKey: intent.public_key }),
    redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`helper ${label} HTTP ${response.status}; do not retry this account`);
  await waitForNewTestnetKey(provider, id, key.getPublicKey());
  const state = await waitForFinalTestnetAccount(provider, id, key.getPublicKey());
  writeFreshEvidence(dir, `helper-${label}-created.json`, { account_id: id, public_key: intent.public_key });
  return state;
}

/** All fields are obtained at the same finalized block, but the RPC remains
 * trusted and block availability is not a guarantee of long-term archival. */
export async function readVrf2Snapshot(provider, vault, reviewedBlockHash) {
  const blockHash = reviewedBlockHash ?? (await provider.block({ finality: 'final' }))?.header?.hash;
  if (typeof blockHash !== 'string' || !blockHash) throw new Error('missing FINAL snapshot block');
  const opts = { blockId: blockHash }, view = (id, method, args = {}) => provider.callFunction(id, method, args, opts);
  const [providerPrepaid, vaultFt, vaultLedger, recordedPrepaid, fundingSpent, tokenSpent, nativeSpent] = await Promise.all([
    view(OUTLAYER, 'get_user_stablecoin_balance', { account_id: vault }),
    view(TOKEN, 'ft_balance_of', { account_id: vault }), view(vault, 'vault_balance', { token: TOKEN }),
    view(vault, 'outlayer_prepaid_balance', { token: TOKEN }), view(vault, 'daily_spent', { policy_id: 'provider-funding' }),
    view(vault, 'daily_spent', { policy_id: 'project-token' }), view(vault, 'daily_spent', { policy_id: 'project-native' }),
  ]);
  return { block_hash: blockHash, provider_prepaid: providerPrepaid, vault_ft: vaultFt, vault_ledger: vaultLedger,
    recorded_prepaid: recordedPrepaid, funding_spent: fundingSpent, project_token_spent: tokenSpent, project_native_spent: nativeSpent };
}

export function assertVrf2Snapshot(stage, s) {
  const wanted = stage === 'before' ? ['0', '10000', '10000', '0', '0', '0', '0'] :
    stage === 'funded' ? ['10000', '0', '0', '10000', '10000', '0', '0'] :
    stage === 'fulfilled' ? ['0', '0', '0', '0', '10000', '10000', MAX_NATIVE.toString()] : null;
  const fields = ['provider_prepaid', 'vault_ft', 'vault_ledger', 'recorded_prepaid', 'funding_spent', 'project_token_spent', 'project_native_spent'];
  if (!wanted || !s || typeof s.block_hash !== 'string' || !s.block_hash || fields.some((field, i) => s[field] !== wanted[i])) {
    throw new Error(`${stage}: provider/vault/rolling budgets did not reconcile at one FINAL block`);
  }
}

async function main() {
  if (process.env.BOUNCER_VRF2_ACK !== 'fresh-testnet-fake-token-vrf-one-shot' || !process.env.BOUNCER_VRF2_DIR ||
      !process.env.BOUNCER_VRF2_WASM) throw new Error('explicit fresh testnet acknowledgement, evidence directory and reviewed artifact are required');
  const dir = path.resolve(process.env.BOUNCER_VRF2_DIR), wasm = fs.readFileSync(process.env.BOUNCER_VRF2_WASM);
  assertReviewedVrf2Wasm(wasm);
  const pub = fs.readFileSync(path.join(ROOT, 'bouncer/config/testnet-outlayer-vrf2-recovery-public.pem'), 'utf8');
  if (testnetRecoveryKeyId(pub) !== KEY_ID) throw new Error('unexpected fresh recovery key');
  const provider = new PaymentRpcProvider(process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com',
    { sendTimeoutMs: 90_000, receiptTimeoutMs: 60_000 });
  const ownerKey = KeyPair.fromRandom('ed25519'), vaultKey = KeyPair.fromRandom('ed25519');
  const fundingKey = KeyPair.fromRandom('ed25519'), projectKey = KeyPair.fromRandom('ed25519');
  const suffix = crypto.randomBytes(5).toString('hex'), vault = `bouncer-vrf2-${suffix}.testnet`, owner = `owner-vrf2-${suffix}.testnet`;
  const seed = `bouncer_vrf2_${crypto.randomBytes(16).toString('hex')}`;
  const input = JSON.stringify({ operation: 'vrf', seed });
  // No account creation or test-token acquisition unless all terms are live.
  const initialTerms = await assertProviderTerms(provider, input);
  fs.mkdirSync(dir, { mode: 0o700 }); // fail closed if any evidence directory already exists
  const envelope = sealTestnetCredentials({ version: 3, purpose: 'outlayer-vrf-testnet', owner_account_id: owner, contract_id: vault,
    owner_secret: ownerKey.toString(), contract_secret: vaultKey.toString(), funding_secret: fundingKey.toString(), project_secret: projectKey.toString() }, pub);
  const journalKey = crypto.createHash('sha256').update('bouncer-vrf2-journal-v1\0').update(vaultKey.toString()).digest();
  const codeHash = utils.serialize.base_encode(crypto.createHash('sha256').update(wasm).digest());
  const identity = { vault, owner, vault_public_key: vaultKey.getPublicKey().toString(), owner_public_key: ownerKey.getPublicKey().toString(),
    funding_public_key: fundingKey.getPublicKey().toString(), project_public_key: projectKey.getPublicKey().toString(),
    seed, vault_code_hash: codeHash, vault_wasm_sha256: WASM_SHA256, recovery_key_id: KEY_ID,
    purpose: 'fresh-testnet-fake-token-independent-vrf-diagnostic' };
  let journal;
  try {
    writeFreshEvidence(dir, 'sealed-testnet-credentials.json', envelope);
    writeFreshEvidence(dir, 'identity.json', identity); writeFreshEvidence(dir, 'initial-terms.json', initialTerms);
    notice('Encrypted disposable VRF2 recovery credentials', envelope);
    notice('Fresh VRF2 diagnostic public identity', identity);
    const journalPath = path.join(dir, 'journal.enc.json');
    journal = new FileJournal(journalPath, vault, owner, { encryptionKey: journalKey });
    const vaultState = await createFundedOnce(provider, dir, 'vault', vault, vaultKey);
    const ownerState = await createFundedOnce(provider, dir, 'owner', owner, ownerKey);
    const storagePrice = 10n ** 19n, vaultReserve = BigInt(wasm.length + 50_000) * storagePrice + ONE / 4n;
    if (BigInt(vaultState.amount) - BigInt(vaultState.storage_usage) * storagePrice < vaultReserve ||
        BigInt(ownerState.amount) - BigInt(ownerState.storage_usage) * storagePrice < ONE + NATIVE_FUND) {
      throw new Error('fresh helper balances are too low for bounded deployment, storage and gas');
    }
    const account = (id, key) => new MonotonicAccount(id, provider, new KeyPairSigner(key));
    const vaultAccount = account(vault, vaultKey), ownerAccount = account(owner, ownerKey);
    const fundingAgent = account(owner, fundingKey), projectAgent = account(owner, projectKey);
    const view = (id, method, args = {}) => provider.callFunction(id, method, args, { finality: 'final' });
    const setup = async (id, signer, key, receiver, actions, review) => submitTestnetProbeSetupOnce({ id, account: signer,
      publicKey: key.getPublicKey(), receiverId: receiver, actions, review, provider, journal,
      persistIntent(intent) { writeFreshEvidence(dir, `${id}-intent.json`, intent); notice('Original setup hash before one broadcast', intent); },
      saveReceipt(receipt) { writeFreshEvidence(dir, `${id}-receipt.json`, receipt); } });
    const fc = (name, args, gas = 40n * TGAS, deposit = 1n) => transactions.functionCall(name, args, gas, deposit);
    await setup('deployment', vaultAccount, vaultKey, vault, [transactions.deployContract(wasm),
      fc('new', { owner }, 100n * TGAS, 0n), transactions.deleteKey(vaultKey.getPublicKey())],
    { actions: ['deploy reviewed V9', 'initialize exact owner', 'delete deployment key'], code_hash: codeHash, owner });
    const deployed = await provider.query({ request_type: 'view_account', account_id: vault, finality: 'final' });
    if (deployed.code_hash !== codeHash) throw new Error('deployed V9 code hash mismatch');
    const at = { blockId: deployed.block_hash };
    const [contractVersion, actualOwner, keys] = await Promise.all([
      provider.callFunction(vault, 'contract_version', {}, at), provider.callFunction(vault, 'get_owner', {}, at),
      provider.query({ request_type: 'view_access_key_list', account_id: vault, ...at }),
    ]);
    if (contractVersion !== 'bouncer-agent-v9' || actualOwner !== owner || !Array.isArray(keys?.keys) || keys.keys.length ||
        keys.block_hash !== deployed.block_hash) throw new Error('FINAL vault version, owner or locked deployment keys differ');

    for (const [token, ids, stage] of [[WRAP, [owner, REF], 'register-wrap'], [TOKEN, [owner, vault, OUTLAYER], 'register-fake']]) {
      const bounds = await view(token, 'storage_balance_bounds');
      if (typeof bounds?.min !== 'string' || !/^[0-9]+$/.test(bounds.min) || BigInt(bounds.min) <= 0n || BigInt(bounds.min) > ONE / 10n) {
        throw new Error(`unsafe ${token} storage registration cost`);
      }
      const missing = [];
      for (const id of ids) if (await view(token, 'storage_balance_of', { account_id: id }) === null) missing.push(id);
      if (missing.length) await setup(stage, ownerAccount, ownerKey, token,
        missing.map(id => fc('storage_deposit', { account_id: id, registration_only: true }, 50n * TGAS, BigInt(bounds.min))),
        { token, accounts: missing, deposit_each: bounds.min, storage_only: true });
    }
    await setup('wrap-owner', ownerAccount, ownerKey, WRAP, [fc('near_deposit', {}, 50n * TGAS, WRAP_FUND)],
      { token: WRAP, method: 'near_deposit', amount: WRAP_FUND.toString() });
    const pools = [54, 477, 596, 624]; let selected;
    for (const pool_id of pools) {
      try {
        const quote = BigInt(await view(REF, 'get_return', { pool_id, token_in: WRAP, amount_in: INPUT_NEAR.toString(), token_out: TOKEN }));
        if (quote >= AMOUNT * 2n && quote <= 1_000_000n) { selected = { pool_id, quote }; break; }
      } catch { /* read-only unavailable/changed pools are skipped */ }
    }
    if (!selected) throw new Error('no bounded Ref pool quote for acquiring fake test USDC.e');
    const beforeFake = BigInt(await view(TOKEN, 'ft_balance_of', { account_id: owner }));
    if (beforeFake !== 0n) throw new Error('fresh owner unexpectedly has fake test tokens');
    const swapMsg = JSON.stringify({ force: 0, actions: [{ pool_id: selected.pool_id, token_in: WRAP, token_out: TOKEN,
      amount_in: INPUT_NEAR.toString(), min_amount_out: (selected.quote * 95n / 100n).toString() }] });
    const swapArgs = { receiver_id: REF, amount: INPUT_NEAR.toString(), msg: swapMsg };
    await setup('owner-ref-acquisition', ownerAccount, ownerKey, WRAP, [fc('ft_transfer_call', swapArgs, 300n * TGAS)],
      { token: WRAP, method: 'ft_transfer_call', args: swapArgs, quote: selected.quote.toString(), owner_setup_not_guarded: true });
    const acquired = BigInt(await view(TOKEN, 'ft_balance_of', { account_id: owner })) - beforeFake;
    if (acquired < AMOUNT || acquired > 1_100_000n) throw new Error('owner Ref acquisition output outside hard test-token bounds');
    const fundArgs = { receiver_id: vault, amount: AMOUNT.toString(), msg: 'fund' };
    await setup('owner-fake-funding', ownerAccount, ownerKey, TOKEN, [fc('ft_transfer_call', fundArgs, 200n * TGAS)],
      { token: TOKEN, method: 'ft_transfer_call', args: fundArgs, owner_setup_not_agent_payment: true });
    if (await view(vault, 'vault_balance', { token: TOKEN }) !== AMOUNT.toString()) throw new Error('fake token funding was not credited to the vault');
    await setup('native-funding', ownerAccount, ownerKey, vault, [fc('deposit_native', {}, 50n * TGAS, NATIVE_FUND)],
      { method: 'deposit_native', amount: NATIVE_FUND.toString() });

    const cap = (id, token, amount) => fc('set_policy', { policy_id: id, token, per_tx_cap: amount.toString(), daily_cap: amount.toString() });
    const allow = id => fc('allow_payee', { policy_id: id, payee: OUTLAYER });
    const grant = (id, key) => fc('grant_agent_key', { policy_id: id, public_key: key.getPublicKey().toString() });
    await setup('funding-policy', ownerAccount, ownerKey, vault, [cap('provider-funding', TOKEN, AMOUNT), allow('provider-funding'),
      fc('set_ft_call_message', { policy_id: 'provider-funding', payee: OUTLAYER, msg: MSG }), grant('provider-funding', fundingKey)],
    { policy: 'provider-funding', token: TOKEN, cap: AMOUNT.toString(), daily: AMOUNT.toString(), payee: OUTLAYER, msg: MSG,
      grant: fundingKey.getPublicKey().toString(), owner_calls_each_one_yocto: true });
    await setup('native-policy', ownerAccount, ownerKey, vault, [cap('project-native', 'native', MAX_NATIVE), allow('project-native'), grant('project-native', projectKey)],
      { policy: 'project-native', token: 'native', cap: MAX_NATIVE.toString(), daily: MAX_NATIVE.toString(), payee: OUTLAYER,
        grant: projectKey.getPublicKey().toString(), owner_calls_each_one_yocto: true });
    await setup('token-policy', ownerAccount, ownerKey, vault, [cap('project-token', TOKEN, AMOUNT), allow('project-token'), grant('project-token', projectKey)],
      { policy: 'project-token', token: TOKEN, cap: AMOUNT.toString(), daily: AMOUNT.toString(), payee: OUTLAYER,
        grant: projectKey.getPublicKey().toString(), owner_calls_each_one_yocto: true });
    const project = { project_id: PROJECT, version_key: VERSION, usd_policy_id: 'project-token', token: TOKEN,
      attached_usd: AMOUNT.toString(), input_data: input, ...LIMITS };
    await setup('project-route', ownerAccount, ownerKey, vault,
      [fc('set_outlayer_project', { native_policy_id: 'project-native', project }, 70n * TGAS)],
      { method: 'set_outlayer_project', native_policy_id: 'project-native', project, owner_call_one_yocto: true });
    await setup('agent-access-keys', ownerAccount, ownerKey, owner, [
      transactions.addKey(fundingKey.getPublicKey(), transactions.functionCallAccessKey(vault, ['execute_ft_call'], ONE / 2n)),
      transactions.addKey(projectKey.getPublicKey(), transactions.functionCallAccessKey(vault, ['execute_outlayer_project'], ONE / 2n)),
    ], { receiver: vault, funding_key: fundingKey.getPublicKey().toString(), funding_methods: ['execute_ft_call'],
      project_key: projectKey.getPublicKey().toString(), project_methods: ['execute_outlayer_project'], allowance_each: (ONE / 2n).toString() });
    const route = await view(vault, 'get_ft_call_route', { policy_id: 'provider-funding', payee: OUTLAYER });
    const projectRoute = await view(vault, 'get_outlayer_project', { native_policy_id: 'project-native' });
    const fundingGoal = { id: 'provider-prepaid-funding', contract_id: vault, owner_account_id: owner, policy_id: 'provider-funding',
      payee: OUTLAYER, token: TOKEN, amount: AMOUNT.toString(), msg: MSG, policy_revision: route?.policy_revision, route_revision: route?.route_revision };
    const projectGoal = { id: 'independent-vrf-diagnostic', contract_id: vault, owner_account_id: owner, native_policy_id: 'project-native',
      amount: MAX_NATIVE.toString(), route: projectRoute, expected_author: AUTHOR, expected_vrf_pubkey: VRF_PIN };
    writeFreshEvidence(dir, 'funding-goal.json', fundingGoal); writeFreshEvidence(dir, 'project-goal.json', projectGoal);
    notice('Reviewed VRF2 goals before provider funding', { funding_goal: fundingGoal, project_goal: projectGoal });
    const before = await readVrf2Snapshot(provider, vault); assertVrf2Snapshot('before', before);
    writeFreshEvidence(dir, 'before-snapshot.json', before);
    // Validate the project route, restricted key, budgets and live registry
    // *before* moving tokens to provider custody; insufficient credit is expected.
    if ((await runProjectGoal({ goal: projectGoal, provider, account: projectAgent, publicKey: projectKey.getPublicKey(), journal })).status !== 'FUNDING_REQUIRED') {
      throw new Error('project preflight did not report the expected funding shortfall');
    }
    if ((await runFtCallGoal({ goal: fundingGoal, provider, account: fundingAgent, publicKey: fundingKey.getPublicKey(), journal })).status !== 'READY') {
      throw new Error('FT funding preflight did not become ready');
    }
    await assertProviderTerms(provider, input); // non-atomic: terms can still change after this check
    let fundingSends = 0, projectSends = 0;
    const runWithReceiptFault = async (id, execute) => {
      let inject = true;
      const guarded = new Proxy(provider, { get(target, property) {
        if (property === 'sendTransactionOnce') return async (...args) => {
          const entry = journal.get(id);
          if (entry?.status !== 'pending' || typeof entry.tx_hash !== 'string') throw new Error('payment hash not durable before send');
          const intent = { id, tx_hash: entry.tx_hash, vault, owner, signer_public_key: entry.agent_public_key, do_not_resend: true };
          writeFreshEvidence(dir, `${id}-intent.json`, intent); notice('Original guarded payment hash before one broadcast', intent);
          if (id === fundingGoal.id) fundingSends++; else projectSends++;
          return target.sendTransactionOnce(...args);
        };
        if (property === 'txStatusReceipts') return async (...args) => {
          const result = await target.txStatusReceipts(...args);
          if (!inject) return result;
          inject = false; return { ...result, receipts: [] }; // deterministic incomplete-response recovery exercise
        };
        const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
      } });
      try { await execute(guarded); throw new Error('injected incomplete receipt unexpectedly passed'); }
      catch (error) {
        if (inject || !/(FT call unresolved|paid project unresolved)/.test(error.message)) throw error;
      }
      const pending = journal.get(id);
      if (pending?.status !== 'pending') throw new Error('incomplete receipt did not leave the original hash pending');
      return pending.tx_hash;
    };
    const fundingHash = await runWithReceiptFault(fundingGoal.id, guarded => runFtCallGoal({ goal: fundingGoal, provider: guarded,
      account: fundingAgent, publicKey: fundingKey.getPublicKey(), journal, execute: true }));
    journal.close(); journal = new FileJournal(journalPath, vault, owner, { encryptionKey: journalKey, requireExisting: true });
    const funding = await recoverFtCallGoal({ goal: fundingGoal, provider, journal });
    if (funding.status !== 'REUSED' || funding.settlement.tx_hash !== fundingHash || funding.settlement.used !== AMOUNT.toString() ||
        funding.settlement.unused !== '0' || fundingSends !== 1) throw new Error('original FT funding did not settle exactly once');
    writeFreshEvidence(dir, 'funding-receipt.json', redactProbeReceipt(await provider.txStatusReceipts(fundingHash, owner, 'FINAL')));
    const funded = await readVrf2Snapshot(provider, vault); assertVrf2Snapshot('funded', funded); writeFreshEvidence(dir, 'funded-snapshot.json', funded);
    notice('Independent OutLayer prepaid FT settled', { vault, owner, tx: fundingHash, amount: AMOUNT.toString(), token: TOKEN,
      used: funding.settlement.used, unused: funding.settlement.unused, sends: fundingSends,
      recovery: 'reopened journal; original hash only; no signer used', snapshot: funded, scope: 'provider deposit, not delivery' });
    await assertProviderTerms(provider, input);
    if ((await runProjectGoal({ goal: projectGoal, provider, account: projectAgent, publicKey: projectKey.getPublicKey(), journal })).status !== 'READY') {
      throw new Error('funded project preflight did not become ready');
    }
    const projectHash = await runWithReceiptFault(projectGoal.id, guarded => runProjectGoal({ goal: projectGoal, provider: guarded,
      account: projectAgent, publicKey: projectKey.getPublicKey(), journal, execute: true }));
    journal.close(); journal = new FileJournal(journalPath, vault, owner, { encryptionKey: journalKey, requireExisting: true });
    const projectResult = await recoverProjectGoal({ goal: projectGoal, provider, journal });
    if (projectResult.status !== 'REUSED' || projectResult.delivery.tx_hash !== projectHash ||
        projectResult.delivery.prepaid_charged !== AMOUNT.toString() || projectSends !== 1) throw new Error('original VRF project did not reconcile exactly once');
    writeFreshEvidence(dir, 'project-receipt.json', redactProbeReceipt(await provider.txStatusReceipts(projectHash, owner, 'FINAL')));
    const fulfilled = await readVrf2Snapshot(provider, vault); assertVrf2Snapshot('fulfilled', fulfilled);
    writeFreshEvidence(dir, 'fulfilled-snapshot.json', fulfilled);
    const report = { vault, owner, token: TOKEN, funding_tx: fundingHash, project_tx: projectHash, funding: funding.settlement,
      delivery: projectResult.delivery, before, funded, fulfilled, funding_sends: fundingSends, project_sends: projectSends,
      recovery: 'both journals reopened; original hashes only; no signer used for recovery', vault_deployment_key_removed: true,
      scope: 'independent provider testnet VRF diagnostic; fake test USDC.e plus native NEAR, not Circle USDC or a commercial compute/storage/API service; no TEE or unbiased-key proof' };
    writeFreshEvidence(dir, 'report.json', report); notice('Independent FT-paid VRF diagnostic and exact accounting', report);
  } finally { journal?.close(); journalKey.fill(0); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    const detail = String(error.message || error).slice(0, 2000).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    console.error(`[paid-vrf2-once] ${error.message}`); console.log(`::error title=One-shot VRF2 stopped; never resend original hashes::${detail}`);
    process.exitCode = 1;
  });
}
