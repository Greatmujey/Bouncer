/**
 * Read-only verification of ONE previously completed, public testnet funding
 * transaction. This never reads a key, submits a transaction or authorizes a
 * new purchase. The transaction funded the older V3 vault with 6,898 atoms;
 * it is not the user's new Buffer setup and proves no seller delivery.
 */
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { ReadOnlyNearReceiptProvider } from '../agent/read-only-near-receipts.mjs';
import { graph, rootOf, fundingEvidence, statusKind } from '../agent/setup-receipt-graph.mjs';

const owner = 'bouncer-owner-12f343b795633e357ae5560d.testnet';
const vault = `vault.${owner}`;
const token = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
const signerPublicKey = 'ed25519:3FQ4vfUxvrWpfBgsxsiu9ER8jx71GeUHff5rUJx4zVog';
const originalHash = 'CUSSFm9M4sdrUvfphkzbyDxzsZXiDYRrmjdRmDn3jGzw';
const amount = '6898';
// The original is historical. The public FastNear endpoint is not archival and
// timed out; use the official archival testnet RPC for this single lookup.
const provider = new ReadOnlyNearReceiptProvider('https://archival-rpc.testnet.near.org', { timeoutMs: 25_000 });

if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('testnet RPC required');
const result = await provider.txStatusReceipts(originalHash, owner, 'FINAL');
assert.equal(result.final_execution_status, 'FINAL');
assert.equal(statusKind(result.status), 'value');
const batch = { actions: [nearApi.transactions.functionCall('ft_transfer_call',
  { receiver_id: vault, amount, msg: '' }, 200_000_000_000_000n, 1n)] };
const attempt = { stage_id: 'fund_vault_circle', tx_hash: originalHash, signer_id: owner,
  signer_public_key: signerPublicKey, receiver_id: token };
let g, funding;
try {
  g = graph(result);
  const root = rootOf(result, batch, attempt, g);
  funding = fundingEvidence(result, root, g, { owner, vault, token, amount, signerPublicKey });
} catch (error) {
  // Only public action-receipt metadata, never signed transaction bytes. This
  // bounded diagnostic helps distinguish legitimate nearcore shapes from an
  // incomplete/unexpected graph without weakening the verifier.
  const receipts = Array.isArray(result.receipts) ? result.receipts.slice(0, 12).map(r => {
    const a = r?.receipt?.Action;
    return { id: r.receipt_id, from: r.predecessor_id, to: r.receiver_id, kind: Object.keys(r.receipt ?? {}),
      signer: a?.signer_id, key: a?.signer_public_key, gas_price: a?.gas_price,
      inputs: a?.input_data_ids, outputs: a?.output_data_receivers,
      promise: a?.is_promise_yield, refund_to: a?.refund_to,
      actions: a?.actions?.map(x => ({ type: typeof x === 'string' ? x : Object.keys(x)[0],
        method: x?.FunctionCall?.method_name, deposit: x?.Transfer?.deposit ?? x?.FunctionCall?.deposit })) };
  }) : [];
  const outcomes = Array.isArray(result.receipts_outcome) ? result.receipts_outcome.slice(0, 12).map(x =>
    ({ id: x.id, executor: x.outcome?.executor_id, status: x.outcome?.status, children: x.outcome?.receipt_ids })) : [];
  console.error('PUBLIC_RECEIPT_SHAPE ' + JSON.stringify({ receipts, outcomes }));
  throw error;
}
const report = { status: 'HISTORICAL_FUNDING_GRAPH_MATCHED', network: 'testnet', original_hash: originalHash,
  amount_atoms: amount, linked_action_receipts: g.receipts.size, linked_outcomes: g.outcomes.size,
  vault_callback_receipt: funding.vault_callback_receipt, token_resolver_receipt: funding.token_resolver_receipt,
  signed_or_sent_now: false, new_wallet_setup: false, independent_seller_paid: false, independent_delivery_verified: false,
  trusted_rpc_not_consensus_proof: true, do_not_resend: true,
  scope: 'Existing V3 testnet vault funding only; not the new Buffer flow or a seller purchase.' };
console.log(JSON.stringify(report, null, 2));
