// READ-ONLY testnet discovery. No keys, accounts, signatures or payments.
// A registry view/HTTPS key is not proof of deployed worker code, a live
// fulfilled order, commercial utility, TEE, or unbiased randomness.
import nearApi from 'near-api-js';
import { readBoundedJson } from '../shared/bounded-json.mjs';

const OUTLAYER = 'outlayer.testnet';
const PROJECT = 'connectors.outlayer.testnet/connector-probe';
const TOKEN = 'usdc.fakes.testnet'; // NOT Circle USDC and has no real value
const VERSION = '2d406ed8005a422c38aec0616990989970e2c444c1386d4f09d54cce59468fb9';
const PIN = 'c0c5aeae1688c2f7cc2350aae1ee3ce96eddc0de84d678db873de48268f8cfa8';
const provider = new nearApi.providers.JsonRpcProvider({ url: process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com' }, { retries: 1 });
const view = (method, args = {}) => provider.callFunction(OUTLAYER, method, args, { finality: 'final' });
async function main() {
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const [token, project, version, pricing, account, response] = await Promise.all([
    view('get_payment_token_contract'), view('get_project', { project_id: PROJECT }),
    view('get_version', { project_id: PROJECT, version_key: VERSION }), view('get_project_pricing', { project_id: PROJECT }),
    provider.query({ request_type: 'view_account', account_id: OUTLAYER, finality: 'final' }),
    fetch('https://testnet-api.outlayer.ai/vrf/pubkey', { redirect: 'error', signal: AbortSignal.timeout(15_000) }),
  ]);
  if (!response.ok) throw new Error(`VRF public-key endpoint HTTP ${response.status}`);
  const key = await readBoundedJson(response, { maxBytes: 4096, label: 'testnet VRF key' });
  const rows = Array.isArray(pricing?.operations) ? pricing.operations.filter(row => row?.operation === 'vrf') : [];
  if (token !== TOKEN || project?.project_id !== PROJECT || project?.active_version !== VERSION ||
      version?.wasm_hash !== VERSION || version?.source?.WasmUrl?.hash !== VERSION ||
      version?.source?.WasmUrl?.build_target !== 'wasm32-wasip2' || pricing?.author_account_id !== 'zavodil.testnet' ||
      rows.length !== 1 || rows[0].price_usd !== '10000' || rows[0].developer_share_bp !== 0 || key?.vrf_public_key_hex !== PIN) {
    throw new Error('testnet VRF price, version, account or independently observed key changed; no payment attempted');
  }
  const report = { chain: 'testnet', provider: OUTLAYER, provider_code_hash: account.code_hash, project: PROJECT,
    version: VERSION, payment_token: TOKEN, price_units: '10000', author: pricing.author_account_id, author_share_bp: 0,
    vrf_public_key_hex: PIN, key_source: 'public HTTPS testnet endpoint; operator must trust and independently pin it',
    scope: 'diagnostic availability/price only; no service execution, payment, commercial provider or TEE proof' };
  console.log(`::notice title=Read-only OutLayer testnet VRF capability::${JSON.stringify(report)}`);
}
main().catch(error => {
  const text = String(error.message || error).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.error(`[vrf-discovery] ${text}`); console.log(`::error title=Read-only VRF capability failed::${text}`); process.exitCode = 1;
});
