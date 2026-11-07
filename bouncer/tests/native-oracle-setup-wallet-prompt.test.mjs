import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { webcrypto, createHash, randomBytes } from 'node:crypto';
import nearApi from 'near-api-js';
import nearConnect from '@hot-labs/near-connect';
import { IDBFactory } from 'fake-indexeddb';
import { buildNativeOracleWalletPlan, NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } from '../agent/native-oracle-wallet-plan.mjs';
import { prepareNativeOracleSetupWalletPrompt } from '../web-src/native-oracle-setup-wallet-prompt.mjs';
import { openNativeOracleDeviceKey } from '../web-src/native-oracle-device-key.mjs';

const wasm = fs.readFileSync(new URL('../../bouncer.wasm', import.meta.url));
const key = () => String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const hash = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n));
const OWNER = 'buyer.testnet', VAULT = 'native.buyer.testnet', time = 1_800_000_000_000, origin = 'https://bouncer.example';
function fixture(i = 0, agent = key()) {
  const ownerKey = key(), plan = buildNativeOracleWalletPlan({ wasmBytes: wasm, terms: { owner: OWNER, vault: VAULT,
    policy_id: 'price', agent_public_key: agent, per_tx_cap_yocto: '100000000000000000000000',
    daily_cap_yocto: '100000000000000000000000', vault_deposit_yocto: '100000000000000000000000',
    agent_gas_allowance_yocto: NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } });
  const review = plan.review, identity = { owner: OWNER, owner_public_key: ownerKey, operation_id: randomBytes(16).toString('hex'),
    review_sha256: review.review_sha256, stages: review.stages.map(s => ({ stage_id: s.id, action_commitment_sha256: s.action_commitment_sha256 })) };
  const deviceKey = { status: 'LOCAL_DEVICE_KEY_AVAILABLE', origin, owner: OWNER, vault: VAULT, public_key: agent,
    expected_public_key_matched: true, private_key_exportable: false, local_storage_only: true, signing_authorized: false };
  const claim = { status: 'PROMPT_CLAIMED_NO_HASH', independently_witnessed: true, do_not_retry: true, execution_authorized: false,
    owner: OWNER, operation_id: identity.operation_id, review_sha256: review.review_sha256, stage_id: review.stages[i].id,
    action_commitment_sha256: review.stages[i].action_commitment_sha256, witness_head: 'c'.repeat(40),
    preflight_block_hash: hash(9), preflight_checked_at: new Date(time).toISOString() };
  const calls = [], wallet = { manifest: { features: { signAndSendTransaction: true } }, async signAndSendTransaction(params) {
    calls.push(params); return { transaction: { hash: hash(4) }, transaction_outcome: { id: hash(4) } };
  } };
  return { plan, review, identity, deviceKey, claim, calls, wallet,
    args: { wallet, review, identity, deviceKey, stageId: review.stages[i].id, wasmBytes: wasm,
      location: { origin }, isTopLevel: true, crypto: webcrypto, now: () => time } };
}
function reorder(x) {
  if (Array.isArray(x)) return x.map(reorder);
  if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).reverse().map(k => [k, reorder(x[k])]));
  return x;
}

test('all four exact reviewed stages convert into one explicit wallet call apiece, without implying FINAL', async () => {
  for (let i = 0; i < 4; i++) {
    const f = fixture(i), prompt = await prepareNativeOracleSetupWalletPrompt(f.args);
    assert.equal(f.calls.length, 0); assert.equal(prompt.stage_id, f.review.stages[i].id);
    const result = await prompt.invoke(f.claim);
    assert.equal(result.status, 'ORIGINAL_HASH_RETURNED'); assert.equal(result.original_hash, hash(4));
    assert.equal(result.final_execution_verified, false); assert.equal(result.independent_delivery_verified, false);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].network, 'testnet'); assert.equal(f.calls[0].signerId, OWNER);
    assert.equal(f.calls[0].receiverId, i === 3 ? OWNER : VAULT);
    const expected = nearConnect.nearActionsToConnectorActions(f.plan.batches[i].actions);
    if (i === 0) expected[2].params.code = new Uint8Array(expected[2].params.code);
    assert.deepEqual(f.calls[0].actions, expected);
    if (i === 0) {
      assert.equal(f.calls[0].actions[1].params.deposit, '5400000000000000000000000');
      assert.equal(createHash('sha256').update(f.calls[0].actions[2].params.code).digest('hex'), f.review.artifact.sha256);
    }
    if (i === 1) assert.deepEqual(f.calls[0].actions.map(a => a.params.deposit), ['1','1','1','1']);
    if (i === 2) assert.equal(f.calls[0].actions[0].params.deposit, '100000000000000000000000');
    if (i === 3) assert.deepEqual(f.calls[0].actions[0].params.accessKey.permission.methodNames, ['execute_outlayer_native_project']);
    await assert.rejects(prompt.invoke(f.claim), /NATIVE_SETUP_PROMPT_UNAVAILABLE/);
    const recreated = await prepareNativeOracleSetupWalletPrompt(f.args);
    await assert.rejects(recreated.invoke(f.claim), /NATIVE_SETUP_PROMPT_UNAVAILABLE/);
    assert.equal(f.calls.length, 1);
  }
});

test('canonical review survives JSONB object-key reordering without changing the digest', async () => {
  const f = fixture(2), review = reorder(f.review), identity = reorder(f.identity), deviceKey = reorder(f.deviceKey);
  const prompt = await prepareNativeOracleSetupWalletPrompt({ ...f.args, review, identity, deviceKey });
  await prompt.invoke(f.claim); assert.equal(f.calls.length, 1);
});

