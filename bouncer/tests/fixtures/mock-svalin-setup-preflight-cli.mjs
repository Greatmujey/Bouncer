// Synthetic local CLI fixture; global fetch is replaced so no real network or
// mutation can occur. The parent supplies only disposable public test inputs.
import fs from 'node:fs';
const config = JSON.parse(fs.readFileSync(process.env.BOUNCER_SETUP_PREFLIGHT_CONFIG, 'utf8'));
const TOKEN = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
const REG = '1250000000000000000000';
globalThis.fetch = async (url, options) => {
  if (url !== 'http://127.0.0.1:9999/' || options?.method !== 'POST') throw new Error('unexpected network request');
  const request = JSON.parse(options.body), p = request.params;
  fs.appendFileSync(config.log, `${request.method}${p?.request_type ? ':' + p.request_type : ''}\n`);
  let result, error;
  if (request.method === 'status') result = { chain_id: config.mainnet ? 'mainnet' : 'testnet' };
  else if (request.method === 'block') result = { header: { hash: config.block, timestamp_nanosec: String(BigInt(Date.now()) * 1_000_000n) } };
  else if (request.method === 'EXPERIMENTAL_protocol_config' && p.block_id === config.block) {
    result = { chain_id: 'testnet', runtime_config: { storage_amount_per_byte: '10000000000000000000' } };
  } else if (request.method === 'query' && p.block_id === config.block) {
    if (p.request_type === 'view_account' && p.account_id === config.goal.vault) {
      if (config.occupied) result = { block_hash: config.block, amount: '1', locked: '0', storage_usage: 0 };
      else error = { cause: { name: 'UNKNOWN_ACCOUNT', info: { requested_account_id: config.goal.vault, block_hash: config.block, block_height: 99 } } };
    } else if (p.request_type === 'view_account' && p.account_id === config.goal.owner) {
      result = { block_hash: config.block, amount: '20000000000000000000000000', locked: '0', storage_usage: 10000 };
    } else if (p.request_type === 'view_access_key' && p.account_id === config.goal.owner && p.public_key === config.ownerKey) {
      result = { block_hash: config.block, nonce: 1, permission: 'FullAccess' };
    } else if (p.request_type === 'view_access_key_list' && p.account_id === config.goal.owner) {
      result = { block_hash: config.block, keys: [{ public_key: config.ownerKey, access_key: { nonce: 1, permission: 'FullAccess' } }] };
    } else if (p.request_type === 'call_function' && p.account_id === TOKEN) {
      const args = JSON.parse(Buffer.from(p.args_base64, 'base64').toString('utf8'));
      let value;
      if (p.method_name === 'storage_balance_bounds') value = { min: REG, max: REG };
      else if (p.method_name === 'storage_balance_of') value = args.account_id === config.goal.vault ? null : { total: REG, available: '0' };
      else if (p.method_name === 'ft_balance_of' && args.account_id === config.goal.owner) value = config.lowBalance ? '10' : '5009999';
      else throw new Error('unexpected function view');
      result = { block_hash: config.block, result: [...Buffer.from(JSON.stringify(value))] };
    } else throw new Error('unexpected query');
  } else throw new Error('mutation or unpinned RPC denied');
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(error ? { error } : { result }) }),
    { status: 200, headers: { 'content-type': 'application/json' } });
};
