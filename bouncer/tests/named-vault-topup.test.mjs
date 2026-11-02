import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { V11_NEAR_CODE_HASH } from '../agent/keyless-vault-bootstrap.mjs';
import { TOPUP_SOURCE, TOPUP_VAULT, TOPUP_VAULT_OWNER, TOPUP_ATOMS, inspectNamedVaultTopup,
  assertNamedVaultTopupBefore, signNamedVaultTopup, verifySignedNamedVaultTopup } from '../agent/named-vault-topup.mjs';
import { verifyNamedVaultTopupReceipt, reconcileNamedVaultTopup,
  broadcastNamedVaultTopupOnce } from '../agent/named-vault-topup-runner.mjs';

const TIME = Date.parse('2026-11-02T22:00:00.000Z');
const HASH = nearApi.utils.serialize.base_encode(Buffer.alloc(32, 9));
const WRONG = nearApi.utils.serialize.base_encode(Buffer.alloc(32, 8));
const CIRCLE_HASH = 'EoAUFWELjD9gYzsjKDXYRmHDHf1RJ95jaKNSYE6v9b2z';
const EMPTY_CODE = '11111111111111111111111111111111';
function fixture() {
  const key = nearApi.KeyPair.fromRandom('ed25519'), pub = String(key.getPublicKey());
  const plan = { version: 1, purpose: 'user-requested-uncreated-testnet-account-recovery', network: 'testnet',
    account_id: TOPUP_SOURCE, public_key: pub, circle_token: TOKEN, circle_code_hash: CIRCLE_HASH, observed_circle_atoms: '40000000' };
  const s = { chain: 'testnet', nonce: 100, sourceBalance: '40000000', actual: '6907', tracked: '6907',
    vaultCode: V11_NEAR_CODE_HASH, circleCode: CIRCLE_HASH, sourceCode: EMPTY_CODE, owner: TOPUP_VAULT_OWNER,
    sourceKeys: [{ public_key: pub, access_key: { permission: 'FullAccess', nonce: 100 } }], vaultKeys: [],
    registration: { total: '1250000000000000000000', available: '0' }, gas: '100000000', mixed: false, height: 1234,
    sourceNative: '10000000000000000000000000', vaultNative: '6000000000000000000000000' };
  const p = {
    async viewNodeStatus() { return { chain_id: s.chain }; },
    async viewBlock() { return { header: { hash: HASH, height: s.height, timestamp_nanosec: String(BigInt(TIME) * 1_000_000n) } }; },
    async query(q) {
      assert.equal(q.block_id, HASH); const bh = s.mixed ? WRONG : HASH;
      if (q.request_type === 'view_account') {
        if (q.account_id === TOPUP_SOURCE) return { block_hash: bh, code_hash: s.sourceCode, amount: s.sourceNative, locked: '0', storage_usage: 150 };
        if (q.account_id === TOPUP_VAULT) return { block_hash: bh, code_hash: s.vaultCode, amount: s.vaultNative, locked: '0', storage_usage: 540_000 };
        assert.equal(q.account_id, TOKEN); return { block_hash: bh, code_hash: s.circleCode };
      }
      if (q.request_type === 'view_access_key_list') return { block_hash: bh, keys: q.account_id === TOPUP_VAULT ? s.vaultKeys : s.sourceKeys };
      if (q.request_type === 'view_access_key') return { block_hash: bh, permission: 'FullAccess', nonce: s.nonce };
      throw Error('unexpected query');
    },
    async callFunctionRaw(contract, method, args, options) {
      assert.equal(options.blockId, HASH); let value;
      if (contract === TOPUP_VAULT && method === 'get_owner') value = s.owner;
      else if (contract === TOPUP_VAULT && method === 'contract_version') value = 'bouncer-agent-v11-exact-ft-testnet';
      else if (contract === TOPUP_VAULT && method === 'vault_balance') value = s.tracked;
      else if (contract === TOKEN && method === 'ft_balance_of') value = args.account_id === TOPUP_SOURCE ? s.sourceBalance : s.actual;
      else if (contract === TOKEN && method === 'storage_balance_of') value = s.registration;
      else throw Error('unexpected view');
      return { block_hash: s.mixed ? WRONG : HASH, result: [...Buffer.from(JSON.stringify(value))] };
    },
    async experimental_protocolConfig({ blockId }) { assert.equal(blockId, HASH); return { chain_id: s.chain,
      transaction_validity_period: 86400, runtime_config: { storage_amount_per_byte: '10000000000000000000' } }; },
    async gasPrice(block) { assert.equal(block, HASH); return { gas_price: s.gas }; },
  };
  return { key, pub, plan, s, p, now: () => TIME };
}

