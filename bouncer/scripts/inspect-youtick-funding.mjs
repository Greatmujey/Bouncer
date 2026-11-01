#!/usr/bin/env node
// Read-only assessment of whether the existing testnet owner has a plausible
// 1-NEAR Ref quote. No signing, swap, account changes or provider requests.
import { PaymentRpcProvider } from '../agent/near-account.mjs';
import { assessYoutickFunding } from '../agent/youtick-funding.mjs';
import { TESTNET_CIRCLE_USDC } from '../agent/youtick-capabilities.mjs';

if (process.argv.length !== 2) throw new Error('usage: node inspect-youtick-funding.mjs');
const VAULT = 'bouncer-ref-44f619d9.testnet', OWNER = 'owner.bouncer-ref-44f619d9.testnet';
const REF = 'ref-finance-101.testnet', WRAP = 'wrap.testnet', INPUT = '1000000000000000000000000';
const provider = new PaymentRpcProvider(process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com');
const view = (id, method, args = {}) => provider.callFunction(id, method, args, { finality: 'final' });
async function main() {
  const [status, owner, protocol, ledger, tokens, ...candidates] = await Promise.all([
    provider.viewNodeStatus(), provider.query({ request_type: 'view_account', account_id: OWNER, finality: 'final' }),
    provider.experimental_protocolConfig({ finality: 'final' }), view(VAULT, 'vault_balance', { token: TESTNET_CIRCLE_USDC }),
    view(TESTNET_CIRCLE_USDC, 'ft_balance_of', { account_id: VAULT }),
    ...[1845, 2206].map(async pool_id => {
      try {
        const pool = await view(REF, 'get_pool', { pool_id });
        if (pool?.pool_kind !== 'SIMPLE_POOL' || !Array.isArray(pool.token_account_ids) || pool.token_account_ids.length !== 2 ||
            !pool.token_account_ids.includes(WRAP) || !pool.token_account_ids.includes(TESTNET_CIRCLE_USDC)) return null;
        const output = await view(REF, 'get_return', { pool_id, token_in: WRAP, amount_in: INPUT, token_out: TESTNET_CIRCLE_USDC });
        return { pool_id, input: INPUT, output };
      } catch { return null; }
    }),
  ]);
  const result = assessYoutickFunding({ chain: status?.chain_id, ownerAmount: owner?.amount, ownerStorageBytes: owner?.storage_usage,
    storagePrice: protocol?.runtime_config?.storage_amount_per_byte, vaultLedger: ledger, vaultTokens: tokens, pools: candidates });
  console.log(`::notice title=Testnet provider funding estimate::${JSON.stringify({ ...result, vault: VAULT, owner: OWNER, sends: 0 })}`);
}
main().catch(error => {
  const text = String(error.message).slice(0, 1000).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.error(`[youtick-funding-read-only] ${error.message}`);
  console.log(`::error title=Testnet funding inspection stopped::${text}`); process.exitCode = 1;
});
