/** Synthetic loopback JSON-RPC test of the sandbox harness. It does not run
 * nearcore, testnet, a public faucet helper, or real token transfers. */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import nearApi from 'near-api-js';
import { exerciseSandboxNativeFaucet } from '../integration/v11-sandbox-native-faucet.mjs';
import { SANDBOX_CHAIN_ID } from '../integration/v11-sandbox-support.mjs';
import { FAUCET_RETURN, FAUCET_TRANSFER_YOCTO } from '../agent/native-testnet-faucet.mjs';
import { NO_LOCAL_CONTRACT_HASH } from '../shared/plain-owner-profile.mjs';

const NEAR = 10n ** 24n, blockHash = nearApi.utils.serialize.base_encode(Buffer.alloc(32, 6));
const hashId = byte => nearApi.utils.serialize.base_encode(Buffer.alloc(32, byte));
const account = amount => ({ amount: amount.toString(), locked: '0', storage_usage: 200, code_hash: NO_LOCAL_CONTRACT_HASH, block_hash: blockHash });
const publicKeyText = key => `ed25519:${nearApi.utils.serialize.base_encode(Buffer.from(key.ed25519Key.data))}`;
const responseAction = (signed, hash) => {
  const tx = signed.transaction, a = tx.actions[0], deleting = Boolean(a.deleteAccount);
  const action = deleting ? { DeleteAccount: { beneficiary_id: a.deleteAccount.beneficiaryId } } :
    { Transfer: { deposit: a.transfer.deposit.toString() } };
  const root = hashId(deleting ? 21 : 20), refund = hashId(22);
  const body = { signer_id: tx.signerId, signer_public_key: publicKeyText(tx.publicKey), gas_price: '100',
    input_data_ids: [], output_data_receivers: [], actions: [action] };
  const payment = { receipt_id: refund, predecessor_id: 'system', receiver_id: FAUCET_RETURN,
    receipt: { Action: { signer_id: 'system', signer_public_key: 'ed25519:11111111111111111111111111111111',
      gas_price: '0', input_data_ids: [], output_data_receivers: [], actions: [{ Transfer: { deposit: String(4n * NEAR) } }] } } };
  return { final_execution_status: 'FINAL', status: { SuccessValue: '' },
    transaction: { hash, signer_id: tx.signerId, receiver_id: tx.receiverId, public_key: publicKeyText(tx.publicKey), nonce: Number(tx.nonce), actions: [action] },
    transaction_outcome: { id: hash, outcome: { executor_id: tx.signerId, receipt_ids: [root], status: { SuccessReceiptId: root } } },
    receipts: deleting ? [payment] : [{ receipt_id: root, predecessor_id: tx.signerId, receiver_id: tx.receiverId, receipt: { Action: body } }],
    receipts_outcome: [{ id: root, outcome: { executor_id: tx.receiverId, receipt_ids: deleting ? [refund] : [], status: { SuccessValue: '' } } },
      ...(deleting ? [{ id: refund, outcome: { executor_id: FAUCET_RETURN, receipt_ids: [], status: { SuccessValue: '' } } }] : [])] };
};
async function fakeRpc() {
  const state = { recipient: 100n * NEAR, beneficiary: NEAR, temp: null, sends: 0, helperCreates: 0, errors: [], receipts: new Map() };
  const root = { accountId: 'testnet', async signAndSendTransaction({ receiverId, actions, waitUntil }) {
    assert.equal(waitUntil, 'FINAL'); assert.equal(actions[0].enum, 'createAccount');
    assert.equal(actions[1].transfer.deposit, 10n * NEAR); assert.equal(actions[2].enum, 'addKey');
    state.helperCreates++; state.temp = { id: receiverId, key: String(actions[2].addKey.publicKey), nonce: 0,
      amount: 10n * NEAR, deleted: false };
    return { final_execution_status: 'FINAL', status: { SuccessValue: '' },
      receipts_outcome: [{ outcome: { status: { SuccessValue: '' } } }] };
  } };
  const server = http.createServer(async (req, res) => {
    let rpc;
    try {
      let body = ''; for await (const chunk of req) body += chunk; rpc = JSON.parse(body);
      const p = rpc.params; let result;
      if (rpc.method === 'status') result = { chain_id: SANDBOX_CHAIN_ID, sync_info: { syncing: false } };
      else if (rpc.method === 'block') result = { header: { hash: blockHash, timestamp_nanosec: String(BigInt(Date.now()) * 1_000_000n) } };
      else if (rpc.method === 'EXPERIMENTAL_protocol_config') {
        assert.equal(p.block_id, blockHash);
        result = { chain_id: SANDBOX_CHAIN_ID, protocol_version: 88, runtime_config: { storage_amount_per_byte: '10000000000000000000' } };
      } else if (rpc.method === 'query') {
        const id = p.account_id, existing = state.temp && id === state.temp.id && !state.temp.deleted;
        if (rpc.id === 'bouncer-pinned-presence' && !existing) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { cause: { name: 'UNKNOWN_ACCOUNT',
            info: { requested_account_id: id, block_hash: blockHash } } } })); return;
        }
        if (p.request_type === 'view_account') {
          if (id === 'owner.testnet') result = account(state.recipient);
          else if (id === FAUCET_RETURN) result = account(state.beneficiary);
          else { assert.ok(existing); result = account(state.temp.amount); }
        } else if (p.request_type === 'view_access_key') {
          assert.ok(existing); assert.equal(p.public_key, state.temp.key);
          result = { block_hash: blockHash, nonce: state.temp.nonce, permission: 'FullAccess' };
        } else if (p.request_type === 'view_access_key_list') {
          assert.ok(existing);
          result = { block_hash: blockHash, keys: [{ public_key: state.temp.key, access_key: { permission: 'FullAccess', nonce: state.temp.nonce } }] };
        } else throw new Error('unexpected synthetic query');
      } else if (rpc.method === 'send_tx') {
        assert.equal(p.wait_until, 'FINAL');
        const signed = nearApi.transactions.SignedTransaction.decode(Buffer.from(p.signed_tx_base64, 'base64'));
        const tx = signed.transaction, digest = crypto.createHash('sha256').update(nearApi.transactions.encodeTransaction(tx)).digest();
        const hash = nearApi.utils.serialize.base_encode(digest);
        const key = nearApi.utils.PublicKey.from(publicKeyText(tx.publicKey));
        assert.ok(key.verify(digest, Uint8Array.from(signed.signature.ed25519Signature.data))); assert.equal(tx.signerId, state.temp.id);
        assert.equal(tx.nonce, BigInt(state.temp.nonce + 1));
        const receipt = responseAction(signed, hash); state.receipts.set(hash, receipt); state.sends++; state.temp.nonce++;
        if (tx.actions[0].transfer) {
          assert.equal(tx.receiverId, 'owner.testnet'); assert.equal(tx.actions[0].transfer.deposit.toString(), FAUCET_TRANSFER_YOCTO);
          state.temp.amount -= BigInt(FAUCET_TRANSFER_YOCTO); state.recipient += BigInt(FAUCET_TRANSFER_YOCTO);
        } else {
          assert.equal(tx.actions[0].deleteAccount.beneficiaryId, FAUCET_RETURN); state.temp.deleted = true; state.beneficiary += 4n * NEAR;
        }
        result = { transaction_outcome: { id: hash } };
      } else if (rpc.method === 'EXPERIMENTAL_tx_status') {
        assert.equal(p.wait_until, 'FINAL'); assert.equal(p.sender_account_id, state.temp.id);
        result = state.receipts.get(p.tx_hash); assert.ok(result);
      } else throw new Error('unexpected synthetic method');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    } catch (error) { state.errors.push(String(error)); res.writeHead(500); res.end('synthetic RPC error'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { state, root, url: `http://127.0.0.1:${server.address().port}`,
    async close() { server.closeAllConnections(); server.close(); await once(server, 'close'); } };
}

test('native faucet sandbox harness preserves both original hashes against synthetic loopback RPC', async () => {
  const fake = await fakeRpc(), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-faucet-sandbox-'));
  try {
    const result = await exerciseSandboxNativeFaucet({ rpcUrl: fake.url, directory, root: fake.root });
    assert.equal(result.local_fake_helper_calls, 1); assert.equal(result.one_shot_transport_calls, 2);
    assert.equal(result.encrypted_original_journal_checks_before_transport, 2);
    assert.equal(result.both_original_hashes_recovered_after_simulated_lost_ack, true);
    assert.equal(result.public_helper_contacted, false); assert.equal(result.production_testnet_chain_check_not_exercised, true);
    assert.equal(fake.state.sends, 2); assert.equal(fake.state.helperCreates, 1); assert.deepEqual(fake.state.errors, []);
  } catch (error) {
    error.message += `; synthetic RPC errors: ${JSON.stringify(fake.state.errors)}`;
    throw error;
  } finally { await fake.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
test('native faucet sandbox harness rejects a remote RPC or non-sandbox root before network', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-faucet-guard-'));
  try {
    await assert.rejects(exerciseSandboxNativeFaucet({ rpcUrl: 'https://rpc.testnet.near.org', directory,
      root: { accountId: 'testnet', signAndSendTransaction() {} } }), /loopback/);
    await assert.rejects(exerciseSandboxNativeFaucet({ rpcUrl: 'http://127.0.0.1:1', directory,
      root: { accountId: 'owner.testnet', signAndSendTransaction() {} } }), /sandbox root/);
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
