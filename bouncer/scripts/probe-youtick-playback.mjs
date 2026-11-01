#!/usr/bin/env node
// Read-only point-in-time discovery: no quote, grant, token, payment or upload.
import { PaymentRpcProvider } from '../agent/near-account.mjs';
import { assessYoutickPlaybackReadiness, YOUTICK_ACCESS, YOUTICK_HEALTH, YOUTICK_MARKET } from '../agent/youtick-capabilities.mjs';
import { readBoundedJson } from '../shared/bounded-json.mjs';

if (process.argv.length !== 2) throw new Error('usage: node probe-youtick-playback.mjs');
const provider = new PaymentRpcProvider(process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com');
const safe = async action => { try { return await action(); } catch { return null; } };
async function main() {
  const [status, access, health] = await Promise.all([
    safe(() => provider.viewNodeStatus()),
    safe(() => provider.query({ request_type: 'view_account', account_id: YOUTICK_ACCESS, finality: 'final' })),
    safe(async () => {
      const response = await fetch(YOUTICK_HEALTH, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
      return response.ok ? readBoundedJson(response, { maxBytes: 65_536, label: 'testnet bridge health' }) : null;
    }),
  ]);
  // Pin all chain views to one already-finalized block. No provider secrets or
  // playback request are submitted; inability to observe a view is not success.
  const block = typeof access?.block_hash === 'string' ? { blockId: access.block_hash } : null;
  const [market, state, playPolicy, uploadPolicy] = block ? await Promise.all([
    safe(() => provider.query({ request_type: 'view_account', account_id: YOUTICK_MARKET, ...block })),
    safe(() => provider.callFunction(YOUTICK_ACCESS, 'get_contract_state', {}, block)),
    safe(() => provider.callFunction(YOUTICK_ACCESS, 'get_scope_policy', { scope: 'Play' }, block)),
    safe(() => provider.callFunction(YOUTICK_MARKET, 'get_public_upload_policy', {}, block)),
  ]) : [null, null, null, null];
  const result = assessYoutickPlaybackReadiness({ chain: status?.chain_id, blockHash: access?.block_hash,
    marketCodeHash: market?.block_hash === access?.block_hash ? market?.code_hash : null,
    accessCodeHash: access?.code_hash, health, state, playPolicy, uploadPolicy });
  console.log(`::notice title=YouTick legacy playback readiness (read only)::${JSON.stringify(result)}`);
}
main().catch(error => {
  const text = String(error.message).slice(0, 1000).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.error('[youtick-playback-read-only] readiness probe failed');
  console.log(`::error title=YouTick playback probe stopped::${text}`); process.exitCode = 1;
});
