/**
 * Extremely small synthetic RPC/token/receipt model, for testing sandbox
 * harness wiring against the hash-pinned V11 WASM. NOT nearcore, NEP-141
 * conformance, Circle, PayPerCall, delivery, settlement or a network service.
 * It implements only the successful paths that the test harness requests.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import nearApi from 'near-api-js';
import { SyntheticNearHost } from './v11-synthetic-host.mjs';
import { SANDBOX_CHAIN_ID } from '../../integration/v11-sandbox-support.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../../scripts/circle-testnet-setup.mjs';

const blockHash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update('synthetic-block').digest());
const pub = value => `ed25519:${nearApi.utils.serialize.base_encode(Buffer.from(value.ed25519Key.data))}`;
const keyBytes = value => Buffer.concat([Buffer.from([0]), Buffer.from(value.ed25519Key.data)]);

export async function createSyntheticEscrowRpc(wasm, { callbackOnPlain = false } = {}) {
  const rootKey = nearApi.KeyPair.fromRandom('ed25519'), ownerKey = nearApi.KeyPair.fromRandom('ed25519');
  const accounts = new Map(), vaults = new Map(), token = new Map([['owner.testnet', 100_000n]]);
  const unexpected = [], state = { requests: 0, sends: 0, unexpected, callbackOnPlain };
  const addAccount = (id, pair) => accounts.set(id, { keys: new Map([[String(pair.getPublicKey()), { nonce: 0, permission: 'FullAccess' }]]) });
  addAccount('testnet', rootKey); addAccount('owner.testnet', ownerKey);
  const outcome = (executor, logs = []) => ({ id: `synthetic-receipt-${state.sends}`, outcome: {
    executor_id: executor, status: { SuccessValue: '' }, logs, receipt_ids: [] } });
  const balance = id => token.get(id) ?? 0n;
  const credit = (id, n) => token.set(id, balance(id) + n);
  const debit = (id, n) => { assert.ok(balance(id) >= n, 'synthetic FT insufficient balance'); token.set(id, balance(id) - n); };
  const context = (current, predecessor, signer, signerPk, deposit = 0n, extra = {}) =>
    ({ current, predecessor, signer, signerPk, deposit, ...extra });
  function receiverHook(receiver, sender, amount, msg, signerId, signerPk) {
    const h = vaults.get(receiver); assert.ok(h, 'synthetic receiver is missing');
    const r = h.call('ft_on_transfer', { sender_id: sender, amount, msg }, context(receiver, TOKEN, signerId, signerPk));
    assert.equal(r.value, '0', 'synthetic model supports only a fully used transfer-call');
  }
  function dispatchVault(receiver, method, args, deposit, signerId, signerPk) {
    const h = vaults.get(receiver); assert.ok(h, `no synthetic vault for ${receiver}`);
    const response = h.call(method, args, context(receiver, signerId, signerId, signerPk, deposit));
    const logs = [...response.logs];
    if (response.promises.length) {
      assert.equal(response.promises.length, 2);
      const promise = response.promises[0], action = promise.actions[0], callback = response.promises[1].actions[0];
      assert.equal(promise.receiver, TOKEN);
      assert.ok(['ft_transfer', 'ft_transfer_call'].includes(action.method));
      const a = action.args, amount = BigInt(a.amount);
      debit(receiver, amount); credit(a.receiver_id, amount);
      if (action.method === 'ft_transfer_call') receiverHook(a.receiver_id, receiver, a.amount, a.msg, signerId, signerPk);
      else if (callbackOnPlain && vaults.has(a.receiver_id)) receiverHook(a.receiver_id, receiver, a.amount, '', signerId, signerPk);
      const cb = h.call(callback.method, callback.args, context(receiver, receiver, signerId, signerPk, 0n,
        { promiseResult: 'success', ...(action.method === 'ft_transfer_call' ? { promiseValue: Buffer.from(JSON.stringify(a.amount)) } : {}) }));
      logs.push(...cb.logs);
    }
    return logs;
  }
  function send(signed) {
    const tr = signed.transaction, signer = tr.signerId, receiver = tr.receiverId, publicKey = pub(tr.publicKey);
    const account = accounts.get(signer), access = account?.keys.get(publicKey);
    assert.ok(access, 'unknown synthetic signing key');
    if (access.permission !== 'FullAccess') {
      assert.equal(access.permission.FunctionCall.receiver_id, receiver);
      assert.equal(tr.actions.length, 1);
      assert.ok(tr.actions[0].functionCall);
      assert.ok(access.permission.FunctionCall.method_names.includes(tr.actions[0].functionCall.methodName));
      assert.equal(tr.actions[0].functionCall.deposit, 0n);
    }
    access.nonce = Number(tr.nonce); state.sends++;
    let logs = [], failed = null;
    try {
      for (const action of tr.actions) {
        switch (Object.keys(action)[0]) {
          case 'createAccount':
            assert.ok(!accounts.has(receiver)); accounts.set(receiver, { keys: new Map() }); break;
          case 'transfer': break; // fake NEAR; not modelled
          case 'deployContract':
            assert.deepEqual(Buffer.from(action.deployContract.code), wasm);
            vaults.set(receiver, new SyntheticNearHost(wasm)); break;
          case 'addKey': {
            const { publicKey: pk, accessKey } = action.addKey, permission = accessKey.permission;
            const entry = permission.fullAccess ? 'FullAccess' : { FunctionCall: {
              receiver_id: permission.functionCall.receiverId,
              method_names: permission.functionCall.methodNames,
              allowance: permission.functionCall.allowance?.toString() ?? null } };
            accounts.get(receiver).keys.set(pub(pk), { nonce: 0, permission: entry }); break;
          }
          case 'functionCall': {
            const f = action.functionCall, args = JSON.parse(Buffer.from(f.args).toString('utf8'));
            if (receiver === TOKEN) {
              if (f.methodName === 'storage_deposit') token.set(args.account_id, balance(args.account_id));
              else if (f.methodName === 'ft_transfer_call') {
                debit(signer, BigInt(args.amount)); credit(args.receiver_id, BigInt(args.amount));
                receiverHook(args.receiver_id, signer, args.amount, args.msg, signer, keyBytes(tr.publicKey));
              } else throw new Error(`unexpected synthetic token method ${f.methodName}`);
            } else logs.push(...dispatchVault(receiver, f.methodName, args, f.deposit, signer, keyBytes(tr.publicKey)));
            break;
          }
          default: throw new Error(`unexpected synthetic action ${Object.keys(action)[0]}`);
        }
      }
    } catch (e) { failed = e; state.lastFailure = String(e.message); }
    const hash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256')
      .update(nearApi.transactions.encodeTransaction(tr)).digest());
    return { final_execution_status: 'FINAL', transaction_outcome: { id: hash },
      status: failed ? { Failure: { SyntheticFailure: String(failed.message) } } : { SuccessValue: '' },
      receipts_outcome: [outcome(receiver, logs)] };
  }
  const server = http.createServer(async (req, res) => {
    try {
      let text = ''; for await (const part of req) text += part;
      const message = JSON.parse(text), p = message.params; state.requests++;
      let result;
      if (message.method === 'status') result = { chain_id: SANDBOX_CHAIN_ID, sync_info: { syncing: false } };
      else if (message.method === 'block') result = { header: { hash: blockHash, height: 1 } };
      else if (message.method === 'query') {
        if (p.request_type === 'view_access_key') {
          const k = accounts.get(p.account_id)?.keys.get(p.public_key); assert.ok(k, 'no synthetic access key');
          result = { ...k, block_hash: blockHash, block_height: 1 };
        } else if (p.request_type === 'view_access_key_list') {
          const account = accounts.get(p.account_id); assert.ok(account, 'no synthetic account');
          result = { keys: [...account.keys].map(([public_key, access_key]) => ({ public_key, access_key })), block_hash: blockHash, block_height: 1 };
        } else if (p.request_type === 'call_function') {
          const args = JSON.parse(Buffer.from(p.args_base64, 'base64').toString('utf8'));
          let value;
          if (p.account_id === TOKEN && p.method_name === 'ft_balance_of') value = balance(args.account_id).toString();
          else {
            const h = vaults.get(p.account_id); assert.ok(h, 'no synthetic view contract');
            value = h.call(p.method_name, args, context(p.account_id, 'testnet', 'testnet', Buffer.alloc(33))).value;
          }
          result = { result: [...Buffer.from(JSON.stringify(value))], logs: [], block_hash: blockHash, block_height: 1 };
        } else throw new Error(`unexpected synthetic query ${p.request_type}`);
      } else if (message.method === 'send_tx') {
        assert.equal(p.wait_until, 'FINAL');
        result = send(nearApi.transactions.SignedTransaction.decode(Buffer.from(p.signed_tx_base64, 'base64')));
      } else throw new Error(`unexpected synthetic RPC method ${message.method}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    } catch (error) {
      unexpected.push(String(error.message)); res.writeHead(500); res.end('synthetic RPC rejected request');
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const provider = new nearApi.providers.JsonRpcProvider({ url });
  return { url, state,
    root: new nearApi.Account('testnet', provider, new nearApi.KeyPairSigner(rootKey)),
    tokenOwner: new nearApi.Account('owner.testnet', provider, new nearApi.KeyPairSigner(ownerKey)),
    async close() { server.closeAllConnections(); server.close(); await once(server, 'close'); } };
}
