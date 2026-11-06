import test from 'node:test';
import assert from 'node:assert/strict';
import { CIRCLE_TEST_USDC, TESTNET_RPC, formatPublicAmount, isNearAccountId, readPublicTestnetAccount } from '../web-src/account-view.mjs';

const blockHash = 'B'.repeat(44), blockHeight = 276000123;
const bytes = value => [...new TextEncoder().encode(JSON.stringify(value))];
const response = value => ({ ok: true, text: async () => JSON.stringify(value) });
function mockRpc({ missing = false, mismatch = false, circle = '20000000' } = {}) {
  const requests = [];
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body); requests.push({ url, options, body });
    const id = body.id;
    if (body.params.request_type === 'view_account') {
      return response(missing
        ? { jsonrpc: '2.0', id, error: { cause: { name: 'UNKNOWN_ACCOUNT' } } }
        : { jsonrpc: '2.0', id, result: { amount: '16019958035075000000000000', locked: '0', block_hash: blockHash, block_height: blockHeight } });
    }
    return response({ jsonrpc: '2.0', id, result: { result: bytes(circle), block_hash: mismatch ? 'C'.repeat(44) : blockHash, block_height: blockHeight } });
  };
  return { fetch, requests };
}

test('public account input validates NEAR IDs without changing network or inventing a suffix', () => {
  for (const valid of ['great_mujey.testnet', 'great_mujey.near', 'vault.a.testnet', 'a'.repeat(64)]) assert.equal(isNearAccountId(valid), true, valid);
  for (const invalid of ['', 'a', 'UPPER.testnet', 'a..testnet', 'a_.testnet', '.a', 'a.', 'a/b.testnet', 'a b.testnet', 'a'.repeat(65), null]) {
    assert.equal(isNearAccountId(invalid), false, String(invalid));
  }
});

test('public balances use the exact typed ID and one final testnet block, with read-only queries only', async () => {
  const mock = mockRpc();
  const value = await readPublicTestnetAccount('great_mujey.testnet', { fetch: mock.fetch });
  assert.deepEqual(value, { exists: true, near: '16019958035075000000000000', circle: '20000000', blockHash, blockHeight });
  assert.equal(mock.requests.length, 2);
  for (const request of mock.requests) {
    assert.equal(request.url, TESTNET_RPC);
    assert.equal(request.options.credentials, 'omit');
    assert.equal(request.options.redirect, 'error');
    assert.equal(request.body.method, 'query');
  }
  assert.deepEqual(mock.requests[0].body.params, { request_type: 'view_account', finality: 'final', account_id: 'great_mujey.testnet' });
  const second = mock.requests[1].body.params;
  assert.deepEqual(second, { request_type: 'call_function', block_id: blockHash, account_id: CIRCLE_TEST_USDC,
    method_name: 'ft_balance_of', args_base64: btoa('{"account_id":"great_mujey.testnet"}') });
  const other = mockRpc();
  await readPublicTestnetAccount('great_mujey.near', { fetch: other.fetch });
  assert.equal(other.requests[0].body.params.account_id, 'great_mujey.near', 'never silently rewrite .near as .testnet');
});

test('unknown account is not assigned a fake balance; malformed or inconsistent RPC responses fail closed', async () => {
  const absent = mockRpc({ missing: true });
  assert.deepEqual(await readPublicTestnetAccount('great_mujey.near', { fetch: absent.fetch }), { exists: false });
  assert.equal(absent.requests.length, 1);
  for (const mock of [mockRpc({ mismatch: true }), mockRpc({ circle: '1e8' }), mockRpc({ circle: 0 })]) {
    await assert.rejects(readPublicTestnetAccount('alice.testnet', { fetch: mock.fetch }), /TESTNET_RPC_INVALID/);
  }
  await assert.rejects(readPublicTestnetAccount('alice.testnet', { fetch: async () => ({ ok: false }) }), /TESTNET_RPC_UNAVAILABLE/);
  await assert.rejects(readPublicTestnetAccount('BAD', { fetch: () => { throw new Error('must not query'); } }), /INVALID_ACCOUNT_ID/);
});

test('displayed units preserve exact Circle atoms and mark NEAR truncation explicitly', () => {
  assert.equal(formatPublicAmount('20000000', 6), '20');
  assert.equal(formatPublicAmount('20000001', 6), '20.000001');
  assert.equal(formatPublicAmount('16019958035075000000000000', 24, 6), '≈16.019958');
  assert.equal(formatPublicAmount('1000000000000000000000000', 24, 6), '1');
  assert.throws(() => formatPublicAmount('fake', 6));
});
