// ONE-SHOT TESTNET ONLY. A fresh vault/router, disposable keys, <=0.01 testnet
// wNEAR and a reviewed Ref pool. The two swap transactions are signed once,
// write-ahead journaled, deliberately lose their responses, and recovered by
// the original hashes. No Circle mainnet funds, commercial purchase or TEE
// claim. Never rerun an ambiguous trade or the separate pending project call.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import util from 'node:util';
import { fileURLToPath } from 'node:url';
import nearApi from 'near-api-js';
import { MonotonicAccount, PaymentRpcProvider } from './agent/near-account.mjs';
import { openConfiguredFileJournal, validateConfiguredFileJournalKey } from './agent/procurement.mjs';
import { runRefSwap, recoverRefSwap } from './agent/ref-swap.mjs';
import { REF_SWAP_INPUT_MESSAGE } from './agent/ref-swap-evidence.mjs';
import { sealTestnetCredentials, testnetRecoveryKeyId } from './agent/testnet-credential-envelope.mjs';
import { selectOwnerSetupQuote, WRAP_TESTNET as WRAP, CIRCLE_TESTNET_USDC as TOKEN, REF_TESTNET as REF } from './scripts/circle-testnet-setup.mjs';
import { waitForNewTestnetKey } from './shared/testnet-ready.mjs';