test('changed action, cap, artifact, owner, device binding or origin fails before any wallet prompt', async () => {
  const f = fixture(0);
  for (const change of [
    r => { r.owner = 'other.testnet'; }, r => { r.vault = 'other.buyer.testnet'; }, r => { r.asset = 'usdc'; },
    r => { r.vault_storage_funding_yocto = '9999999999999999999999999'; },
    r => { r.per_tx_cap_yocto = '100000000000000000000001'; }, r => { r.payee = 'evil.testnet'; },
    r => { r.project.input_data = '{}'; }, r => { r.stages[1].actions[0].deposit_yocto = '0'; },
    r => { r.stages[3].actions[0].method_names.push('set_policy'); }, r => { r.artifact.sha256 = '0'.repeat(64); },
    r => { r.review_sha256 = 'f'.repeat(64); }, r => { r.extra = 'not allowed'; },
  ]) { const review = structuredClone(f.review); change(review); await assert.rejects(prepareNativeOracleSetupWalletPrompt({ ...f.args, review })); }
  // A malicious/buggy server cannot make unsafe actions acceptable merely by
  // recomputing the review digest and matching identity.
  for (const change of [r => { r.per_tx_cap_yocto = '100000000000000000000001'; },
    r => { r.stages[3].actions[0].method_names = ['set_policy']; }, r => { r.project.input_data = '{}'; }]) {
    const review = structuredClone(f.review), identity = structuredClone(f.identity); change(review);
    const { review_sha256: _ignored, ...unsigned } = review;
    review.review_sha256 = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
    identity.review_sha256 = review.review_sha256;
    await assert.rejects(prepareNativeOracleSetupWalletPrompt({ ...f.args, review, identity }));
  }
  for (const patch of [
    { deviceKey: { ...f.deviceKey, expected_public_key_matched: false } }, { deviceKey: { ...f.deviceKey, public_key: key() } },
    { deviceKey: { ...f.deviceKey, private_key_exportable: true } }, { deviceKey: { ...f.deviceKey, origin: 'https://other.example' } },
    { wasmBytes: new Uint8Array(wasm.length) }, { location: { origin: 'http://bouncer.example' } },
    { location: { origin: 'https://example.github.io' } }, { isTopLevel: false },
    { wallet: { manifest: { features: {} }, signAndSendTransaction() {} } },
  ]) await assert.rejects(prepareNativeOracleSetupWalletPrompt({ ...f.args, ...patch }));
  assert.equal(f.calls.length, 0);
});

test('missing witness, mismatched claim, stale preflight or inconsistent hash never opens a second prompt', async () => {
  const f = fixture(2), prompt = await prepareNativeOracleSetupWalletPrompt(f.args);
  for (const change of [{ independently_witnessed: false }, { witness_head: 'bad' }, { stage_id: f.review.stages[3].id },
    { operation_id: 'f'.repeat(32) }, { action_commitment_sha256: 'f'.repeat(64) },
    { preflight_checked_at: new Date(time - 5001).toISOString() }, { preflight_block_hash: 'wrong' }]) {
    await assert.rejects(prompt.invoke({ ...f.claim, ...change }));
  }
  assert.equal(f.calls.length, 0);
  for (const mode of ['throw','missing','conflicting']) {
    const g = fixture(2); let invoked = 0;
    g.wallet.signAndSendTransaction = async () => { invoked++; if (mode === 'throw') throw Error('unknown');
      return mode === 'missing' ? {} : { transaction: { hash: hash(2) }, transaction_outcome: { id: hash(3) } }; };
    const adapter = await prepareNativeOracleSetupWalletPrompt(g.args), result = await adapter.invoke(g.claim);
    assert.equal(result.status, 'WALLET_RESULT_UNKNOWN'); assert.equal(result.original_hash, null); assert.equal(result.do_not_retry, true);
    await assert.rejects(adapter.invoke(g.claim)); assert.equal(invoked, 1);
  }
});


test('concurrent adapters in one page cannot invoke the same claimed stage twice', async () => {
  const f = fixture(1);
  const [first, second] = await Promise.all([prepareNativeOracleSetupWalletPrompt(f.args), prepareNativeOracleSetupWalletPrompt(f.args)]);
  const results = await Promise.allSettled([first.invoke(f.claim), second.invoke(f.claim)]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.filter(x => x.status === 'rejected').length, 1);
  assert.equal(f.calls.length, 1); // cross-reload and cross-device exclusion still requires the durable backend fence
});


test('real non-extractable WebCrypto key metadata composes with the reviewed prompt in a simulated browser store', async () => {
  const device = await openNativeOracleDeviceKey({ indexedDB: new IDBFactory(), storage: { persisted: async () => true },
    crypto: webcrypto, origin, isTopLevel: true });
  try {
    const created = await device.create({ owner: OWNER, vault: VAULT });
    const f = fixture(0, created.public_key);
    await assert.rejects(prepareNativeOracleSetupWalletPrompt({ ...f.args, deviceKey: created }), /NATIVE_SETUP_PROMPT_UNAVAILABLE/);
    const retained = await device.inspect({ owner: OWNER, vault: VAULT, expected_public_key: f.review.agent_public_key });
    const prompt = await prepareNativeOracleSetupWalletPrompt({ ...f.args, deviceKey: retained });
    assert.equal((await prompt.invoke(f.claim)).status, 'ORIGINAL_HASH_RETURNED');
    assert.equal(f.calls.length, 1); assert.equal(retained.private_key_exportable, false);
    assert.equal(retained.independent_backup_verified, false); // simulated IndexedDB is not a durable backup or real phone
  } finally { device.close(); }
});
