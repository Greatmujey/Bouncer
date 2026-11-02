// TEST ONLY: synthetic seller and FINAL RPC for the actual Svalin CLI.
// This cannot establish any live transaction, seller attribution or delivery.
import fs from 'node:fs';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { PaymentRpcProvider, MonotonicAccount } from '../../agent/near-account.mjs';
import { SVALIN_ORIGIN, SVALIN_PAYEE } from '../../agent/svalin-pro-readiness.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../../scripts/circle-testnet-setup.mjs';
import { mockGuardedPayment, mockHash } from '../mock-guarded-payment.mjs';

const configPath = process.env.BOUNCER_SVALIN_TEST_CONFIG, logPath = process.env.BOUNCER_SVALIN_TEST_LOG;
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const now = Number(process.env.BOUNCER_SVALIN_TEST_CLOCK);
if (!Number.isSafeInteger(now)) throw new Error('synthetic clock required');
Date.now = () => now;
const log = action => fs.appendFileSync(logPath, `${action}\n`);
const enc = value => Buffer.from(JSON.stringify(value)).toString('base64');
const finalBlock = mockHash('svalin-cli-final'), txBlock = mockHash('svalin-cli-tx'), executionBlock = mockHash('svalin-cli-execution');
const a = config.prepared?.owner_call.args, view = config.view;
const status = () => ({ kind: 'pro', plan: 'pro', active: true, until: new Date(now + 30 * 24 * 60 * 60_000).toISOString(), callsLeft: 100, callsPer: 'day' });
PaymentRpcProvider.prototype.viewNodeStatus = async () => ({ chain_id: 'testnet' });
PaymentRpcProvider.prototype.viewBlock = async () => ({ header: { hash: finalBlock, timestamp_nanosec: (BigInt(now) * 1_000_000n).toString() } });
PaymentRpcProvider.prototype.viewAccount = async (id, { blockId }) => {
  if (![finalBlock, txBlock, executionBlock].includes(blockId)) throw new Error('unexpected synthetic account block');
  if (id === config.goal.owner) return { block_hash: blockId,
    code_hash: config.ownerContract ? config.goal.vault_code_hash : '11111111111111111111111111111111',
    ...(config.ownerGlobal ? { global_contract_account_id: 'shared.testnet' } : {}) };
  if (id !== config.goal.vault) throw new Error('unexpected synthetic vault lookup');
  return { block_hash: blockId, code_hash: config.goal.vault_code_hash };
};
PaymentRpcProvider.prototype.viewAccessKeyList = async (id, { blockId }) => {
  if (id !== config.goal.vault) throw new Error('unexpected synthetic key lookup'); return { block_hash: blockId, keys: [] };
};
PaymentRpcProvider.prototype.viewAccessKey = async (id, publicKey, { blockId }) => {
  if (id !== config.goal.owner || String(publicKey) !== a?.agent_public_key) throw new Error('unexpected synthetic agent key');
  return { block_hash: blockId, permission: { FunctionCall: { receiver_id: config.goal.vault,
    method_names: ['execute_exact_ft'], allowance: '100000000000000000000000' } } };
};
PaymentRpcProvider.prototype.callFunction = async (id, method, args, { blockId }) => {
  if (method === 'storage_balance_of') return { total: '1250000000000000000000' };
  if (id !== config.goal.vault) throw new Error('unexpected synthetic contract');
  if (method === 'get_owner') return config.goal.owner;
  if (method === 'contract_version') return 'bouncer-agent-v11-exact-ft-testnet';
  if (method === 'is_exact_ft_policy_locked' || method === 'is_exact_ft_payee_locked' || method === 'is_agent_key_allowed') return true;
  if (method === 'get_policy') return { token: TOKEN };
  if (method === 'check') return [true, 'ok'];
  if (method === 'get_exact_ft_intent' && args.intent_id === a.intent_id) return blockId === executionBlock ? { ...view, consumed: true, active: false } : structuredClone(view);
  throw new Error('unexpected synthetic view');
};
PaymentRpcProvider.prototype.callFunctionRaw = async function(id, method, args, opts) {
  const value = await this.callFunction(id, method, args, opts);
  return { block_hash: opts.blockId, result: [...Buffer.from(JSON.stringify(value))] };
};
MonotonicAccount.prototype.createTransaction = async function(receiver, actions, publicKey) {
  return nearApi.transactions.createTransaction(this.accountId, publicKey, receiver, 7n, actions, Buffer.alloc(32, 4));
};
PaymentRpcProvider.prototype.sendTransactionUntil = async () => { throw new Error('retrying transport must not be used'); };
PaymentRpcProvider.prototype.sendTransactionOnce = async (signed, finality) => {
  if (finality !== 'FINAL') throw new Error('unexpected finality'); log('send');
  const hash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(nearApi.transactions.encodeTransaction(signed.transaction)).digest());
  const chain = mockGuardedPayment({ hash, owner: config.goal.owner, contract: config.goal.vault, publicKey: a.agent_public_key,
    args: { policy_id: a.policy_id, payee: SVALIN_PAYEE, amount: a.amount, memo: a.memo, expected_token: TOKEN } });
  chain.transaction_outcome.block_hash = txBlock; chain.receipts_outcome[0].block_hash = executionBlock;
  chain.transaction.actions[0].FunctionCall.method_name = 'execute_exact_ft';
  chain.transaction.actions[0].FunctionCall.args = enc({ intent_id: a.intent_id });
  chain.receipts_outcome[0].outcome.logs = ['BOUNCER exact FT intent consumed; transfer initiated'];
  chain.receipts_outcome[1].outcome.logs = ['EVENT_JSON:' + JSON.stringify({ standard: 'nep141', version: '1.0.0', event: 'ft_transfer',
    data: [{ old_owner_id: config.goal.vault, new_owner_id: SVALIN_PAYEE, amount: a.amount, memo: a.memo }] })];
  chain.receipts_outcome[2].outcome.logs = ['BOUNCER exact FT transfer succeeded; intent stays consumed'];
  const callback = chain.receipts[1].receipt.Action.actions[0].FunctionCall;
  callback.method_name = 'after_exact_ft_transfer'; callback.args = enc({ intent_id: a.intent_id, policy_id: a.policy_id,
    token: TOKEN, amount: a.amount, bucket: 24, policy_revision: 1 });
  config.hash = hash; config.chain = chain; fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  if (process.env.BOUNCER_SVALIN_TEST_LOSE_SEND === '1') throw new Error('synthetic lost send response');
  return { transaction_outcome: { id: hash } };
};
PaymentRpcProvider.prototype.txStatusReceipts = async (hash, owner, finality) => {
  if (hash !== config.hash || owner !== config.goal.owner || finality !== 'FINAL') throw new Error('unexpected synthetic receipt lookup');
  return structuredClone(config.chain);
};
globalThis.fetch = async (url, opts) => {
  if (opts.redirect !== 'error' || opts.cache !== 'no-store') throw new Error('unexpected network settings');
  if (url === `${SVALIN_ORIGIN}/v1/pro` && opts.method === 'GET') {
    log('offer'); return new Response(JSON.stringify({ plans: [{ id: 'month', usd: 5, days: 30 }, { id: 'year', usd: 48, days: 365 }],
      callsPerDay: 100, near: { network: 'near:testnet', environment: 'testnet', payTo: SVALIN_PAYEE, token: TOKEN }, solana: null }));
  }
  if (url === `${SVALIN_ORIGIN}/v1/pro/near` && opts.method === 'POST') {
    log('reservation'); const body = JSON.parse(opts.body);
    return new Response(JSON.stringify({ plan: 'month', network: 'near:testnet', payTo: SVALIN_PAYEE, token: TOKEN,
      amount: '5.004217', expiresAt: new Date(now + 24 * 60 * 60_000).toISOString(), echo: body.code }));
  }
  if (url === `${SVALIN_ORIGIN}/v1/pro/activate` && opts.method === 'POST') {
    log('activation'); const body = JSON.parse(opts.body); return new Response(JSON.stringify({ status: status(), found: 1, pending: [], echo: body.code }));
  }
  if (url === `${SVALIN_ORIGIN}/v1/risk/root.near` && opts.method === 'GET') {
    log('risk'); return new Response(JSON.stringify({ wallet: 'root.near', chain: 'near', score: 21, grade: 'B', level: 'low',
      dataCoverage: 90, dataSource: 'fastnear', methodologyVersion: '2026-10.8', generatedAt: new Date(now).toISOString(),
      metrics: { totalValueUsd: 25, pricedAssetCount: 2, unpricedAssetCount: 0 },
      findings: [{ kind: 'small-portfolio', severity: 'info', action: `untrusted ${opts.headers.authorization}` }], echo: opts.headers.authorization }),
      { headers: { 'x-calls-left': '99' } });
  }
  throw new Error('unexpected synthetic seller request');
};
