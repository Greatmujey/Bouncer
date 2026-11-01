// Read-only regression against one already-finalized testnet FT call. This
// fetches no secrets, does not sign or submit anything, and must never touch
// the separate unresolved project transaction. The token is fake test USDC.e,
// NOT Circle USDC; a prepaid deposit does not establish service delivery.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { verifyFtCallSettlement } from '../agent/ft-call.mjs';
import { validateRpcEndpoint } from '../shared/rpc-endpoint.mjs';
import { readBoundedJson } from '../shared/bounded-json.mjs';

export const HISTORICAL_FT_CALL = Object.freeze({
  tx_hash: '3uMBAaenMBQzJyxPxEdH8tBg5M3rvAuoQy5oRpNx56MY',
  public_key: 'ed25519:wwADv6XMc7iLnadpd2XnksW192Bnsd3MPTbzfUYsnnJ',
  goal: Object.freeze({ id: 'historical-ft-funding', contract_id: 'bouncer-ft-69756b49.testnet',
    owner_account_id: 'owner.bouncer-ft-69756b49.testnet', policy_id: 'provider-funding',
    payee: 'outlayer.testnet', token: 'usdc.fakes.testnet', amount: '10000',
    msg: '{"action":"deposit_balance"}', policy_revision: 1, route_revision: 1 }),
});

export async function verifyHistoricalFtCall({ provider }) {
  if (!provider || typeof provider.viewNodeStatus !== 'function' || typeof provider.txStatusReceipts !== 'function') {
    throw new Error('read-only receipt-inclusive provider required');
  }
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const { goal, tx_hash, public_key } = HISTORICAL_FT_CALL;
  const raw = await provider.txStatusReceipts(tx_hash, goal.owner_account_id, 'FINAL');
  const verified = verifyFtCallSettlement(goal, raw, public_key);
  if (verified.tx_hash !== tx_hash || verified.used !== goal.amount || verified.unused !== '0') {
    throw new Error('historical funding did not match the pinned settlement');
  }
  // Negative checks do not send: the same historical response must not accept
  // an unrelated initiation, duplicate receipt, or substituted destination.
  const variants = [
    result => { result.transaction_outcome.outcome.receipt_ids = []; },
    result => { result.receipts.push(structuredClone(result.receipts[0])); },
  ];
  for (const change of variants) {
    const forged = structuredClone(raw); change(forged);
    let rejected = false;
    try { verifyFtCallSettlement(goal, forged, public_key); } catch { rejected = true; }
    if (!rejected) throw new Error('tampered historical receipt graph was unexpectedly accepted');
  }
  let substitutionRejected = false;
  try { verifyFtCallSettlement({ ...goal, payee: 'attacker.testnet' }, raw, public_key); } catch { substitutionRejected = true; }
  if (!substitutionRejected) throw new Error('substituted historical payee was unexpectedly accepted');
  return { mode: 'read-only existing testnet transaction; no signing or new payment',
    tx_hash, contract: goal.contract_id, owner: goal.owner_account_id, token: goal.token, receiver: goal.payee,
    requested: verified.requested, used: verified.used, unused: verified.unused,
    graph_mutations_rejected: true, substituted_payee_rejected: true,
    scope: 'historical fake-token prepaid funding only; not Circle USDC, service delivery, or a guarded swap',
    trust: 'configured RPC, deployed Bouncer and token; no light-client proof' };
}

// Historical receipts may have aged out of the free non-archival node. Try a
// bounded archival read first, then a bounded fallback; neither can broadcast.
function readOnlyProvider(rawEndpoint) {
  const endpoint = validateRpcEndpoint(rawEndpoint);
  const rpc = async (method, params) => {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'ft-call-history', method, params }), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`${method}: RPC HTTP ${response.status}`);
    const body = await readBoundedJson(response, { maxBytes: 4_000_000, label: method });
    if (!body || body.error || !Object.hasOwn(body, 'result')) throw new Error(`${method}: RPC error ${JSON.stringify(body?.error ?? 'missing result').slice(0, 400)}`);
    return body.result;
  };
  return { viewNodeStatus: () => rpc('status', []),
    txStatusReceipts: (tx_hash, sender_account_id, wait_until) => rpc('EXPERIMENTAL_tx_status', { tx_hash, sender_account_id, wait_until }) };
}
const escapeAnnotation = value => String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
async function main() {
  // Never print the operator-selected URL, which may contain a secret path.
  const endpoints = process.env.NEAR_TESTNET_RPC ? [{ name: 'configured RPC', url: process.env.NEAR_TESTNET_RPC }] :
    [{ name: 'testnet archival RPC', url: 'https://archival-rpc.testnet.near.org' },
      { name: 'testnet fallback RPC', url: 'https://test.rpc.fastnear.com' }];
  const errors = [];
  for (const endpoint of endpoints) {
    try {
      const summary = await verifyHistoricalFtCall({ provider: readOnlyProvider(endpoint.url) });
      console.log(`::notice title=Historical guarded FT-call receipt graph::${escapeAnnotation(JSON.stringify({ ...summary, endpoint: endpoint.name }))}`);
      return;
    } catch (error) { errors.push(`${endpoint.name}: ${error.message}`); }
  }
  throw new Error(`read-only historical inspection failed: ${errors.join('; ')}`);
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(`[ft-call-history] ${error.message}`);
    console.log(`::error title=Historical FT-call inspection failed::${escapeAnnotation(error.message)}`);
    process.exitCode = 1;
  });
}