const { KeyPair, KeyPairSigner, transactions, utils } = nearApi;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ONE = 10n ** 24n, TGAS = 10n ** 12n, POLICY = 'bounded-ref-swap';
const RECOVERY_KEY_ID = '4dea968ec5691e26569b92b85fef218b2b1d08a43e32011b1f22d9c6ac2222ec';
const provider = new PaymentRpcProvider(process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com', { receiptTimeoutMs: 60_000 });
const accountFor = (id, key) => new MonotonicAccount(id, provider, new KeyPairSigner(key));
const view = (id, method, args = {}) => provider.callFunction(id, method, args, { finality: 'final' });
const url = hash => `https://testnet.nearblocks.io/txns/${hash}`;
const notice = (title, obj) => console.log(`::notice title=${title}::${JSON.stringify(obj).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);

function receiptsOk(result, label) {
  if (result?.final_execution_status !== 'FINAL' || !Array.isArray(result.receipts_outcome) || !result.receipts_outcome.length ||
      result.receipts_outcome.some(r => r.outcome?.status?.Failure) || typeof result.status?.SuccessValue !== 'string') {
    throw new Error(`${label}: missing FINAL successful setup receipts`);
  }
}
async function setupAttempt(label, operation) {
  try { return await operation(); }
  catch (error) {
    if (error?.type !== 'Expired' || error.transaction_outcome !== undefined) throw error;
    console.log(`    ${label}: explicit pre-admission expiry; retrying setup once`);
    return operation();
  }
}
async function call(account, id, methodName, args, deposit = 0n, gas = 100n * TGAS, setup = true) {
  const operation = () => account.callFunctionRaw({ contractId: id, methodName, args, deposit, gas, waitUntil: 'FINAL' });
  const result = setup ? await setupAttempt(methodName, operation) : await operation();
  receiptsOk(result, methodName); console.log(`    ${methodName}: ${url(result.transaction_outcome.id)}`); return result;
}
async function createFunded(id, key) {
  const response = await fetch('https://helper.testnet.near.org/account', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newAccountId: id, newAccountPublicKey: key.getPublicKey().toString() }), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`testnet helper HTTP ${response.status}`);
  await waitForNewTestnetKey(provider, id, key.getPublicKey()); return accountFor(id, key);
}
async function register(owner, token, id) {
  if ((await view(token, 'storage_balance_of', { account_id: id })) !== null) return;
  const min = (await view(token, 'storage_balance_bounds'))?.min;
  if (typeof min !== 'string' || !/^(?:0|[1-9][0-9]{0,38})$/.test(min) || BigInt(min) > ONE / 10n) throw new Error(`invalid token storage minimum for ${token}`);
  await call(owner, token, 'storage_deposit', { account_id: id, registration_only: true }, BigInt(min), 50n * TGAS);
}
async function addKey(owner, receiver, key, methods) {
  const result = await setupAttempt('install restricted key', () => owner.signAndSendTransaction({ receiverId: owner.accountId, waitUntil: 'FINAL',
    actions: [transactions.addKey(key.getPublicKey(), transactions.functionCallAccessKey(receiver, methods, ONE / 2n))] }));
  receiptsOk(result, 'install restricted key');
  const permission = (await provider.viewAccessKey(owner.accountId, key.getPublicKey(), { finality: 'final' })).permission?.FunctionCall;
  if (permission?.receiver_id !== receiver || JSON.stringify(permission.method_names) !== JSON.stringify(methods)) throw new Error('restricted-key scope mismatch');
}
async function expectRejection(label, pattern, operation) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await operation(); }
    catch (error) {
      if (attempt === 0 && error?.type === 'Expired' && error.transaction_outcome === undefined) continue;
      const detail = `${error.message || ''} ${util.inspect(error, { depth: 8 })}`;
      if (!pattern.test(detail)) throw new Error(`${label}: unexpected rejection`);
      console.log(`    ${label}: rejected`); return;
    }
    throw new Error(`${label}: unexpectedly succeeded`);
  }
  throw new Error(`${label}: repeated setup expiry`);
}
function writePublic(dir, name, data) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}

async function main() {
  if (process.env.BOUNCER_REF_DEMO_ACK !== 'testnet-only-one-shot') throw new Error('explicit testnet-only one-shot acknowledgement is required');
  validateConfiguredFileJournalKey();
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const metadata = await view(TOKEN, 'ft_metadata');
  if (metadata?.spec !== 'ft-1.0.0' || metadata?.symbol !== 'USDC' || metadata?.decimals !== 6) throw new Error('unexpected Circle testnet USDC metadata');
  const quote = await selectOwnerSetupQuote(provider); // read only, before creating or funding accounts
  const wasm = fs.readFileSync(path.join(ROOT, 'bouncer.wasm'));
  const routerWasm = fs.readFileSync(process.env.BOUNCER_REF_ROUTER_WASM || path.join(ROOT, 'ref-router-wasm/bouncer_ref_router.wasm'));
  if (!wasm.includes(Buffer.from('bouncer-agent-v9')) || !routerWasm.includes(Buffer.from('bouncer-ref-router-v1'))) throw new Error('fresh Bouncer and router WASM artifacts are required');
  const routerCodeHash = utils.serialize.base_encode(crypto.createHash('sha256').update(routerWasm).digest());
  const recoveryPub = fs.readFileSync(path.join(ROOT, 'bouncer/config/testnet-ref-demo-recovery-public.pem'), 'utf8');
  if (testnetRecoveryKeyId(recoveryPub) !== RECOVERY_KEY_ID) throw new Error('unexpected testnet recovery public key');
  const contractKey = KeyPair.fromRandom('ed25519'), ownerKey = KeyPair.fromRandom('ed25519'), routerKey = KeyPair.fromRandom('ed25519');
  const inputKey = KeyPair.fromRandom('ed25519'), sweepKey = KeyPair.fromRandom('ed25519'), attackKey = KeyPair.fromRandom('ed25519');
  const suffix = crypto.randomBytes(4).toString('hex'), contractId = `bouncer-ref-${suffix}.testnet`;
  // A second funded root account prevents the router's code-storage stake from
  // exhausting the vault's limited testnet helper grant.
  const ownerId = `owner.${contractId}`, routerId = `ref-router-${suffix}.testnet`;
  const dir = process.env.BOUNCER_REF_DEMO_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-ref-proof-'));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const credentials = { version: 2, owner_account_id: ownerId, contract_id: contractId, router_id: routerId,
    owner_secret: ownerKey.toString(), input_secret: inputKey.toString(), sweep_secret: sweepKey.toString(),
    contract_secret: contractKey.toString(), router_secret: routerKey.toString() };
  const envelope = sealTestnetCredentials(credentials, recoveryPub);
  writePublic(dir, 'sealed-testnet-credentials.json', envelope);
  writePublic(dir, 'identity.json', { contract: contractId, owner: ownerId, router: routerId, input_key: inputKey.getPublicKey().toString(),
    sweep_key: sweepKey.getPublicKey().toString(), owner_key: ownerKey.getPublicKey().toString(),
    contract_key: contractKey.getPublicKey().toString(), router_key: routerKey.getPublicKey().toString(), router_code_hash: routerCodeHash });
  writePublic(dir, 'reviewed-quote.json', quote);
  // The ciphertext can be recovered via the check-run annotation without
  // exposing plaintext testnet keys; the RSA private key remains outside Git.
  notice('Encrypted disposable testnet recovery credentials', envelope);
  console.log(`Ref TESTNET proof: contract=${contractId}, owner=${ownerId}, router=${routerId}; tokens have no real value.`);
  const contract = await createFunded(contractId, contractKey);
  const deploy = await setupAttempt('deploy Bouncer', () => contract.signAndSendTransaction({ receiverId: contractId,
    actions: [transactions.deployContract(wasm)], waitUntil: 'FINAL' }));
  receiptsOk(deploy, 'deploy Bouncer');
  // Check storage stake before allocating funds or attempting the route. The
  // protocol price must agree with this narrow testnet harness's review.
  const protocol = await provider.experimental_protocolConfig({ finality: 'final' });
  if (protocol?.runtime_config?.storage_amount_per_byte !== '10000000000000000000') throw new Error('unexpected testnet storage price');
  const storagePrice = 10n ** 19n, routerRequired = BigInt(routerWasm.length + 20_000) * storagePrice + ONE / 2n;
  if (routerRequired > 10n * ONE) throw new Error('router WASM storage exceeds disposable testnet budget');
  const vaultAccount = await provider.query({ request_type: 'view_account', account_id: contractId, finality: 'final' });
  const ownerFunding = 3n * ONE / 2n;
  if (typeof vaultAccount?.amount !== 'string' || !Number.isSafeInteger(vaultAccount?.storage_usage) ||
      BigInt(vaultAccount.amount) - BigInt(vaultAccount.storage_usage) * storagePrice < ownerFunding + ONE / 2n) {
    throw new Error('testnet helper grant cannot fund the owner while retaining vault storage and gas');
  }
  const created = await setupAttempt('create disposable owner', () => contract.signAndSendTransaction({ receiverId: ownerId, waitUntil: 'FINAL',
    actions: [transactions.createAccount(), transactions.transfer(ownerFunding), transactions.addKey(ownerKey.getPublicKey(), transactions.fullAccessKey())] }));
  receiptsOk(created, 'create disposable owner');
  const router = await createFunded(routerId, routerKey);
  const routerAccount = await provider.query({ request_type: 'view_account', account_id: routerId, finality: 'final' });
  if (typeof routerAccount?.amount !== 'string' || BigInt(routerAccount.amount) < routerRequired) {
    throw new Error('testnet helper grant cannot cover the router code storage and reserve');
  }
  const owner = accountFor(ownerId, ownerKey), agent = accountFor(ownerId, inputKey),
    sweep = accountFor(ownerId, sweepKey), attacker = accountFor(ownerId, attackKey);
  await call(contract, contractId, 'new', { owner: ownerId });
  if (await view(contractId, 'contract_version') !== 'bouncer-agent-v9' || await view(contractId, 'get_owner') !== ownerId) throw new Error('unexpected Bouncer owner/version');
  const lockVault = await setupAttempt('lock vault code', () => contract.signAndSendTransaction({ receiverId: contractId, waitUntil: 'FINAL',
    actions: [transactions.deleteKey(contractKey.getPublicKey())] }));
  receiptsOk(lockVault, 'lock vault code');
  // Deploy, initialize and remove the only router key in ONE transaction.
  const lockRouter = await setupAttempt('deploy and lock router', () => router.signAndSendTransaction({ receiverId: routerId, waitUntil: 'FINAL',
    actions: [transactions.deployContract(routerWasm), transactions.functionCall('new', { owner: ownerId, vault: contractId,
      pool_id: quote.pool_id, amount_in: quote.input_amount, min_amount_out: quote.min_output }, 100n * TGAS, 0n),
      transactions.deleteKey(routerKey.getPublicKey())] }));
  receiptsOk(lockRouter, 'deploy and lock router');
  for (const [token, id] of [[WRAP, ownerId], [WRAP, contractId], [WRAP, routerId], [TOKEN, routerId], [TOKEN, contractId]]) await register(owner, token, id);
  // If Ref's output transfer fails, extra registered Ref storage makes it
  // possible for its callback to retain the token for owner-only recovery.
  await call(owner, REF, 'storage_deposit', { account_id: routerId, registration_only: false }, ONE / 10n, 50n * TGAS);
  await call(owner, WRAP, 'near_deposit', {}, BigInt(quote.input_amount), 50n * TGAS, false);
  await call(owner, WRAP, 'ft_transfer_call', { receiver_id: contractId, amount: quote.input_amount, msg: 'bouncer:fund-ref-input' }, 1n, 200n * TGAS, false);
  if (String(await view(contractId, 'vault_balance', { token: WRAP })) !== quote.input_amount) throw new Error('vault input funding mismatch');
  await call(owner, contractId, 'set_policy', { policy_id: POLICY, token: WRAP, per_tx_cap: quote.input_amount, daily_cap: quote.input_amount }, 1n);
  await call(owner, contractId, 'allow_payee', { policy_id: POLICY, payee: routerId }, 1n);
  await call(owner, contractId, 'set_ft_call_message', { policy_id: POLICY, payee: routerId, msg: REF_SWAP_INPUT_MESSAGE }, 1n);
  await call(owner, contractId, 'grant_agent_key', { policy_id: POLICY, public_key: inputKey.getPublicKey().toString() }, 1n);
  await addKey(owner, contractId, inputKey, ['execute_ft_call']);
  await addKey(owner, routerId, sweepKey, ['sweep_output']);
  await addKey(owner, contractId, attackKey, ['set_policy']);
  await expectRejection('1-yocto owner-policy escalation guard', /owner-only method requires exactly 1 yoctoNEAR/, () => attacker.callFunctionRaw({
    contractId, methodName: 'set_policy', args: { policy_id: POLICY, token: WRAP, per_tx_cap: '99999999999999999999999', daily_cap: '99999999999999999999999' },
    deposit: 0n, gas: 100n * TGAS, waitUntil: 'FINAL' }));
  const pinned = await view(contractId, 'get_ft_call_route', { policy_id: POLICY, payee: routerId });
  const goal = { version: 1, id: `guarded-ref-${suffix}`, contract_id: contractId, owner_account_id: ownerId, router_id: routerId,
    router_code_hash: routerCodeHash, policy_id: POLICY, policy_revision: pinned?.policy_revision, route_revision: pinned?.route_revision,
    pool_id: quote.pool_id, input_amount: quote.input_amount, min_output: quote.min_output };
  writePublic(dir, 'goal.json', goal);
  const current = await view(REF, 'get_return', { pool_id: quote.pool_id, token_in: WRAP, amount_in: quote.input_amount, token_out: TOKEN });
  if (typeof current !== 'string' || !/^[0-9]+$/.test(current) || BigInt(current) < BigInt(quote.min_output)) throw new Error('Ref quote moved below the reviewed minimum; no swap input sent');
  let journal = openConfiguredFileJournal(path.join(dir, 'journal.json'), contractId, ownerId), broadcasts = 0;
  const lossy = new Proxy(provider, { get(target, property) {
    if (property === 'sendTransactionUntil') return async (...args) => {
      broadcasts++;
      const receiver = args[0]?.transaction?.receiverId;
      if ((broadcasts === 1 && receiver !== contractId) || (broadcasts === 2 && receiver !== routerId) || broadcasts > 2) throw new Error('unexpected broadcast');
      const outcome = await target.sendTransactionUntil(...args);
      if (!outcome?.transaction_outcome?.id) throw new Error('missing final transaction hash');
      throw new Error(`injected lost ${broadcasts === 1 ? 'input' : 'sweep'} response after actual broadcast`);
    };
    const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const opts = { goal, provider: lossy, account: agent, publicKey: inputKey.getPublicKey(), sweepAccount: sweep,
    sweepPublicKey: sweepKey.getPublicKey(), journal, execute: true, log: console.log };
  try {
    if ((await runRefSwap({ ...opts, execute: false })).status !== 'READY') throw new Error('guarded router dry run was not ready');
    try { await runRefSwap(opts); throw new Error('input response loss did not trigger'); }
    catch (error) { if (!/FT call unresolved.*injected lost input response/.test(error.message)) throw error; }
    const input = journal.get(`${goal.id}-input`);
    if (broadcasts !== 1 || input?.status !== 'pending' || journal.get(`${goal.id}-sweep`)) throw new Error('input journal state mismatch');
    journal.close(); journal = openConfiguredFileJournal(path.join(dir, 'journal.json'), contractId, ownerId, { requireExisting: true }); opts.journal = journal;
    const first = await recoverRefSwap({ goal, provider, journal });
    if (first.status !== 'OUTPUT_RECEIVED' || first.swap.tx_hash !== input.tx_hash || broadcasts !== 1) throw new Error('key-free input/output reconciliation mismatch');
    try { await runRefSwap(opts); throw new Error('sweep response loss did not trigger'); }
    catch (error) { if (!/sweep unresolved.*injected lost sweep response/.test(error.message)) throw error; }
    const sweepEntry = journal.get(`${goal.id}-sweep`);
    if (broadcasts !== 2 || sweepEntry?.status !== 'pending') throw new Error('sweep journal state mismatch');
    journal.close(); journal = openConfiguredFileJournal(path.join(dir, 'journal.json'), contractId, ownerId, { requireExisting: true });
    const final = await recoverRefSwap({ goal, provider, journal });
    if (final.status !== 'COMPLETED' || final.swap.tx_hash !== input.tx_hash || final.vault_credit.tx_hash !== sweepEntry.tx_hash ||
        final.swap.output_amount !== final.vault_credit.credited || broadcasts !== 2 ||
        String(await view(contractId, 'vault_balance', { token: TOKEN })) !== final.vault_credit.credited ||
        String(await view(contractId, 'daily_spent', { policy_id: POLICY })) !== quote.input_amount) throw new Error('verified swap, vault credit or capped accounting mismatch');
    writePublic(dir, 'verified-proof.json', final);
    notice('Guarded one-shot Ref testnet swap and vault credit', { contract: contractId, owner: ownerId, router: routerId, pool: quote.pool_id,
      token_in: WRAP, token_out: TOKEN, input: quote.input_amount, min_output: quote.min_output, credited_output: final.vault_credit.credited,
      input_tx: input.tx_hash, sweep_tx: sweepEntry.tx_hash, router_code_hash: routerCodeHash, input_broadcasts: 1, sweep_broadcasts: 1,
      lost_responses_recovered_without_keys: true, yocto_policy_escalation_rejected: true, router_keys_removed: true,
      scope: 'testnet only; trusted RPC, Bouncer, router, Ref and tokens; not a commercial resource purchase or production readiness' });
  } finally {
    let records = [];
    try { records = [journal?.get(`${goal.id}-input`), journal?.get(`${goal.id}-sweep`)].filter(Boolean); }
    catch (error) { console.error(`Preserved journal requires reopening before inspection: ${error.message}`); }
    try { journal?.close(); } catch (error) { console.error(`Journal close requires inspection: ${error.message}`); }
    for (const [index, record] of records.entries()) {
      try { const chain = await provider.txStatusReceipts(record.tx_hash, ownerId, 'FINAL'); writePublic(dir, `receipt-${index}.json`, chain); }
      catch (error) { console.error(`Read-only receipt preservation failed: ${error.message}`); }
    }
    console.log(`Testnet-only public journal and encrypted recovery envelope retained in ${dir}; never resend an uncertain transaction.`);
  }
}
main().catch(error => { console.error(`[guarded-ref-testnet] ERROR: ${error.stack || error}`); process.exitCode = 1; });
