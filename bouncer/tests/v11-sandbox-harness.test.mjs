// Unit tests for sandbox-harness guards only. These objects are synthetic and
// do not run nearcore, V11, the token contract, or a live NEAR transaction.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import nearApi from 'near-api-js';
import { SANDBOX_CHAIN_ID, MOCK_TOKEN_GENESIS_BALANCE, readVerifiedFile, withMockTokenInGenesis,
  assertSandboxStatus, requireFinalSuccess, assertOmittedLocalAddKeyReceipt, assertRegistrationWithOnlyGasRefund,
  requireReceiptLog } from '../integration/v11-sandbox-support.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';

const publicKey = String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const genesis = () => ({ chain_id: SANDBOX_CHAIN_ID, total_supply: '123', records: [
  { Account: { account_id: 'testnet', account: { amount: '123' } } },
] });
const receipt = (executor_id, status, logs = []) => ({ id: 'synthetic', outcome: { executor_id, status, logs } });
const success = () => ({ final_execution_status: 'FINAL', status: { SuccessValue: '' },
  receipts_outcome: [receipt('vault.testnet', { SuccessValue: '' }, ['mock success'])] });

test('sandbox genesis helper adds only an artificial mock-token account and never mutates its input', () => {
  const input = genesis(), original = structuredClone(input);
  const output = withMockTokenInGenesis(input, TOKEN, publicKey);
  assert.deepEqual(input, original);
  assert.equal(output.total_supply, (MOCK_TOKEN_GENESIS_BALANCE + 123n).toString());
  assert.deepEqual(output.records.slice(1).map(record => Object.keys(record)[0]), ['Account', 'AccessKey']);
  assert.equal(output.records[1].Account.account_id, TOKEN);
  assert.equal(output.records[2].AccessKey.account_id, TOKEN);
  assert.equal(output.records[2].AccessKey.public_key, publicKey);
  assert.equal(JSON.stringify(output).includes('secret_key'), false);
  assert.throws(() => withMockTokenInGenesis(output, TOKEN, publicKey), /already exists/);
  for (const bad of [null, {}, { ...genesis(), chain_id: 'testnet' },
    { ...genesis(), chain_id: 'mainnet' }, { ...genesis(), total_supply: '1.5' }]) {
    assert.throws(() => withMockTokenInGenesis(bad, TOKEN, publicKey));
  }
  assert.throws(() => withMockTokenInGenesis(genesis(), 'anything.testnet', publicKey));
  assert.throws(() => withMockTokenInGenesis(genesis(), TOKEN, 'not-a-public-key'));
});

