// READ ONLY: re-verify an existing connector-probe fetch transaction against
// receipt-inclusive FINAL RPC. No account creation, signing or payment. This
// verifies the legacy 405 probe, not burn, Circle USDC, or TEE attestation.
import assert from 'node:assert/strict';
import { verifyProjectResult } from '../agent/outlayer-project.mjs';
import { validateRpcEndpoint } from '../shared/rpc-endpoint.mjs';
import { readBoundedJson } from '../shared/bounded-json.mjs';

const hash = '3WSS8Cma8SBqtnk9Krb6g7cNhSgpX2m7wpbKBdtiEuny';
const contract = 'bouncer-ft-4b80e5ae.testnet', owner = `owner.${contract}`;
const version = '2d406ed8005a422c38aec0616990989970e2c444c1386d4f09d54cce59468fb9';
// The public FASTNEAR free node is not archival. Try the published archival
// testnet endpoint first; each read has a hard timeout and cannot send a tx.
const endpoints = (process.env.NEAR_TESTNET_RPC ? [process.env.NEAR_TESTNET_RPC] :
  ['https://archival-rpc.testnet.near.org', 'https://test.rpc.fastnear.com']).map(validateRpcEndpoint);
async function rpc(url, method, params) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'bouncer-history', method, params }), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${method}: RPC HTTP ${response.status}`);
  const body = await readBoundedJson(response, { maxBytes: 4_000_000, label: method });
  if (body?.error || !body || !Object.hasOwn(body, 'result')) throw new Error(`${method}: RPC error ${JSON.stringify(body?.error).slice(0, 400)}`);
  return body.result;
}
async function historicalResult() {
  const errors = [];
  for (const endpoint of endpoints) {
    try {
      if ((await rpc(endpoint, 'status', []))?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
      return { endpoint, result: await rpc(endpoint, 'EXPERIMENTAL_tx_status', { tx_hash: hash, sender_account_id: owner, wait_until: 'FINAL' }) };
    } catch (error) { errors.push(`${endpoint}: ${error.message}`); }
  }
  throw new Error(`historical receipt-inclusive RPC unavailable: ${errors.join('; ')}`);
}
async function main() {
  const { endpoint, result } = await historicalResult();
  const call = result?.transaction?.actions?.[0]?.FunctionCall;
  if (!call || result?.transaction?.actions?.length !== 1) throw new Error('missing historical signed action');
  const args = JSON.parse(Buffer.from(call.args, 'base64').toString('utf8'));
  const goal = { id: 'historical-paid-fetch', contract_id: contract, owner_account_id: owner,
    native_policy_id: args.native_policy_id, amount: args.amount, route: args.expected_route, expected_author: 'zavodil.testnet' };
  if (goal.native_policy_id !== 'project-native' || goal.amount !== '100000000000000000000000' ||
      goal.route?.project?.version_key !== version || goal.route?.project?.input_data !== '{"operation":"fetch"}') {
    throw new Error('historical reviewed goal differs from published evidence');
  }
  const delivery = verifyProjectResult(goal, result, result.transaction.public_key);
  assert.equal(delivery.tx_hash, hash); assert.equal(delivery.prepaid_charged, '15000');
  assert.equal(delivery.near_charged, '1113300000000000000000'); assert.equal(delivery.near_refunded_to_owner, '98886700000000000000000');
  assert.deepEqual(delivery.result, { operation: 'fetch', http_status: 405 });
  const duplicate = structuredClone(result);
  duplicate.receipts_outcome.push(structuredClone(duplicate.receipts_outcome[0]));
  assert.throws(() => verifyProjectResult(goal, duplicate, result.transaction.public_key), /duplicate or invalid receipt identifiers/);
  const altered = structuredClone(result);
  altered.transaction.public_key = 'ed25519:substituted';
  assert.throws(() => verifyProjectResult(goal, altered, result.transaction.public_key), /owner, contract or key mismatch/);
  console.log(`::notice title=Historical paid connector regression (read only)::${JSON.stringify({ hash, contract, owner, endpoint,
    asset: delivery.asset, prepaid_charged: delivery.prepaid_charged, result: delivery.result, near_charged: delivery.near_charged,
    duplicate_receipt_rejected: true, substituted_key_rejected: true, new_payments: 0,
    scope: 'old failed-HTTP fetch; trusted RPC and provider; no burn or TEE proof' })}`);
}
main().catch(error => {
  const detail = String(error.stack || error).slice(0, 3000);
  console.error(`[project-history] ${detail}`);
  console.log(`::error title=Historical connector check failed::${detail.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
  process.exitCode = 1;
});
