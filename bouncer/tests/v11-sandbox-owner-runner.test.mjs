/** Synthetic loopback JSON-RPC integration of the *test harness*. The server
 * invents state and receipts; this test is NOT a nearcore or testnet run. */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import nearApi from 'near-api-js';
import { buildUnsignedSvalinTrialSetup } from '../agent/svalin-setup-plan.mjs';
import { RUNNER_OWNER, RUNNER_VAULT, exerciseSandboxOwnerRunner } from '../integration/v11-sandbox-owner-runner.mjs';
import { SANDBOX_CHAIN_ID } from '../integration/v11-sandbox-support.mjs';
import { fixture, resultFor, addSyntheticSystemGasRefund, omitSyntheticLocalAddKeyReceipt } from './fixtures/svalin-setup-fixture.mjs';
import { BLOCK, REG, snapshot, providerFor } from './fixtures/svalin-setup-rpc-fixture.mjs';

const pub = pair => String(pair.getPublicKey());
const stringify = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
function makeFixture(wasm, ownerKey, agentKey) {
  const inputs = { goal: { version: 1, id: 'sandbox-runner-only', owner: RUNNER_OWNER, vault: RUNNER_VAULT,
    vault_code_hash: nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(wasm).digest()), policy_id: 'svalin',
    accept_unsigned_seller_risk: true, accept_exact_amount_matching_risk: true },
    wasmBytes: wasm, agentPublicKey: pub(agentKey), initialVaultFundingYocto: String(7n * 10n ** 24n),
    agentGasAllowanceYocto: String(10n ** 24n), vaultTokenStorageDepositYocto: REG };
  return { inputs, plan: buildUnsignedSvalinTrialSetup(inputs), ownerKey: pub(ownerKey) };
}

async function fakeRpc(f) {
  const state = { stage: 0, sends: 0, receipts: new Map(), unexpected: [] };
  const server = http.createServer(async (req, res) => {
    let rpc;
    try {
      let text = '';
      for await (const chunk of req) text += chunk;
      rpc = JSON.parse(text);
      const p = rpc.params, s = snapshot(f, state.stage), fake = providerFor(f, s);
      s.block.header.timestamp_nanosec = String(BigInt(Date.now()) * 1_000_000n);
      s.protocol.chain_id = SANDBOX_CHAIN_ID;
      s.ownerKey.nonce = BigInt(state.stage + 2);
      let result;
      if (rpc.method === 'status') result = { chain_id: SANDBOX_CHAIN_ID, sync_info: { syncing: false } };
      else if (rpc.method === 'block') result = await fake.viewBlock({ finality: p.finality });
      else if (rpc.method === 'EXPERIMENTAL_protocol_config') {
        assert.deepEqual(p, { block_id: BLOCK });
        result = await fake.experimental_protocolConfig({ blockId: p.block_id });
      } else if (rpc.method === 'query') {
        assert.equal(p.block_id, BLOCK);
        if (rpc.id === 'bouncer-pinned-presence') {
          assert.equal(state.stage, 0); assert.equal(p.account_id, RUNNER_VAULT);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(stringify({ jsonrpc: '2.0', id: rpc.id, error: { cause: { name: 'UNKNOWN_ACCOUNT',
            info: { requested_account_id: RUNNER_VAULT, block_hash: BLOCK } } } }));
          return;
        }
        if (p.request_type === 'view_account') result = { ...(await fake.viewAccount(p.account_id, { blockId: p.block_id })), locked: '0' };
        else if (p.request_type === 'view_access_key') result = await fake.viewAccessKey(p.account_id, p.public_key, { blockId: p.block_id });
        else if (p.request_type === 'view_access_key_list') result = await fake.viewAccessKeyList(p.account_id, { blockId: p.block_id });
        else if (p.request_type === 'call_function') result = await fake.callFunctionRaw(p.account_id, p.method_name,
          JSON.parse(Buffer.from(p.args_base64, 'base64').toString()), { blockId: p.block_id });
        else throw new Error('unexpected synthetic query');
      } else if (rpc.method === 'send_tx') {
        assert.equal(p.wait_until, 'FINAL');
        const signed = nearApi.transactions.SignedTransaction.decode(Buffer.from(p.signed_tx_base64, 'base64'));
        assert.equal(signed.transaction.signerId, RUNNER_OWNER);
        assert.equal(signed.transaction.nonce, BigInt(state.stage + 3));
        const hash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256')
          .update(nearApi.transactions.encodeTransaction(signed.transaction)).digest());
        let chain = resultFor(f, state.stage, hash);
        if (state.stage === 2) chain = omitSyntheticLocalAddKeyReceipt(f, chain);
        if (state.stage === 3) chain = addSyntheticSystemGasRefund(f, chain);
        state.receipts.set(hash, chain);
        state.sends++; state.stage++;
        result = { transaction_outcome: { id: hash } };
      } else if (rpc.method === 'EXPERIMENTAL_tx_status') {
        assert.equal(p.wait_until, 'FINAL'); assert.equal(p.sender_account_id, RUNNER_OWNER);
        result = state.receipts.get(p.tx_hash);
        assert.ok(result, 'only original synthetic hashes can be looked up');
      } else throw new Error('unexpected synthetic method');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    } catch (error) {
      state.unexpected.push(String(error));
      res.writeHead(500); res.end('synthetic RPC failure');
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { state, url: `http://127.0.0.1:${server.address().port}`,
    close: async () => { server.closeAllConnections(); server.close(); await once(server, 'close'); } };
}

test('sandbox owner harness wires all stages and lost-ack recovery against explicitly synthetic loopback RPC', async () => {
  const initial = fixture();
  const wasm = Buffer.from(initial.inputs.wasmBytes);
  initial.close();
  const ownerKey = nearApi.KeyPair.fromRandom('ed25519'), agentKey = nearApi.KeyPair.fromRandom('ed25519');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-sandbox-runner-test-'));
  const rpc = await fakeRpc(makeFixture(wasm, ownerKey, agentKey)), checkpoints = [];
  try {
    const result = await exerciseSandboxOwnerRunner({ rpcUrl: rpc.url, wasm, tokenStorageMin: REG, directory: dir,
      ownerKey, agentKey, checkpoint: text => checkpoints.push(text) });
    assert.equal(result.production_testnet_chain_check_not_exercised, true);
    assert.equal(result.actual_node_chain_id_is_aliased_to_testnet_only_in_this_harness, true);
    assert.equal(result.simulated_approvals_are_not_user_consent_or_review, true);
    assert.equal(result.pinned_final_stage_snapshots.length, 5);
    assert.equal(result.post_funding_snapshot, 'READ_ONLY_FUNDED_VAULT_PROFILE_MATCH');
    assert.equal(result.exact_agent_key_allowance_checked, true);
    assert.equal(result.encrypted_original_journal_checks_before_transport, 5);
    assert.equal(result.coordinator_transport_calls, 5);
    assert.equal(result.simulated_lost_ack_recovered_original_without_resend, true);
    assert.equal(rpc.state.sends, 5);
    assert.deepEqual(rpc.state.unexpected, []);
    assert.equal(checkpoints.length, 6);
  } finally { await rpc.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
