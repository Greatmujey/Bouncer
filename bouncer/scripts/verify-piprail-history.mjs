// READ ONLY. Fetch an already-finalized Circle testnet transfer, check its
// Bouncer receipt graph, then give the ACTUAL receipt to an isolated PipRail
// SDK 3.3.0 gate through a loopback RPC adapter. No key, signing, payments,
// merchant request or new order. The synthetic gate fixes its nonce to the
// OLD memo retrospectively; it is NOT a seller-issued quote or delivery.
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PaymentRpcProvider } from '../agent/near-account.mjs';
import { buildOnchainProofHeader, selectOnchainProofOffer, verifyOnchainProofSettlement } from '../agent/onchain-proof.mjs';
import { V2_HISTORICAL as h, V2_MEMOS } from './seller-v2-history-vectors.mjs';
import { loadPipRailTestSdk } from './piprail-test-adapter.mjs';

const HISTORICAL_AGENT_KEY = 'ed25519:kMuMxfvV9WNLuhhqfawrcknYZh8ukCEVTGC4zR2kpXW';
const URL = 'http://127.0.0.1:40000/retrospective';
const goal = { version: 1, id: 'retrospective-check', contract_id: h.contract, owner_account_id: h.owner,
  policy_id: 'circle-resources', token: h.token, payee: h.vendor, max_amount: '1000', resource_url: URL,
  max_quote_age_seconds: 120, accept_public_proof_risk: true, accept_unbound_resource_risk: true };
const request = { id: goal.id, resource: 'api', policy_id: goal.policy_id, token: goal.token, payee: goal.payee,
  amount: '1000', memo: V2_MEMOS.compute };

export async function verifyPipRailHistory({ provider, sdk }) {
  if (!provider || typeof provider.viewNodeStatus !== 'function' || typeof provider.txStatusReceipts !== 'function' ||
      !sdk || typeof sdk.createPaymentGate !== 'function') throw new Error('testnet receipt provider and installed PipRail SDK required');
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const chain = await provider.txStatusReceipts(h.compute_tx, h.owner, 'FINAL');
  const settlement = verifyOnchainProofSettlement({ result: chain, goal, request, publicKey: HISTORICAL_AGENT_KEY, txHash: h.compute_tx });
  // Preserve the real logs/actions but remove the block hash so the SDK does
  // not issue a second historical block read for recency. This intentionally
  // exercises its documented FT path when block time is unavailable, and is
  // NOT proof of a fresh challenge or that a real merchant accepts old proof.
  const snapshot = structuredClone(chain);
  delete snapshot.transaction_outcome.block_hash;
  let sdkRpcReads = 0;
  const server = http.createServer(async (req, res) => {
    let body = '';
    try {
      for await (const chunk of req) { body += chunk; if (body.length > 64 * 1024) throw new Error('oversize RPC request'); }
      const call = JSON.parse(body); sdkRpcReads++;
      res.setHeader('content-type', 'application/json');
      if (!['tx', 'EXPERIMENTAL_tx_status'].includes(call.method)) throw new Error('unexpected loopback RPC method');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: snapshot }));
    } catch { res.statusCode = 400; res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const settings = { chain: 'near', token: { contractId: h.token, decimals: 6, symbol: 'USDC' },
      amount: '0.001', payTo: h.vendor, rpcUrl: `http://127.0.0.1:${server.address().port}`,
      generateNonce: () => V2_MEMOS.compute, maxTimeoutSeconds: 600 };
    const gate = sdk.createPaymentGate(settings), q = await gate.challenge(URL);
    const offer = selectOnchainProofOffer(goal, q.requiredHeader);
    const proof = buildOnchainProofHeader(goal, offer, h.compute_tx);
    const first = await gate.verify(proof), duplicate = await gate.verify(proof);
    if (first.kind !== 'paid' || first.receipt?.transaction !== h.compute_tx || duplicate.kind !== 'invalid' || duplicate.error !== 'tx_already_used') {
      throw new Error(`published verifier did not accept then reject replay: ${first.kind}/${duplicate.kind}`);
    }
    const wrongNonce = buildOnchainProofHeader(goal, { ...offer, extra: { ...offer.extra, nonce: 'substituted-nonce' } }, h.compute_tx);
    const badNonce = await sdk.createPaymentGate(settings).verify(wrongNonce);
    const badPayee = await sdk.createPaymentGate({ ...settings, payTo: 'attacker.testnet' }).verify(proof);
    if (badNonce.kind !== 'invalid' || badPayee.kind !== 'invalid') throw new Error('published verifier accepted a substituted nonce or payee');
    const afterRestart = await sdk.createPaymentGate(settings).verify(proof);
    if (afterRestart.kind !== 'paid') throw new Error('unexpected default replay-store behavior after gate restart');
    return { mode: 'read-only historical FINAL receipt; loopback SDK gate; no signing, payment, or external merchant request',
      tx_hash: h.compute_tx, token: h.token, payee: h.vendor, amount: settlement.amount,
      sdk: '@piprail/sdk@3.3.0', testnet_wrapper: 'published mainnet NEAR driver with network label switched to testnet and loopback RPC',
      sdk_rpc_reads: sdkRpcReads, substituted_nonce_rejected: true, substituted_payee_rejected: true,
      same_instance_replay_rejected: true, fresh_default_gate_accepts_again: true,
      challenge: 'retrospectively fixed to old memo; no independent seller quote, URL binding, delivery or adoption proved',
      trust: 'FINAL data from configured testnet RPC; published verifier receives the receipt without its block timestamp; output is not a light-client proof' };
  } finally { await new Promise(resolve => server.close(resolve)); }
}

async function main() {
  const sdk = await loadPipRailTestSdk(process.env.BOUNCER_PIPRAIL_PACKAGE_ROOT);
  const provider = new PaymentRpcProvider(process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com');
  const result = await verifyPipRailHistory({ provider, sdk });
  console.log(`::notice title=Read-only third-party SDK receipt compatibility::${JSON.stringify(result)}`);
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`[piprail-history] ${error.stack || error}`); process.exitCode = 1; });
}
