/**
 * Synthetic local RPC, token, scheduling and receipts for checking the
 * experimental nearcore harness. It does NOT run nearcore or real escrow;
 * access-key/admission and FT behavior below are only simplified models.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import nearApi from 'near-api-js';
import { SyntheticNearHost } from './v11-synthetic-host.mjs';
import { SANDBOX_CHAIN_ID } from '../../integration/v11-sandbox-support.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../../scripts/circle-testnet-setup.mjs';
import { PAYPERCALL_TESTNET_ESCROW as ESCROW } from '../../agent/paypercall-inspect.mjs';
import { FIXTURE_FORWARDER as ADAPTER } from '../../integration/fixtures/paypercall-stand-in.mjs';

const blockHash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update('synthetic-forwarder-block').digest());
const pub = value => `ed25519:${nearApi.utils.serialize.base_encode(Buffer.from(value.ed25519Key.data))}`;
const keyBytes = value => Buffer.concat([Buffer.from([0]), Buffer.from(value.ed25519Key.data)]);
const sha = bytes => nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(bytes).digest());

export async function createSyntheticForwarderRpc(wasm, { wrongPartialRefund = false } = {}) {
  const now = Date.now(), timestamp = BigInt(now) * 1_000_000n;
  const rootKey = nearApi.KeyPair.fromRandom('ed25519'), ownerKey = nearApi.KeyPair.fromRandom('ed25519');
  const accounts = new Map(), contracts = new Map(), token = new Map([['owner.testnet', 100_000n]]);
  const unexpected = [], state = { sends: 0, requests: 0, unexpected, wrongPartialRefund };
  const addAccount = (id, pair) => accounts.set(id, { keys: new Map([[String(pair.getPublicKey()), { nonce: 0, permission: 'FullAccess' }]]),
    codeHash: '11111111111111111111111111111111' });
  addAccount('testnet', rootKey); addAccount('owner.testnet', ownerKey);
  const outcome = (executor, logs = []) => ({ id: `synthetic-receipt-${state.sends}`, outcome: {
    executor_id: executor, status: { SuccessValue: '' }, logs, receipt_ids: [] } });
  const balance = id => token.get(id) ?? 0n;
  const credit = (id, n) => token.set(id, balance(id) + n);
  const debit = (id, n) => { assert.ok(balance(id) >= n, 'synthetic FT insufficient balance'); token.set(id, balance(id) - n); };
  const context = (current, predecessor, signer, signerPk, deposit = 0n, extra = {}) =>
    ({ current, predecessor, signer, signerPk, deposit, timestamp, balance: 10n ** 26n, ...extra });
  const modelHost = bytes => {
    const h = new SyntheticNearHost(bytes);
    h.env.promise_batch_action_transfer = (index, ptr) => {
      const p = h.promises[Number(index)], value = h.read(ptr, 16);
      assert.ok(p); p.actions.push({ method: '$native_transfer', amount: (value.readBigUInt64LE(0) + (value.readBigUInt64LE(8) << 64n)).toString() });
    };
    return h;
  };
  function hook(receiver, sender, amount, msg, signer, pk) {
    const h = contracts.get(receiver); assert.ok(h, 'missing synthetic transfer-call receiver');
    const response = h.call('ft_on_transfer', { sender_id: sender, amount: String(amount), msg },
      context(receiver, TOKEN, signer, pk));
    if (receiver === ESCROW && wrongPartialRefund) return '0'; // fault injection: real bytecode result is deliberately overridden
    return response.value;
  }
  function ftTransfer(from, action, signer, pk) {
    assert.equal(action.method === 'ft_transfer' || action.method === 'ft_transfer_call', true);
    const { receiver_id: receiver, amount, msg } = action.args, n = BigInt(amount);
    debit(from, n); credit(receiver, n);
    if (action.method === 'ft_transfer_call') {
      const unused = BigInt(hook(receiver, from, amount, msg, signer, pk));
      assert.ok(unused >= 0n && unused <= n);
      debit(receiver, unused); credit(from, unused);
      return (n - unused).toString();
    }
    return '';
  }
  function dispatch(receiver, method, args, deposit, signer, pk) {
    const h = contracts.get(receiver); assert.ok(h, `no synthetic contract for ${receiver}`);
    const response = h.call(method, args, context(receiver, signer, signer, pk, deposit)), logs = [...response.logs];
    if (!response.promises.length) return logs;
    const first = response.promises[0], action = first.actions[0];
    if (action.method === '$native_transfer') return logs; // native balance and scheduling are not modelled
    assert.equal(first.receiver, TOKEN);
    const used = ftTransfer(receiver, action, signer, pk);
    if (response.promises.length === 2) {
      const callback = response.promises[1].actions[0];
      const cb = h.call(callback.method, callback.args, context(receiver, receiver, signer, pk, 0n,
        { promiseResult: 'success', promiseValue: Buffer.from(JSON.stringify(used)) }));
      logs.push(...cb.logs);
    }
    return logs;
  }
  function send(signed) {
    const tr = signed.transaction, signer = tr.signerId, receiver = tr.receiverId, publicKey = pub(tr.publicKey);
    const access = accounts.get(signer)?.keys.get(publicKey);
    assert.ok(access, 'unknown synthetic signing key');
    if (access.permission !== 'FullAccess') {
      if (access.permission.FunctionCall.receiver_id !== receiver) throw new Error('ReceiverMismatch');
      assert.equal(tr.actions.length, 1);
      assert.ok(tr.actions[0].functionCall);
      if (!access.permission.FunctionCall.method_names.includes(tr.actions[0].functionCall.methodName)) throw new Error('MethodNameMismatch');
      if (tr.actions[0].functionCall.deposit !== 0n) throw new Error('DepositWithFunctionCall');
    }
    access.nonce = Number(tr.nonce); state.sends++;
    let logs = [], failed = null;
    try {
      for (const action of tr.actions) {
        switch (Object.keys(action)[0]) {
          case 'createAccount':
            assert.ok(!accounts.has(receiver)); accounts.set(receiver, { keys: new Map(), codeHash: '11111111111111111111111111111111' }); break;
          case 'transfer': break;
          case 'deployContract': {
            const bytes = Buffer.from(action.deployContract.code);
            if (receiver.endsWith('vault.forward-buyer.testnet')) assert.deepEqual(bytes, wasm);
            assert.ok(receiver.endsWith('vault.forward-buyer.testnet') || receiver === ADAPTER || receiver === ESCROW);
            accounts.get(receiver).codeHash = sha(bytes); contracts.set(receiver, modelHost(bytes)); break;
          }
          case 'addKey': {
            const { publicKey: pk, accessKey } = action.addKey, permission = accessKey.permission;
            const entry = permission.fullAccess ? 'FullAccess' : { FunctionCall: {
              receiver_id: permission.functionCall.receiverId, method_names: permission.functionCall.methodNames,
              allowance: permission.functionCall.allowance?.toString() ?? null } };
            accounts.get(receiver).keys.set(pub(pk), { nonce: 0, permission: entry }); break;
          }
          case 'functionCall': {
            const f = action.functionCall, args = JSON.parse(Buffer.from(f.args).toString('utf8'));
            if (receiver === TOKEN) {
              if (f.methodName === 'storage_deposit') token.set(args.account_id, balance(args.account_id));
              else if (f.methodName === 'ft_transfer_call') ftTransfer(signer, { method: f.methodName, args }, signer, keyBytes(tr.publicKey));
              else throw new Error(`unexpected synthetic token method ${f.methodName}`);
            } else logs.push(...dispatch(receiver, f.methodName, args, f.deposit, signer, keyBytes(tr.publicKey)));
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
      else if (message.method === 'block') result = { header: { hash: blockHash, height: 1, timestamp_nanosec: timestamp.toString() } };
      else if (message.method === 'query') {
        if (p.request_type === 'view_access_key') {
          const k = accounts.get(p.account_id)?.keys.get(p.public_key); assert.ok(k, 'no synthetic access key');
          result = { ...k, block_hash: blockHash, block_height: 1 };
        } else if (p.request_type === 'view_access_key_list') {
          const a = accounts.get(p.account_id); assert.ok(a, 'no synthetic account');
          result = { keys: [...a.keys].map(([public_key, access_key]) => ({ public_key, access_key })), block_hash: blockHash, block_height: 1 };
        } else if (p.request_type === 'view_account') {
          const a = accounts.get(p.account_id); assert.ok(a, 'no synthetic account');
          result = { amount: (10n ** 26n).toString(), locked: '0', code_hash: a.codeHash, storage_usage: 10000,
            block_hash: blockHash, block_height: 1 };
        } else if (p.request_type === 'call_function') {
          const args = JSON.parse(Buffer.from(p.args_base64, 'base64').toString('utf8'));
          let value;
          if (p.account_id === TOKEN && p.method_name === 'ft_balance_of') value = balance(args.account_id).toString();
          else {
            const h = contracts.get(p.account_id); assert.ok(h, 'no synthetic view contract');
            value = h.call(p.method_name, args, context(p.account_id, 'testnet', 'testnet', Buffer.alloc(33))).value;
          }
          result = { result: [...Buffer.from(JSON.stringify(value))], logs: [], block_hash: blockHash, block_height: 1 };
        } else throw new Error(`unexpected synthetic query ${p.request_type}`);
      } else if (message.method === 'send_tx') {
        assert.equal(p.wait_until, 'FINAL');
        try { result = send(nearApi.transactions.SignedTransaction.decode(Buffer.from(p.signed_tx_base64, 'base64'))); }
        catch (e) {
          if (!/ReceiverMismatch|MethodNameMismatch|DepositWithFunctionCall/.test(e.message)) throw e;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: e.message, data: e.message } }));
          return;
        }
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
