import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { KeyPair } from '@near-js/crypto';
import nearApi from 'near-api-js';
import { nearActionsToConnectorActions } from '@hot-labs/near-connect';
import { buildBufferWalletSpendingPlan, assertBufferSpendingBatchMatchesReview, BUFFER_WALLET_TRIAL_MAX_ATOMS,
  BUFFER_WALLET_MAX_AGENT_GAS_YOCTO } from '../agent/buffer-wallet-spending-plan.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE } from '../scripts/circle-testnet-setup.mjs';
import { BUFFER_TESTNET_CONTRACT as SELLER } from '../experiments/buffer-forwarder/build.mjs';

// All keys and IDs in these tests are synthetic. No network is contacted.
const vaultKey = String(KeyPair.fromRandom('ed25519').getPublicKey());
const forwarderKey = String(KeyPair.fromRandom('ed25519').getPublicKey());
const options = () => ({ owner: 'buyer.testnet', vault: 'vault.buyer.testnet', adapter: 'buffer.buyer.testnet',
  policy_id: 'buffer-research', vault_agent_public_key: vaultKey, forwarder_agent_public_key: forwarderKey,
  per_tx_cap_atoms: '20000000', daily_cap_atoms: '20000000',
  vault_agent_gas_allowance_yocto: '250000000000000000000000', forwarder_agent_gas_allowance_yocto: '250000000000000000000000' });

test('Buffer spending authorization is unsigned, capped, exact-intent locked, and grants only receiver-scoped keys', () => {
  const p = options(), { review, batches } = buildBufferWalletSpendingPlan(p);
  assert.equal(review.status, 'UNSIGNED_OFFLINE_PLAN_ONLY');
  assert.equal(review.network, 'testnet');
  assert.equal(review.token, CIRCLE); assert.equal(review.seller, SELLER);
  assert.equal(review.signing_authorized, false); assert.equal(review.transaction_sent, false);
  assert.equal(review.agent_key_installed, false); assert.equal(review.provider_order_created, false);
  assert.equal(review.independent_delivery_verified, false);
  assert.deepEqual(review.stages.map(s => s.id), ['configure_buffer_locked_policy', 'install_buffer_vault_agent', 'install_buffer_forwarder_agent']);
  assert.deepEqual(review.stages[0].actions.map(a => a.method), ['set_policy', 'allow_payee', 'lock_ft_policy_to_intents', 'grant_agent_key']);
  assert.ok(review.stages[0].actions.every(a => a.deposit_yocto === '1' && a.gas === '30000000000000'));
  assert.deepEqual(review.stages[0].actions[0].args, { policy_id: p.policy_id, token: CIRCLE, per_tx_cap: '20000000', daily_cap: '20000000' });
  assert.deepEqual(review.stages[0].actions[1].args, { policy_id: p.policy_id, payee: p.adapter });
  assert.deepEqual(review.stages[0].actions[3].args, { policy_id: p.policy_id, public_key: vaultKey });
  assert.deepEqual(review.stages[1].actions[0], { type: 'add_function_call_key', public_key: vaultKey,
    receiver_id: p.vault, method_names: ['execute_exact_ft'], allowance_yocto: p.vault_agent_gas_allowance_yocto });
  assert.deepEqual(review.stages[2].actions[0], { type: 'add_function_call_key', public_key: forwarderKey,
    receiver_id: p.adapter, method_names: ['open', 'return_tokens'], allowance_yocto: p.forwarder_agent_gas_allowance_yocto });
  for (let i = 0; i < batches.length; i++) assert.equal(assertBufferSpendingBatchMatchesReview(batches[i], review.stages[i]), true);
  const { review_sha256, ...withoutDigest } = review;
  assert.equal(review_sha256, crypto.createHash('sha256').update(JSON.stringify(withoutDigest)).digest('hex'));
  assert.doesNotMatch(JSON.stringify(review), /private_key|secret_key|signed_tx/);
});