async function sign(f) {
  const snapshot = await inspectNamedVaultTopup({ plan: f.plan, provider: f.p, now: f.now });
  return signNamedVaultTopup({ plan: f.plan, snapshot, keyPair: f.key, nowMs: TIME });
}

test('pinned snapshot and fixed offline signature transfer exactly six test USDC only to the keyless vault', async () => {
  const f = fixture(), snapshot = await inspectNamedVaultTopup({ plan: f.plan, provider: f.p, now: f.now });
  assert.equal(assertNamedVaultTopupBefore(snapshot, f.plan, TIME), snapshot);
  assert.equal(snapshot.vault_actual_circle_atoms, '6907'); assert.equal(snapshot.vault_tracked_circle_atoms, '6907');
  const e = await sign(f), signed = verifySignedNamedVaultTopup(e, f.plan);
  assert.equal(e.amount_atoms, TOPUP_ATOMS); assert.equal(e.source, TOPUP_SOURCE); assert.equal(e.vault, TOPUP_VAULT);
  assert.equal(e.nonce, '101'); assert.equal(e.do_not_blindly_resend, true);
  assert.equal(signed.transaction.actions.length, 1);
  const call = signed.transaction.actions[0].functionCall;
  assert.equal(call.methodName, 'ft_transfer_call'); assert.equal(call.deposit, 1n); assert.equal(call.gas, 200n * 10n ** 12n);
  assert.deepEqual(JSON.parse(Buffer.from(call.args)), { receiver_id: TOPUP_VAULT, amount: TOPUP_ATOMS, msg: '' });
});

test('wrong chain, code, key, owner, registration, storage or mixed-block state cannot authorize a topup', async () => {
  for (const mutate of [s => { s.chain = 'mainnet'; }, s => { s.sourceCode = WRONG; }, s => { s.vaultCode = WRONG; },
    s => { s.circleCode = WRONG; }, s => { s.owner = 'other.testnet'; }, s => { s.sourceKeys = []; },
    s => { s.vaultKeys = [{ public_key: 'bad' }]; }, s => { s.registration = null; }, s => { s.mixed = true; },
    s => { s.nonce++; }, s => { s.gas = '0'; }, s => { s.sourceNative = '1'; }, s => { s.vaultNative = '1'; }]) {
    const f = fixture(); mutate(f.s); await assert.rejects(inspectNamedVaultTopup({ plan: f.plan, provider: f.p, now: f.now }));
  }
});

test('changed source or tracked/actual balances and stale snapshots stop before signing', async () => {
  for (const mutate of [s => { s.sourceBalance = '39999999'; }, s => { s.actual = '0'; }, s => { s.tracked = '0'; }]) {
    const f = fixture(); mutate(f.s); const snapshot = await inspectNamedVaultTopup({ plan: f.plan, provider: f.p, now: f.now });
    await assert.rejects(signNamedVaultTopup({ plan: f.plan, snapshot, keyPair: f.key, nowMs: TIME }));
  }
  const f = fixture(), snapshot = await inspectNamedVaultTopup({ plan: f.plan, provider: f.p, now: f.now });
  await assert.rejects(signNamedVaultTopup({ plan: f.plan, snapshot, keyPair: f.key, nowMs: TIME + 121_000 }));
  await assert.rejects(signNamedVaultTopup({ plan: f.plan, snapshot, keyPair: nearApi.KeyPair.fromRandom('ed25519'), nowMs: TIME }));
});

test('altered signed action, amount, nonce, public key, hash or target is rejected', async () => {
  const f = fixture(), e = await sign(f);
  for (const change of [{ amount_atoms: '1' }, { vault: 'other.testnet' }, { source: 'other.testnet' }, { nonce: '102' },
    { token: 'other.testnet' }, { tx_hash: WRONG }, { public_key: String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey()) },
    { signed_tx_base64: e.signed_tx_base64.slice(0, -4) + 'AAAA' }]) {
    assert.throws(() => verifySignedNamedVaultTopup({ ...e, ...change }, f.plan));
  }
});

