// READ ONLY: verify one historical OutLayer result and three Bouncer-guarded
// Circle TESTNET FT receipts. No keys, signatures, broadcasts, provider quotes
// or fulfillment. The reconstructed memo vectors do not prove future storage
// or independent FT-seller adoption.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PaymentRpcProvider } from '../agent/near-account.mjs';
import { verifyOracleResult } from '../agent/oracle-outlayer.mjs';
import { HISTORICAL, OBSERVED_SOURCE, OBSERVED_MEMOS, historicalOracleGoal,
  reconstructHistoricalOrders } from './dependent-history-vectors.mjs';

export async function verifyDependentHistory({ provider, sdk, verifySource = verifyOracleResult }) {
  if (!provider || typeof provider.viewNodeStatus !== 'function' || typeof provider.txStatusReceipts !== 'function' ||
      !sdk || typeof sdk.verifyProviderPayment !== 'function' || typeof sdk.readAndVerifyProviderPayment !== 'function' ||
      typeof verifySource !== 'function') throw new Error('receipt-inclusive testnet RPC and seller SDK required');
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const sourceChain = await provider.txStatusReceipts(HISTORICAL.source_tx, HISTORICAL.owner, 'FINAL');
  const source = await verifySource(historicalOracleGoal(), sourceChain, HISTORICAL.source_key, provider);
  if (source?.tx_hash !== HISTORICAL.source_tx || Object.entries(OBSERVED_SOURCE).some(([key, value]) => source?.result?.[key] !== value)) {
    throw new Error('historical oracle receipt does not match the observed result');
  }
  const reconstructed = reconstructHistoricalOrders(source.result);
  const verified = [];
  for (const item of reconstructed.cases) {
    if (item.memo !== OBSERVED_MEMOS[item.resource]) throw new Error(`${item.resource}: reconstructed order memo changed`);
    const expectation = { tx_hash: item.tx_hash, contract_id: HISTORICAL.contract, owner_account_id: HISTORICAL.owner,
      policy_id: 'circle-resources', token: HISTORICAL.token, payee: HISTORICAL.vendor, amount: '1000', memo: item.memo };
    const chain = await provider.txStatusReceipts(item.tx_hash, HISTORICAL.owner, 'FINAL');
    const proof = sdk.verifyProviderPayment(chain, expectation);
    if (proof?.tx_hash !== item.tx_hash || proof?.amount !== expectation.amount || proof?.payee !== expectation.payee || proof?.token !== expectation.token) {
      throw new Error(`${item.resource}: seller proof mismatch`);
    }
    let rejected = false;
    try { sdk.verifyProviderPayment(chain, { ...expectation, payee: 'attacker.testnet' }); } catch { rejected = true; }
    if (!rejected) throw new Error(`${item.resource}: substituted seller was accepted`);
    if (item.resource === 'compute') {
      const fetched = await sdk.readAndVerifyProviderPayment({ provider, expectation });
      if (fetched?.tx_hash !== item.tx_hash) throw new Error('standalone SDK RPC adapter did not verify the compute transaction');
    }
    verified.push({ resource: item.resource, tx_hash: item.tx_hash, memo: item.memo, substituted_seller_rejected: true });
  }
  return { mode: 'read-only historical verification; no signing, broadcasts or delivery requests', contract: HISTORICAL.contract,
    source_tx: source.tx_hash, source_result: { ...OBSERVED_SOURCE }, native_charge_yocto: source.charged_yocto ?? null,
    native_refund_yocto: source.refunded_to_owner_yocto ?? null, reconstructed_orders: verified,
    seller: 'self-hosted development', independent_ft_seller_proven: false, testnet_tokens_have_no_real_value: true,
    trust: 'configured testnet RPC, Bouncer deployment, token and OutLayer; order memos do not prove future storage or price truth' };
}

async function main() {
  // Optional local archive installation under test. Importing any module runs
  // its code: the operator must supply a trusted path, never a buyer's path.
  const local = process.env.BOUNCER_SELLER_SDK_MODULE;
  const sdk = local ? await import(pathToFileURL(path.resolve(local)).href) : await import('../packages/provider-sdk/index.mjs');
  const provider = new PaymentRpcProvider(process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com');
  const summary = await verifyDependentHistory({ provider, sdk });
  console.log(`::notice title=Read-only dependent testnet receipt verification::${JSON.stringify(summary)}`);
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`[dependent-history] ${error.stack || error}`); process.exitCode = 1; });
}
