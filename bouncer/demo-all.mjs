// End-to-end wNEAR firewall check on NEAR testnet, with a fresh contract per run.
// Run from the repo root: node bouncer/demo-all.mjs
// This currently uses an owner key, not a restricted agent key. See README.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';

const { KeyPair, KeyPairSigner, Account, providers } = nearApi;
const { JsonRpcProvider } = providers;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NETWORK = 'testnet';
const RPC = 'https://rpc.testnet.near.org';
const HELPER = 'https://helper.testnet.near.org';
const WNEAR = 'wrap.testnet';
const WASM_PATH = path.join(REPO_ROOT, 'bouncer.wasm');
const KEY_DIR = path.join(os.homedir(), '.near-credentials', NETWORK);
const provider = new JsonRpcProvider({ url: RPC });

const ONE_NEAR = 10n ** 24n;
const TGAS = 10n ** 12n;
const GAS_50 = 50n * TGAS;
const GAS_100 = 100n * TGAS;
const GAS_200 = 200n * TGAS;
const STORAGE = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR
const YOCTO = 1n;
const txUrl = hash => `https://testnet.nearblocks.io/txns/${hash}?network=testnet`;
const accountFor = (id, key) => new Account(id, provider, new KeyPairSigner(key));

function saveKey(id, key) {
  fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(KEY_DIR, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({
    account_id: id, public_key: key.getPublicKey().toString(), private_key: key.toString(),
  }, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

async function helperCreate(id, publicKey) {
  const response = await fetch(`${HELPER}/account`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newAccountId: id, newAccountPublicKey: publicKey }),
  });
  if (!response.ok) throw new Error(`testnet helper ${response.status}: ${await response.text()}`);
  return response.json();
}

// A successful top-level transaction is not enough: a downstream ft_transfer can
// fail and the contract's refund callback can still make the final status success.
function assertReceiptsSucceeded(outcome, action) {
  if (!Array.isArray(outcome.receipts_outcome) || outcome.receipts_outcome.length === 0) {
    throw new Error(`${action}: no receipt outcomes returned; cannot verify settlement`);
  }
  const failed = outcome.receipts_outcome.find(receipt => receipt.outcome?.status?.Failure);
  if (failed) {
    throw new Error(`${action}: a receipt failed: ${JSON.stringify(failed.outcome.status.Failure)}`);
  }
}