test('NEAR Connect action conversion preserves the four one-yocto calls and narrow keys', () => {
  const { batches } = buildBufferWalletSpendingPlan(options());
  const policy = nearActionsToConnectorActions(batches[0].actions);
  assert.deepEqual(policy.map(a => a.type), ['FunctionCall', 'FunctionCall', 'FunctionCall', 'FunctionCall']);
  assert.ok(policy.every(a => a.params.deposit === '1' && a.params.gas === '30000000000000'));
  assert.deepEqual(policy.map(a => a.params.methodName), ['set_policy', 'allow_payee', 'lock_ft_policy_to_intents', 'grant_agent_key']);
  assert.equal(policy[0].params.args.token, CIRCLE);
  assert.equal(policy[1].params.args.payee, 'buffer.buyer.testnet');
  const vault = nearActionsToConnectorActions(batches[1].actions)[0];
  assert.equal(vault.type, 'AddKey');
  assert.deepEqual(vault.params.accessKey.permission, { receiverId: 'vault.buyer.testnet',
    allowance: '250000000000000000000000', methodNames: ['execute_exact_ft'] });
  const forwarder = nearActionsToConnectorActions(batches[2].actions)[0];
  assert.equal(forwarder.type, 'AddKey');
  assert.deepEqual(forwarder.params.accessKey.permission, { receiverId: 'buffer.buyer.testnet',
    allowance: '250000000000000000000000', methodNames: ['open', 'return_tokens'] });
});

test('the retained review catches changed action, recipient, key, allowance and method', () => {
  const cases = [
    batch => { batch.actions[0].functionCall.deposit = 0n; },
    batch => { batch.actions[1].functionCall.args = Buffer.from('{"policy_id":"buffer-research","payee":"thief.testnet"}'); },
    batch => { batch.receiverId = 'other.buyer.testnet'; },
  ];
  for (const tamper of cases) {
    const { review, batches } = buildBufferWalletSpendingPlan(options());
    const retained = structuredClone(review.stages[0]); tamper(batches[0]);
    assert.throws(() => assertBufferSpendingBatchMatchesReview(batches[0], retained), /does not match/);
  }
  for (const tamper of [
    batch => { batch.actions[0].addKey.accessKey.permission.functionCall.methodNames = ['execute_exact_ft', 'set_policy']; },
    batch => { batch.actions[0].addKey.accessKey.permission.functionCall.receiverId = 'thief.testnet'; },
    batch => { batch.actions[0].addKey.accessKey.permission.functionCall.allowance = 2n * 10n ** 24n; },
    batch => { batch.actions[0] = nearApi.transactions.addKey(nearApi.utils.PublicKey.from(vaultKey), nearApi.transactions.fullAccessKey()); },
  ]) {
    const { review, batches } = buildBufferWalletSpendingPlan(options());
    const retained = structuredClone(review.stages[1]); tamper(batches[1]);
    assert.throws(() => assertBufferSpendingBatchMatchesReview(batches[1], retained), /does not match/);
  }
});

test('mainnet, EVM, non-child, repeated keys, unlimited caps and broad inputs fail closed', () => {
  const changes = [
    p => { p.owner = 'buyer.near'; },
    p => { p.owner = `0x${'a'.repeat(40)}`; },
    p => { p.vault = 'vault.other.testnet'; },
    p => { p.adapter = 'nested.buffer.buyer.testnet'; },
    p => { p.adapter = p.vault; },
    p => { p.policy_id = 'unsafe id'; },
    p => { p.vault_agent_public_key = forwarderKey; },
    p => { p.vault_agent_public_key = 'ed25519:bad'; },
    p => { p.per_tx_cap_atoms = '0'; },
    p => { p.per_tx_cap_atoms = '020000000'; },
    p => { p.per_tx_cap_atoms = String(BigInt(BUFFER_WALLET_TRIAL_MAX_ATOMS) + 1n); },
    p => { p.daily_cap_atoms = '19999999'; },
    p => { p.daily_cap_atoms = '20000001'; },
    p => { p.vault_agent_gas_allowance_yocto = '0'; },
    p => { p.forwarder_agent_gas_allowance_yocto = String(BigInt(BUFFER_WALLET_MAX_AGENT_GAS_YOCTO) + 1n); },
    p => { p.unexpected_permission = 'FullAccess'; },
    p => { delete p.policy_id; },
    p => { Object.defineProperty(p, 'policy_id', { get() { throw new Error('do not read'); }, enumerable: true }); },
  ];
  for (const change of changes) { const p = options(); change(p); assert.throws(() => buildBufferWalletSpendingPlan(p)); }
});

test('smaller explicit caps and gas allowances remain exact integer strings', () => {
  const p = options(); p.per_tx_cap_atoms = '5000000'; p.daily_cap_atoms = '10000000';
  p.vault_agent_gas_allowance_yocto = '1'; p.forwarder_agent_gas_allowance_yocto = '2';
  const { review } = buildBufferWalletSpendingPlan(p);
  assert.equal(review.per_tx_cap_atoms, '5000000'); assert.equal(review.daily_cap_atoms, '10000000');
  assert.equal(review.stages[1].actions[0].allowance_yocto, '1');
  assert.equal(review.stages[2].actions[0].allowance_yocto, '2');
});
