import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import { assertReviewedVrf2Wasm, assertVrf2Snapshot, readVrf2Snapshot, writeFreshEvidence } from '../scripts/paid-vrf2-once.mjs';
import { assertVrf2Review, assertOwnerPolicyCalls } from '../scripts/inspect-paid-vrf2.mjs';

const WASM = '835f0baa51d08ddf3af6812df0caefb93283480735a63e3d382073e04fbaf8ee';
const VERSION = '2d406ed8005a422c38aec0616990989970e2c444c1386d4f09d54cce59468fb9';
const KEY = 'c0c5aeae1688c2f7cc2350aae1ee3ce96eddc0de84d678db873de48268f8cfa8';
const MAX = '100000000000000000000000';
function fixture() {
  const keys = Array.from({ length: 4 }, () => nearApi.KeyPair.fromRandom('ed25519').getPublicKey().toString());
  const identity = { vault: 'bouncer-vrf2-abcdef0123.testnet', owner: 'owner-vrf2-abcdef0123.testnet',
    vault_public_key: keys[0], owner_public_key: keys[1], funding_public_key: keys[2], project_public_key: keys[3],
    seed: `bouncer_vrf2_${'a'.repeat(32)}`, vault_wasm_sha256: WASM,
    vault_code_hash: nearApi.utils.serialize.base_encode(Buffer.from(WASM, 'hex')),
    purpose: 'fresh-testnet-fake-token-independent-vrf-diagnostic' };
  const funding = { id: 'provider-prepaid-funding', contract_id: identity.vault, owner_account_id: identity.owner,
    policy_id: 'provider-funding', payee: 'outlayer.testnet', token: 'usdc.fakes.testnet', amount: '10000',
    msg: '{"action":"deposit_balance"}', policy_revision: 1, route_revision: 1 };
  const project = { id: 'independent-vrf-diagnostic', contract_id: identity.vault, owner_account_id: identity.owner,
    native_policy_id: 'project-native', amount: MAX, expected_author: 'zavodil.testnet', expected_vrf_pubkey: KEY,
    route: { project: { project_id: 'connectors.outlayer.testnet/connector-probe', version_key: VERSION,
      usd_policy_id: 'project-token', token: 'usdc.fakes.testnet', attached_usd: '10000',
      input_data: JSON.stringify({ operation: 'vrf', seed: identity.seed }), max_instructions: 1_000_000_000,
      max_memory_mb: 256, max_execution_seconds: 60 }, route_revision: 1, native_policy_revision: 1, usd_policy_revision: 1,
      native_payee_revision: 1, usd_payee_revision: 1, active: true } };
  return { identity, funding, project };
}
const before = { block_hash: 'final-block', provider_prepaid: '0', vault_ft: '10000', vault_ledger: '10000',
  recorded_prepaid: '0', funding_spent: '0', project_token_spent: '0', project_native_spent: '0' };
const funded = { block_hash: 'final-block', provider_prepaid: '10000', vault_ft: '0', vault_ledger: '0',
  recorded_prepaid: '10000', funding_spent: '10000', project_token_spent: '0', project_native_spent: '0' };
const fulfilled = { block_hash: 'final-block', provider_prepaid: '0', vault_ft: '0', vault_ledger: '0',
  recorded_prepaid: '0', funding_spent: '10000', project_token_spent: '10000', project_native_spent: MAX };

test('fresh VRF2 preflight requires the exact reviewed V9 binary', () => {
  const wasm = fs.readFileSync('../bouncer.wasm');
  assert.doesNotThrow(() => assertReviewedVrf2Wasm(wasm));
  const modified = Buffer.from(wasm); modified[modified.length - 1] ^= 1;
  assert.throws(() => assertReviewedVrf2Wasm(modified), /hash or marker changed/);
  assert.throws(() => assertReviewedVrf2Wasm(Buffer.alloc(8)), /hash or marker changed/);
});

