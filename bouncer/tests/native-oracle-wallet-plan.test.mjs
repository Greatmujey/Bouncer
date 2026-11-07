import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import nearApi from 'near-api-js';
import { buildNativeOracleWalletPlan, assertNativeOracleBatchMatchesReview, NATIVE_ORACLE_VAULT_FUNDING,
  NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE, NATIVE_ORACLE_V9_SHA256, NATIVE_ORACLE_METHOD } from '../agent/native-oracle-wallet-plan.mjs';
import { ORACLE_TESTNET_PROJECT } from '../agent/oracle-outlayer.mjs';
import { V3_OWNER } from '../agent/v3-faucet-github-fence.mjs';

const wasm = fs.readFileSync(new URL('../../bouncer.wasm', import.meta.url));
const publicKey = nearApi.KeyPair.fromRandom('ed25519').getPublicKey().toString();
const terms = () => ({ owner: 'buyer.testnet', vault: 'native.buyer.testnet', policy_id: 'price', agent_public_key: publicKey,
  per_tx_cap_yocto: '100000000000000000000000', daily_cap_yocto: '100000000000000000000000',
  vault_deposit_yocto: '100000000000000000000000', agent_gas_allowance_yocto: NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE });

test('unsigned native plan pins owner, artifact, provider, project, caps, one-yocto changes and one-method key', () => {
  const { review, batches } = buildNativeOracleWalletPlan({ terms: terms(), wasmBytes: wasm });
  assert.equal(review.status, 'UNSIGNED_OFFLINE_PLAN_ONLY'); assert.equal(review.signing_authorized, false);
  assert.equal(review.transaction_sent, false); assert.equal(review.independent_delivery_verified, false);
  assert.equal(review.artifact.sha256, NATIVE_ORACLE_V9_SHA256); assert.equal(review.vault_storage_funding_yocto, NATIVE_ORACLE_VAULT_FUNDING);
  assert.deepEqual(review.project, ORACLE_TESTNET_PROJECT);
  assert.deepEqual(review.stages.map(s => s.id), ['create_keyless_native_vault', 'configure_native_oracle_policy', 'fund_native_vault', 'install_native_oracle_agent']);
  assert.deepEqual(review.stages[0].actions.map(a => a.type), ['create_account', 'transfer', 'deploy_contract', 'function_call']);
  assert.equal(review.stages[0].actions[3].method, 'new');
  assert.deepEqual(review.stages[1].actions.map(a => a.method), ['set_policy', 'allow_payee', 'set_outlayer_native_project', 'grant_agent_key']);
  assert(review.stages[1].actions.every(a => a.deposit_yocto === '1'));
  assert.equal(review.stages[1].actions[0].args.token, 'native');
  assert.equal(review.stages[1].actions[1].args.payee, 'outlayer.testnet');
  assert.equal(review.stages[2].actions[0].method, 'deposit_native');
  assert.deepEqual(review.stages[3].actions[0].method_names, [NATIVE_ORACLE_METHOD]);
  assert.equal(review.stages[3].actions[0].receiver_id, terms().vault);
  for (let i = 0; i < batches.length; i++) assert.equal(assertNativeOracleBatchMatchesReview(batches[i], review.stages[i]), true);
  assert(!JSON.stringify(review).includes('private_key'));
  assert(!JSON.stringify(review).includes('signed_tx'));
});

test('mutations of reviewed destination, actions, caps, route, key permission or bytecode cannot pass', () => {
  const mutate = [
    b => { b[0].receiverId = 'evil.buyer.testnet'; },
    b => { b[0].actions[1].transfer.deposit += 1n; },
    b => { b[0].actions[2].deployContract.code[9] ^= 1; },
    b => { b[1].actions[0].functionCall.deposit = 0n; },
    b => { b[1].actions[1].functionCall.args = Buffer.from('{"policy_id":"price","payee":"evil.testnet"}'); },
    b => { b[1].actions[2].functionCall.args = Buffer.from('{}'); },
    b => { b[2].actions[0].functionCall.deposit += 1n; },
    b => { b[3].actions[0].addKey.accessKey.permission.functionCall.methodNames.push('set_policy'); },
  ];
  for (const change of mutate) {
    const { review, batches } = buildNativeOracleWalletPlan({ terms: terms(), wasmBytes: wasm });
    const retained = structuredClone(review.stages); change(batches);
    assert(batches.some((b, i) => { try { assertNativeOracleBatchMatchesReview(b, retained[i]); return false; } catch { return true; } }));
  }
});

test('rejects wrong network, unrelated child, unsafe limits, malformed keys, unresolved V3 and wrong bytes', () => {
  const mutations = [
    r => { r.owner = 'buyer.near'; }, r => { r.vault = 'native.other.testnet'; },
    r => { r.vault = 'a.b.buyer.testnet'; }, r => { r.owner = V3_OWNER; r.vault = `native.${V3_OWNER}`; },
    r => { r.policy_id = 'x/'.repeat(50); }, r => { r.agent_public_key = 'ed25519:not-a-key'; },
    r => { r.per_tx_cap_yocto = '0'; }, r => { r.per_tx_cap_yocto = '100000000000000000000001'; },
    r => { r.daily_cap_yocto = '0'; }, r => { r.daily_cap_yocto = '1'; },
    r => { r.vault_deposit_yocto = '1'; }, r => { r.agent_gas_allowance_yocto = '1000000000000000000000001'; },
    r => { r.extra = true; },
  ];
  for (const mutate of mutations) { const r = terms(); mutate(r); assert.throws(() => buildNativeOracleWalletPlan({ terms: r, wasmBytes: wasm })); }
  const r = terms(); Object.defineProperty(r, 'owner', { get: () => 'buyer.testnet' });
  assert.throws(() => buildNativeOracleWalletPlan({ terms: r, wasmBytes: wasm }), /exactly/);
  const changed = Buffer.from(wasm); changed[100] ^= 1;
  assert.throws(() => buildNativeOracleWalletPlan({ terms: terms(), wasmBytes: changed }), /artifact/);
});
