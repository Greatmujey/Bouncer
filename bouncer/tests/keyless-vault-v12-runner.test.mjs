import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import nearApi from 'near-api-js';
import { mockHash } from './mock-guarded-payment.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE } from '../scripts/circle-testnet-setup.mjs';
import { newTestnetVaultId, V12_EXPECTED_BYTES, V12_EXPECTED_SHA256, VAULT_NATIVE_FUNDING_YOCTO } from '../agent/keyless-vault-v12-readiness.mjs';
import { signVaultBootstrap, V12_NEAR_CODE_HASH } from '../agent/keyless-vault-v12.mjs';
import { verifyVaultBootstrapReceipt, inspectDeployedKeylessVault, reconcileVaultBootstrap, broadcastVaultBootstrapOnce }
  from '../agent/keyless-vault-v12-runner.mjs';

const NOW = Date.parse('2026-11-02T20:30:00Z'), BLOCK = mockHash('vault-runner-block'), ROOT = mockHash('vault-root'), GAS = mockHash('gas-refund');
const key = nearApi.KeyPair.fromRandom('ed25519'), pub = String(key.getPublicKey());
const plan = { version: 1, purpose: 'new-bouncer-testnet-owner', network: 'testnet',
  account_id: 'bouncer-owner-0123456789abcdef01234567.testnet', public_key: pub }, vault = newTestnetVaultId(plan);
const checks = Object.fromEntries(['new_direct_child_absent', 'owner_and_circle_ready', 'circle_code_pinned', 'vault_not_pre_registered_for_circle',
  'testnet_protocol_floor', 'selected_v12_wasm_features', 'owner_native_estimate', 'vault_native_estimate'].map(k => [k, 'PASS']));
const features = { global_contract_host_fns: true, reftypes_bulk_memory: true, gas_key_host_fns: true, universal_accounts: true };
const artifact = process.env.BOUNCER_V12_WASM || '/home/user/bouncer-tools/v12-review/bouncer-v12.wasm';
function snapshot() { return { version: 1, status: 'READ_ONLY_BOOTSTRAP_INDICATED', network: 'testnet', owner: plan.account_id,
  public_key: pub, vault, circle_token: CIRCLE, circle_code_hash: 'EoAUFWELjD9gYzsjKDXYRmHDHf1RJ95jaKNSYE6v9b2z', block_hash: BLOCK,
  block_timestamp_nanosec: (BigInt(NOW) * 1_000_000n).toString(), owner_key_nonce: '100', owner_native_yocto: '9990000000000000000000000',
  owner_test_usdc_atoms: '6917', planned_vault_native_yocto: VAULT_NATIVE_FUNDING_YOCTO, v12_sha256: V12_EXPECTED_SHA256,
  v12_bytes: V12_EXPECTED_BYTES, observed_protocol_version: 88, selected_v12_wasm_features: { ...features }, checks: { ...checks },
  blockers: [], signed: false, sent: false, vault_deployed: false }; }
