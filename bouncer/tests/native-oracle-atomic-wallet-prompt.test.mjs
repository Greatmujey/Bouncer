import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { webcrypto, createHash, randomBytes } from 'node:crypto';
import nearApi from 'near-api-js';
import nearConnect from '@hot-labs/near-connect';
import { NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } from '../agent/native-oracle-wallet-plan.mjs';
import { buildAtomicNativeOracleWalletPlan } from '../agent/native-oracle-atomic-wallet.mjs';
import { prepareAtomicNativeOracleSetupWalletPrompt, prepareNativeOracleSetupWalletPrompt,
  verifyAtomicNativeOracleRetainedReview } from '../web-src/native-oracle-setup-wallet-prompt.mjs';

const wasm = fs.readFileSync(new URL('../../bouncer.wasm', import.meta.url));
const key = () => String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const hash = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n));
const OWNER = 'buyer.testnet', VAULT = 'native.buyer.testnet', time = 1_800_000_000_000, origin = 'https://bouncer.example';
function fixture(index = 0) {
  const ownerKey = key(), agentKey = key(), plan = buildAtomicNativeOracleWalletPlan({ wasmBytes: wasm, trustedOwnerPublicKey: ownerKey,
    terms: { owner: OWNER, vault: VAULT, policy_id: 'price', agent_public_key: agentKey,
      per_tx_cap_yocto: '100000000000000000000000', daily_cap_yocto: '100000000000000000000000',
      vault_deposit_yocto: '100000000000000000000000', agent_gas_allowance_yocto: NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } });
  const review = plan.review, identity = { owner: OWNER, owner_public_key: ownerKey, operation_id: randomBytes(16).toString('hex'),
    review_sha256: review.review_sha256, stages: review.stages.map(s => ({ stage_id: s.id, action_commitment_sha256: s.action_commitment_sha256 })) };
  const deviceKey = { status: 'LOCAL_DEVICE_KEY_AVAILABLE', origin, owner: OWNER, vault: VAULT, public_key: agentKey,
    expected_public_key_matched: true, private_key_exportable: false, local_storage_only: true, signing_authorized: false };
  const claim = { status: 'PROMPT_CLAIMED_NO_HASH', independently_witnessed: true, do_not_retry: true, execution_authorized: false,
    owner: OWNER, operation_id: identity.operation_id, review_sha256: review.review_sha256, stage_id: review.stages[index].id,
    action_commitment_sha256: review.stages[index].action_commitment_sha256, witness_head: 'c'.repeat(40),
    preflight_block_hash: hash(9), preflight_checked_at: new Date(time).toISOString() };
  const calls = [], wallet = { manifest: { features: { signAndSendTransaction: true } }, async signAndSendTransaction(params) {
    calls.push(params); return { transaction: { hash: hash(4) }, transaction_outcome: { id: hash(4) } };
  } };
  return { plan, review, identity, deviceKey, claim, calls, wallet,
    args: { wallet, review, identity, deviceKey, stageId: review.stages[index].id, wasmBytes: wasm,
      location: { origin }, isTopLevel: true, crypto: webcrypto, now: () => time } };
}
function reorder(x) {
  if (Array.isArray(x)) return x.map(reorder);
  if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).reverse().map(k => [k, reorder(x[k])]));
  return x;
}

test('atomic stages map exactly to connector actions and require two separate fenced wallet calls', async () => {
  for (let i = 0; i < 2; i++) {
    const f = fixture(i), prompt = await prepareAtomicNativeOracleSetupWalletPrompt(f.args);
    assert.equal(f.calls.length, 0); assert.equal(prompt.stage_id, f.review.stages[i].id);
    const result = await prompt.invoke(f.claim);
    assert.equal(result.status, 'ORIGINAL_HASH_RETURNED'); assert.equal(result.original_hash, hash(4));
    assert.equal(result.final_execution_verified, false); assert.equal(result.independent_delivery_verified, false);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].network, 'testnet'); assert.equal(f.calls[0].signerId, OWNER);
    assert.equal(f.calls[0].receiverId, i === 1 ? OWNER : VAULT);
    const expected = nearConnect.nearActionsToConnectorActions(f.plan.batches[i].actions);
    if (i === 0) expected[2].params.code = new Uint8Array(expected[2].params.code);
    assert.deepEqual(f.calls[0].actions, expected);
    if (i === 0) {
      assert.equal(f.calls[0].actions.length, 9); assert.equal(f.calls[0].actions[1].params.deposit, '5400000000000000000000000');
      assert.equal(createHash('sha256').update(f.calls[0].actions[2].params.code).digest('hex'), f.review.artifact.sha256);
      assert.deepEqual(f.calls[0].actions.slice(4, 8).map(a => a.params.deposit), ['1', '1', '1', '1']);
      assert.equal(f.calls[0].actions[8].params.deposit, '100000000000000000000000');
    } else assert.deepEqual(f.calls[0].actions[0].params.accessKey.permission.methodNames, ['execute_outlayer_native_project']);
    await assert.rejects(prompt.invoke(f.claim));
    const recreated = await prepareAtomicNativeOracleSetupWalletPrompt(f.args);
    await assert.rejects(recreated.invoke(f.claim)); assert.equal(f.calls.length, 1);
  }
});

