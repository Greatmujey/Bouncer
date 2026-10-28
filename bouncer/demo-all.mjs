// Fresh-deployment NEAR testnet check: real wNEAR settlement using a restricted
// function-call key, policy-key isolation, and the 1-yocto escalation guard.
// Run from the repo root: node bouncer/demo-all.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import util from 'node:util';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { validateRpcEndpoint } from './shared/rpc-endpoint.mjs';
import { waitForNewTestnetKey } from './shared/testnet-ready.mjs';
import { MonotonicAccount } from './agent/near-account.mjs';

const { KeyPair, KeyPairSigner, providers, transactions } = nearApi;
const { JsonRpcProvider } = providers;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NETWORK = 'testnet';
const RPC = process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com';
const HELPER = 'https://helper.testnet.near.org';
const WNEAR = 'wrap.testnet';
const WASM_PATH = path.join(REPO_ROOT, 'bouncer.wasm');
const KEY_DIR = path.join(os.homedir(), '.near-credentials', NETWORK);
const provider = new JsonRpcProvider({ url: validateRpcEndpoint(RPC) });

const ONE_NEAR = 10n ** 24n;
const TGAS = 10n ** 12n;
const GAS_50 = 50n * TGAS;
const GAS_100 = 100n * TGAS;
const GAS_200 = 200n * TGAS;
const STORAGE = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR
const YOCTO = 1n;
const COMPUTE_POLICY = 'wnear-compute';
const STORAGE_POLICY = 'wnear-storage'; // same token: policy isolation, not a second FT
const txUrl = hash => `https://testnet.nearblocks.io/txns/${hash}?network=testnet`;
const accountFor = (id, key) => new MonotonicAccount(id, provider, new KeyPairSigner(key));

function saveKey(id, key, label = '') {
  fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(KEY_DIR, `${id}${label ? `.${label}` : ''}.json`);
  fs.writeFileSync(file, JSON.stringify({
    account_id: id, public_key: key.getPublicKey().toString(), private_key: key.toString(),
  }, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

async function helperCreate(id, publicKey) {
  const response = await fetch(`${HELPER}/account`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newAccountId: id, newAccountPublicKey: publicKey }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`testnet helper ${response.status}: ${await response.text()}`);
  const body = await response.json();
  await waitForNewTestnetKey(provider, id, publicKey);
  return body;
}

// A callback can succeed after a failed ft_transfer. A successful top-level
// status alone is not proof of settlement; inspect all receipts and balances.
function assertReceiptsSucceeded(outcome, action) {
  if (!Array.isArray(outcome.receipts_outcome) || outcome.receipts_outcome.length === 0) {
    throw new Error(`${action}: no receipt outcomes returned; cannot verify settlement`);
  }
  const failed = outcome.receipts_outcome.find(receipt => receipt.outcome?.status?.Failure);
  if (failed) throw new Error(`${action}: a receipt failed: ${JSON.stringify(failed.outcome.status.Failure)}`);
}

async function callFrom(account, contractId, method, args, deposit = 0n, gas = GAS_100) {
  const result = await account.callFunctionRaw({
    contractId, methodName: method, args, deposit, gas, waitUntil: 'FINAL',
  });
  assertReceiptsSucceeded(result, method);
  console.log(`    ✅ ${method}  tx: ${txUrl(result.transaction_outcome.id)}`);
  for (const receipt of result.receipts_outcome) {
    for (const log of receipt.outcome?.logs || []) {
      if (log.startsWith('BOUNCER')) console.log(`       ${log}`);
    }
  }
  return result;
}

async function expectRejection(description, expected, operation) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await operation(); }
    catch (error) {
      // These are deliberately invalid TEST transactions, not payments. A
      // stale-block Expired response is not the rejection being tested. Retry
      // it once only; ambiguous timeouts and actual receipt outcomes never retry.
      if (attempt === 0 && error.type === 'Expired' && !error.transaction_outcome) {
        console.warn(`    Test-only ${description}: expired transaction; retrying once.`);
        continue;
      }
      const detail = `${error.message || String(error)} ${util.inspect(error, { depth: 6 })}`;
      const matched = typeof expected === 'string' ? detail.includes(expected) : expected.test(detail);
      if (!matched) throw new Error(`${description}: expected ${expected}, got: ${detail}`, { cause: error });
      console.log(`    ✅ ${description}: rejected as expected`);
      if (error.transaction_outcome?.id) console.log(`       tx: ${txUrl(error.transaction_outcome.id)}`);
      return;
    }
    throw new Error(`${description}: transaction unexpectedly succeeded`);
  }
}