const id = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n));
const ROOT = id(1), HOOK = id(2), RESOLVER = id(3), DATA = id(4);
const b64 = x => Buffer.from(JSON.stringify(x)).toString('base64');
const outcome = (rid, executor, status, receipt_ids = [], logs = []) => ({ id: rid, outcome: { executor_id: executor, status, receipt_ids, logs } });
const receipt = (rid, from, to, action) => ({ receipt_id: rid, predecessor_id: from, receiver_id: to, receipt: { Action: action } });
const call = (method, args) => ({ FunctionCall: { method_name: method, args: b64(args), gas: '70000000000000', deposit: '0' } });
function chainReceipt(f, envelope) {
  const signed = verifySignedNamedVaultTopup(envelope, f.plan), c = signed.transaction.actions[0].functionCall;
  const rootCall = { FunctionCall: { method_name: c.methodName, args: Buffer.from(c.args).toString('base64'),
    gas: c.gas.toString(), deposit: c.deposit.toString() } };
  const result = { final_execution_status: 'FINAL', status: { SuccessValue: b64(TOPUP_ATOMS) },
    transaction: { hash: envelope.tx_hash, signer_id: TOPUP_SOURCE, public_key: f.pub, receiver_id: TOKEN,
      nonce: envelope.nonce, actions: [structuredClone(rootCall)] },
    transaction_outcome: { id: envelope.tx_hash, outcome: { executor_id: TOPUP_SOURCE, status: { SuccessReceiptId: ROOT }, receipt_ids: [ROOT] } },
    receipts: [receipt(ROOT, TOPUP_SOURCE, TOKEN, { signer_id: TOPUP_SOURCE, signer_public_key: f.pub, actions: [structuredClone(rootCall)] }),
      receipt(HOOK, TOKEN, TOPUP_VAULT, { signer_id: TOPUP_SOURCE, signer_public_key: f.pub,
        actions: [call('ft_on_transfer', { sender_id: TOPUP_SOURCE, amount: TOPUP_ATOMS, msg: '' })],
        input_data_ids: [], output_data_receivers: [{ data_id: DATA, receiver_id: TOKEN }] }),
      receipt(RESOLVER, TOKEN, TOKEN, { signer_id: TOPUP_SOURCE, signer_public_key: f.pub,
        actions: [call('ft_resolve_transfer', { sender_id: TOPUP_SOURCE, receiver_id: TOPUP_VAULT, amount: TOPUP_ATOMS })],
        input_data_ids: [DATA], output_data_receivers: [] })],
    receipts_outcome: [outcome(ROOT, TOKEN, { SuccessReceiptId: RESOLVER }, [HOOK, RESOLVER],
      ['EVENT_JSON:' + JSON.stringify({ standard: 'nep141', version: '1.0.0', event: 'ft_transfer',
        data: [{ old_owner_id: TOPUP_SOURCE, new_owner_id: TOPUP_VAULT, amount: TOPUP_ATOMS }] })]),
      outcome(HOOK, TOPUP_VAULT, { SuccessValue: b64('0') }, [], ['BOUNCER deposit received']),
      outcome(RESOLVER, TOKEN, { SuccessValue: b64(TOPUP_ATOMS) })] };
  return result;
}
function attachRunner(f, envelope, { loseSend = false, fenceOk = true } = {}) {
  let sends = 0, fences = 0, lookups = 0;
  const result = chainReceipt(f, envelope);
  f.p.enforcesSetupBeforeSubmitGuard = true;
  f.p.sendTransactionOnce = async (signed, wait, { beforeSubmit }) => {
    assert.equal(wait, 'FINAL'); assert.equal(fences, 1); assert.equal(signed.transaction.nonce, BigInt(envelope.nonce));
    beforeSubmit(); sends++; f.s.nonce = Number(envelope.nonce); f.s.sourceKeys[0].access_key.nonce = f.s.nonce;
    f.s.sourceBalance = '34000000'; f.s.actual = '6006907'; f.s.tracked = '6006907';
    if (loseSend) throw Error('lost synthetic acknowledgement');
    return { final_execution_status: 'FINAL', transaction_outcome: { id: envelope.tx_hash } };
  };
  f.p.txStatusReceipts = async (hash, owner, wait) => {
    lookups++; assert.equal(hash, envelope.tx_hash); assert.equal(owner, TOPUP_SOURCE); assert.equal(wait, 'FINAL');
    return structuredClone(result);
  };
  const persistAttempt = async value => { fences++; assert.equal(value.tx_hash, envelope.tx_hash); return fenceOk; };
  return { result, persistAttempt, get sends() { return sends; }, get fences() { return fences; }, get lookups() { return lookups; } };
}

