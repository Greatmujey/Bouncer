/** Synthetic loopback wiring for the test-only buyer harness. All balances,
 * seller responses and receipts are invented; this is NOT nearcore/testnet. */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import nearApi from 'near-api-js';
import { SandboxBuyerRpc, exerciseSandboxBuyerRunner } from '../integration/v11-sandbox-buyer-runner.mjs';
import { RUNNER_OWNER, RUNNER_VAULT } from '../integration/v11-sandbox-owner-runner.mjs';
import { SANDBOX_CHAIN_ID } from '../integration/v11-sandbox-support.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { SVALIN_PAYEE } from '../agent/svalin-pro-readiness.mjs';
import { mockGuardedPayment, mockHash } from './mock-guarded-payment.mjs';

const enc = value => Buffer.from(JSON.stringify(value)).toString('base64');
const FINAL = mockHash('sandbox-buyer-final'), TX_BLOCK = mockHash('sandbox-buyer-tx'), EXEC_BLOCK = mockHash('sandbox-buyer-execution');
const INITIAL = 5_009_999n, AMOUNT = 5_004_217n, SELLER_INITIAL = 2_000_000n;

async function fakeRpc(wasm, agentKey, { corruptEvent = false } = {}) {
  const publicKey = String(agentKey.getPublicKey());
  const codeHash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(wasm).digest());
  const state = { status: SANDBOX_CHAIN_ID, pinned: null, sends: 0, seller: SELLER_INITIAL,
    balance: INITIAL, spent: 0n, chain: null, unexpected: [] };
  const server = http.createServer(async (req, res) => {
    let message;
    try {
      let text = '';
      for await (const chunk of req) text += chunk;
      message = JSON.parse(text);
      const p = message.params;
      let result;
      if (message.method === 'status') result = { chain_id: state.status, sync_info: { syncing: false } };
      else if (message.method === 'block') result = { header: { hash: FINAL, height: 100,
        timestamp_nanosec: String(BigInt(Date.now()) * 1_000_000n) } };
      else if (message.method === 'query') {
        const block = p.block_id ?? FINAL;
        assert.ok([FINAL, TX_BLOCK, EXEC_BLOCK].includes(block));
        if (p.request_type === 'view_account') {
          assert.equal(p.account_id, RUNNER_VAULT);
          result = { block_hash: block, code_hash: codeHash, amount: String(7n * 10n ** 24n), locked: '0' };
        } else if (p.request_type === 'view_access_key_list') {
          assert.equal(p.account_id, RUNNER_VAULT);
          result = { block_hash: block, keys: [] };
        } else if (p.request_type === 'view_access_key') {
          assert.equal(p.account_id, RUNNER_OWNER); assert.equal(p.public_key, publicKey);
          result = { block_hash: block, nonce: 2, permission: { FunctionCall: { receiver_id: RUNNER_VAULT,
            method_names: ['execute_exact_ft'], allowance: String(10n ** 24n) } } };
        } else if (p.request_type === 'call_function') {
          const args = JSON.parse(Buffer.from(p.args_base64, 'base64').toString());
          let value;
          if (p.account_id === TOKEN && p.method_name === 'storage_balance_of') {
            assert.equal(args.account_id, SVALIN_PAYEE); value = { total: '1250000000000000000000', available: '0' };
          } else if (p.account_id === TOKEN && p.method_name === 'ft_balance_of') {
            if (args.account_id === RUNNER_VAULT) value = state.balance.toString();
            else if (args.account_id === SVALIN_PAYEE) value = state.seller.toString();
            else throw new Error('unexpected mock FT account');
          } else {
            assert.equal(p.account_id, RUNNER_VAULT);
            if (p.method_name === 'get_owner') value = RUNNER_OWNER;
            else if (p.method_name === 'contract_version') value = 'bouncer-agent-v11-exact-ft-testnet';
            else if (['is_exact_ft_policy_locked', 'is_exact_ft_payee_locked', 'is_agent_key_allowed'].includes(p.method_name)) value = true;
            else if (p.method_name === 'get_policy') value = { token: TOKEN, per_tx_cap: INITIAL.toString(), daily_cap: INITIAL.toString() };
            else if (p.method_name === 'check') value = [true, 'synthetic allowed'];
            else if (p.method_name === 'vault_balance') value = state.balance.toString();
            else if (p.method_name === 'daily_spent') value = state.spent.toString();
            else if (p.method_name === 'get_exact_ft_intent') {
              assert.equal(args.intent_id, state.pinned?.intent_id);
              value = { ...state.pinned, consumed: state.sends > 0, active: state.sends === 0 };
            } else throw new Error(`unexpected synthetic view ${p.method_name}`);
          }
          result = { block_hash: block, result: [...Buffer.from(JSON.stringify(value))] };
        } else throw new Error('unexpected synthetic query');
      } else if (message.method === 'send_tx') {
        assert.equal(p.wait_until, 'FINAL');
        const signed = nearApi.transactions.SignedTransaction.decode(Buffer.from(p.signed_tx_base64, 'base64'));
        const tx = signed.transaction, call = tx.actions[0].functionCall;
        assert.equal(tx.signerId, RUNNER_OWNER); assert.equal(tx.receiverId, RUNNER_VAULT);
        assert.equal(`ed25519:${nearApi.utils.serialize.base_encode(Buffer.from(tx.publicKey.ed25519Key.data))}`, publicKey);
        assert.equal(call.methodName, 'execute_exact_ft');
        assert.equal(call.deposit, 0n); assert.deepEqual(JSON.parse(Buffer.from(call.args).toString()), { intent_id: state.pinned.intent_id });
        assert.equal(state.sends, 0, 'only one synthetic send is allowed');
        const hash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256')
          .update(nearApi.transactions.encodeTransaction(tx)).digest());
        const a = state.pinned;
        const chain = mockGuardedPayment({ hash, owner: RUNNER_OWNER, contract: RUNNER_VAULT, publicKey,
          args: { policy_id: a.policy_id, payee: a.payee, amount: a.amount, memo: a.memo, expected_token: a.token } });
        chain.transaction_outcome.block_hash = TX_BLOCK; chain.receipts_outcome[0].block_hash = EXEC_BLOCK;
        chain.transaction.actions[0].FunctionCall.method_name = 'execute_exact_ft';
        chain.transaction.actions[0].FunctionCall.args = enc({ intent_id: a.intent_id });
        chain.receipts_outcome[0].outcome.logs = ['BOUNCER exact FT intent consumed; transfer initiated'];
        chain.receipts_outcome[1].outcome.logs = corruptEvent ? [] : ['EVENT_JSON:' + JSON.stringify({ standard: 'nep141',
          version: '1.0.0', event: 'ft_transfer', data: [{ old_owner_id: RUNNER_VAULT, new_owner_id: SVALIN_PAYEE,
            amount: a.amount, memo: a.memo }] })];
        chain.receipts_outcome[2].outcome.logs = ['BOUNCER exact FT transfer succeeded; intent stays consumed'];
        const callback = chain.receipts[1].receipt.Action.actions[0].FunctionCall;
        callback.method_name = 'after_exact_ft_transfer';
        callback.args = enc({ intent_id: a.intent_id, policy_id: a.policy_id, token: a.token,
          amount: a.amount, bucket: 24, policy_revision: a.policy_revision });
        state.chain = chain; state.sends++; state.balance -= AMOUNT; state.seller += AMOUNT; state.spent += AMOUNT;
        result = { transaction_outcome: { id: hash } };
      } else if (message.method === 'EXPERIMENTAL_tx_status') {
        assert.equal(p.sender_account_id, RUNNER_OWNER); assert.equal(p.wait_until, 'FINAL');
        assert.equal(p.tx_hash, state.chain?.transaction_outcome.id);
        result = state.chain;
      } else throw new Error(`unexpected synthetic RPC ${message.method}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    } catch (error) {
      state.unexpected.push(String(error));
      res.writeHead(500); res.end('synthetic RPC failure');
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { state, url: `http://127.0.0.1:${server.address().port}`,
    async pinIntent(call) {
      assert.equal(call.receiver_id, RUNNER_VAULT); assert.equal(call.method, 'set_exact_ft_intent');
      assert.equal(call.attached_yocto, '1');
      const a = call.args;
      state.pinned = { intent_id: a.intent_id, policy_id: a.policy_id, token: a.expected_token,
        payee: a.payee, amount: a.amount, memo: a.memo, review_hash: a.review_hash, expires_at_ms: a.expires_at_ms,
        agent_public_key: a.agent_public_key, policy_revision: 1, payee_revision: 2, agent_revision: 3,
        consumed: false, cancelled: false, active: true };
    },
    close: async () => { server.closeAllConnections(); server.close(); await once(server, 'close'); } };
}

async function withFixture(options, operation) {
  const wasm = Buffer.from('synthetic V11 bytes, never deployed');
  const agentKey = nearApi.KeyPair.fromRandom('ed25519');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-sandbox-buyer-test-'));
  const rpc = await fakeRpc(wasm, agentKey, options), checkpoints = [];
  const args = { rpcUrl: rpc.url, wasm, directory: dir, agentKey, pinIntent: rpc.pinIntent,
    checkpoint: text => checkpoints.push(text) };
  try { await operation({ rpc, args, checkpoints }); }
  catch (error) {
    if (rpc.state.unexpected.length) error.message += `; synthetic RPC diagnostics: ${rpc.state.unexpected.join('; ')}`;
    throw error;
  } finally { await rpc.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('buyer harness wires real buyer logic to synthetic loopback state, a fake seller and original-hash recovery', async () => {
  await withFixture({}, async ({ rpc, args, checkpoints }) => {
    const originalFetch = globalThis.fetch;
    const result = await exerciseSandboxBuyerRunner(args);
    assert.equal(globalThis.fetch, originalFetch);
    assert.equal(result.local_chain_id_aliased_for_test_only, true);
    assert.equal(result.simulated_approvals_are_not_user_consent_or_review, true);
    assert.equal(result.seller_contacted, false);
    assert.equal(result.seller_offer_and_reservation_are_synthetic, true);
    assert.equal(result.encrypted_original_hash_journaled_before_transport, true);
    assert.equal(result.payment_transport_calls, 1);
    assert.equal(result.acknowledgement_lost_and_original_hash_recovered, true);
    assert.equal(result.payment_evidence, 'RECOVERED_PAYMENT_ONLY');
    assert.equal(result.seller_attribution_verified, false); assert.equal(result.fulfillment_verified, false);
    assert.equal(rpc.state.sends, 1); assert.equal(rpc.state.balance, INITIAL - AMOUNT);
    assert.deepEqual(rpc.state.unexpected, []); assert.equal(checkpoints.length, 2);
  });
});

test('missing synthetic token event fails recovery without another send or a delivery claim', async () => {
  await withFixture({ corruptEvent: true }, async ({ rpc, args }) => {
    await assert.rejects(exerciseSandboxBuyerRunner(args), /missing unique Circle event/);
    assert.equal(rpc.state.sends, 1); assert.deepEqual(rpc.state.unexpected, []);
  });
});

test('buyer adapter refuses remote nodes, endpoint mutation, other chains and non-buyer actions', async () => {
  for (const url of ['https://rpc.testnet.near.org', 'http://localhost:3030', 'http://127.0.0.2:3030',
    'http://127.0.0.1:3030/path']) assert.throws(() => new SandboxBuyerRpc(url), /loopback HTTP URL/);
  await withFixture({}, async ({ rpc, args }) => {
    const provider = new SandboxBuyerRpc(rpc.url);
    assert.throws(() => { provider.connection.url = 'https://rpc.testnet.near.org/'; }, TypeError);
    assert.throws(() => { provider.connection = { url: 'https://rpc.testnet.near.org/' }; }, TypeError);
    rpc.state.status = 'testnet';
    await assert.rejects(provider.viewNodeStatus(), /refusing to use an RPC/);
    await assert.rejects(exerciseSandboxBuyerRunner(args), /refusing to use an RPC/);
    assert.equal(rpc.state.pinned, null); assert.equal(rpc.state.sends, 0);
    const tx = nearApi.transactions.createTransaction(RUNNER_OWNER, args.agentKey.getPublicKey(), RUNNER_VAULT, 1n,
      [nearApi.transactions.functionCall('set_policy', {}, 1n, 1n)], Buffer.alloc(32, 1));
    const signer = new nearApi.KeyPairSigner(args.agentKey);
    const signed = (await signer.signTransaction(tx))[1];
    await assert.rejects(provider.sendTransactionOnce(signed, 'FINAL'), /restricted zero-deposit call/);
    const otherwiseValid = nearApi.transactions.createTransaction(RUNNER_OWNER, args.agentKey.getPublicKey(), RUNNER_VAULT, 1n,
      [nearApi.transactions.functionCall('execute_exact_ft', { intent_id: 'local-only' }, 200n * 10n ** 12n, 0n)], Buffer.alloc(32, 1));
    await assert.rejects(provider.sendTransactionOnce((await signer.signTransaction(otherwiseValid))[1], 'FINAL'), /refusing to use an RPC/);
    assert.equal(provider.transportCalls, 0);
  });
});
