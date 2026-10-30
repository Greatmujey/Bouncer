// Read-only discovery of independent OutLayer price data on NEAR testnet.
// No keys, accounts, signing, transactions or payment. Results are untrusted
// provider/RPC views and are not an endorsement or a delivery guarantee.
import nearApi from 'near-api-js';
import { validateRpcEndpoint } from '../shared/rpc-endpoint.mjs';

const provider = new nearApi.providers.JsonRpcProvider({ url: validateRpcEndpoint(process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com') });
const final = { finality: 'final' }, contract = 'outlayer.testnet', oracle = 'price-oracle.testnet';
const ids = ['zavodil2.testnet/price-oracle', 'price-oracle.testnet/price-oracle'];
const view = (id, method, args = {}) => provider.callFunction(id, method, args, final);
const safe = async (id, method, args = {}) => {
  try { return { ok: true, value: await view(id, method, args) }; }
  catch (error) { return { ok: false, error: String(error.message || error).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 180) }; }
};
function notice(title, data) {
  const text = JSON.stringify(data).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::notice title=${title}::${text.slice(0, 3800)}`);
}
async function main() {
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const [prices, assets, subsidy, estimate] = await Promise.all([
    safe(oracle, 'get_price_data', { asset_ids: ['wrap.near'] }),
    safe(oracle, 'get_assets', { from_index: 0, limit: 20 }), safe(oracle, 'can_subsidize_outlayer_calls'),
    safe(contract, 'estimate_execution_cost', { resource_limits: { max_instructions: 10_000_000_000, max_memory_mb: 256, max_execution_seconds: 60 } }),
  ]);
  notice('Independent testnet oracle read-only views', { prices, assets: assets.ok && Array.isArray(assets.value)
    ? { ok: true, asset_ids: assets.value.map(row => Array.isArray(row) ? row[0] : null) } : assets, subsidy, native_estimate_yocto: estimate });
  for (const project_id of ids) {
    const [project, pricing] = await Promise.all([safe(contract, 'get_project', { project_id }), safe(contract, 'get_project_pricing', { project_id })]);
    const active = project.ok && project.value?.active_version;
    const version = active ? await safe(contract, 'get_version', { project_id, version_key: active }) : null;
    notice('Independent oracle project ' + project_id, { project, version, pricing });
  }
  console.log('Read-only research: no guarded payment or independent delivery has been made.');
}
main().catch(error => { console.error(`[oracle-discovery] ${error.message}`); process.exitCode = 1; });