let sharedEnvelope;
async function envelope() {
  if (!sharedEnvelope) sharedEnvelope = await signVaultBootstrap({ plan, snapshot: snapshot(), wasmBytes: fs.readFileSync(artifact), keyPair: key, nowMs: NOW });
  return sharedEnvelope;
}
function actions() {
  return ['CreateAccount', { Transfer: { deposit: VAULT_NATIVE_FUNDING_YOCTO } },
    { DeployContract: { code: Buffer.from(V12_EXPECTED_SHA256, 'hex').toString('base64') } },
    { FunctionCall: { method_name: 'new', args: Buffer.from(JSON.stringify({ owner: plan.account_id })).toString('base64'),
      gas: '30000000000000', deposit: '0' } }];
}
function receipt(e, withRefund = true) {
  const calls = actions(), receiptBody = { signer_id: plan.account_id, signer_public_key: pub, actions: structuredClone(calls) };
  const receipts = [{ receipt_id: ROOT, predecessor_id: plan.account_id, receiver_id: vault, receipt: { Action: receiptBody } }];
  const outcomes = [{ id: ROOT, outcome: { executor_id: vault, status: { SuccessValue: '' }, receipt_ids: withRefund ? [GAS] : [] } }];
  if (withRefund) {
    receipts.push({ receipt_id: GAS, predecessor_id: 'system', receiver_id: plan.account_id, receipt: { Action: {
      signer_id: plan.account_id, signer_public_key: pub, gas_price: '0', input_data_ids: [], output_data_receivers: [],
      actions: [{ Transfer: { deposit: '12' } }] } } });
    outcomes.push({ id: GAS, outcome: { executor_id: plan.account_id, status: { SuccessValue: '' }, receipt_ids: [] } });
  }
  return { final_execution_status: 'FINAL', status: { SuccessValue: '' }, transaction: {
    hash: e.tx_hash, signer_id: plan.account_id, public_key: pub, receiver_id: vault, nonce: e.nonce, actions: calls },
    transaction_outcome: { id: e.tx_hash, outcome: { executor_id: plan.account_id, status: { SuccessReceiptId: ROOT }, receipt_ids: [ROOT] } },
    receipts, receipts_outcome: outcomes };
}
function provider(e, opts = {}) {
  let after = false, sent = 0, lookups = 0, fenced = false;
  return { get enforcesSetupBeforeSubmitGuard() { return true; }, get sent() { return sent; }, get lookups() { return lookups; },
    async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewBlock(reference) { return { header: { hash: opts.badCanonical && reference?.blockId === 100 ? mockHash('fork') : BLOCK,
      height: 100, timestamp_nanosec: (BigInt(NOW) * 1_000_000n).toString() } }; },
    async query(q) {
      assert.equal(q.block_id, BLOCK);
      const access = { nonce: after ? 101 : opts.badNonce ? 101 : 100, permission: 'FullAccess' };
      if (q.request_type === 'view_account') {
        if (q.account_id === vault) return { block_hash: BLOCK, code_hash: opts.badVaultCode ? mockHash('wrong') : V12_NEAR_CODE_HASH,
          amount: VAULT_NATIVE_FUNDING_YOCTO, locked: '0', storage_usage: V12_EXPECTED_BYTES };
        return { block_hash: BLOCK, code_hash: q.account_id === plan.account_id ? '11111111111111111111111111111111' :
          opts.badCircleCode ? mockHash('wrong-circle') : 'EoAUFWELjD9gYzsjKDXYRmHDHf1RJ95jaKNSYE6v9b2z', amount: '9990000000000000000000000', locked: '0', storage_usage: 150 };
      }
      if (q.request_type === 'view_access_key_list') return q.account_id === vault ?
        { block_hash: BLOCK, keys: opts.vaultHasKey ? [{ public_key: pub, access_key: access }] : [] } :
        { block_hash: BLOCK, keys: [{ public_key: pub, access_key: access }] };
      if (q.request_type === 'view_access_key') return { block_hash: BLOCK, ...access };
      throw new Error('unexpected query');
    },
    async callFunctionRaw(contract, method, args) {
      let value;
      if (contract === vault && method === 'get_owner') value = opts.wrongOwner ? 'other.testnet' : plan.account_id;
      else if (contract === vault && method === 'contract_version') value = 'bouncer-agent-v12-exact-ft-testnet';
      else if (contract === vault && method === 'vault_balance') value = opts.nonzeroTracked ? '1' : '0';
      else if (method === 'ft_metadata') value = { symbol: 'USDC', decimals: 6 };
      else if (method === 'storage_balance_bounds') value = { min: '1250000000000000000000', max: null };
      else if (method === 'storage_balance_of') value = args.account_id === plan.account_id ? { total: '1250000000000000000000', available: '0' } : null;
      else if (method === 'ft_balance_of') value = '6917';
      else throw new Error('unexpected view');
      return { block_hash: BLOCK, result: [...Buffer.from(JSON.stringify(value))] };
    },
    async viewTestnetAccountPresenceAt() { return { block_hash: BLOCK, exists: !!opts.exists }; },
    async experimental_protocolConfig() { return { chain_id: 'testnet', protocol_version: 88,
      transaction_validity_period: opts.invalidValidity ? 0 : 86400, runtime_config: {
      storage_amount_per_byte: '10000000000000000000', wasm_config: features } }; },
    async sendTransactionOnce(signed, wait, { beforeSubmit }) {
      assert.equal(wait, 'FINAL'); assert.equal(fenced, true); beforeSubmit(); sent++; after = true;
      if (opts.lostAck) throw new Error('lost response');
      return { final_execution_status: 'FINAL', transaction_outcome: { id: e.tx_hash } };
    },
    async txStatusReceipts(hash, account, wait) { lookups++; assert.equal(hash, e.tx_hash); assert.equal(account, plan.account_id); assert.equal(wait, 'FINAL');
      if (opts.noReceipt) throw new Error('unavailable'); return receipt(e); },
    async persist(record) { assert.equal(sent, 0); assert.equal(record.tx_hash, e.tx_hash); fenced = true; return opts.fence !== false; },
  };
}
const skip = !fs.existsSync(artifact);

