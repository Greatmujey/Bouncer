import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { mockHash } from './mock-guarded-payment.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE } from '../scripts/circle-testnet-setup.mjs';
import { newTestnetVaultId, CIRCLE_TESTNET_CODE_HASH } from '../agent/keyless-vault-v12-readiness.mjs';
import { V12_NEAR_CODE_HASH } from '../agent/keyless-vault-v12.mjs';
import { inspectVaultCircleFunding } from '../agent/keyless-vault-v12-circle-readiness.mjs';
import { signVaultCircle, verifySignedVaultCircle } from '../agent/keyless-vault-v12-circle.mjs';
import { verifyVaultCircleReceipt, reconcileVaultCircle, broadcastVaultCircleOnce } from '../agent/keyless-vault-v12-circle-runner.mjs';

const NOW = Date.parse('2026-11-02T20:30:00Z'), BLOCK = mockHash('circle-vault-block'), CODE = CIRCLE_TESTNET_CODE_HASH;
const ROOT = mockHash('circle-vault-root'), HOOK = mockHash('circle-vault-hook'), RESOLVER = mockHash('circle-vault-resolver'), DATA = mockHash('circle-vault-data');
const MIN = '1250000000000000000000', AMOUNT = '6907';
const encode = x => Buffer.from(JSON.stringify(x)).toString('base64');
const out = (id, executor, status, receipt_ids = [], logs = []) => ({ id, outcome: { executor_id: executor, status, receipt_ids, logs } });
const receipt = (id, from, to, action) => ({ receipt_id: id, predecessor_id: from, receiver_id: to, receipt: { Action: action } });
const call = (method, args) => ({ FunctionCall: { method_name: method, args: encode(args), gas: '70000000000000', deposit: '0' } });
function fixture() {
  const key = nearApi.KeyPair.fromRandom('ed25519'), pub = String(key.getPublicKey());
  const plan = { version: 1, purpose: 'new-bouncer-testnet-owner', network: 'testnet',
    account_id: 'bouncer-owner-0123456789abcdef01234567.testnet', public_key: pub }, vault = newTestnetVaultId(plan);
  let phase = 0, sent = 0, lookups = 0, active, fenced = false, lostAck = false, badCanonical = false;
  const outcomeFor = e => {
    const signed = verifySignedVaultCircle(e, plan), c = signed.transaction.actions[0].functionCall;
    const action = { FunctionCall: { method_name: c.methodName, args: Buffer.from(c.args).toString('base64'), gas: c.gas.toString(), deposit: c.deposit.toString() } };
    const r = { final_execution_status: 'FINAL', status: { SuccessValue: '' },
      transaction: { hash: e.tx_hash, signer_id: plan.account_id, public_key: pub, receiver_id: CIRCLE, nonce: e.nonce, actions: [structuredClone(action)] },
      transaction_outcome: { id: e.tx_hash, outcome: { executor_id: plan.account_id, status: { SuccessReceiptId: ROOT }, receipt_ids: [ROOT] } },
      receipts: [receipt(ROOT, plan.account_id, CIRCLE, { signer_id: plan.account_id, signer_public_key: pub, actions: [structuredClone(action)] })],
      receipts_outcome: [out(ROOT, CIRCLE, { SuccessValue: '' })] };
    if (e.kind === 'register') {
      r.status.SuccessValue = encode({ total: MIN, available: '0' }); r.receipts_outcome[0].outcome.status = { ...r.status };
    } else {
      r.status.SuccessValue = encode(AMOUNT);
      const root = r.receipts_outcome[0].outcome;
      root.status = { SuccessReceiptId: RESOLVER }; root.receipt_ids = [HOOK, RESOLVER];
      root.logs = ['EVENT_JSON:' + JSON.stringify({ standard: 'nep141', version: '1.0.0', event: 'ft_transfer',
        data: [{ old_owner_id: plan.account_id, new_owner_id: vault, amount: AMOUNT }] })];
      r.receipts.push(receipt(HOOK, CIRCLE, vault, { signer_id: plan.account_id, signer_public_key: pub,
        actions: [call('ft_on_transfer', { sender_id: plan.account_id, amount: AMOUNT, msg: '' })],
        input_data_ids: [], output_data_receivers: [{ data_id: DATA, receiver_id: CIRCLE }] }));
      r.receipts.push(receipt(RESOLVER, CIRCLE, CIRCLE, { signer_id: plan.account_id, signer_public_key: pub,
        actions: [call('ft_resolve_transfer', { sender_id: plan.account_id, receiver_id: vault, amount: AMOUNT })],
        input_data_ids: [DATA], output_data_receivers: [] }));
      r.receipts_outcome.push(out(HOOK, vault, { SuccessValue: encode('0') }, [], ['BOUNCER deposit received']));
      r.receipts_outcome.push(out(RESOLVER, CIRCLE, { SuccessValue: encode(AMOUNT) }));
    }
    return r;
  };
  const p = { get enforcesSetupBeforeSubmitGuard() { return true; }, get sent() { return sent; }, get lookups() { return lookups; },
    set active(e) { active = e; }, set lostAck(x) { lostAck = x; }, set badCanonical(x) { badCanonical = x; },
    async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewBlock(ref) { return { header: { hash: badCanonical && ref?.blockId === 100 ? mockHash('different-canonical') : BLOCK,
      height: 100, timestamp_nanosec: (BigInt(NOW) * 1_000_000n).toString() } }; },
    async query(q) {
      assert.equal(q.block_id, BLOCK);
      const access = { nonce: 100 + phase, permission: 'FullAccess' };
      if (q.request_type === 'view_account') {
        if (q.account_id === vault) return { block_hash: BLOCK, code_hash: V12_NEAR_CODE_HASH,
          amount: '6000000000000000000000000', locked: '0', storage_usage: 540_000 };
        if (q.account_id === plan.account_id) return { block_hash: BLOCK, code_hash: '11111111111111111111111111111111',
          amount: '3000000000000000000000000', locked: '0', storage_usage: 150 };
        return { block_hash: BLOCK, code_hash: CODE, amount: '3000000000000000000000000', locked: '0', storage_usage: 150 };
      }
      if (q.request_type === 'view_access_key_list') return q.account_id === vault ? { block_hash: BLOCK, keys: [] } :
        { block_hash: BLOCK, keys: [{ public_key: pub, access_key: access }] };
      if (q.request_type === 'view_access_key') return { block_hash: BLOCK, ...access };
      throw new Error('unexpected query');
    },
    async callFunctionRaw(contract, method, args) {
      let value;
      if (contract === vault && method === 'get_owner') value = plan.account_id;
      else if (contract === vault && method === 'contract_version') value = 'bouncer-agent-v12-exact-ft-testnet';
      else if (contract === vault && method === 'vault_balance') value = phase === 2 ? AMOUNT : '0';
      else if (contract === CIRCLE && method === 'ft_metadata') value = { symbol: 'USDC', decimals: 6 };
      else if (contract === CIRCLE && method === 'storage_balance_bounds') value = { min: MIN, max: null };
      else if (contract === CIRCLE && method === 'storage_balance_of') value = args.account_id === plan.account_id || phase >= 1 ?
        { total: MIN, available: '0' } : null;
      else if (contract === CIRCLE && method === 'ft_balance_of') value = args.account_id === vault ? (phase === 2 ? AMOUNT : '0') : (phase === 2 ? '0' : AMOUNT);
      else throw new Error(`unexpected view ${method}`);
      return { block_hash: BLOCK, result: [...Buffer.from(JSON.stringify(value))] };
    },
    async experimental_protocolConfig() { return { chain_id: 'testnet', protocol_version: 88, transaction_validity_period: 86400, runtime_config: { storage_amount_per_byte: '10000000000000000000' } }; },
    async sendTransactionOnce(signed, wait, { beforeSubmit }) {
      assert.equal(wait, 'FINAL'); assert.ok(fenced); assert.equal(verifySignedVaultCircle(active, plan).transaction.nonce, signed.transaction.nonce);
      beforeSubmit(); sent++; phase++; fenced = false;
      if (lostAck) { lostAck = false; throw new Error('simulated lost acknowledgement'); }
      return { final_execution_status: 'FINAL', transaction_outcome: { id: active.tx_hash } };
    },
    async txStatusReceipts(hash, account, wait) { lookups++; assert.equal(hash, active.tx_hash); assert.equal(account, plan.account_id); assert.equal(wait, 'FINAL'); return outcomeFor(active); },
    async persist(x) { assert.equal(x.tx_hash, active.tx_hash); assert.equal(x.vault, vault); fenced = true; return true; },
  };
  return { key, plan, vault, p, outcomeFor, now: () => NOW };
}

