// TEST ONLY: an in-process, network-free HTTP/RPC fixture for the actual CLI.
import fs from 'node:fs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../../scripts/circle-testnet-setup.mjs';
import { SVALIN_ORIGIN, SVALIN_PAYEE } from '../../agent/svalin-pro-readiness.mjs';
const config = JSON.parse(fs.readFileSync(process.env.BOUNCER_PREFLIGHT_TEST_CONFIG, 'utf8'));
const note = value => fs.appendFileSync(config.log, `${value}\n`);
const response = (id, result) => Response.json({ jsonrpc: '2.0', id, result });
globalThis.fetch = async (url, options) => {
  if (url === `${SVALIN_ORIGIN}/v1/pro`) {
    if (options.method !== 'GET' || options.body || options.headers?.authorization) throw new Error('invalid synthetic seller request');
    note('seller-get');
    return Response.json({ plans: [{ id: 'month', usd: 5, days: 30 }, { id: 'year', usd: 48, days: 365 }],
      callsPerDay: 100, near: { network: 'near:testnet', environment: 'testnet', payTo: SVALIN_PAYEE, token: TOKEN }, solana: null });
  }
  if (url !== 'http://127.0.0.1:9999/' || options.method !== 'POST' || options.redirect !== 'error') throw new Error('unexpected synthetic HTTP');
  const rpc = JSON.parse(options.body), p = rpc.params;
  note(rpc.method === 'query' ? `query:${p.request_type}` : rpc.method);
  if (rpc.method === 'status') return response(rpc.id, { chain_id: config.mainnet ? 'mainnet' : 'testnet' });
  if (rpc.method === 'block') return response(rpc.id, { header: { hash: config.block, timestamp_nanosec: (BigInt(Date.now()) * 1_000_000n).toString() } });
  if (rpc.method !== 'query' || p.block_id !== config.block) throw new Error('unexpected synthetic RPC');
  const shared = { block_hash: config.block, block_height: 42 };
  if (p.request_type === 'view_account') {
    if (![config.goal.vault, config.goal.owner].includes(p.account_id)) throw new Error('unknown synthetic account');
    return response(rpc.id, { ...shared, code_hash: config.goal.vault_code_hash, amount: '1000000000000000000000000', locked: '0' });
  }
  if (p.request_type === 'view_access_key_list') return response(rpc.id, { ...shared, keys: [] });
  if (p.request_type === 'view_access_key') return response(rpc.id, { ...shared, nonce: 1, permission: { FunctionCall: {
    receiver_id: config.goal.vault, method_names: ['execute_exact_ft'], allowance: '100000000000000000000000' } } });
  if (p.request_type !== 'call_function') throw new Error('unexpected synthetic query');
  const args = JSON.parse(Buffer.from(p.args_base64, 'base64').toString('utf8'));
  const values = { get_owner: config.goal.owner, contract_version: 'bouncer-agent-v11-exact-ft-testnet',
    get_policy: { token: TOKEN, per_tx_cap: '5009999', daily_cap: '5009999' },
    is_exact_ft_policy_locked: true, is_exact_ft_payee_locked: false, is_agent_key_allowed: true, daily_spent: '0',
    vault_balance: config.lowBalance ? '5009998' : '5009999', ft_balance_of: '5009999',
    storage_balance_of: { total: '1250000000000000000000', available: '0' }, check: [true, 'ok'] };
  if (!Object.hasOwn(values, p.method_name) || (p.account_id !== config.goal.vault && p.account_id !== TOKEN)) throw new Error('unexpected synthetic view');
  if (p.method_name === 'storage_balance_of' && ![config.goal.vault, SVALIN_PAYEE].includes(args.account_id)) throw new Error('unexpected synthetic registration');
  return response(rpc.id, { ...shared, result: [...Buffer.from(JSON.stringify(values[p.method_name]))], logs: [] });
};
