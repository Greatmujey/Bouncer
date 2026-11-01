#!/usr/bin/env node
// Read-only inspection of one abandoned testnet setup and fresh build sizes.
// No signing, payments, retries or access to secret keys.
import fs from 'node:fs';
import { PaymentRpcProvider } from '../agent/near-account.mjs';
import { REF_SWAP_OUTPUT, REF_SWAP_INPUT, REF_SWAP_EXCHANGE } from '../agent/ref-swap-evidence.mjs';
import { isTestnetAccount } from '../shared/account-id.mjs';

const parent = process.argv[2], owner = process.argv[3];
if (!isTestnetAccount(parent) || !isTestnetAccount(owner) || process.argv.length !== 4) throw new Error('provide two testnet account IDs');
const provider = new PaymentRpcProvider(process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com');
async function main() {
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const protocol = await provider.experimental_protocolConfig({ finality: 'final' });
  const storage = protocol?.runtime_config?.storage_amount_per_byte;
  if (storage !== '10000000000000000000') throw new Error('unexpected storage price');
  const [vault, ownerAccount, quote, inputBounds, outputBounds] = await Promise.all([
    provider.query({ request_type: 'view_account', account_id: parent, finality: 'final' }),
    provider.query({ request_type: 'view_account', account_id: owner, finality: 'final' }).catch(error => ({ lookup_error: String(error.message).slice(0, 300) })), 
    provider.callFunction(REF_SWAP_EXCHANGE, 'get_return', { pool_id: 1845, token_in: REF_SWAP_INPUT,
      token_out: REF_SWAP_OUTPUT, amount_in: '10000000000000000000000' }, { finality: 'final' }),
    provider.callFunction(REF_SWAP_INPUT, 'storage_balance_bounds', {}, { finality: 'final' }),
    provider.callFunction(REF_SWAP_OUTPUT, 'storage_balance_bounds', {}, { finality: 'final' }),
  ]);
  const routerBytes = fs.statSync('ref-router-wasm/bouncer_ref_router.wasm').size;
  if (!Number.isSafeInteger(routerBytes) || routerBytes < 1) throw new Error('router build missing');
  const result = { old_vault: parent, vault_total: vault.amount, vault_storage_bytes: vault.storage_usage,
    vault_liquid_after_storage: (BigInt(vault.amount) - BigInt(vault.storage_usage) * BigInt(storage)).toString(),
    old_owner: owner, owner_total: ownerAccount.amount ?? null, owner_lookup_error: ownerAccount.lookup_error ?? null,
    storage_price: storage, router_bytes: routerBytes,
    router_storage_plus_half_near: ((BigInt(routerBytes) + 20_000n) * BigInt(storage) + 500_000_000_000_000_000_000_000n).toString(),
    pool_1845_quote_micro: quote, input_storage_min: inputBounds?.min, output_storage_min: outputBounds?.min,
    scope: 'read_only_no_trade_or_payment' };
  console.log(`::notice title=Ref testnet setup and storage inspection::${JSON.stringify(result)}`);
}
main().catch(error => { console.error(`[ref-setup-probe] ${error.message}`); process.exitCode = 1; });
