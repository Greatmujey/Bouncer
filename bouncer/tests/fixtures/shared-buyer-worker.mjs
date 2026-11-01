// Test-only worker: real PostgreSQL, actual signatures, synthetic NEAR and seller.
import crypto from 'node:crypto';
import pg from 'pg';
import nearApi from 'near-api-js';
import { openPostgresBuyerJournal } from '../../agent/postgres-buyer-journal.mjs';
import { runResourceAgent } from '../../agent/resource-agent.mjs';
import { orderMemoV3 } from '../../packages/provider-sdk/lib/resource-order.mjs';

const owner = 'owner.testnet', contract = 'bouncer.testnet', token = 'token.testnet', payee = 'seller.testnet';
const origin = 'https://synthetic-seller.example';
const goal = { id: 'work', resource: 'compute', policy_id: 'resources', token, payee,
  max_amount: '1000', order_binding: 'seller-v3', input: { text: 'process race', rounds: 2 } };
const keyPair = nearApi.KeyPair.fromString(process.env.BOUNCER_TEST_AGENT_KEY), signer = new nearApi.KeyPairSigner(keyPair);
const publicKey = keyPair.getPublicKey();
const pool = new pg.Pool({ connectionString: process.env.BOUNCER_TEST_POSTGRES_URL, max: 1 });
let journal;
let allow;
const gate = new Promise(resolve => { allow = resolve; });
process.on('message', message => { if (message?.type === 'go') allow(); });
try {
  journal = await openPostgresBuyerJournal({ pool, contractId: contract, ownerAccountId: owner,
    journalId: process.env.BOUNCER_TEST_JOURNAL, key: Buffer.from(process.env.BOUNCER_TEST_JOURNAL_KEY, 'hex') });
  process.send?.({ type: 'opened' });
  const provider = {
    async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewAccessKey() { return { permission: { FunctionCall: { receiver_id: contract, method_names: ['execute'] } } }; },
    async callFunction(_, method) {
      if (method === 'contract_version') return 'bouncer-agent-v9';
      if (method === 'get_policy') return { token, per_tx_cap: '1000', daily_cap: '10000' };
      if (method === 'is_agent_key_allowed') return true;
      if (method === 'check') return [true, 'ok'];
      if (method === 'daily_spent' || method === 'ft_balance_of') return '0';
      if (method === 'vault_balance') return '10000';
      throw new Error('unexpected synthetic RPC method');
    },
    async sendTransactionUntil(signed) {
      const hash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(nearApi.transactions.encodeTransaction(signed.transaction)).digest());
      process.send?.({ type: 'broadcast', hash }); // synthetic, not a network submission
      if (process.env.BOUNCER_TEST_HOLD === '1') await new Promise(() => {});
      throw new Error('synthetic ambiguous send');
    },
    async txStatusReceipts() { throw new Error('synthetic unavailable receipt'); },
  };
  const account = { accountId: owner, signer, async createTransaction(receiver, actions, key) {
    const tx = nearApi.transactions.createTransaction(owner, key, receiver, BigInt(process.env.BOUNCER_TEST_NONCE), actions, Buffer.alloc(32, 4));
    const hash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(nearApi.transactions.encodeTransaction(tx)).digest());
    process.send?.({ type: 'signed', hash });
    return tx;
  } };
  await runResourceAgent({ contractId: contract, ownerAccountId: owner, goals: [goal], providerUrl: origin,
    getQuote: async order => { process.send?.({ type: 'quote' }); return { resource: order.resource, policy_id: 'resources', token, payee, amount: '1000',
      memo: orderMemoV3(order.resource, order.input, process.env.BOUNCER_TEST_CHALLENGE),
      auth_scheme: 'bouncer-nep413-claim-v1', seller_origin: origin }; },
    fulfill: async () => { throw new Error('must not fulfill a pending payment'); }, provider, account, publicKey, journal,
    execute: true, durablePayment: true, log: () => {},
    beforePayment: async () => { if (process.env.BOUNCER_TEST_BARRIER === '1') { process.send?.({ type: 'prepared' }); await gate; } },
  });
  process.send?.({ type: 'result', ok: true });
} catch (error) {
  process.send?.({ type: 'result', ok: false, code: error.code ?? null, message: String(error.message).slice(0, 300) });
} finally {
  if (journal) await journal.close();
  await pool.end();
  process.disconnect?.();
}