async function signed(f, kind) {
  const snapshot = await inspectVaultCircleFunding({ plan: f.plan, provider: f.p, now: f.now });
  return signVaultCircle({ plan: f.plan, snapshot, kind, amountAtoms: AMOUNT, keyPair: f.key, nowMs: NOW });
}

test('registered and funded keyless vault requires two fenced sends and checks actual/tracked Circle balances', async () => {
  const f = fixture(), initial = await inspectVaultCircleFunding({ plan: f.plan, provider: f.p, now: f.now });
  assert.equal(initial.register_eligible, true); assert.equal(initial.fund_eligible, false); assert.equal(initial.vault_key_count, 0);
  const register = await signed(f, 'register'); f.p.active = register;
  const r = await broadcastVaultCircleOnce({ plan: f.plan, envelope: register, provider: f.p, now: f.now, persistAttempt: x => f.p.persist(x) });
  assert.equal(r.status, 'VAULT_CIRCLE_REGISTERED_AT_FINAL'); assert.equal(r.state.vault_circle_registration, 'REGISTERED_AT_VIEW');
  const fund = await signed(f, 'fund'); f.p.active = fund;
  const funded = await broadcastVaultCircleOnce({ plan: f.plan, envelope: fund, provider: f.p, now: f.now, persistAttempt: x => f.p.persist(x) });
  assert.equal(funded.status, 'VAULT_FUNDED_CIRCLE_TEST_USDC_AT_FINAL');
  assert.equal(funded.state.owner_circle_atoms, '0'); assert.equal(funded.state.vault_actual_circle_atoms, AMOUNT);
  assert.equal(funded.state.vault_tracked_circle_atoms, AMOUNT); assert.equal(funded.receipt.funding.full_amount_accepted, true);
  assert.equal(funded.seller_contacted, false); assert.equal(f.p.sent, 2);
});

