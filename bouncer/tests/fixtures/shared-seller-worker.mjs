// Test-only worker process: real PostgreSQL coordination, synthetic FINAL NEAR receipts.
import pg from 'pg';
import { createSharedResourceProvider } from '../../services/shared-resource-provider.mjs';
import { mockGuardedPayment } from '../mock-guarded-payment.mjs';

const owner = 'owner.testnet', contract = 'bouncer.testnet';
const products = Object.fromEntries(['compute', 'storage', 'api'].map(resource => [resource,
  { policy_id: resource, token: 'token.testnet', payee: 'seller.testnet', amount: '1000' }]));
const pool = new pg.Pool({ connectionString: process.env.BOUNCER_TEST_POSTGRES_URL, max: 8 });
const receipts = new Map();
let releaseFetch;
const blocked = new Promise(resolve => { releaseFetch = resolve; });
const rpcProvider = { async viewNodeStatus() { return { chain_id: 'testnet' }; }, async txStatusReceipts(hash) {
  if (!receipts.has(hash)) throw new Error('missing synthetic receipt');
  return structuredClone(receipts.get(hash));
} };
const dataFetch = async () => {
  process.send?.({ type: 'fulfillment', pid: process.pid });
  await blocked;
  return new Response(JSON.stringify({ private: false, full_name: 'example/project', id: 42,
    description: null, stargazers_count: 5, forks_count: 2, open_issues_count: 1, license: null }),
  { status: 200, headers: { 'content-type': 'application/json' } });
};
try {
  const provider = await createSharedResourceProvider({ pool, rpcProvider, sellerId: process.env.BOUNCER_TEST_SELLER,
    contractId: contract, ownerAccountId: owner, sellerOrigin: process.env.BOUNCER_TEST_ORIGIN, products, dataFetch });
  await new Promise((resolve, reject) => { provider.server.once('error', reject); provider.server.listen(0, '127.0.0.1', resolve); });
  process.send?.({ type: 'ready', pid: process.pid, port: provider.server.address().port });
  process.on('message', async message => {
    if (message.type === 'receipt') {
      const { hash, quote, publicKey } = message;
      receipts.set(hash, mockGuardedPayment({ hash, owner, contract, publicKey, args: {
        policy_id: quote.policy_id, payee: quote.payee, amount: quote.amount, memo: quote.memo, expected_token: quote.token } }));
      process.send?.({ type: 'receipt-ready', id: message.id });
    } else if (message.type === 'release') {
      releaseFetch();
    } else if (message.type === 'close') {
      releaseFetch();
      await provider.close(); await pool.end(); process.disconnect();
    }
  });
} catch (error) {
  process.send?.({ type: 'error', message: String(error.message).slice(0, 300) });
  await pool.end(); process.exitCode = 1;
}
