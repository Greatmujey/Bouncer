// Public, read-only testnet transaction inspection. No keys or transactions.
// Do not treat RPC logs as independent proof of provider behavior; use them to
// reconcile one existing hash, not to decide an ambiguous payment is retryable.
import nearApi from 'near-api-js';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { validateRpcEndpoint } from '../shared/rpc-endpoint.mjs';

const [hash, signer] = process.argv.slice(2);
if (!/^[1-9A-HJ-NP-Za-km-z]{32,60}$/.test(hash || '') || !isTestnetAccount(signer) || process.argv.length !== 4) {
  throw new Error('usage: node inspect-testnet-transaction.mjs TRANSACTION_HASH TESTNET_SIGNER');
}
const provider = new nearApi.providers.JsonRpcProvider({ url: validateRpcEndpoint(process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com') });
function notice(title, value) {
  const text = JSON.stringify(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::notice title=${title}::${text.slice(0, 3800)}`);
}
async function main() {
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const result = await provider.txStatusReceipts(hash, signer, 'FINAL');
  if (result?.transaction_outcome?.id !== hash || result?.transaction?.signer_id !== signer) throw new Error('RPC transaction identity mismatch');
  let decoded;
  try { decoded = JSON.parse(Buffer.from(result.status?.SuccessValue || '', 'base64').toString('utf8')); } catch { decoded = null; }
  notice('Existing testnet transaction', { hash, signer, final_status: result.final_execution_status, status: result.status, decoded });
  for (const item of result.receipts_outcome || []) {
    const logs = (item?.outcome?.logs || []).filter(x => typeof x === 'string').map(x => x.slice(0, 2400)).slice(0, 8);
    notice('Existing receipt ' + String(item?.id || '').slice(0, 16), { id: item?.id, block: item?.block_hash,
      executor: item?.outcome?.executor_id, status: item?.outcome?.status, logs });
  }
  console.log('Read-only investigation only; this does not resend or authorize another payment.');
}
main().catch(error => { console.error(`[inspect-testnet] ${error.message}`); process.exitCode = 1; });