test('lost funding acknowledgement is recovered by original hash without a second send', async () => {
  const f = fixture(), register = await signed(f, 'register'); f.p.active = register;
  await broadcastVaultCircleOnce({ plan: f.plan, envelope: register, provider: f.p, now: f.now, persistAttempt: x => f.p.persist(x) });
  const fund = await signed(f, 'fund'); f.p.active = fund; f.p.lostAck = true;
  await assert.rejects(broadcastVaultCircleOnce({ plan: f.plan, envelope: fund, provider: f.p, now: f.now, persistAttempt: x => f.p.persist(x) }), /never resend/);
  assert.equal(f.p.sent, 2);
  const recovered = await reconcileVaultCircle({ plan: f.plan, envelope: fund, provider: f.p, now: f.now });
  assert.equal(recovered.tx_hash, fund.tx_hash); assert.equal(recovered.state.vault_actual_circle_atoms, AMOUNT); assert.equal(f.p.sent, 2);
});

test('tampered signed actions, unsafe amounts, stale snapshots and failed fences cannot broadcast', async () => {
  const f = fixture(), e = await signed(f, 'register'); f.p.active = e;
  for (const changes of [{ amount_atoms: '999999' }, { expected_circle_code_hash: mockHash('wrong-token-code') }, { expected_vault_code_hash: mockHash('wrong-vault-code') }, { vault: 'other.testnet' }, { nonce: '102' }, { storage_min_yocto: '1' }]) {
    assert.throws(() => verifySignedVaultCircle({ ...e, ...changes }, f.plan));
  }
  const snap = await inspectVaultCircleFunding({ plan: f.plan, provider: f.p, now: f.now });
  await assert.rejects(signVaultCircle({ plan: f.plan, snapshot: snap, kind: 'register', amountAtoms: '2999', keyPair: f.key, nowMs: NOW }));
  await assert.rejects(signVaultCircle({ plan: f.plan, snapshot: snap, kind: 'register', amountAtoms: AMOUNT, keyPair: f.key, nowMs: NOW + 180_000 }));
  await assert.rejects(broadcastVaultCircleOnce({ plan: f.plan, envelope: e, provider: f.p, now: f.now, persistAttempt: async () => false }), /fence/);
  assert.equal(f.p.sent, 0);
});

test('receipt verification rejects mismatched roots, callback, resolver, event and incomplete graphs', async () => {
  const f = fixture(), register = await signed(f, 'register'); f.p.active = register;
  await broadcastVaultCircleOnce({ plan: f.plan, envelope: register, provider: f.p, now: f.now, persistAttempt: x => f.p.persist(x) });
  const fund = await signed(f, 'fund'), good = f.outcomeFor(fund);
  assert.equal(verifyVaultCircleReceipt(good, fund, f.plan).funding.amount_atoms, AMOUNT);
  for (const mutate of [
    r => { r.transaction.nonce = '99'; }, r => { r.receipts[0].receiver_id = 'other.testnet'; },
    r => { r.receipts_outcome[0].outcome.logs = []; }, r => { r.receipts[1].receipt.Action.output_data_receivers[0].data_id = mockHash('wrong'); },
    r => { r.receipts_outcome[1].outcome.status.SuccessValue = encode('1'); },
    r => { r.receipts_outcome[2].outcome.status.SuccessValue = encode('2'); },
    r => { r.receipts_outcome.pop(); }, r => { r.receipts_outcome[1].outcome.status = { Failure: {} }; },
  ]) {
    const bad = structuredClone(good); mutate(bad); assert.throws(() => verifyVaultCircleReceipt(bad, fund, f.plan));
  }
});

test('V12 and Circle code identity and canonical signed reference fail closed before any send', async () => {
  const f = fixture(), snap = await inspectVaultCircleFunding({ plan: f.plan, provider: f.p, now: f.now });
  for (const diff of [{ circle_code_hash: mockHash('wrong-circle') }, { vault_code_hash: mockHash('wrong-vault') }, { vault_key_count: 1 }]) {
    await assert.rejects(signVaultCircle({ plan: f.plan, snapshot: { ...snap, ...diff }, kind: 'register',
      amountAtoms: AMOUNT, keyPair: f.key, nowMs: NOW }), /snapshot is not eligible/);
  }
  const e = await signed(f, 'register'); f.p.active = e; f.p.badCanonical = true;
  await assert.rejects(broadcastVaultCircleOnce({ plan: f.plan, envelope: e, provider: f.p, now: f.now,
    persistAttempt: x => f.p.persist(x) }), /not canonical/);
  assert.equal(f.p.sent, 0);
});
