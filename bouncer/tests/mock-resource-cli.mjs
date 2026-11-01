// TEST ONLY: fake RPC and provider. This never proves a live transaction.
import nearApi from 'near-api-js';
import { orderMemo } from '../services/resource-provider.mjs';
import { computeResult } from './mock-delivery.mjs';
import { mockHash, mockGuardedPayment } from './mock-guarded-payment.mjs';
const { Account, providers } = nearApi;
let vendorBalance = 0n;
const transactionsByHash = new Map();
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, options);
  const body = JSON.parse(options.body);
  if (String(url).endsWith('/quote')) {
    const alternative = new URL(url).hostname === 'alternative.example';
    return new Response(JSON.stringify({ ok: true, quote: {
      resource: body.resource, policy_id: alternative ? 'compute-b' : 'compute', token: 'wrap.testnet',
      payee: (process.env.MOCK_BAD_QUOTE || (alternative && process.env.MOCK_ALT_BAD_QUOTE)) ? 'attacker.testnet' : (alternative ? 'vendor-b.testnet' : 'vendor.testnet'),
      amount: alternative ? (process.env.MOCK_ALT_AMOUNT || '70') : '80', memo: orderMemo(body.resource, body.input),
    } }));
  }
  if (String(url).endsWith('/redeem')) {
    const result = computeResult(body.input);
    if (process.env.MOCK_BAD_DELIVERY) result.result = '0'.repeat(64);
    return new Response(JSON.stringify({ ok: true, result }));
  }
  throw new Error('unexpected HTTP request');
};
providers.JsonRpcProvider.prototype.viewNodeStatus = async () => ({ chain_id: process.env.BOUNCER_MOCK_MODE === 'wrong_chain' ? 'mainnet' : (process.env.MOCK_CHAIN || 'testnet') });
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
  const hash = mockHash('mock-payment');
  const result = mockGuardedPayment({ hash, owner: this.accountId, contract: options.contractId, args: options.args });
  transactionsByHash.set(hash, result);
  return result;
};
providers.JsonRpcProvider.prototype.txStatusReceipts = async (hash, id, wait) => {
  if (id !== 'bouncer.testnet' || wait !== 'FINAL' || !transactionsByHash.has(hash)) throw new Error('unknown mock transaction');
  return transactionsByHash.get(hash);
};