test('fenced one-shot topup verifies the original Circle callback graph and both vault balances', async () => {
  const f = fixture(), e = await sign(f), runner = attachRunner(f, e);
  const result = await broadcastNamedVaultTopupOnce({ plan: f.plan, envelope: e, provider: f.p, now: f.now, persistAttempt: runner.persistAttempt });
  assert.equal(result.status, 'NAMED_TESTNET_TOPUP_FINAL_VERIFIED'); assert.equal(result.tx_hash, e.tx_hash);
  assert.equal(result.state.source_circle_atoms, '34000000'); assert.equal(result.state.vault_actual_circle_atoms, '6006907');
  assert.equal(result.state.vault_tracked_circle_atoms, '6006907'); assert.equal(result.receipt.funding.full_amount_accepted, true);
  assert.equal(result.seller_contacted, false); assert.equal(runner.sends, 1); assert.equal(runner.lookups, 1);
  await assert.rejects(broadcastNamedVaultTopupOnce({ plan: f.plan, envelope: e, provider: f.p, now: f.now, persistAttempt: runner.persistAttempt }));
  assert.equal(runner.sends, 1);
});

test('lost topup response recovers the original hash and never sends a replacement', async () => {
  const f = fixture(), e = await sign(f), runner = attachRunner(f, e, { loseSend: true });
  await assert.rejects(broadcastNamedVaultTopupOnce({ plan: f.plan, envelope: e, provider: f.p, now: f.now,
    persistAttempt: runner.persistAttempt }), /unconfirmed.*never resend/);
  assert.equal(runner.sends, 1); assert.equal(runner.lookups, 0);
  const recovered = await reconcileNamedVaultTopup({ plan: f.plan, envelope: e, provider: f.p, now: f.now });
  assert.equal(recovered.tx_hash, e.tx_hash); assert.equal(runner.sends, 1); assert.equal(runner.lookups, 1);
});

test('missing fence, old or noncanonical reference, and changed state prevent the topup send', async () => {
  const f = fixture(), e = await sign(f), runner = attachRunner(f, e, { fenceOk: false });
  await assert.rejects(broadcastNamedVaultTopupOnce({ plan: f.plan, envelope: e, provider: f.p, now: f.now,
    persistAttempt: runner.persistAttempt }), /fence/); assert.equal(runner.sends, 0);
  const g = fixture(), eg = await sign(g), rg = attachRunner(g, eg);
  g.p.viewBlock = async opts => opts?.blockId ? { header: { hash: WRONG, height: eg.block_height } } :
    { header: { hash: HASH, height: eg.block_height, timestamp_nanosec: String(BigInt(TIME) * 1_000_000n) } };
  await assert.rejects(broadcastNamedVaultTopupOnce({ plan: g.plan, envelope: eg, provider: g.p, now: g.now,
    persistAttempt: rg.persistAttempt }), /reference block/); assert.equal(rg.sends, 0);
  const h = fixture(), eh = await sign(h), rh = attachRunner(h, eh);
  h.s.sourceBalance = '39999999';
  await assert.rejects(broadcastNamedVaultTopupOnce({ plan: h.plan, envelope: eh, provider: h.p, now: h.now,
    persistAttempt: rh.persistAttempt })); assert.equal(rh.sends, 0);
});

test('receipt validation rejects forged roots, events, callbacks, resolver links and failed outcomes', async () => {
  const f = fixture(), e = await sign(f), runner = attachRunner(f, e), good = runner.result;
  assert.equal(verifyNamedVaultTopupReceipt(good, e, f.plan).funding.amount_atoms, TOPUP_ATOMS);
  for (const mutate of [r => { r.transaction.signer_id = 'other.testnet'; }, r => { r.transaction.nonce = '1'; },
    r => { r.receipts[0].receiver_id = 'other.testnet'; }, r => { r.receipts_outcome[0].outcome.logs = []; },
    r => { r.receipts[1].receipt.Action.output_data_receivers[0].data_id = id(7); },
    r => { r.receipts_outcome[1].outcome.status.SuccessValue = b64('1'); },
    r => { r.receipts_outcome[2].outcome.status.SuccessValue = b64('0'); },
    r => { r.receipts_outcome.pop(); }, r => { r.receipts_outcome[1].outcome.status = { Failure: {} }; }]) {
    const bad = structuredClone(good); mutate(bad); assert.throws(() => verifyNamedVaultTopupReceipt(bad, e, f.plan));
  }
});