const view = (contractId, method, args) => provider.callFunction(contractId, method, args, { finality: 'final' });
function assertAmount(actual, expected, description) {
  if (BigInt(actual) !== expected) throw new Error(`${description}: expected ${expected}, got ${actual}`);
}
function formatNear(amount) {
  const value = BigInt(amount);
  const fraction = (value % ONE_NEAR).toString().padStart(24, '0').replace(/0+$/, '');
  return fraction ? `${value / ONE_NEAR}.${fraction}` : String(value / ONE_NEAR);
}

// Fresh-demo setup only: an explicit Expired response without a transaction
// outcome is a pre-admission rejection. Never retry a timeout, an ambiguous
// outcome or a procurement payment through this helper.
async function setupAttempt(description, operation) {
  try { return await operation(); }
  catch (error) {
    if (error?.type !== 'Expired' || error.transaction_outcome !== undefined) throw error;
    console.warn(`    Testnet security setup ${description}: explicit expired transaction; retrying once.`);
    return operation();
  }
}

async function addRestrictedKey(owner, contractId, key, methods) {
  const result = await setupAttempt('add restricted key', () => owner.signAndSendTransaction({
    receiverId: owner.accountId, waitUntil: 'FINAL',
    actions: [transactions.addKey(key.getPublicKey(), transactions.functionCallAccessKey(contractId, methods, ONE_NEAR))],
  }));
  assertReceiptsSucceeded(result, 'add restricted key');
  const access = await provider.viewAccessKey(owner.accountId, key.getPublicKey(), { finality: 'final' });
  const permission = access.permission?.FunctionCall;
  if (!permission || permission.receiver_id !== contractId ||
      JSON.stringify(permission.method_names) !== JSON.stringify(methods)) {
    throw new Error(`unexpected access-key permission: ${JSON.stringify(access.permission)}`);
  }
  console.log(`    ✅ restricted key (${methods.join(',')})  tx: ${txUrl(result.transaction_outcome.id)}`);
}

