#!/usr/bin/env node
// Read-only discovery only: no quote request, payment, reservation or upload.
import { PaymentRpcProvider } from '../agent/near-account.mjs';
import { assessYoutickCapabilities, YOUTICK_HEALTH, YOUTICK_MARKET } from '../agent/youtick-capabilities.mjs';
import { readBoundedJson } from '../shared/bounded-json.mjs';

if (process.argv.length !== 2) throw new Error('usage: node probe-youtick.mjs');
const provider = new PaymentRpcProvider(process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com');
const safe = async action => { try { return await action(); } catch { return null; } };
const view = (method, args = {}) => provider.callFunction(YOUTICK_MARKET, method, args, { finality: 'final' });
async function main() {
  const [status, account, token, policy, governance, quoteKeyVersion, health] = await Promise.all([
    safe(() => provider.viewNodeStatus()),
    safe(() => provider.query({ request_type: 'view_account', account_id: YOUTICK_MARKET, finality: 'final' })),
    safe(() => view('get_usdc_contract_id')), safe(() => view('get_public_upload_policy')),
    safe(() => view('get_governance_state')), safe(() => view('get_quote_key_version')),
    safe(async () => {
      const response = await fetch(YOUTICK_HEALTH, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return null;
      return readBoundedJson(response, { maxBytes: 65_536, label: 'independent testnet bridge health' });
    }),
  ]);
  const result = assessYoutickCapabilities({ chain: status?.chain_id, codeHash: account?.code_hash,
    token, policy, governance, quoteKeyVersion, health });
  console.log(`::notice title=Independent testnet video provider capability::${JSON.stringify(result)}`);
}
main().catch(error => {
  const text = String(error.message).slice(0, 1000).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.error(`[youtick-read-only] ${error.message}`);
  console.log(`::error title=Independent provider discovery failed::${text}`); process.exitCode = 1;
});
