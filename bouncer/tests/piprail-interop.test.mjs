// Runs only when the separately installed third-party SDK path is provided.
// The seller and RPC here are local fixtures, NOT an independent merchant or
// live blockchain. The SDK's actual published NEAR verifier is not mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { loadPipRailTestSdk } from '../scripts/piprail-test-adapter.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { buildOnchainProofHeader, runOnchainProofGoal } from '../agent/onchain-proof.mjs';
import { mockGuardedPayment } from './mock-guarded-payment.mjs';

const sdkRoot = process.env.BOUNCER_PIPRAIL_PACKAGE_ROOT;
test('published PipRail 3.3.0 verifies a synthetic nested Bouncer payment; default replay memory is process-local',
  { skip: !sdkRoot && 'install the pinned independent SDK and set BOUNCER_PIPRAIL_PACKAGE_ROOT' }, async () => {
    const sdk = await loadPipRailTestSdk(sdkRoot), keypair = nearApi.KeyPair.fromRandom('ed25519');
    const key = keypair.getPublicKey(), signer = new nearApi.KeyPairSigner(keypair);
    const goal = { version: 1, id: 'api-1', contract_id: 'bouncer.testnet', owner_account_id: 'owner.testnet', policy_id: 'api',
      token: TOKEN, payee: 'vendor.testnet', max_amount: '1000', resource_url: 'http://127.0.0.1:40000/api',
      max_quote_age_seconds: 120, accept_public_proof_risk: true, accept_unbound_resource_risk: true };
    let chain, rpcReads = 0, sends = 0, sellerCalls = 0;
    const rpc = http.createServer(async (req, res) => {
      let text = ''; for await (const part of req) text += part;
      const call = JSON.parse(text); rpcReads++;
      res.setHeader('content-type', 'application/json');
      if (!chain || !['tx', 'EXPERIMENTAL_tx_status'].includes(call.method)) {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, error: { code: -32601, message: `unexpected ${call.method}` } })); return;
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: chain }));
    });
    await new Promise(resolve => rpc.listen(0, '127.0.0.1', resolve));
    try {
      const rpcUrl = `http://127.0.0.1:${rpc.address().port}`;
      const settings = { chain: 'near', token: { contractId: TOKEN, decimals: 6, symbol: 'USDC' }, amount: '0.001', payTo: goal.payee,
        rpcUrl, generateNonce: () => 'real-sdk-quote-nonce' };
      const gate = sdk.createPaymentGate(settings);
      const handler = sdk.toFetchHandler(gate, async () => { sellerCalls++; return new Response('{"sdk":"accepted"}', { headers: { 'content-type': 'application/json' } }); });
      const entries = new Map(), journal = { get: id => entries.get(id), list: () => structuredClone([...entries.values()]),
        put: (id, value) => entries.set(id, structuredClone({ ...value, id })) };
      const account = { accountId: goal.owner_account_id, signer,
        async createTransaction(receiver, actions, pub) { return nearApi.transactions.createTransaction(goal.owner_account_id, pub, receiver, 9n, actions, Buffer.alloc(32, 3)); } };
      const provider = { async viewNodeStatus() { return { chain_id: 'testnet' }; },
        async viewAccessKey() { return { permission: { FunctionCall: { receiver_id: goal.contract_id, method_names: ['execute'] } } }; },
        async callFunction(_, method) {
          if (method === 'contract_version') return 'bouncer-agent-v9';
          if (method === 'get_owner') return goal.owner_account_id;
          if (method === 'get_policy') return { token: TOKEN };
          if (method === 'is_agent_key_allowed') return true;
          if (method === 'check') return [true, 'ok'];
          if (method === 'storage_balance_of') return { total: '1250000000000000000000' };
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
          return { transaction_outcome: { id: hash } };
        },
        async txStatusReceipts(hash) { assert.equal(hash, chain.transaction.hash); return structuredClone(chain); },
      };
      const result = await runOnchainProofGoal({ goal, provider, account, publicKey: key, journal, execute: true,
        fetchImpl: (url, options) => handler(new Request(url, options)), log: () => {} });
      assert.equal(result.status, 'RESPONDED'); assert.equal(sends, 1); assert.equal(sellerCalls, 1); assert.ok(rpcReads > 0);
      assert.equal(Buffer.from(result.response.body_base64, 'base64').toString(), '{"sdk":"accepted"}');
      const stored = journal.get(goal.id), header = buildOnchainProofHeader(goal, stored.protocol.offer, stored.tx_hash);
      const replay = await gate.verify(header); assert.equal(replay.kind, 'invalid'); assert.equal(replay.error, 'tx_already_used');
      // A newly constructed SDK gate loses its built-in replay set. This is a
      // deliberately adversarial test, NOT a durable-replay guarantee.
      const restarted = sdk.createPaymentGate(settings), replayAfterRestart = await restarted.verify(header);
      assert.equal(replayAfterRestart.kind, 'paid');
    } finally { await new Promise(resolve => rpc.close(resolve)); }
  });
