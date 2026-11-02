#!/usr/bin/env node
/**
 * Opt-in integration against a disposable, loopback-only nearcore sandbox.
 *
 * It executes the recovered V11 WASM and the actual five setup-plan batches.
 * A pinned nearcore example FT is deliberately placed at the planner's Circle
 * address in the SANDBOX GENESIS ONLY. Neither that account nor its tokens are
 * Circle, testnet, mainnet, a provider, or evidence of paid fulfillment.
 *
 * No RPC URL, account, or key is accepted from the environment. All keys are
 * generated for the disposable local chain. Three explicitly supplied files
 * must match their pinned SHA-256 digests before any node is started.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import nearApi from 'near-api-js';
import { buildUnsignedSvalinTrialSetup } from '../agent/svalin-setup-plan.mjs';
import { verifySignedSvalinSetup, inspectSvalinSetupAttempt } from '../agent/svalin-setup-evidence.mjs';
import { FileJournal } from '../agent/procurement.mjs';
import { initializeSvalinSetupJournal, recordSvalinSetupSignedAttempt, reconcileSvalinSetupResult,
  inspectSvalinSetupJournal } from '../agent/svalin-setup-journal.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { SVALIN_PAYEE as SELLER } from '../agent/svalin-pro-readiness.mjs';
import { SVALIN_TRIAL_MAX_ATOMS as FUNDING } from '../agent/svalin-pro-preflight.mjs';
import { RUNNER_OWNER, exerciseSandboxOwnerRunner } from './v11-sandbox-owner-runner.mjs';
import { exerciseSandboxBuyerRunner } from './v11-sandbox-buyer-runner.mjs';
import { exerciseSandboxNativeFaucet } from './v11-sandbox-native-faucet.mjs';
import { exerciseSandboxEscrowBoundary } from './v11-sandbox-escrow-boundary.mjs';
import { exerciseSandboxForwarder } from './v11-sandbox-forwarder.mjs';
import { FAUCET_RETURN } from '../agent/native-testnet-faucet.mjs';
import { V11_SHA256, MOCK_FT_SHA256, SANDBOX_SHA256, SANDBOX_CHAIN_ID, readVerifiedFile,
  withMockTokenInGenesis, assertSandboxStatus, requireFinalSuccess, assertOmittedLocalAddKeyReceipt,
  assertRegistrationWithOnlyGasRefund, requireReceiptLog } from './v11-sandbox-support.mjs';

const { transactions: tx, KeyPair, KeyPairSigner, Account, providers, utils } = nearApi;
const ROOT = 'testnet', OWNER = 'owner.testnet', VAULT = 'trial.owner.testnet';
const ATTACKER = 'attacker.testnet', UNREGISTERED = 'unregistered.testnet', POLICY = 'svalin';
const NEAR = 10n ** 24n, TGAS = 10n ** 12n;
const WAIT = 'FINAL';
const CHAIN_QUERY = { finality: 'final' };
const func = (name, args = {}, deposit = 0n, gas = 100n * TGAS) => tx.functionCall(name, args, gas, deposit);
const key = () => KeyPair.fromRandom('ed25519');
const pub = pair => String(pair.getPublicKey());
const makeAccount = (id, provider, pair) => new Account(id, provider, new KeyPairSigner(pair));
const codeHash = bytes => utils.serialize.base_encode(crypto.createHash('sha256').update(bytes).digest());

async function freeLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

export async function stopSandboxChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit').catch(() => {});
  child.kill('SIGTERM');
  await Promise.race([exited, delay(5000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

export async function startSandbox(binaryPath, directory, tokenPublicKey) {
  const version = spawnSync(binaryPath, ['--version'], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(version.status, 0, 'sandbox binary did not report its version');
  const versionText = `${version.stdout ?? ''} ${version.stderr ?? ''}`.trim();
  assert.match(versionText, /\b2\.14\.0\b/, 'expected nearcore 2.14.0');
  const init = spawnSync(binaryPath, ['--home', directory, 'init', '--fast', '--chain-id', SANDBOX_CHAIN_ID,
    '--account-id', ROOT], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.equal(init.status, 0, `local sandbox initialization failed (exit ${init.status}, signal ${init.signal})`);

  const genesisPath = path.join(directory, 'genesis.json');
  const genesis = JSON.parse(fs.readFileSync(genesisPath, 'utf8'));
  fs.writeFileSync(genesisPath, JSON.stringify(withMockTokenInGenesis(genesis, TOKEN, tokenPublicKey)), { mode: 0o600 });
  const configPath = path.join(directory, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.ok(config.network && config.telemetry, 'unexpected nearcore config');
  config.network.boot_nodes = '';
  config.telemetry.endpoints = [];
  fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const validator = JSON.parse(fs.readFileSync(path.join(directory, 'validator_key.json'), 'utf8'));
  assert.equal(validator.account_id, ROOT);
  const secret = validator.secret_key ?? validator.private_key;
  assert.equal(typeof secret, 'string', 'sandbox validator key was not generated');
  const rootKey = KeyPair.fromString(secret);
  assert.equal(pub(rootKey), validator.public_key);

  const rpcPort = await freeLoopbackPort();
  let networkPort = await freeLoopbackPort();
  if (networkPort === rpcPort) networkPort = await freeLoopbackPort();
  assert.notEqual(networkPort, rpcPort);
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const child = spawn(binaryPath, ['--home', directory, 'run', '--rpc-addr', `127.0.0.1:${rpcPort}`,
    '--network-addr', `127.0.0.1:${networkPort}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  let tail = '';
  child.stderr.on('data', chunk => { tail = (tail + chunk.toString('utf8')).slice(-6000); });
  let spawnError;
  child.on('error', error => { spawnError = error; });
  const provider = new providers.JsonRpcProvider({ url: rpcUrl });
  try {
    const deadline = Date.now() + 90_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`sandbox exited before readiness: ${tail}`);
      try {
        const status = await provider.status();
        assertSandboxStatus(status);
        ready = true;
        break;
      } catch (error) {
        // A responding different chain is a hard failure, not a reason to wait.
        if (String(error.message).includes('refusing to use an RPC')) throw error;
        await delay(300);
      }
    }
    if (!ready) throw new Error(`local sandbox did not become ready: ${tail}`);
    const protocol = await provider.experimental_protocolConfig(CHAIN_QUERY);
    assert.equal(protocol.protocol_version, 88, 'this harness is pinned to protocol 88');
    return { provider, rpcUrl, child, rootKey, versionText, protocol: protocol.protocol_version };
  } catch (error) {
    await stopSandboxChild(child);
    throw error;
  }
}

function assertFailure(result, label, pattern) {
  assert.equal(result?.final_execution_status, WAIT, `${label}: not FINAL`);
  assert.ok(result?.status?.Failure, `${label}: expected a failed contract action`);
  assert.match(JSON.stringify(result.status.Failure), pattern, `${label}: wrong failure`);
}

async function rejectedByProtocol(promise, label, pattern) {
  let error;
  try { await promise; } catch (caught) { error = caught; }
  assert.ok(error, `${label}: transaction was not rejected at admission`);
  const details = `${error.message ?? ''} ${JSON.stringify(error)}`;
  assert.match(details, pattern, `${label}: unexpected admission error`);
}

async function run() {
  const binary = process.env.BOUNCER_SANDBOX_BIN;
  const wasm = readVerifiedFile(process.env.BOUNCER_V11_WASM_PATH, V11_SHA256, { maxBytes: 4 * 1024 * 1024 });
  const mockFt = readVerifiedFile(process.env.BOUNCER_MOCK_FT_WASM_PATH, MOCK_FT_SHA256, { maxBytes: 4 * 1024 * 1024 });
  // Read/hash before executing. This is not an independent binary attestation.
  readVerifiedFile(binary, SANDBOX_SHA256);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-v11-sandbox-'));
  const tokenKey = key(), ownerKey = key(), sellerKey = key(), attackerKey = key(), agentKey = key(), probeKey = key();
  const runnerOwnerKey = key(), runnerAgentKey = key();
  let sandbox, journal, journalKey;
  try {
    sandbox = await startSandbox(binary, directory, pub(tokenKey));
    const { provider } = sandbox;
    const root = makeAccount(ROOT, provider, sandbox.rootKey);
    const owner = makeAccount(OWNER, provider, ownerKey);
    const token = makeAccount(TOKEN, provider, tokenKey);
    const attacker = makeAccount(ATTACKER, provider, attackerKey);
    const agent = makeAccount(OWNER, provider, agentKey);
    const probe = makeAccount(OWNER, provider, probeKey);
    const view = (contractId, method, args = {}) => provider.callFunction(contractId, method, args, CHAIN_QUERY);
    const call = (account, receiverId, name, args = {}, deposit = 0n, gas = 100n * TGAS) =>
      account.signAndSendTransaction({ receiverId, actions: [func(name, args, deposit, gas)], waitUntil: WAIT, throwOnFailure: false });
    const mustCall = async (account, receiver, name, args, deposit, gas) => {
      const result = await call(account, receiver, name, args, deposit, gas);
      requireFinalSuccess(result, name);
      return result;
    };
    const mustBatch = async (account, receiverId, actions, label) => {
      const result = await account.signAndSendTransaction({ receiverId, actions, waitUntil: WAIT, throwOnFailure: false });
      requireFinalSuccess(result, label);
      return result;
    };
    const create = (id, pair) => mustBatch(root, id, [tx.createAccount(), tx.transfer(100n * NEAR),
      tx.addKey(pair.getPublicKey(), tx.fullAccessKey())], `create ${id}`);

    await create(OWNER, ownerKey);
    await create(SELLER, sellerKey);
    await create(ATTACKER, attackerKey);
    await mustBatch(token, TOKEN, [tx.deployContract(mockFt), func('new_default_meta',
      { owner_id: OWNER, total_supply: '30000000' }, 0n, 50n * TGAS)], 'deploy mock FT');
    const bounds = await view(TOKEN, 'storage_balance_bounds');
    assert.ok(typeof bounds?.min === 'string' && /^[1-9][0-9]*$/.test(bounds.min), 'mock FT minimum missing');
    assert.ok(BigInt(bounds.min) <= 10n ** 23n, 'mock FT minimum exceeds the planner limit');
    await mustCall(owner, TOKEN, 'storage_deposit', { account_id: SELLER, registration_only: true }, BigInt(bounds.min), 50n * TGAS);

    const plan = buildUnsignedSvalinTrialSetup({
      goal: { version: 1, id: 'sandbox-only', owner: OWNER, vault: VAULT,
        vault_code_hash: codeHash(wasm), policy_id: POLICY,
        accept_unsigned_seller_risk: true, accept_exact_amount_matching_risk: true },
      wasmBytes: wasm, agentPublicKey: pub(agentKey), initialVaultFundingYocto: (7n * NEAR).toString(),
      agentGasAllowanceYocto: NEAR.toString(), vaultTokenStorageDepositYocto: bounds.min,
    });
    // Exercise the actual encrypted setup journal with disposable keys and
    // chain results. This is not the live testnet runner or stage preflight.
    journalKey = crypto.randomBytes(32);
    const journalFile = path.join(directory, 'sandbox-setup-journal.json');
    journal = new FileJournal(journalFile, VAULT, OWNER, { encryptionKey: journalKey });
    const journalBase = () => ({ plan, trustedReviewHash: plan.review.review_sha256, ownerPublicKey: pub(ownerKey), journal });
    await initializeSvalinSetupJournal({ ...journalBase(), confirmNew: true });
    const stageEvidence = [], verifierBlockers = [];
    let journalStagesReconciled = 0;
    const checkpoint = message => console.error(`Sandbox checkpoint: ${message}`);
    const setupStage = async index => {
      const batch = plan.batches[index];
      assert.equal(batch.signerId, OWNER);
      const signed = await owner.createSignedTransaction(batch.receiverId, batch.actions);
      const proof = verifySignedSvalinSetup({ plan, trustedReviewHash: plan.review.review_sha256,
        stageId: batch.id, ownerPublicKey: pub(ownerKey), signed });
      // Once a blocker is recorded, later sends are sandbox-only contract
      // diagnostics, not journaled or accepted as a complete setup.
      const useJournal = verifierBlockers.length === 0;
      if (useJournal) {
        const recorded = await recordSvalinSetupSignedAttempt({ ...journalBase(), stageId: batch.id, signed,
          acknowledgeRecovery: true });
        assert.equal(recorded.tx_hash, proof.attempt.tx_hash, `${batch.id}: journal must fence the original before send`);
      }
      const sent = await provider.sendTransactionUntil(signed, WAIT);
      requireFinalSuccess(sent, batch.id);
      const outcome = await provider.txStatusReceipts(proof.attempt.tx_hash, OWNER, WAIT);
      let checked;
      try {
        checked = inspectSvalinSetupAttempt({ plan, trustedReviewHash: plan.review.review_sha256,
          trustedOriginalHash: proof.attempt.tx_hash, trustedOwnerPublicKey: pub(ownerKey), attempt: proof.attempt, result: outcome });
      } catch (error) {
        // The production verifier has already failed closed. Continue ONLY on
        // this isolated chain after diagnosing one of the specific known
        // blockers below. Do not synthesize receipts or call either stage
        // verified; the job will still fail while any blocker is present.
        if (index === 2) {
          // If a future runtime/RPC shape fails this narrow verifier, report
          // only bounded sandbox structure, never keys or raw signatures.
          const txRootIds = outcome.transaction_outcome?.outcome?.receipt_ids;
          const rootId = outcome.transaction_outcome?.outcome?.status?.SuccessReceiptId;
          const root = outcome.receipts_outcome?.find(item => item.id === rootId)?.outcome;
          const children = (root?.receipt_ids ?? []).slice(0, 8).map(id => {
            const child = outcome.receipts?.find(item => item.receipt_id === id);
            const action = child?.receipt?.Action;
            return { present: Boolean(child), predecessor: child?.predecessor_id, receiver: child?.receiver_id,
              gas_price: action?.gas_price, action_types: action?.actions?.map(value => Object.keys(value)[0]) };
          });
          checkpoint(`local AddKey diagnostic: ${JSON.stringify({ verifier_error: error?.message,
            transaction_root_count: txRootIds?.length, receipt_count: outcome.receipts?.length,
            outcome_count: outcome.receipts_outcome?.length, root_body_present: outcome.receipts?.some(item => item.receipt_id === rootId),
            root_child_count: root?.receipt_ids?.length, children })}`);
          assertOmittedLocalAddKeyReceipt(outcome, proof.attempt, error);
          verifierBlockers.push('same-account AddKey root receipt omitted by nearcore');
          stageEvidence.push({ stage: batch.id, sandbox_transaction_hash: proof.attempt.tx_hash,
            status: 'BLOCKED_PRODUCTION_VERIFIER_OMITTED_LOCAL_RECEIPT' });
          checkpoint('agent-key transaction finalized but production receipt verifier failed closed; remaining tests are sandbox diagnostics only');
          return;
        }
        if (index === 3 && error?.message === 'token registration result does not match the reviewed fresh registration') {
          const fresh = await view(TOKEN, 'storage_balance_of', { account_id: VAULT });
          const rootId = outcome.transaction_outcome?.outcome?.status?.SuccessReceiptId;
          const root = outcome.receipts_outcome?.find(item => item.id === rootId)?.outcome;
          // Bounded, public sandbox diagnostics only. Do not print keys,
          // transaction signatures, arbitrary RPC values or environment data.
          const children = (root?.receipt_ids ?? []).slice(0, 8).map(id => {
            const child = outcome.receipts?.find(item => item.receipt_id === id);
            const action = child?.receipt?.Action;
            return { present: Boolean(child), predecessor: child?.predecessor_id, receiver: child?.receiver_id,
              signer: action?.signer_id, gas_price: action?.gas_price,
              action_types: action?.actions?.map(value => Object.keys(value)[0]) };
          });
          checkpoint(`registration diagnostic: ${JSON.stringify({ fresh, child_count: root?.receipt_ids?.length, children })}`);
          assertRegistrationWithOnlyGasRefund(outcome, proof.attempt, error, bounds.min, fresh);
          verifierBlockers.push('registration verifier rejects a linked protocol gas refund');
          stageEvidence.push({ stage: batch.id, sandbox_transaction_hash: proof.attempt.tx_hash,
            status: 'BLOCKED_PRODUCTION_VERIFIER_SYSTEM_GAS_REFUND' });
          checkpoint('mock registration state matches but production verifier rejects the gas-refund child');
          return;
        }
        throw error;
      }
      const expected = index === 4 ? 'FINAL_FUNDING_RECEIPTS_MATCH' :
        index === 2 ? 'FINAL_LOCAL_ADD_KEY_OUTCOME_MATCH' : 'FINAL_SETUP_RECEIPT_MATCH';
      assert.equal(checked.status, expected, `${batch.id}: receipt verification failed`);
      if (useJournal) {
        const settled = await reconcileSvalinSetupResult({ ...journalBase(), stageId: batch.id, result: outcome });
        assert.equal(settled.status, expected, `${batch.id}: journal evidence did not reconcile`);
        assert.equal(settled.tx_hash, proof.attempt.tx_hash);
        const state = await inspectSvalinSetupJournal(journalBase());
        assert.equal(state.stages[index].state, index === 2 ? 'FINAL_LOCAL_ADD_KEY_OUTCOME_MATCH' : 'FINAL_RECEIPTS_MATCH');
        journalStagesReconciled++;
        if (index === 2) {
          journal.close();
          journal = new FileJournal(journalFile, VAULT, OWNER, { encryptionKey: journalKey, requireExisting: true });
          assert.equal((await inspectSvalinSetupJournal(journalBase())).stages[index].state, 'FINAL_LOCAL_ADD_KEY_OUTCOME_MATCH');
        }
      }
      stageEvidence.push({ stage: batch.id, sandbox_transaction_hash: proof.attempt.tx_hash,
        status: checked.status, encrypted_journal_reconciled: useJournal });
      checkpoint(index === 2 ? `${batch.id}: original transaction and local outcome matched; local receipt body was omitted` :
        `${batch.id}: original transaction and receipts matched`);
    };

    await setupStage(0);
    assert.equal((await provider.viewAccount(VAULT, CHAIN_QUERY)).code_hash, codeHash(wasm));
    assert.deepEqual((await provider.viewAccessKeyList(VAULT, CHAIN_QUERY)).keys, [], 'the sandbox vault must have no access keys');
    assert.equal(await view(VAULT, 'contract_version'), 'bouncer-agent-v11-exact-ft-testnet');
    assert.equal(await view(VAULT, 'get_owner'), OWNER);
    checkpoint('V11 code hash, owner, version and keyless vault confirmed');

    // Give a separate sandbox-only key permission to try set_policy. This lets
    // the WASM's 1-yocto guard be tested, rather than merely relying on the
    // agent key's narrower method-name filter.
    await mustBatch(owner, OWNER, [tx.addKey(probeKey.getPublicKey(),
      tx.functionCallAccessKey(VAULT, ['set_policy'], NEAR))], 'install policy-guard probe key');
    const policyArgs = { policy_id: POLICY, token: TOKEN, per_tx_cap: FUNDING, daily_cap: FUNDING };
    assertFailure(await call(probe, VAULT, 'set_policy', policyArgs, 0n), 'restricted zero-deposit escalation', /exactly 1 yoctoNEAR/);
    await rejectedByProtocol(call(probe, VAULT, 'set_policy', policyArgs, 1n), 'restricted key attached deposit',
      /DepositWithFunctionCall|attached deposit|deposit.*(?:function|access.key)|requires.*full.access/i);
    assertFailure(await call(owner, VAULT, 'set_policy', policyArgs, 2n), 'owner attached two yocto', /exactly 1 yoctoNEAR/);
    assertFailure(await call(attacker, VAULT, 'set_policy', policyArgs, 1n), 'non-owner attached one yocto', /caller is not owner/);
    assert.equal(await view(VAULT, 'get_policy', { policy_id: POLICY }), null);
    checkpoint('one-yocto guard and non-owner rejection confirmed on V11');

    await setupStage(1);
    assert.deepEqual(await view(VAULT, 'get_policy', { policy_id: POLICY }),
      { token: TOKEN, per_tx_cap: FUNDING, daily_cap: FUNDING });
    assert.equal(await view(VAULT, 'is_exact_ft_policy_locked', { policy_id: POLICY }), true);
    assert.equal(await view(VAULT, 'is_agent_key_allowed', { policy_id: POLICY, public_key: pub(agentKey) }), true);
    await setupStage(2);
    const permission = (await provider.viewAccessKey(OWNER, pub(agentKey), CHAIN_QUERY)).permission;
    assert.equal(permission?.FunctionCall?.receiver_id, VAULT);
    assert.deepEqual(permission.FunctionCall.method_names, ['execute_exact_ft']);
    await rejectedByProtocol(call(agent, VAULT, 'set_policy', policyArgs, 0n), 'agent cannot call owner method',
      /MethodNameMismatch|method.*(?:not allowed|permission|restricted|mismatch)/i);
    checkpoint('agent key permissions and method restriction confirmed by chain state and admission');
    await setupStage(3);
    const registration = await view(TOKEN, 'storage_balance_of', { account_id: VAULT });
    assert.deepEqual(registration, { total: bounds.min, available: '0' });
    await setupStage(4);
    const ftBalance = id => view(TOKEN, 'ft_balance_of', { account_id: id });
    const vaultBalance = () => view(VAULT, 'vault_balance', { token: TOKEN });
    const spent = () => view(VAULT, 'daily_spent', { policy_id: POLICY });
    const check = (payee, amount) => view(VAULT, 'check', { policy_id: POLICY, payee, amount });
    assert.equal(await ftBalance(VAULT), FUNDING);
    assert.equal(await vaultBalance(), FUNDING);
    assert.equal((await check(ATTACKER, '1'))[0], false);
    assert.match((await check(SELLER, '5010000'))[1], /per-tx cap/);
    checkpoint('mock FT balances, allowlist and per-transaction cap confirmed');

    const block = await provider.viewBlock(CHAIN_QUERY);
    const timestamp = block.header.timestamp_nanosec ?? String(block.header.timestamp);
    const expiry = (BigInt(timestamp) / 1_000_000n + 60n * 60n * 1000n).toString();
    const intent = (id, payee, amount) => ({ intent_id: id, policy_id: POLICY, expected_token: TOKEN,
      payee, amount, memo: `sandbox-${id}`, review_hash: 'a'.repeat(64), expires_at_ms: expiry,
      agent_public_key: pub(agentKey) });
    const successfulIntent = intent('success', SELLER, '2000000');
    await mustCall(owner, VAULT, 'set_exact_ft_intent', successfulIntent, 1n);
    assertFailure(await call(owner, VAULT, 'execute_exact_ft', { intent_id: 'success' }, 0n),
      'wrong signer key', /wrong exact FT agent key/);
    const transfer = await mustCall(agent, VAULT, 'execute_exact_ft', { intent_id: 'success' }, 0n, 150n * TGAS);
    requireReceiptLog(transfer, VAULT, 'exact FT transfer succeeded');
    assert.equal(await ftBalance(SELLER), '2000000');
    assert.equal(await ftBalance(VAULT), '3009999');
    assert.equal(await vaultBalance(), '3009999');
    assert.equal(await spent(), '2000000');
    assert.equal((await view(VAULT, 'get_exact_ft_intent', { intent_id: 'success' })).consumed, true);
    assertFailure(await call(agent, VAULT, 'execute_exact_ft', { intent_id: 'success' }, 0n, 150n * TGAS),
      'consumed intent replay', /consumed, cancelled, expired or stale/);
    assert.match((await check(SELLER, '3010000'))[1], /daily cap exceeded/);
    checkpoint('mock exact FT transfer, balances, replay rejection and rolling cap confirmed');

    // The second payee is allowed by the owner but is NOT registered in the
    // mock FT. Its transfer receipt must fail; the real callback must restore
    // the vault and rolling budget without re-opening the consumed intent.
    await mustCall(owner, VAULT, 'allow_payee', { policy_id: POLICY, payee: UNREGISTERED }, 1n);
    await mustCall(owner, VAULT, 'set_exact_ft_intent', intent('failure', UNREGISTERED, '500000'), 1n);
    const refund = await call(agent, VAULT, 'execute_exact_ft', { intent_id: 'failure' }, 0n, 150n * TGAS);
    assert.equal(requireFinalSuccess(refund, 'failed transfer with successful callback', { allowReceiptFailure: true }), 1);
    const failedFt = refund.receipts_outcome.filter(item => item.outcome.executor_id === TOKEN && item.outcome.status?.Failure);
    assert.equal(failedFt.length, 1, 'the intended mock FT receipt must fail');
    assert.match(JSON.stringify(failedFt[0].outcome.status.Failure), /not registered/i,
      'the mock FT must fail because the payee is unregistered');
    requireReceiptLog(refund, VAULT, 'exact FT transfer failed; vault refunded');
    assert.equal(await ftBalance(VAULT), '3009999');
    assert.equal(await vaultBalance(), '3009999');
    assert.equal(await spent(), '2000000');
    const consumedFailure = await view(VAULT, 'get_exact_ft_intent', { intent_id: 'failure' });
    assert.equal(consumedFailure.consumed, true);
    assert.equal(consumedFailure.active, false);
    assertFailure(await call(agent, VAULT, 'execute_exact_ft', { intent_id: 'failure' }, 0n, 150n * TGAS),
      'failed intent replay', /consumed, cancelled, expired or stale/);
    checkpoint('failed mock FT receipt, refund callback, restored balances and replay rejection confirmed');

    // Separate local receiver-contract experiment: not PayPerCall, not a real
    // seller. Compare a later plain FT return with a transfer-call callback.
    const escrowBoundaryEvidence = await exerciseSandboxEscrowBoundary({ rpcUrl: sandbox.rpcUrl,
      root, tokenOwner: owner, wasm, storageMin: bounds.min, checkpoint });
    // This next scenario uses an experimental generated bridge and a tiny
    // stand-in, not the actual PayPerCall escrow or a provider. It must pass
    // independently before it can be described as nearcore evidence.
    const forwarderEvidence = await exerciseSandboxForwarder({ rpcUrl: sandbox.rpcUrl,
      root, tokenOwner: owner, wasm, storageMin: bounds.min, checkpoint });

    // The first scenario above deliberately uses direct signing/evidence so it
    // can diagnose specific verifier failures. A second, fresh owner and vault
    // exercise the actual stage preflight and one-stage coordinator instead.
    // All accounts and tokens remain exclusively on this disposable chain.
    let ownerRunnerEvidence = null, buyerRunnerEvidence = null, nativeFaucetEvidence = null;
    if (verifierBlockers.length === 0) {
      await create(RUNNER_OWNER, runnerOwnerKey);
      await mustCall(owner, TOKEN, 'storage_deposit', { account_id: RUNNER_OWNER, registration_only: true },
        BigInt(bounds.min), 50n * TGAS);
      await mustCall(owner, TOKEN, 'ft_transfer', { receiver_id: RUNNER_OWNER, amount: '6000000', memo: 'local sandbox runner' },
        1n, 50n * TGAS);
      ownerRunnerEvidence = await exerciseSandboxOwnerRunner({ rpcUrl: sandbox.rpcUrl, wasm, tokenStorageMin: bounds.min,
        directory, ownerKey: runnerOwnerKey, agentKey: runnerAgentKey, checkpoint });
      // The same fresh, funded sandbox vault now exercises the actual buyer
      // and original-hash recovery. Seller responses are in-process fixtures;
      // neither Svalin nor any other network service is contacted.
      const runnerOwner = makeAccount(RUNNER_OWNER, provider, runnerOwnerKey);
      buyerRunnerEvidence = await exerciseSandboxBuyerRunner({ rpcUrl: sandbox.rpcUrl, wasm, directory,
        agentKey: runnerAgentKey, checkpoint, pinIntent: call =>
          mustCall(runnerOwner, call.receiver_id, call.method, call.args, 1n, 100n * TGAS) });

      // Create ONLY local accounts matching the public faucet beneficiary name.
      // The helper itself is an in-process sandbox stub; no public endpoint is
      // contacted, and neither these test keys nor balances exist on testnet.
      const parentKey = key(), faucetKey = key(), beneficiaryKey = key();
      await create('nonofficial.testnet', parentKey);
      const parent = makeAccount('nonofficial.testnet', provider, parentKey);
      await mustBatch(parent, 'faucet.nonofficial.testnet', [tx.createAccount(), tx.transfer(10n * NEAR),
        tx.addKey(faucetKey.getPublicKey(), tx.fullAccessKey())], 'create local faucet parent');
      const faucet = makeAccount('faucet.nonofficial.testnet', provider, faucetKey);
      await mustBatch(faucet, FAUCET_RETURN, [tx.createAccount(), tx.transfer(NEAR),
        tx.addKey(beneficiaryKey.getPublicKey(), tx.fullAccessKey())], 'create local faucet beneficiary');
      nativeFaucetEvidence = await exerciseSandboxNativeFaucet({ rpcUrl: sandbox.rpcUrl, directory, root, checkpoint });
    }

    assertSandboxStatus(await provider.status());
    const evidence = {
      scope: 'ISOLATED LOCAL SANDBOX ONLY: mock FT, fake balances and no seller service; not a testnet deployment, audit or fulfillment proof',
      chain_id: SANDBOX_CHAIN_ID, nearcore_version: sandbox.versionText, protocol_version: sandbox.protocol,
      v11_sha256: V11_SHA256, mock_ft_sha256: MOCK_FT_SHA256, sandbox_binary_sha256: SANDBOX_SHA256,
      genesis_token_is_circle: false, keys_are_ephemeral: true, seller_contacted: false, real_funds_used: false,
      setup_stage_observations: stageEvidence,
      all_setup_stages_reconciled: verifierBlockers.length === 0 && journalStagesReconciled === 5,
      encrypted_journal_stages_reconciled: journalStagesReconciled,
      local_add_key_receipt_body_omitted: stageEvidence.some(stage =>
        ['FINAL_LOCAL_ADD_KEY_OUTCOME_MATCH', 'BLOCKED_PRODUCTION_VERIFIER_OMITTED_LOCAL_RECEIPT'].includes(stage.status)),
      known_setup_verifier_blockers: verifierBlockers,
      guard: { restricted_zero_deposit_blocked_by_contract: true, restricted_one_yocto_rejected_by_protocol: true,
        non_owner_one_yocto_blocked: true, owner_two_yocto_blocked: true, owner_one_yocto_configuration_succeeded: true },
      restricted_agent_method_filter_checked: true, allowlist_and_caps_checked: true,
      exact_ft_success_receipts_and_balances_checked: true, replay_rejected: true,
      failed_ft_receipt_and_refund_callback_checked: true,
      mock_escrow_refund_boundary: escrowBoundaryEvidence,
      experimental_forwarder_with_mock_escrow: forwarderEvidence,
      owner_runner_and_stage_preflight: ownerRunnerEvidence,
      buyer_runner_and_original_hash_recovery: buyerRunnerEvidence,
      native_faucet_and_original_hash_recovery: nativeFaucetEvidence,
    };
    console.log(JSON.stringify(evidence, null, 2));
    if (verifierBlockers.length) {
      throw new Error('sandbox contract diagnostics finished, but the production setup verifier remains blocked; no successful setup verification claimed');
    }
    assert.equal(journalStagesReconciled, 5, 'all sandbox setup stages must reconcile in the original encrypted journal');
  } finally {
    journal?.close();
    journalKey?.fill(0);
    if (sandbox) await stopSandboxChild(sandbox.child);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  run().catch(error => { console.error('V11 sandbox integration FAILED:', error?.stack ?? String(error)); process.exitCode = 1; });
}
