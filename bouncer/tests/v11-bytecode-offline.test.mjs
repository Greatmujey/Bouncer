/**
 * Optional bytecode-level regression for the recovered V11 artifact.
 *
 * Run with BOUNCER_V11_WASM_PATH=/absolute/path/to/bouncer-v11.wasm.
 * The exact recorded artifact SHA-256 is required; the binary is not tracked
 * in this repository. This minimal, fail-on-unimplemented mock is NOT nearcore:
 * it does not model gas, protocol gates, access-key permissions, transaction
 * validation, receipt scheduling, FT behavior, storage economics or consensus.
 * It sends no network requests, creates no accounts, and signs nothing.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import nearApi from 'near-api-js';
import { buildUnsignedSvalinTrialSetup } from '../agent/svalin-setup-plan.mjs';
import { verifySvalinSetupPlan } from '../agent/svalin-setup-evidence.mjs';

import { EXPECTED_SHA256, OWNER, VAULT, TOKEN, PAYEE, AGENT_PK, AGENT_BYTES,
  readExactArtifact, SyntheticNearHost } from './fixtures/v11-synthetic-host.mjs';

const path = process.env.BOUNCER_V11_WASM_PATH;

const ownerCall = { predecessor: OWNER, deposit: 1n };
const policy = { policy_id: 'svalin', token: TOKEN, per_tx_cap: '200', daily_cap: '300' };
function setup(host) {
  host.call('new', { owner: OWNER });
  host.call('set_policy', policy, ownerCall);
  host.call('allow_payee', { policy_id: 'svalin', payee: PAYEE }, ownerCall);
  host.call('grant_agent_key', { policy_id: 'svalin', public_key: AGENT_PK }, ownerCall);
  host.call('lock_ft_policy_to_intents', { policy_id: 'svalin' }, ownerCall);
  host.call('ft_on_transfer', { sender_id: OWNER, amount: '1000', msg: '' }, { predecessor: TOKEN });
  host.call('set_exact_ft_intent', { intent_id: 'proof1', policy_id: 'svalin', expected_token: TOKEN,
    payee: PAYEE, amount: '100', memo: 'synthetic-code', review_hash: 'a'.repeat(64),
    expires_at_ms: '1800000060000', agent_public_key: AGENT_PK }, ownerCall);
}

const skip = path ? false : 'set BOUNCER_V11_WASM_PATH to the recovered V11 artifact';
test('actual V11 bytecode blocks policy escalation in a synthetic host', { skip }, () => {
  const host = new SyntheticNearHost(readExactArtifact(path));
  host.call('new', { owner: OWNER });
  assert.equal(host.call('get_owner', {}).value, OWNER);
  assert.equal(host.call('contract_version', {}).value, 'bouncer-agent-v11-exact-ft-testnet');
  for (const deposit of [0n, 2n]) {
    assert.throws(() => host.call('set_policy', policy, { predecessor: OWNER, deposit }), /exactly 1 yoctoNEAR/);
    assert.equal(host.call('get_policy', { policy_id: 'svalin' }).value, null);
  }
  assert.throws(() => host.call('set_policy', policy, { predecessor: 'intruder.testnet', deposit: 1n }), /caller is not owner/);
  host.call('set_policy', policy, ownerCall);
  assert.deepEqual(host.call('get_policy', { policy_id: 'svalin' }).value,
    { token: TOKEN, per_tx_cap: '200', daily_cap: '300' });
  // Predecessor plus deposit is not proof of human approval: a forwarding
  // owner contract can call with an unrelated transaction signer.
  host.call('set_policy', { ...policy, policy_id: 'forwarded' }, { ...ownerCall, signer: 'requester.testnet' });
  assert.equal(host.call('get_policy', { policy_id: 'forwarded' }).value.per_tx_cap, '200');
});

test('actual V11 bytecode distinguishes the reviewed payee from an unfunded vault', { skip }, () => {
  const host = new SyntheticNearHost(readExactArtifact(path));
  host.call('new', { owner: OWNER });
  host.call('set_policy', policy, ownerCall);
  host.call('allow_payee', { policy_id: 'svalin', payee: PAYEE }, ownerCall);
  // This is the same ordering used by the reviewed setup batch.
  host.call('lock_ft_policy_to_intents', { policy_id: 'svalin' }, ownerCall);
  host.call('grant_agent_key', { policy_id: 'svalin', public_key: AGENT_PK }, ownerCall);
  assert.deepEqual(host.call('check', { policy_id: 'svalin', payee: PAYEE, amount: '200' }).value,
    [false, 'BLOCKED: insufficient vault balance (fund first)']);
  assert.deepEqual(host.call('check', { policy_id: 'svalin', payee: 'other.testnet', amount: '200' }).value,
    [false, 'BLOCKED: payee not in allowlist']);
  host.call('ft_on_transfer', { sender_id: OWNER, amount: '200', msg: '' }, { predecessor: TOKEN });
  assert.equal(host.call('check', { policy_id: 'svalin', payee: PAYEE, amount: '200' }).value[0], true);
});

test('actual V11 bytecode consumes the reviewed synthetic intent and refunds a failed mocked callback', { skip }, () => {
  const host = new SyntheticNearHost(readExactArtifact(path));
  setup(host);
  assert.equal(host.call('is_exact_ft_policy_locked', { policy_id: 'svalin' }).value, true);
  assert.equal(host.call('vault_balance', { token: TOKEN }).value, '1000');
  assert.equal(host.call('get_exact_ft_intent', { intent_id: 'proof1' }).value.active, true);
  assert.throws(() => host.call('execute_exact_ft', { intent_id: 'proof1' },
    { predecessor: OWNER, signerPk: Buffer.concat([Buffer.from([0]), Buffer.alloc(32, 3)]) }), /wrong exact FT agent key/);
  assert.throws(() => host.call('execute_exact_ft', { intent_id: 'proof1' }, { ...ownerCall, signerPk: AGENT_BYTES }), /zero deposit/);
  assert.throws(() => host.call('execute', { policy_id: 'svalin', payee: PAYEE, amount: '100', memo: 'synthetic-code',
    expected_token: TOKEN }, { predecessor: OWNER, signerPk: AGENT_BYTES }), /policy requires exact FT intents/);
  assert.equal(host.call('get_exact_ft_intent', { intent_id: 'proof1' }).value.active, true);

  const execution = host.call('execute_exact_ft', { intent_id: 'proof1' }, { predecessor: OWNER, signerPk: AGENT_BYTES });
  assert.equal(execution.promises.length, 2);
  const [transfer, callback] = execution.promises;
  assert.equal(transfer.receiver, TOKEN); assert.equal(transfer.parent, null);
  assert.equal(transfer.actions.length, 1);
  assert.equal(transfer.actions[0].method, 'ft_transfer');
  assert.deepEqual(transfer.actions[0].args, { receiver_id: PAYEE, amount: '100', memo: 'synthetic-code' });
  assert.equal(transfer.actions[0].deposit, '1');
  assert.equal(callback.receiver, VAULT); assert.equal(callback.parent, 0); assert.equal(callback.actions.length, 1);
  assert.equal(callback.actions[0].method, 'after_exact_ft_transfer'); assert.equal(callback.actions[0].deposit, '0');
  assert.equal(host.call('vault_balance', { token: TOKEN }).value, '900');
  assert.equal(host.call('daily_spent', { policy_id: 'svalin' }).value, '100');
  assert.throws(() => host.call('execute_exact_ft', { intent_id: 'proof1' },
    { predecessor: OWNER, signerPk: AGENT_BYTES }), /consumed, cancelled, expired or stale/);

  const args = callback.actions[0].args;
  // The optimized wrapper may trap with a generic WASM unreachable instead
  // of returning the SDK's private-method message. Either way, the external
  // attempt must not change the mock state or credit a refund.
  assert.throws(() => host.call('after_exact_ft_transfer', args,
    { predecessor: 'intruder.testnet', promiseResult: 'failed' }), /private|unreachable/i);
  assert.equal(host.call('vault_balance', { token: TOKEN }).value, '900');
  host.call('after_exact_ft_transfer', args, { predecessor: VAULT, promiseResult: 'failed' });
  assert.equal(host.call('vault_balance', { token: TOKEN }).value, '1000');
  assert.equal(host.call('daily_spent', { policy_id: 'svalin' }).value, '0');
  const final = host.call('get_exact_ft_intent', { intent_id: 'proof1' }).value;
  assert.equal(final.consumed, true); assert.equal(final.active, false);
});

test('actual V11 bytecode keeps conservative accounting when a synthetic callback succeeds or a policy changes', { skip }, () => {
  const success = new SyntheticNearHost(readExactArtifact(path));
  setup(success);
  const sent = success.call('execute_exact_ft', { intent_id: 'proof1' }, { predecessor: OWNER, signerPk: AGENT_BYTES });
  const callback = sent.promises[1].actions[0].args;
  success.call('after_exact_ft_transfer', callback, { predecessor: VAULT, promiseResult: 'success' });
  assert.equal(success.call('vault_balance', { token: TOKEN }).value, '900');
  assert.equal(success.call('daily_spent', { policy_id: 'svalin' }).value, '100');
  assert.equal(success.call('get_exact_ft_intent', { intent_id: 'proof1' }).value.consumed, true);

  const changed = new SyntheticNearHost(readExactArtifact(path));
  setup(changed);
  const pending = changed.call('execute_exact_ft', { intent_id: 'proof1' }, { predecessor: OWNER, signerPk: AGENT_BYTES });
  changed.call('set_policy', policy, ownerCall); // increments the policy revision while the callback is pending
  changed.call('after_exact_ft_transfer', pending.promises[1].actions[0].args,
    { predecessor: VAULT, promiseResult: 'failed' });
  assert.equal(changed.call('vault_balance', { token: TOKEN }).value, '1000');
  assert.equal(changed.call('daily_spent', { policy_id: 'svalin' }).value, '100');
  assert.equal(changed.call('get_exact_ft_intent', { intent_id: 'proof1' }).value.consumed, true);

  const stale = new SyntheticNearHost(readExactArtifact(path));
  setup(stale);
  stale.call('set_policy', policy, ownerCall);
  assert.throws(() => stale.call('execute_exact_ft', { intent_id: 'proof1' },
    { predecessor: OWNER, signerPk: AGENT_BYTES }), /consumed, cancelled, expired or stale/);
  assert.equal(stale.call('vault_balance', { token: TOKEN }).value, '1000');
});

test('the exact recovered binary can form a synthetic, unsigned keyless setup review', { skip }, () => {
  const wasmBytes = readExactArtifact(path);
  const codeHash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(wasmBytes).digest());
  const ownerKey = `ed25519:${nearApi.utils.serialize.base_encode(Buffer.alloc(32, 8))}`;
  const plan = buildUnsignedSvalinTrialSetup({
    goal: { version: 1, id: 'synthetic-only', vault: 'trial.owner.testnet', owner: OWNER,
      vault_code_hash: codeHash, policy_id: 'svalin', accept_unsigned_seller_risk: true,
      accept_exact_amount_matching_risk: true },
    wasmBytes, agentPublicKey: AGENT_PK,
    initialVaultFundingYocto: (7n * 10n ** 24n).toString(),
    agentGasAllowanceYocto: (10n ** 23n).toString(),
    vaultTokenStorageDepositYocto: (125n * 10n ** 19n).toString(),
  });
  assert.equal(plan.review.artifact.sha256, EXPECTED_SHA256);
  assert.equal(plan.review.artifact.byte_length, 536325);
  assert.deepEqual(plan.batches[0].actions.map(a => a.enum), ['createAccount', 'transfer', 'deployContract', 'functionCall']);
  assert.deepEqual(Buffer.from(plan.batches[0].actions[2].deployContract.code), wasmBytes);
  assert.equal(plan.batches[0].actions.some(a => a.enum === 'addKey'), false);
  assert.equal(plan.review.transaction_signed, false);
  assert.equal(plan.review.transaction_sent, false);
  assert.equal(plan.review.setup_or_funding_verified, false);
  const proof = verifySvalinSetupPlan({ plan, trustedReviewHash: plan.review.review_sha256, ownerPublicKey: ownerKey });
  assert.equal(proof.vault, 'trial.owner.testnet');
  plan.batches[0].actions[2].deployContract.code[0] ^= 1;
  assert.throws(() => verifySvalinSetupPlan({ plan, trustedReviewHash: plan.review.review_sha256, ownerPublicKey: ownerKey }));
});
