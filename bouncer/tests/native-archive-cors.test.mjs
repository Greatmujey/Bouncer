import test from 'node:test';
import assert from 'node:assert/strict';
import { checkNativeArchiveCors } from '../scripts/check-native-archive-cors.mjs';
const origin = 'https://bouncer-near.vercel.app';
const block = 'DWvgKDnvo57VTMap6W8HtHszgP7gKWVUSY8JRec8t7SZ';
const headers = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type' };
function makeFetch(change = {}) {
  const calls = [];
  return { calls, fetch: async (url, options) => {
    calls.push({ url, ...options });
    if (calls.length === 1) return new Response(null, { status: change.preflightStatus ?? 204,
      headers: { ...headers, ...(change.preflightHeaders || {}) } });
    if (calls.length === 2) return new Response(JSON.stringify(change.body ?? { jsonrpc: '2.0', id: 'bouncer-archive-cors-read-only',
      result: { header: { hash: block } } }), { status: change.status ?? 200,
      headers: { 'access-control-allow-origin': change.origin ?? origin } });
    return new Response(JSON.stringify(change.receiptBody ?? { jsonrpc: '2.0', id: 'bouncer-archive-cors-receipt',
      result: { final_execution_status: 'FINAL', receipts_outcome: [], transaction: {
        hash: '4MCH1jvtrz43trdnjvxQfkVuLXN4a9nhtyzPt8kM95yZ', signer_id: 'owner.bouncer-oracle-6a42bf32.testnet' } } }),
      { status: change.receiptStatus ?? 200, headers: { 'access-control-allow-origin': change.receiptOrigin ?? origin } });
  } };
}

test('archive probe reads a pinned block and a historical original with an explicit browser origin', async () => {
  const mock = makeFetch();
  assert.deepEqual(await checkNativeArchiveCors(mock.fetch), { known_block_read: true, historical_final_original_read: true,
    browser_origin_header_allowed: true, real_phone_verified: false, current_wallet_trial_verified: false, signed_or_sent_transaction: false });
  assert.equal(mock.calls.length, 3);
  assert(mock.calls.every(c => c.url === 'https://archival-rpc.testnet.near.org' && c.headers.origin === origin));
  assert.deepEqual(JSON.parse(mock.calls[1].body), { jsonrpc: '2.0', id: 'bouncer-archive-cors-read-only',
    method: 'block', params: { block_id: block } });
  assert.deepEqual(JSON.parse(mock.calls[2].body), { jsonrpc: '2.0', id: 'bouncer-archive-cors-receipt',
    method: 'EXPERIMENTAL_tx_status', params: { tx_hash: '4MCH1jvtrz43trdnjvxQfkVuLXN4a9nhtyzPt8kM95yZ',
      sender_account_id: 'owner.bouncer-oracle-6a42bf32.testnet', wait_until: 'FINAL' } });
});

test('archive probe rejects wrong CORS, wrong chain result and network errors', async () => {
  for (const change of [
    { preflightStatus: 403 }, { preflightHeaders: { 'access-control-allow-origin': 'https://other.example' } },
    { preflightHeaders: { 'access-control-allow-methods': 'GET' } },
    { preflightHeaders: { 'access-control-allow-headers': 'authorization' } },
    { status: 500 }, { origin: 'https://other.example' }, { body: { jsonrpc: '2.0', id: 'wrong' } },
    { body: { jsonrpc: '2.0', id: 'bouncer-archive-cors-read-only', result: { header: { hash: 'wrong' } } } },
    { receiptStatus: 500 }, { receiptOrigin: 'https://other.example' },
    { receiptBody: { jsonrpc: '2.0', id: 'bouncer-archive-cors-receipt', result: { final_execution_status: 'EXECUTED' } } },
  ]) await assert.rejects(checkNativeArchiveCors(makeFetch(change).fetch));
  await assert.rejects(checkNativeArchiveCors(async () => { throw Error('offline'); }));
});