test('file verification requires an exact digest and bounded regular file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-harness-test-'));
  try {
    const file = path.join(dir, 'input'); fs.writeFileSync(file, 'local-test');
    const hash = crypto.createHash('sha256').update('local-test').digest('hex');
    assert.equal(readVerifiedFile(file, hash).toString(), 'local-test');
    assert.throws(() => readVerifiedFile(file, '0'.repeat(64)), /SHA-256 mismatch/);
    assert.throws(() => readVerifiedFile(file, hash, { maxBytes: 2 }), /oversized/);
    assert.throws(() => readVerifiedFile(dir, hash), /invalid/);
    assert.throws(() => readVerifiedFile(undefined, hash), /explicit/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('local sandbox status rejects mainnet, testnet, missing chain and syncing nodes', () => {
  assert.doesNotThrow(() => assertSandboxStatus({ chain_id: SANDBOX_CHAIN_ID, sync_info: { syncing: false } }));
  for (const input of [null, {}, { chain_id: 'mainnet', sync_info: { syncing: false } },
    { chain_id: 'testnet', sync_info: { syncing: false } },
    { chain_id: SANDBOX_CHAIN_ID, sync_info: { syncing: true } },
    { chain_id: SANDBOX_CHAIN_ID, sync_info: {} }]) assert.throws(() => assertSandboxStatus(input));
});

test('receipt checks reject unknown or failed outcomes except an explicitly counted failure', () => {
  assert.equal(requireFinalSuccess(success(), 'test'), 0);
  for (const mutate of [r => { r.final_execution_status = 'EXECUTED_OPTIMISTIC'; },
    r => { r.status = { Failure: {} }; }, r => { r.receipts_outcome = []; },
    r => { r.receipts_outcome[0].outcome.status = 'Unknown'; },
    r => { r.receipts_outcome[0].outcome.status = { Failure: { mock: true } }; }]) {
    const result = success(); mutate(result); assert.throws(() => requireFinalSuccess(result, 'test'));
  }
  const failed = success();
  failed.receipts_outcome.push(receipt('mock-ft', { Failure: { test: true } }));
  assert.equal(requireFinalSuccess(failed, 'test', { allowReceiptFailure: true }), 1);
  assert.equal(requireReceiptLog(failed, 'vault.testnet', 'mock success').outcome.executor_id, 'vault.testnet');
  assert.throws(() => requireReceiptLog(failed, 'mock-ft', 'mock success'));
  failed.receipts_outcome.push(structuredClone(failed.receipts_outcome[0]));
  assert.throws(() => requireReceiptLog(failed, 'vault.testnet', 'mock success'));
});

test('local AddKey omission diagnostic requires a specific rejected same-account FINAL outcome', () => {
  const attempt = { stage_id: 'install_restricted_agent_key', tx_hash: 'original-local-hash',
    signer_id: 'owner.testnet', receiver_id: 'owner.testnet', signer_public_key: publicKey };
  const result = { final_execution_status: 'FINAL', status: { SuccessValue: '' },
    transaction: { hash: attempt.tx_hash, signer_id: attempt.signer_id, receiver_id: attempt.receiver_id, public_key: publicKey },
    transaction_outcome: { id: attempt.tx_hash, outcome: { executor_id: attempt.signer_id,
      receipt_ids: ['local-root'], status: { SuccessReceiptId: 'local-root' } } },
    receipts: [], receipts_outcome: [receipt('owner.testnet', { SuccessValue: '' })] };
  result.receipts_outcome[0].id = 'local-root';
  const error = new Error('original action receipt is missing or differs from the reviewed batch');
  assert.equal(assertOmittedLocalAddKeyReceipt(result, attempt, error), 'local-root');
  const changes = [
    r => { r.final_execution_status = 'EXECUTED_OPTIMISTIC'; },
    r => { r.transaction.hash = 'other'; }, r => { r.transaction.signer_id = 'other.testnet'; },
    r => { r.transaction.receiver_id = 'other.testnet'; }, r => { r.transaction.public_key = 'other'; },
    r => { r.transaction_outcome.id = 'other'; }, r => { r.transaction_outcome.outcome.executor_id = 'other.testnet'; },
    r => { r.transaction_outcome.outcome.receipt_ids = []; },
    r => { r.receipts.push({ receipt_id: 'local-root' }); },
    r => { r.receipts_outcome = []; }, r => { r.receipts_outcome.push(structuredClone(r.receipts_outcome[0])); },
    r => { r.receipts_outcome[0].outcome.executor_id = 'other.testnet'; },
    r => { r.receipts_outcome[0].outcome.status = { Failure: {} }; }, r => { r.status = { Failure: {} }; },
  ];
  for (const change of changes) { const r = structuredClone(result); change(r); assert.throws(() => assertOmittedLocalAddKeyReceipt(r, attempt, error)); }
  assert.throws(() => assertOmittedLocalAddKeyReceipt(result, { ...attempt, stage_id: 'create_keyless_vault' }, error));
  assert.throws(() => assertOmittedLocalAddKeyReceipt(result, { ...attempt, receiver_id: 'vault.testnet' }, error));
  assert.throws(() => assertOmittedLocalAddKeyReceipt(result, attempt, new Error('unrelated verifier failure')));
});

test('registration diagnostic only recognizes exact balance plus a linked system gas refund', () => {
  const attempt = { stage_id: 'register_vault_for_test_usdc', tx_hash: 'registration-hash',
    signer_id: 'owner.testnet', receiver_id: TOKEN, signer_public_key: publicKey };
  const minimum = '1250000000000000000000', balance = { total: minimum, available: '0' };
  const encoded = Buffer.from(JSON.stringify(balance)).toString('base64');
  const root = { id: 'registration-root', outcome: { executor_id: TOKEN, status: { SuccessValue: encoded }, receipt_ids: ['gas-refund'] } };
  const gas = { receipt_id: 'gas-refund', predecessor_id: 'system', receiver_id: attempt.signer_id,
    receipt: { Action: { signer_id: attempt.signer_id, signer_public_key: publicKey, gas_price: '0', input_data_ids: [],
      output_data_receivers: [], actions: [{ Transfer: { deposit: '999' } }] } } };
  const gasOutcome = { id: 'gas-refund', outcome: { executor_id: attempt.signer_id, status: { SuccessValue: '' }, receipt_ids: [] } };
  const result = { final_execution_status: 'FINAL', status: { SuccessValue: encoded }, transaction: { hash: attempt.tx_hash },
    transaction_outcome: { outcome: { status: { SuccessReceiptId: 'registration-root' } } },
    receipts: [gas], receipts_outcome: [root, gasOutcome] };
  const error = new Error('token registration result does not match the reviewed fresh registration');
  assert.doesNotThrow(() => assertRegistrationWithOnlyGasRefund(result, attempt, error, minimum, balance));
  const changes = [
    r => { r.final_execution_status = 'EXECUTED'; }, r => { r.transaction.hash = 'other'; },
    r => { r.status.SuccessValue = Buffer.from('{}').toString('base64'); },
    r => { r.receipts_outcome[0].outcome.executor_id = 'other.testnet'; },
    r => { r.receipts_outcome[0].outcome.receipt_ids = []; },
    r => { r.receipts_outcome[0].outcome.receipt_ids.push('other'); },
    r => { r.receipts[0].predecessor_id = TOKEN; }, // contract transfer is NOT a protocol refund
    r => { r.receipts[0].receiver_id = 'attacker.testnet'; },
    r => { r.receipts[0].receipt.Action.signer_id = 'system'; }, // deposit refund, not gas refund
    r => { r.receipts[0].receipt.Action.signer_public_key = 'other'; },
    r => { r.receipts[0].receipt.Action.gas_price = '1'; },
    r => { r.receipts[0].receipt.Action.actions = [{ FunctionCall: { method_name: 'x' } }]; },
    r => { r.receipts[0].receipt.Action.actions[0].Transfer.deposit = '0'; },
    r => { r.receipts_outcome[1].outcome.status = { Failure: {} }; },
    r => { r.receipts_outcome[1].outcome.receipt_ids = ['other']; },
  ];
  for (const change of changes) { const r = structuredClone(result); change(r); assert.throws(() => assertRegistrationWithOnlyGasRefund(r, attempt, error, minimum, balance)); }
  assert.throws(() => assertRegistrationWithOnlyGasRefund(result, attempt, error, minimum, { ...balance, available: '1' }));
  assert.throws(() => assertRegistrationWithOnlyGasRefund(result, { ...attempt, stage_id: 'other' }, error, minimum, balance));
  assert.throws(() => assertRegistrationWithOnlyGasRefund(result, attempt, new Error('other'), minimum, balance));
});
