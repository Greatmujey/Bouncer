import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { runOnchainProofLiveProof } from '../agent/onchain-proof-live-proof.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { mockGuardedPayment } from './mock-guarded-payment.mjs';

const kp = nearApi.KeyPair.fromRandom('ed25519'), key = kp.getPublicKey(), signer = new nearApi.KeyPairSigner(kp);
const goal = { version: 1, id: 'api', contract_id: 'bouncer.testnet', owner_account_id: 'owner.testnet', policy_id: 'api',
  token: TOKEN, payee: 'seller.testnet', max_amount: '1000', resource_url: 'http://127.0.0.1:40000/api',
  max_quote_age_seconds: 120, accept_public_proof_risk: true, accept_unbound_resource_risk: true };
const offer = { scheme: 'onchain-proof', network: 'near:testnet', amount: '1000', asset: TOKEN, payTo: goal.payee,
  maxTimeoutSeconds: 600, extra: { nonce: 'live-harness-nonce', decimals: 6, minConfirmations: 1, amountFormatted: '0.001' } };
function fixture() {
  let chain, sends = 0, requests = 0, reopen = 0, realFailure = false;
  let entries = new Map();
  const journal = { get: id => entries.get(id), list: () => structuredClone([...entries.values()]),
    put: (id, value) => entries.set(id, structuredClone({ ...value, id })) };
  const account = { accountId: goal.owner_account_id, signer,
    async createTransaction(receiver, actions, publicKey) {
      return nearApi.transactions.createTransaction(goal.owner_account_id, publicKey, receiver, 4n, actions, Buffer.alloc(32, 7));
    } };
  const provider = { async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewAccessKey() { return { permission: { FunctionCall: { receiver_id: goal.contract_id, method_names: ['execute'] } } }; },
    async callFunction(_, method) {
      if (method === 'contract_version') return 'bouncer-agent-v9';
      if (method === 'get_owner') return goal.owner_account_id;
      if (method === 'get_policy') return { token: TOKEN };
      if (method === 'is_agent_key_allowed') return true;
      if (method === 'check') return [true, 'ok'];
      if (method === 'storage_balance_of') return { total: '1' };
      throw new Error('unexpected view');
    },
    async sendTransactionUntil(signed) {
      sends++;
      const hash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(nearApi.transactions.encodeTransaction(signed.transaction)).digest());
      assert.equal(journal.get(goal.id).tx_hash, hash);
      const args = JSON.parse(Buffer.from(signed.transaction.actions[0].functionCall.args).toString());
      chain = mockGuardedPayment({ hash, owner: goal.owner_account_id, contract: goal.contract_id, publicKey: String(key), args });
      chain.receipts_outcome[1].outcome.logs = ['EVENT_JSON:' + JSON.stringify({ standard: 'nep141', version: '1.0.0', event: 'ft_transfer',
        data: [{ old_owner_id: goal.contract_id, new_owner_id: goal.payee, amount: args.amount, memo: args.memo }] })];
      if (realFailure) throw new Error('underlying RPC ambiguous');
      return { transaction_outcome: { id: hash } };
    },
    async txStatusReceipts(hash) { assert.equal(hash, journal.get(goal.id).tx_hash); return structuredClone(chain); },
  };
  const fetchImpl = async (_, init) => {
    requests++;
    if (!init.headers) return new Response('', { status: 402, headers: { 'payment-required': Buffer.from(JSON.stringify({ x402Version: 2,
      resource: { url: '' }, accepts: [offer] })).toString('base64') } });
    assert.equal(journal.get(goal.id).redemption.status, 'attempted');
    return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
  };
  return { goal, provider, account, publicKey: key, getJournal: () => journal, fetchImpl,
    async reopenJournal() { reopen++; entries = new Map(structuredClone([...entries.entries()])); },
    setFailure(v) { realFailure = v; }, get sends() { return sends; }, get requests() { return requests; }, get reopen() { return reopen; } };
}

test('one-shot interoperability harness recovers a synthetic lost payment response without a second send', async () => {
  const f = fixture(), proof = await runOnchainProofLiveProof(f);
  assert.equal(proof.payment_broadcasts, 1); assert.equal(proof.quote_requests, 1); assert.equal(proof.seller_redemption_requests, 1);
  assert.equal(proof.lost_payment_response_recovered_without_key, true); assert.equal(proof.response_reused_after_journal_restart, true);
  assert.equal(f.sends, 1); assert.equal(f.requests, 2); assert.equal(f.reopen, 2);
  assert.deepEqual(JSON.parse(Buffer.from(proof.response.body_base64, 'base64')), { ok: true });
});

test('underlying ambiguous RPC or an existing journal stops the harness without a retry', async () => {
  const f = fixture(); f.setFailure(true);
  await assert.rejects(runOnchainProofLiveProof(f), /underlying RPC ambiguous/);
  assert.equal(f.sends, 1); assert.equal(f.requests, 1); assert.equal(f.getJournal().get(goal.id).status, 'pending');
  await assert.rejects(runOnchainProofLiveProof(f), /existing payment entry/);
  assert.equal(f.sends, 1); assert.equal(f.requests, 1);
});
