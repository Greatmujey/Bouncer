#!/usr/bin/env node
/** Read-only public discovery. This does not create a quote, account or job,
 * does not sign or send a transaction, and does not authenticate a seller or
 * promise delivery. FastNear's POST endpoints below are *read-only queries*. */
import { PaymentRpcProvider } from '../agent/near-account.mjs';
import { readBoundedBytes } from '../shared/bounded-json.mjs';
import { MULTIAGENCY_ORIGIN, PRIOR_BLOCK, PRIOR_HASH, PRIOR_OWNER, PRIOR_PAYEE,
  summarizeMultiAgencyReadiness, verifyMultiAgencyIndexerControl } from '../agent/multiagency-readiness.mjs';

async function json(url, { method = 'GET', body } = {}) {
  const response = await fetch(url, { method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000),
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  try {
    if (!response.ok) throw new Error(`read-only endpoint returned HTTP ${response.status}`);
    const bytes = await readBoundedBytes(response, { maxBytes: 1_000_000, label: 'public read-only' });
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { await response.body?.cancel().catch(() => {}); }
}
async function main() {
  const [config, health, engagements, tasks] = await Promise.all(['/api/config', '/api/health', '/api/engagements', '/api/tasks']
    .map(p => json(`${MULTIAGENCY_ORIGIN}${p}`)));
  let indexerControl;
  try {
    const page = await json('https://tx.test.fastnear.com/v0/account', { method: 'POST',
      body: { account_id: PRIOR_PAYEE, from_tx_block_height: PRIOR_BLOCK, is_success: true,
        is_event_log: true, desc: false, limit: 200 } });
    if (!Array.isArray(page.account_txs) || !page.account_txs.some(item => item?.transaction_hash === PRIOR_HASH)) {
      throw new Error('original hash was not returned by the bounded account-index query');
    }
    const result = await json('https://tx.test.fastnear.com/v0/transactions', { method: 'POST', body: { tx_hashes: [PRIOR_HASH] } });
    if (!Array.isArray(result.transactions) || result.transactions.length !== 1) throw new Error('original indexed transaction unavailable');
    const provider = new PaymentRpcProvider('https://archival-rpc.testnet.near.org', { timeoutMs: 30_000 });
    if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('archival RPC does not report testnet');
    const final = await provider.txStatusReceipts(PRIOR_HASH, PRIOR_OWNER, 'FINAL');
    indexerControl = verifyMultiAgencyIndexerControl({ indexed: result.transactions[0], final });
  } catch (error) {
    // Do not print raw indexer responses, signatures, task memos or stack traces.
    indexerControl = { status: 'UNAVAILABLE_OR_UNVERIFIED', reason: String(error.message).slice(0, 200),
      scope: 'not evidence that an otherwise valid payment would or would not be indexed' };
  }
  const observation = summarizeMultiAgencyReadiness({ config, health, engagements, tasks, indexerControl });
  console.log(`::notice title=Independent Circle testnet research-provider readiness::${JSON.stringify(observation)}`);
}
main().catch(error => { console.error(`[multiagency-readiness] ${error.message}`); process.exitCode = 1; });