test('same-block snapshots require exact custody, budget and prepaid reconciliation', async () => {
  for (const [stage, value] of [['before', before], ['funded', funded], ['fulfilled', fulfilled]]) {
    assert.doesNotThrow(() => assertVrf2Snapshot(stage, value));
    for (const field of ['provider_prepaid', 'vault_ft', 'vault_ledger', 'recorded_prepaid', 'funding_spent', 'project_token_spent', 'project_native_spent']) {
      assert.throws(() => assertVrf2Snapshot(stage, { ...value, [field]: '999999' }), /did not reconcile/);
    }
  }
  const seen = [];
  const provider = { async block() { return { header: { hash: 'final-block' } }; }, async callFunction(id, method, args, opts) {
    seen.push(opts.blockId); if (method === 'get_user_stablecoin_balance') return before.provider_prepaid;
    if (method === 'ft_balance_of') return before.vault_ft;
    if (method === 'vault_balance') return before.vault_ledger;
    if (method === 'outlayer_prepaid_balance') return before.recorded_prepaid;
    if (method === 'daily_spent') return args.policy_id === 'provider-funding' ? before.funding_spent :
      args.policy_id === 'project-token' ? before.project_token_spent : before.project_native_spent;
    throw new Error('unexpected view');
  } };
  assert.deepEqual(await readVrf2Snapshot(provider, 'vault.testnet'), before);
  assert.deepEqual(seen, Array(7).fill('final-block'));
});

test('inspection rejects substituted accounts, keys, seed, provider, token or fee', () => {
  const f = fixture(); assert.doesNotThrow(() => assertVrf2Review(f.identity, f.funding, f.project));
  for (const mutate of [
    f => { f.identity.vault = 'bouncer-vrf2-0000000000.testnet'; },
    f => { f.identity.funding_public_key = f.identity.project_public_key; },
    f => { f.identity.seed = `bouncer_vrf2_${'b'.repeat(32)}`; },
    f => { f.funding.payee = 'other.testnet'; }, f => { f.funding.token = 'circle.testnet'; },
    f => { f.funding.amount = '10001'; }, f => { f.project.amount = '1000'; },
    f => { f.project.expected_vrf_pubkey = '00'.repeat(32); },
    f => { f.project.route.project.version_key = '00'.repeat(32); },
  ]) { const changed = fixture(); mutate(changed); assert.throws(() => assertVrf2Review(changed.identity, changed.funding, changed.project)); }
});

test('inspection verifies each exact one-yocto owner policy action', () => {
  const expected = [{ method: 'set_policy', args: { policy_id: 'p', token: 'token.testnet', per_tx_cap: '100', daily_cap: '100' } },
    { method: 'allow_payee', args: { policy_id: 'p', payee: 'outlayer.testnet' } }];
  const result = { transaction: { actions: expected.map(({ method, args }) => ({ FunctionCall: {
    method_name: method, deposit: '1', args: Buffer.from(JSON.stringify(args)).toString('base64') } })) } };
  assert.doesNotThrow(() => assertOwnerPolicyCalls(result, expected));
  for (const mutate of [r => { r.transaction.actions[0].FunctionCall.deposit = '0'; },
    r => { r.transaction.actions[1].FunctionCall.method_name = 'revoke_payee'; },
    r => { r.transaction.actions[1].FunctionCall.args = Buffer.from('{}').toString('base64'); },
    r => { r.transaction.actions.pop(); }]) {
    const bad = structuredClone(result); mutate(bad); assert.throws(() => assertOwnerPolicyCalls(bad, expected));
  }
});

test('public evidence is write-once and refuses unsafe filenames', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrf2-evidence-'));
  try {
    writeFreshEvidence(dir, 'first-intent.json', { tx_hash: 'public' });
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'first-intent.json'), 'utf8')).tx_hash, 'public');
    assert.throws(() => writeFreshEvidence(dir, 'first-intent.json', {}));
    assert.throws(() => writeFreshEvidence(dir, '../unsafe.json', {}), /filename/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