async function callFrom(account, contractId, method, args, deposit = 0n, gas = GAS_100) {
  // near-api-js expects gas in individual gas units, not strings like "50T".
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

async function expectRejection(description, expectedMessage, operation) {
  try {
    await operation();
  } catch (error) {
    const message = error.message || String(error);
    if (!message.includes(expectedMessage)) {
      throw new Error(`${description}: expected "${expectedMessage}", got: ${message}`, { cause: error });
    }
    console.log(`    ✅ rejected as expected: ${expectedMessage}`);
    return;
  }
  throw new Error(`${description}: transaction unexpectedly succeeded`);
}

const view = (contractId, method, args) => provider.callFunction(contractId, method, args);
function assertAmount(actual, expected, description) {
  if (BigInt(actual) !== expected) {
    throw new Error(`${description}: expected ${expected}, got ${actual}`);
  }
}
function formatNear(amount) {
  const value = BigInt(amount);
  const whole = value / ONE_NEAR;
  const fraction = (value % ONE_NEAR).toString().padStart(24, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

async function main() {
  if (!fs.existsSync(WASM_PATH)) throw new Error(`bouncer.wasm missing at ${WASM_PATH}`);
  const wasm = fs.readFileSync(WASM_PATH);
  console.log('BOUNCER — wNEAR payments firewall check (NEAR testnet)');
  console.log('Fresh deploy • payment • caps • allowlist • 1-yocto guard\n');

  const suffix = crypto.randomBytes(3).toString('hex');
  const bouncerId = `bouncer-${suffix}.testnet`;
  const userId = `user-${suffix}.${bouncerId}`;
  const vendorId = `vendor-${suffix}.${bouncerId}`;

  console.log(`=== 1) Create funded contract account: ${bouncerId} ===`);
  const bouncerKey = KeyPair.fromRandom('ed25519');
  saveKey(bouncerId, bouncerKey);
  await helperCreate(bouncerId, bouncerKey.getPublicKey().toString());
  const bouncer = accountFor(bouncerId, bouncerKey);
  // Save the ID as soon as it exists, even if a later transaction fails.
  fs.writeFileSync(path.join(os.homedir(), '.bouncer_id'), bouncerId);
  console.log(`    Key saved under ${KEY_DIR}`);

  console.log(`\n=== 2) Deploy contract (${wasm.length} bytes) and initialize ===`);
  const deploy = await bouncer.deployContract(wasm);
  assertReceiptsSucceeded(deploy, 'deploy');
  console.log(`    ✅ deploy  tx: ${txUrl(deploy.transaction_outcome.id)}`);
  await callFrom(bouncer, bouncerId, 'new', { owner: bouncerId });

  console.log(`\n=== 3) Create user and vendor sub-accounts ===`);
  const userKey = KeyPair.fromRandom('ed25519');
  const vendorKey = KeyPair.fromRandom('ed25519');
  saveKey(userId, userKey);
  saveKey(vendorId, vendorKey);
  const userTx = await bouncer.createAccount(userId, userKey.getPublicKey(), 5n * ONE_NEAR);
  assertReceiptsSucceeded(userTx, 'create user');
  console.log(`    ✅ ${userId}  tx: ${txUrl(userTx.transaction_outcome.id)}`);
  const vendorTx = await bouncer.createAccount(vendorId, vendorKey.getPublicKey(), ONE_NEAR / 2n);
  assertReceiptsSucceeded(vendorTx, 'create vendor');
  console.log(`    ✅ ${vendorId}  tx: ${txUrl(vendorTx.transaction_outcome.id)}`);
  const user = accountFor(userId, userKey);

  console.log(`\n=== 4) Register accounts on ${WNEAR} ===`);
  await callFrom(user, WNEAR, 'storage_deposit', { account_id: userId }, STORAGE, GAS_50);
  await callFrom(bouncer, WNEAR, 'storage_deposit', { account_id: vendorId }, STORAGE, GAS_50);
  await callFrom(bouncer, WNEAR, 'storage_deposit', { account_id: bouncerId }, STORAGE, GAS_50);

  console.log('\n=== 5) User wraps 2 NEAR ===');
  await callFrom(user, WNEAR, 'near_deposit', {}, 2n * ONE_NEAR, GAS_50);

  console.log('\n=== 6) Set policy: 2 wNEAR per transaction, 1 wNEAR per day ===');
  await callFrom(bouncer, bouncerId, 'set_policy', {
    policy_id: 'wnear-agent', token: WNEAR,
    per_tx_cap: (2n * ONE_NEAR).toString(), daily_cap: ONE_NEAR.toString(),
  }, YOCTO);

  console.log(`\n=== 7) Allowlist ${vendorId} ===`);
  await callFrom(bouncer, bouncerId, 'allow_payee', { policy_id: 'wnear-agent', payee: vendorId }, YOCTO);

  console.log('\n=== 8) Deposit 1.5 wNEAR into the vault ===');
  await callFrom(user, WNEAR, 'ft_transfer_call', {
    receiver_id: bouncerId, amount: (3n * ONE_NEAR / 2n).toString(), msg: 'fund',
  }, YOCTO, GAS_200);
  const deposited = await view(bouncerId, 'vault_balance', { token: WNEAR });
  assertAmount(deposited, 3n * ONE_NEAR / 2n, 'vault after deposit');
  console.log(`    Verified vault balance: ${formatNear(deposited)} wNEAR`);

  const execute = (payee, amount, memo) => callFrom(bouncer, bouncerId, 'execute', {
    policy_id: 'wnear-agent', payee, amount: amount.toString(), memo,
  }, YOCTO, GAS_200);

  console.log('\n=== 9) Pay vendor 0.1 wNEAR (must settle) ===');
  await execute(vendorId, ONE_NEAR / 10n, 'compute:1h');

  console.log('\n=== 10) Reject 0.95 wNEAR (daily cap) ===');
  await expectRejection('daily cap', 'BLOCKED: daily cap exceeded',
    () => execute(vendorId, 19n * ONE_NEAR / 20n, 'storage:100gb'));

  console.log('\n=== 11) Reject 3 wNEAR (per-transaction cap) ===');
  await expectRejection('per-transaction cap', 'BLOCKED: amount exceeds per-tx cap',
    () => execute(vendorId, 3n * ONE_NEAR, 'too much'));

  console.log('\n=== 12) Reject a non-allowlisted payee ===');
  await expectRejection('payee allowlist', 'BLOCKED: payee not in allowlist',
    () => execute('attacker.testnet', ONE_NEAR / 10n, 'not allowlisted'));

  console.log('\n=== 13) Reject policy change with zero deposit ===');
  await expectRejection('1-yocto guard', 'ESCALATION BLOCKED: owner-only method requires exactly 1 yoctoNEAR',
    () => callFrom(bouncer, bouncerId, 'set_policy', {
      policy_id: 'pwn', token: WNEAR, per_tx_cap: (999n * ONE_NEAR).toString(), daily_cap: null,
    }, 0n));

  console.log('\n=== 14) Verify final balances on chain ===');
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
  console.log('\n✅ All checks passed. This run uses one token and an owner key.');
  console.log(`Contract: ${bouncerId}`);
  console.log(`Explorer: https://testnet.nearblocks.io/address/${bouncerId}?tab=receipts`);
}

main().catch(error => {
  console.error(`\n❌ FATAL: ${error.stack || error.message || String(error)}`);
  process.exitCode = 1;
});