test('original deployment receipt pins create, transfer, exact WASM digest, initializer and gas refund', { skip }, async () => {
  const e = await envelope();
  for (const withRefund of [false, true]) {
    const r = receipt(e, withRefund), result = verifyVaultBootstrapReceipt(r, e, plan);
    assert.equal(result.tx_hash, e.tx_hash); assert.equal(result.root_receipt_id, ROOT);
    assert.equal(result.protocol_gas_refund_receipts, withRefund ? 1 : 0);
    for (const change of [x => { x.transaction.actions[1].Transfer.deposit = '1'; },
      x => { x.transaction.actions[2].DeployContract.code = Buffer.alloc(32).toString('base64'); },
      x => { x.receipts[0].receipt.Action.actions[3].FunctionCall.args = Buffer.from('{"owner":"other.testnet"}').toString('base64'); },
      x => { x.receipts[0].receiver_id = 'other.testnet'; }, x => { x.receipts_outcome[0].outcome.status = { Failure: {} }; },
      x => { x.receipts_outcome[0].outcome.receipt_ids.push(mockHash('unlinked')); }]) {
      const bad = structuredClone(r); change(bad); assert.throws(() => verifyVaultBootstrapReceipt(bad, e, plan));
    }
    if (withRefund) {
      const bad = structuredClone(r); bad.receipts[1].receiver_id = 'other.testnet';
      assert.throws(() => verifyVaultBootstrapReceipt(bad, e, plan), /refund/);
    }
  }
});

test('one fenced send, original-hash lookup and fresh keyless V12 state are required', { skip }, async () => {
  const e = await envelope(), p = provider(e);
  const result = await broadcastVaultBootstrapOnce({ plan, envelope: e, provider: p, now: () => NOW, persistAttempt: x => p.persist(x) });
  assert.equal(p.sent, 1); assert.equal(p.lookups, 1); assert.equal(result.tx_hash, e.tx_hash);
  assert.equal(result.state.vault_key_count, 0); assert.equal(result.state.code_hash, V12_NEAR_CODE_HASH);
  assert.equal(result.vault_deployed, true); assert.equal(result.circle_funding_verified, false); assert.equal(result.seller_contacted, false);
  const again = await reconcileVaultBootstrap({ plan, envelope: e, provider: p, now: () => NOW });
  assert.equal(again.tx_hash, e.tx_hash); assert.equal(p.sent, 1); assert.equal(p.lookups, 2);
});

test('changed preflight or failed fence makes no send; ambiguous results never trigger a retry', { skip }, async () => {
  const e = await envelope();
  for (const opts of [{ badNonce: true }, { badCircleCode: true }, { exists: true },
    { invalidValidity: true }, { badCanonical: true }, { fence: false }]) {
    const p = provider(e, opts);
    await assert.rejects(broadcastVaultBootstrapOnce({ plan, envelope: e, provider: p, now: () => NOW, persistAttempt: x => p.persist(x) }));
    assert.equal(p.sent, 0);
  }
  for (const opts of [{ lostAck: true }, { noReceipt: true }, { badVaultCode: true }, { vaultHasKey: true }, { wrongOwner: true }, { nonzeroTracked: true }]) {
    const p = provider(e, opts);
    await assert.rejects(broadcastVaultBootstrapOnce({ plan, envelope: e, provider: p, now: () => NOW, persistAttempt: x => p.persist(x) }),
      /original vault deployment .*never resend/);
    assert.equal(p.sent, 1);
  }
});

test('read-only vault state fails closed on wrong code, owner, keys and tracked balance', { skip }, async () => {
  const e = await envelope();
  for (const opts of [{ badVaultCode: true }, { vaultHasKey: true }, { wrongOwner: true }, { nonzeroTracked: true }]) {
    await assert.rejects(inspectDeployedKeylessVault({ plan, provider: provider(e, opts), now: () => NOW }));
  }
});
