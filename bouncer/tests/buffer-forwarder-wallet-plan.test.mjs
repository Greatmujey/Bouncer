import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { buildBufferWalletSpendingPlan } from '../agent/buffer-wallet-spending-plan.mjs';
import { buildBufferForwarderWalletPlan, BUFFER_FORWARDER_FUNDING_YOCTO } from '../agent/buffer-forwarder-wallet-plan.mjs';
import { assertSvalinBatchMatchesReview } from '../agent/svalin-setup-plan.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE } from '../scripts/circle-testnet-setup.mjs';

const NOW = 1_800_000_000_000, OWNER = 'buyer.testnet', VAULT = 'vault.buyer.testnet', ADAPTER = 'buffer.buyer.testnet';
const pk = () => String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
function fixture({ custom = false } = {}) {
  const ownerKey = pk(), vaultKey = pk(), forwarderKey = pk();
  const spend = buildBufferWalletSpendingPlan({ owner: OWNER, vault: VAULT, adapter: ADAPTER, policy_id: 'research',
    vault_agent_public_key: vaultKey, forwarder_agent_public_key: forwarderKey, per_tx_cap_atoms: '20000000',
    daily_cap_atoms: '20000000', vault_agent_gas_allowance_yocto: '250000000000000000000000',
    forwarder_agent_gas_allowance_yocto: '250000000000000000000000' }).review;
  const terms = { owner: OWNER, vault: VAULT, adapter: ADAPTER, forwarder_agent_public_key: forwarderKey,
    vault_agent_public_key: vaultKey, policy_id: 'research', intent_id: 'buffer-job-1', amount: custom ? '5000000' : '20000000',
    expires_at_ms: NOW + 1_000_000, native_return_cap: '1000000000000000000000000', native_reserve: '1000000000000000000000000',
    api_order_id: '123e4567-e89b-12d3-a456-426614174000', onchain_order_id: custom ? 'q-123456789abc' : 'o-123456789abc',
    sku: custom ? 'custom-brief' : 'weekly-market-brief', brief_sha256: crypto.createHash('sha256').update('synthetic brief').digest('hex') };
  return { terms, spendingReview: spend, trustedSpendingReviewHash: spend.review_sha256, trustedOwnerPublicKey: ownerKey,
    registrationDepositYocto: '1250000000000000000000', nowMs: NOW };
}

test('unsigned forwarder deployment, registration and owner-only intent bind exact terms and caps', async () => {
  for (const options of [{}, { custom: true }]) {
    const f = fixture(options), plan = await buildBufferForwarderWalletPlan(f), { review, batches } = plan;
    assert.equal(review.status, 'UNSIGNED_OFFLINE_PLAN_ONLY'); assert.equal(review.network, 'testnet');
    assert.equal(review.signing_or_broadcast_authorized, false); assert.equal(review.wallet_approval_obtained, false);
    assert.equal(review.independently_fulfilled, false); assert.equal(review.order_terms.amount, f.terms.amount);
    assert.equal(review.native_funding_yocto, BUFFER_FORWARDER_FUNDING_YOCTO);
    assert.deepEqual(batches.map(x => x.id), ['create_buffer_forwarder', 'register_buffer_forwarder_circle', 'pin_buffer_exact_intent']);
    assert.deepEqual(review.stages[0].actions.map(x => x.type), ['create_account', 'transfer', 'deploy_contract']);
    assert.equal(batches[0].signerId, OWNER); assert.equal(batches[0].receiverId, ADAPTER);
    assert.equal(batches[1].receiverId, CIRCLE); assert.equal(review.stages[1].actions[0].deposit_yocto, f.registrationDepositYocto);
    const intent = review.stages[2].actions[0];
    assert.equal(batches[2].receiverId, VAULT); assert.equal(intent.method, 'set_exact_ft_intent');
    assert.equal(intent.deposit_yocto, '1'); assert.equal(intent.args.payee, ADAPTER); assert.equal(intent.args.expected_token, CIRCLE);
    assert.equal(intent.args.amount, f.terms.amount); assert.equal(intent.args.review_hash, review.forwarder_review_sha256);
    assert.equal(intent.args.agent_public_key, f.terms.vault_agent_public_key);
    assert.equal(review.forwarder_wasm_sha256, crypto.createHash('sha256').update(plan.forwarder_wasm).digest('hex'));
    for (let i = 0; i < batches.length; i++) assert.equal(assertSvalinBatchMatchesReview(batches[i], review.stages[i]), true);
    const tampered = structuredClone(review.stages[2]); tampered.actions[0].args.payee = 'thief.testnet';
    assert.throws(() => assertSvalinBatchMatchesReview(batches[2], tampered), /does not match/);
    assert.doesNotMatch(JSON.stringify(review), /accessToken|private_key|signed_transaction/);
  }
});

test('wrong accounts, agents, terms, limits, registration or expiry fail closed', async () => {
  const f = fixture();
  const changes = [
    x => { x.terms.owner = 'other.testnet'; }, x => { x.terms.vault = 'vault.other.testnet'; },
    x => { x.terms.adapter = 'other.buyer.testnet'; }, x => { x.terms.policy_id = 'other'; },
    x => { x.terms.vault_agent_public_key = pk(); }, x => { x.terms.forwarder_agent_public_key = pk(); },
    x => { x.terms.amount = '20000001'; }, x => { x.terms.amount = '19999999'; },
    x => { x.terms.native_reserve = '999999999999999999999999'; }, x => { x.terms.native_reserve = '2000000000000000000000001'; },
    x => { x.terms.native_return_cap = '2000000000000000000000001'; }, x => { x.registrationDepositYocto = '0'; },
    x => { x.registrationDepositYocto = '10000000000000000000001'; }, x => { x.terms.expires_at_ms = NOW; },
    x => { x.trustedSpendingReviewHash = '0'.repeat(64); }, x => { x.spendingReview.per_tx_cap_atoms = '1'; },
    x => { x.trustedOwnerPublicKey = x.terms.vault_agent_public_key; }, x => { x.terms.sku = 'other'; },
  ];
  for (const change of changes) { const next = structuredClone(f); change(next); await assert.rejects(buildBufferForwarderWalletPlan(next)); }
  const custom = fixture({ custom: true }); custom.terms.amount = '4999999'; await assert.rejects(buildBufferForwarderWalletPlan(custom));
});

test('rebuilding the same public terms is deterministic and never creates a quote', async () => {
  const f = fixture(), first = await buildBufferForwarderWalletPlan(f), second = await buildBufferForwarderWalletPlan(f);
  assert.equal(first.review.review_sha256, second.review.review_sha256);
  assert.equal(first.forwarder_wasm.toString('hex'), second.forwarder_wasm.toString('hex'));
  assert.equal(first.review.forwarder_wasm_near_hash, second.review.forwarder_wasm_near_hash);
});