test('Meteor oversized deploy is blocked before a claim or wallet call; later setup preparation is unchanged', async () => {
  const first = fixture(0);
  first.wallet.manifest.id = 'meteor-wallet';
  await assert.rejects(prepareAtomicNativeOracleSetupWalletPrompt(first.args), error => error.code === 'NATIVE_METEOR_DEPLOY_TOO_LARGE');
  assert.equal(first.calls.length, 0);
  const install = fixture(1);
  install.wallet.manifest.id = 'meteor-wallet';
  const prompt = await prepareAtomicNativeOracleSetupWalletPrompt(install.args);
  assert.equal(install.calls.length, 0);
  assert.equal(prompt.stage_id, 'install_native_oracle_agent');
});

test('atomic retained review survives key reordering but is not accepted by the four-stage adapter', async () => {
  const f = fixture(0), review = reorder(f.review), identity = reorder(f.identity), deviceKey = reorder(f.deviceKey);
  const recovered = await verifyAtomicNativeOracleRetainedReview({ review, identity, crypto: webcrypto });
  assert.equal(recovered.owner_public_key, identity.owner_public_key);
  await assert.rejects(prepareNativeOracleSetupWalletPrompt({ ...f.args, review, identity, deviceKey }));
  const prompt = await prepareAtomicNativeOracleSetupWalletPrompt({ ...f.args, review, identity, deviceKey });
  await prompt.invoke(f.claim); assert.equal(f.calls.length, 1);
});

test('changed limits, route, code, key, actions or disclosures fail even with a recomputed review digest', async () => {
  const f = fixture(0);
  for (const change of [
    r => { r.owner = 'other.testnet'; }, r => { r.owner_public_key = key(); }, r => { r.vault = 'other.buyer.testnet'; },
    r => { r.vault_storage_funding_yocto = '9999999999999999999999999'; }, r => { r.per_tx_cap_yocto = '100000000000000000000001'; },
    r => { r.payee = 'evil.testnet'; }, r => { r.project.input_data = '{}'; },
    r => { r.stages[0].actions[4].deposit_yocto = '0'; }, r => { r.stages[0].actions[8].deposit_yocto = '1'; },
    r => { r.stages[1].actions[0].method_names.push('set_policy'); }, r => { r.artifact.sha256 = '0'.repeat(64); },
    r => { r.limitations[2] = 'Storage is always refundable.'; }, r => { r.extra = 'not allowed'; },
  ]) {
    const review = structuredClone(f.review), identity = structuredClone(f.identity); change(review);
    const { review_sha256: _ignored, ...unsigned } = review;
    review.review_sha256 = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
    identity.review_sha256 = review.review_sha256;
    await assert.rejects(prepareAtomicNativeOracleSetupWalletPrompt({ ...f.args, review, identity }));
  }
  for (const patch of [
    { deviceKey: { ...f.deviceKey, expected_public_key_matched: false } }, { deviceKey: { ...f.deviceKey, public_key: key() } },
    { deviceKey: { ...f.deviceKey, private_key_exportable: true } }, { wasmBytes: new Uint8Array(wasm.length) },
    { location: { origin: 'http://bouncer.example' } }, { isTopLevel: false },
    { wallet: { manifest: { features: {} }, signAndSendTransaction() {} } },
  ]) await assert.rejects(prepareAtomicNativeOracleSetupWalletPrompt({ ...f.args, ...patch }));
  assert.equal(f.calls.length, 0);
});

test('stale or unwitnessed claims and uncertain wallet responses never cause another prompt', async () => {
  const f = fixture(1), prompt = await prepareAtomicNativeOracleSetupWalletPrompt(f.args);
  for (const patch of [{ independently_witnessed: false }, { stage_id: f.review.stages[0].id },
    { action_commitment_sha256: 'f'.repeat(64) }, { witness_head: 'bad' },
    { preflight_checked_at: new Date(time - 5001).toISOString() }, { preflight_block_hash: 'wrong' }]) {
    await assert.rejects(prompt.invoke({ ...f.claim, ...patch }));
  }
  assert.equal(f.calls.length, 0);
  for (const mode of ['throw', 'missing', 'conflicting']) {
    const g = fixture(1); let invoked = 0;
    g.wallet.signAndSendTransaction = async () => { invoked++; if (mode === 'throw') throw Error('unknown');
      return mode === 'missing' ? {} : { transaction: { hash: hash(2) }, transaction_outcome: { id: hash(3) } }; };
    const adapter = await prepareAtomicNativeOracleSetupWalletPrompt(g.args), result = await adapter.invoke(g.claim);
    assert.equal(result.status, 'WALLET_RESULT_UNKNOWN'); assert.equal(result.original_hash, null); assert.equal(result.do_not_retry, true);
    await assert.rejects(adapter.invoke(g.claim)); assert.equal(invoked, 1);
  }
});

test('same-page concurrency cannot invoke the same atomic claim twice', async () => {
  const f = fixture(0), [first, second] = await Promise.all([
    prepareAtomicNativeOracleSetupWalletPrompt(f.args), prepareAtomicNativeOracleSetupWalletPrompt(f.args),
  ]);
  const results = await Promise.allSettled([first.invoke(f.claim), second.invoke(f.claim)]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.filter(x => x.status === 'rejected').length, 1);
  assert.equal(f.calls.length, 1); // across reloads/devices a real independent fence is still required
});
