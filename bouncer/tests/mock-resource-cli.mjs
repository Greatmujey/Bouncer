// TEST ONLY: fake RPC and provider. This never proves a live transaction.
import nearApi from 'near-api-js';
import { orderMemo } from '../services/resource-provider.mjs';
const { Account, providers } = nearApi;
let vendorBalance = 0n;
const transactionsByHash = new Map();
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, options);
  const body = JSON.parse(options.body);
  if (String(url).endsWith('/quote')) {
    return { ok: true, async json() { return { ok: true, quote: {
      resource: body.resource, policy_id: 'compute', token: 'wrap.testnet',
      payee: process.env.MOCK_BAD_QUOTE ? 'attacker.testnet' : 'vendor.testnet',
      amount: '80', memo: orderMemo(body.resource, body.input),
    } }; } };
  }
  if (String(url).endsWith('/redeem')) return { ok: true, async json() { return { ok: true, result: { type: body.resource, result: 'fake-test-result' } }; } };
  throw new Error('unexpected HTTP request');
};
providers.JsonRpcProvider.prototype.viewAccessKey = async () => ({ permission: { FunctionCall: { receiver_id: 'bouncer.testnet', method_names: ['execute'] } } });
providers.JsonRpcProvider.prototype.callFunction = async (_id, method) => {
  if (method === 'contract_version') return 'bouncer-agent-v4';
  if (method === 'get_policy') return { token: 'wrap.testnet', per_tx_cap: '1000', daily_cap: '1000' };
  if (method === 'daily_spent') return '0';
  if (method === 'vault_balance') return '1000';
  if (method === 'is_agent_key_allowed') return true;
  if (method === 'check') return process.env.MOCK_BLOCKED ? [false, 'blocked'] : [true, 'ok'];
  if (method === 'ft_balance_of') return vendorBalance.toString();
  throw new Error(`unexpected view ${method}`);
};
Account.prototype.callFunctionRaw = async function (options) {
  if (options.methodName !== 'execute' || options.deposit !== 0n || options.waitUntil !== 'FINAL') throw new Error('bad payment');
  vendorBalance += BigInt(options.args.amount);
  const result = {
    status: { SuccessValue: '' }, transaction_outcome: { id: 'mock-payment' },
    transaction: { hash: 'mock-payment', signer_id: this.accountId, receiver_id: options.contractId,
      actions: [{ FunctionCall: { method_name: options.methodName, deposit: '0', args: Buffer.from(JSON.stringify(options.args)).toString('base64') } }] },
    receipts_outcome: [{ outcome: { executor_id: 'wrap.testnet', status: { SuccessValue: '' } } }],
  };
  transactionsByHash.set('mock-payment', result);
  return result;
};
providers.JsonRpcProvider.prototype.viewTransactionStatus = async (hash, id, wait) => {
  if (id !== 'bouncer.testnet' || wait !== 'FINAL' || !transactionsByHash.has(hash)) throw new Error('unknown mock transaction');
  return transactionsByHash.get(hash);
};
