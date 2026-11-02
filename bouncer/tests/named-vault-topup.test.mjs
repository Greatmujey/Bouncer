import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { V11_NEAR_CODE_HASH } from '../agent/keyless-vault-bootstrap.mjs';
import { TOPUP_SOURCE, TOPUP_VAULT, TOPUP_VAULT_OWNER, TOPUP_ATOMS, inspectNamedVaultTopup,
  assertNamedVaultTopupBefore, signNamedVaultTopup, verifySignedNamedVaultTopup } from '../agent/named-vault-topup.mjs';

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