async function main() {
  if (!fs.existsSync(WASM_PATH)) throw new Error(`bouncer.wasm missing at ${WASM_PATH}`);
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report the NEAR testnet chain');
  const wasm = fs.readFileSync(WASM_PATH);
  console.log('BOUNCER — restricted-agent payments firewall (NEAR testnet)');
  console.log('Fresh deploy • real wNEAR • policy-scoped key • 1-yocto guard\n');

  const suffix = crypto.randomBytes(3).toString('hex');
  const bouncerId = `bouncer-${suffix}.testnet`;
  const userId = `user-${suffix}.${bouncerId}`;
  const vendorId = `vendor-${suffix}.${bouncerId}`;
  // Deliberately not registered with wNEAR, to force a downstream FT failure.
  const unregisteredId = `unregistered-${suffix}.${bouncerId}`;

  console.log(`=== 1) Create funded contract account: ${bouncerId} ===`);
  const bouncerKey = KeyPair.fromRandom('ed25519');
  saveKey(bouncerId, bouncerKey);
  await helperCreate(bouncerId, bouncerKey.getPublicKey().toString());
  const bouncer = accountFor(bouncerId, bouncerKey);
  fs.writeFileSync(path.join(os.homedir(), '.bouncer_id'), bouncerId);
  console.log(`    Owner key saved under ${KEY_DIR}`);

  console.log(`\n=== 2) Deploy contract (${wasm.length} bytes) and initialize ===`);
  const deploy = await bouncer.deployContract(wasm);
  assertReceiptsSucceeded(deploy, 'deploy');
  console.log(`    ✅ deploy  tx: ${txUrl(deploy.transaction_outcome.id)}`);
  await callFrom(bouncer, bouncerId, 'new', { owner: bouncerId });
  let version;
  try { version = await view(bouncerId, 'contract_version', {}); }
  catch (error) { throw new Error('The deployed wasm is stale; wait for the CI wasm build and git pull again.', { cause: error }); }
  if (version !== 'bouncer-agent-v7') throw new Error(`Unsupported contract version: ${version}`);

  console.log('\n=== 3) Create user and vendor sub-accounts ===');
  const userKey = KeyPair.fromRandom('ed25519');
  const vendorKey = KeyPair.fromRandom('ed25519');
  saveKey(userId, userKey);
  saveKey(vendorId, vendorKey);
  const userTx = await setupAttempt('create user', () => bouncer.createAccount(userId, userKey.getPublicKey(), 5n * ONE_NEAR));
  assertReceiptsSucceeded(userTx, 'create user');
  console.log(`    ✅ ${userId}  tx: ${txUrl(userTx.transaction_outcome.id)}`);
  const vendorTx = await setupAttempt('create vendor', () => bouncer.createAccount(vendorId, vendorKey.getPublicKey(), ONE_NEAR / 2n));
  assertReceiptsSucceeded(vendorTx, 'create vendor');
  console.log(`    ✅ ${vendorId}  tx: ${txUrl(vendorTx.transaction_outcome.id)}`);
  const user = accountFor(userId, userKey);

  console.log(`\n=== 4) Register accounts on ${WNEAR} ===`);
  await callFrom(user, WNEAR, 'storage_deposit', { account_id: userId }, STORAGE, GAS_50);
  await callFrom(bouncer, WNEAR, 'storage_deposit', { account_id: vendorId }, STORAGE, GAS_50);
  await callFrom(bouncer, WNEAR, 'storage_deposit', { account_id: bouncerId }, STORAGE, GAS_50);

  console.log('\n=== 5) User wraps 2 NEAR ===');
  await callFrom(user, WNEAR, 'near_deposit', {}, 2n * ONE_NEAR, GAS_50);

  console.log('\n=== 6) Create two separate policies (both use wNEAR) ===');
  for (const policyId of [COMPUTE_POLICY, STORAGE_POLICY]) {
    await callFrom(bouncer, bouncerId, 'set_policy', {
      policy_id: policyId, token: WNEAR,
      per_tx_cap: (2n * ONE_NEAR).toString(), daily_cap: ONE_NEAR.toString(),
    }, YOCTO);
    await callFrom(bouncer, bouncerId, 'allow_payee', { policy_id: policyId, payee: vendorId }, YOCTO);
  }

  console.log('\n=== 7) Create and authorize an execute-only agent key for the compute policy ===');
  const agentKey = KeyPair.fromRandom('ed25519');
  const agentKeyFile = saveKey(bouncerId, agentKey, 'agent');
  await addRestrictedKey(bouncer, bouncerId, agentKey, ['execute']);
  await callFrom(bouncer, bouncerId, 'grant_agent_key', {
    policy_id: COMPUTE_POLICY, public_key: agentKey.getPublicKey().toString(),
  }, YOCTO);
  const authorized = await view(bouncerId, 'is_agent_key_allowed', {
    policy_id: COMPUTE_POLICY, public_key: agentKey.getPublicKey().toString(),
  });
  const crossPolicy = await view(bouncerId, 'is_agent_key_allowed', {
    policy_id: STORAGE_POLICY, public_key: agentKey.getPublicKey().toString(),
  });
  if (authorized !== true || crossPolicy !== false) throw new Error('agent policy grants did not match expectation');
  const agent = accountFor(bouncerId, agentKey);
  console.log(`    Agent key saved separately: ${agentKeyFile}`);

  console.log('\n=== 8) Deposit 1.5 wNEAR into the vault ===');
  await callFrom(user, WNEAR, 'ft_transfer_call', {
    receiver_id: bouncerId, amount: (3n * ONE_NEAR / 2n).toString(), msg: 'fund',
  }, YOCTO, GAS_200);
  const deposited = await view(bouncerId, 'vault_balance', { token: WNEAR });
  assertAmount(deposited, 3n * ONE_NEAR / 2n, 'vault after deposit');
  console.log(`    Verified vault balance: ${formatNear(deposited)} wNEAR`);

  const execute = (account, policy, payee, amount, memo, expectedToken = WNEAR) => callFrom(account, bouncerId, 'execute', {
    policy_id: policy, payee, amount: amount.toString(), memo, expected_token: expectedToken,
  }, 0n, GAS_200);

  console.log('\n=== 9) Restricted agent pays vendor 0.1 wNEAR with zero deposit ===');
  await execute(agent, COMPUTE_POLICY, vendorId, ONE_NEAR / 10n, 'compute:1h');

  console.log('\n=== 9b) Force an FT failure and verify the on-chain refund callback ===');
  if (await view(WNEAR, 'storage_balance_of', { account_id: unregisteredId }) !== null) {
    throw new Error('refund test account is unexpectedly registered');
  }
  await callFrom(bouncer, bouncerId, 'allow_payee', { policy_id: COMPUTE_POLICY, payee: unregisteredId }, YOCTO);
  const beforeRefund = BigInt(await view(bouncerId, 'vault_balance', { token: WNEAR }));
  const refundProbe = () => agent.callFunctionRaw({
    contractId: bouncerId, methodName: 'execute',
    args: { policy_id: COMPUTE_POLICY, payee: unregisteredId, amount: (ONE_NEAR / 5n).toString(),
      memo: 'test:refund', expected_token: WNEAR },
    deposit: 0n, gas: GAS_200, waitUntil: 'FINAL',
  });
  let failedTransfer;
  try { failedTransfer = await refundProbe(); }
  catch (error) {
    // This special test payee is deliberately unregistered and cannot receive
    // wNEAR. Retry once only for an explicit pre-admission Expired RPC error;
    // never generalize this to ordinary payments or ambiguous timeouts.
    if (error.type !== 'Expired' || error.transaction_outcome) throw error;
    console.warn('    Test-only refund probe: expired transaction; retrying once.');
    failedTransfer = await refundProbe();
  }
  const receipts = failedTransfer.receipts_outcome || [];
  const tokenFailed = receipts.some(r => r.outcome?.executor_id === WNEAR && r.outcome.status?.Failure);
  const callbackRefunded = receipts.some(r => r.outcome?.executor_id === bouncerId &&
    r.outcome.logs?.includes('BOUNCER ft_transfer failed; vault refunded') && Object.hasOwn(r.outcome.status || {}, 'SuccessValue'));
  const unexpectedFailure = receipts.some(r => r.outcome?.executor_id !== WNEAR && r.outcome?.status?.Failure);
  if (!tokenFailed || !callbackRefunded || unexpectedFailure) throw new Error('expected failed wNEAR receipt and successful refund callback');
  assertAmount(await view(bouncerId, 'vault_balance', { token: WNEAR }), beforeRefund, 'recorded vault after refund');
  assertAmount(await view(WNEAR, 'ft_balance_of', { account_id: bouncerId }), beforeRefund, 'actual vault after refund');
  const refundBudget = await view(bouncerId, 'check', {
    policy_id: COMPUTE_POLICY, payee: vendorId, amount: (9n * ONE_NEAR / 10n).toString(),
  });
  if (!Array.isArray(refundBudget) || refundBudget[0] !== true) throw new Error('failed transfer did not restore daily budget');
  await callFrom(bouncer, bouncerId, 'revoke_payee', { policy_id: COMPUTE_POLICY, payee: unregisteredId }, YOCTO);
  console.log(`    ✅ Failed transfer refunded vault and daily budget  tx: ${txUrl(failedTransfer.transaction_outcome.id)}`);

  console.log('\n=== 10) Reject policy breaches from the actual agent key ===');
  await expectRejection('daily cap', 'BLOCKED: daily cap exceeded',
    () => execute(agent, COMPUTE_POLICY, vendorId, 19n * ONE_NEAR / 20n, 'storage:100gb'));
  await expectRejection('per-transaction cap', 'BLOCKED: amount exceeds per-tx cap',
    () => execute(agent, COMPUTE_POLICY, vendorId, 3n * ONE_NEAR, 'too much'));
  await expectRejection('payee allowlist', 'BLOCKED: payee not in allowlist',
    () => execute(agent, COMPUTE_POLICY, 'attacker.testnet', ONE_NEAR / 10n, 'not allowlisted'));

  console.log('\n=== 11) Reject unauthorized caller and cross-policy spending ===');
  await expectRejection('unrelated account', 'BLOCKED: caller is not the owner account',
    () => execute(user, COMPUTE_POLICY, vendorId, ONE_NEAR / 10n, 'unauthorized'));
  await expectRejection('agent key not granted to storage policy', 'BLOCKED: signing key is not authorized for this policy',
    () => execute(agent, STORAGE_POLICY, vendorId, ONE_NEAR / 10n, 'wrong policy'));
  await expectRejection('signed token mismatch', 'BLOCKED: policy token does not match expected token',
    () => execute(agent, COMPUTE_POLICY, vendorId, ONE_NEAR / 10n, 'wrong token', 'other-token.testnet'));

  console.log('\n=== 12) Prove the 1-yocto guard using a restricted probe key ===');
  // This intentionally broader TEST key can invoke set_policy, isolating the
  // deposit guard from the production agent key's separate method restriction.
  const probeKey = KeyPair.fromRandom('ed25519');
  await addRestrictedKey(bouncer, bouncerId, probeKey, ['set_policy']);
  const probe = accountFor(bouncerId, probeKey);
  const escalation = { policy_id: 'pwn', token: WNEAR, per_tx_cap: (999n * ONE_NEAR).toString(), daily_cap: null };
  await expectRejection('zero-deposit policy escalation (contract)',
    'ESCALATION BLOCKED: owner-only method requires exactly 1 yoctoNEAR',
    () => callFrom(probe, bouncerId, 'set_policy', escalation, 0n));
  await expectRejection('one-yocto policy escalation (NEAR protocol)',
    /DepositWithFunctionCall|deposit with a function call action is not allowed with a function call access key/i,
    () => callFrom(probe, bouncerId, 'set_policy', escalation, YOCTO));
  const deleted = await bouncer.deleteKey(probeKey.getPublicKey());
  assertReceiptsSucceeded(deleted, 'delete probe key');
  console.log(`    ✅ test probe key removed  tx: ${txUrl(deleted.transaction_outcome.id)}`);

  console.log('\n=== 13) Last-payee revocation fails closed ===');
  await callFrom(bouncer, bouncerId, 'revoke_payee', { policy_id: COMPUTE_POLICY, payee: vendorId }, YOCTO);
  await expectRejection('empty allowlist', 'BLOCKED: payee not in allowlist',
    () => execute(agent, COMPUTE_POLICY, vendorId, ONE_NEAR / 10n, 'revoked'));
  await callFrom(bouncer, bouncerId, 'allow_payee', { policy_id: COMPUTE_POLICY, payee: vendorId }, YOCTO);

  console.log('\n=== 14) Agent grant can be revoked ===');
  await callFrom(bouncer, bouncerId, 'revoke_agent_key', {
    policy_id: COMPUTE_POLICY, public_key: agentKey.getPublicKey().toString(),
  }, YOCTO);
  await expectRejection('revoked agent key', 'BLOCKED: signing key is not authorized for this policy',
    () => execute(agent, COMPUTE_POLICY, vendorId, ONE_NEAR / 10n, 'revoked key'));
  // Restore the demo key for follow-on work, after the revocation was proven.
  await callFrom(bouncer, bouncerId, 'grant_agent_key', {
    policy_id: COMPUTE_POLICY, public_key: agentKey.getPublicKey().toString(),
  }, YOCTO);

  console.log('\n=== 15) Verify final balances on chain ===');
  const userBalance = await view(WNEAR, 'ft_balance_of', { account_id: userId });
  const vendorBalance = await view(WNEAR, 'ft_balance_of', { account_id: vendorId });
  const vaultBalance = await view(bouncerId, 'vault_balance', { token: WNEAR });
  const tokenBalance = await view(WNEAR, 'ft_balance_of', { account_id: bouncerId });
  assertAmount(userBalance, ONE_NEAR / 2n, 'user wNEAR');
  assertAmount(vendorBalance, ONE_NEAR / 10n, 'vendor wNEAR');
  assertAmount(vaultBalance, 14n * ONE_NEAR / 10n, 'recorded vault wNEAR');
  assertAmount(tokenBalance, 14n * ONE_NEAR / 10n, 'actual vault wNEAR');
  console.log(`    user:   ${formatNear(userBalance)} wNEAR`);
  console.log(`    vendor: ${formatNear(vendorBalance)} wNEAR`);
  console.log(`    vault:  ${formatNear(vaultBalance)} wNEAR (matches token contract)`);
  console.log('\n✅ All checks passed. One token; payment signed by a restricted agent key.');
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::notice title=Testnet security and refund proof::contract=${bouncerId}; refund_tx=${failedTransfer.transaction_outcome.id}`);
  console.log(`Contract: ${bouncerId}`);
  console.log(`Explorer: https://testnet.nearblocks.io/address/${bouncerId}?tab=receipts`);
}

main().catch(error => {
  const detail = error.stack || error.message || String(error);
  console.error(`\n❌ FATAL: ${detail}`);
  // GitHub's check-run API exposes annotations even when runner log storage is
  // inaccessible from a restricted network; do not include private key data.
  if (process.env.GITHUB_ACTIONS === 'true') {
    const escaped = detail.slice(0, 3500).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    console.log(`::error title=Testnet smoke failed::${escaped}`);
  }
  process.exitCode = 1;
});
