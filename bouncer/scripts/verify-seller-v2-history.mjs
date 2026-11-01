// READ ONLY: check one existing seller-v2 testnet workflow with a trusted SDK
// and receipt-inclusive RPC. No keys, broadcasts, quotes or fulfillment. This
// verifies settlement and reconstructed inputs, not seller independence, market
// truth or future availability of the locally stored object.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PaymentRpcProvider } from '../agent/near-account.mjs';
import { verifyOracleResult } from '../agent/oracle-outlayer.mjs';
import { historicalOracleGoal } from './dependent-history-vectors.mjs';
import { V2_HISTORICAL, V2_SOURCE, V2_CHALLENGES, V2_MEMOS,
  reconstructSellerV2Orders } from './seller-v2-history-vectors.mjs';

const h = V2_HISTORICAL;
export const sellerV2OracleGoal = () => ({ ...historicalOracleGoal(), contract_id: h.contract, owner_account_id: h.owner });

export async function verifySellerV2History({ provider, sdk, verifySource = verifyOracleResult }) {
  if (!provider || typeof provider.viewNodeStatus !== 'function' || typeof provider.txStatusReceipts !== 'function' ||
      !sdk || typeof sdk.verifyProviderPayment !== 'function' || typeof sdk.readAndVerifyProviderPayment !== 'function' ||
      typeof sdk.orderMemoV2 !== 'function' || typeof sdk.challengeFromOrderMemo !== 'function' ||
      typeof verifySource !== 'function') throw new Error('receipt-inclusive testnet RPC and seller-v2 SDK required');
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const sourceChain = await provider.txStatusReceipts(h.source_tx, h.owner, 'FINAL');
  const source = await verifySource(sellerV2OracleGoal(), sourceChain, h.source_key, provider);
  if (source?.tx_hash !== h.source_tx || Object.entries(V2_SOURCE).some(([key, value]) => source?.result?.[key] !== value)) {
    throw new Error('seller-v2 historical oracle receipt does not match the observed result');
  }
  const reconstructed = reconstructSellerV2Orders(source.result), verified = [], challenges = new Set();
  for (const item of reconstructed.cases) {
    const challenge = V2_CHALLENGES[item.resource];
    if (item.memo !== V2_MEMOS[item.resource] || sdk.orderMemoV2(item.resource, item.input, challenge) !== item.memo ||
        sdk.challengeFromOrderMemo(item.resource, item.input, item.memo) !== challenge || challenges.has(challenge)) {
      throw new Error(`${item.resource}: reconstructed seller-v2 order or challenge changed`);
    }
    challenges.add(challenge);
    const expectation = { tx_hash: item.tx_hash, contract_id: h.contract, owner_account_id: h.owner,
      policy_id: 'circle-resources', token: h.token, payee: h.vendor, amount: '1000', memo: item.memo };
    const chain = await provider.txStatusReceipts(item.tx_hash, h.owner, 'FINAL');
    const proof = sdk.verifyProviderPayment(chain, expectation);
    if (proof?.tx_hash !== item.tx_hash || proof?.amount !== expectation.amount || proof?.payee !== expectation.payee || proof?.token !== expectation.token) {
      throw new Error(`${item.resource}: seller proof mismatch`);
    }
    let rejectedSeller = false, rejectedChallenge = false;
    try { sdk.verifyProviderPayment(chain, { ...expectation, payee: 'attacker.testnet' }); } catch { rejectedSeller = true; }
    const other = `${challenge[0] === '0' ? '1' : '0'}${challenge.slice(1)}`;
    const wrongMemo = sdk.orderMemoV2(item.resource, item.input, other);
    if (wrongMemo === item.memo) throw new Error(`${item.resource}: SDK did not bind the challenge`);
    try { sdk.verifyProviderPayment(chain, { ...expectation, memo: wrongMemo }); } catch { rejectedChallenge = true; }
    if (!rejectedSeller || !rejectedChallenge) throw new Error(`${item.resource}: substituted seller or challenge was accepted`);
    if (item.resource === 'compute') {
      const fetched = await sdk.readAndVerifyProviderPayment({ provider, expectation });
      if (fetched?.tx_hash !== item.tx_hash) throw new Error('standalone SDK RPC adapter did not verify the compute transaction');
    }
    verified.push({ resource: item.resource, tx_hash: item.tx_hash, memo: item.memo,
      substituted_seller_rejected: true, substituted_challenge_rejected: true });
  }
  return { mode: 'read-only historical verification; no signing, broadcasts or delivery requests', contract: h.contract,
    source_tx: source.tx_hash, source_result: { ...V2_SOURCE }, native_charge_yocto: source.charged_yocto ?? null,
    native_refund_yocto: source.refunded_to_owner_yocto ?? null, reconstructed_orders: verified,
    seller: 'self-hosted development', independent_ft_seller_proven: false, testnet_tokens_have_no_real_value: true,
    trust: 'configured testnet RPC, Bouncer deployment, token and OutLayer; memos do not prove future storage or price truth' };
}

async function main() {
  // Module import executes code: operators must supply only a trusted local path.
  const local = process.env.BOUNCER_SELLER_SDK_MODULE;
  const sdk = local ? await import(pathToFileURL(path.resolve(local)).href) : await import('../packages/provider-sdk/index.mjs');
  const provider = new PaymentRpcProvider(process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com');
  const summary = await verifySellerV2History({ provider, sdk });
  console.log(`::notice title=Read-only seller-v2 testnet receipt verification::${JSON.stringify(summary)}`);
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`[seller-v2-history] ${error.stack || error}`); process.exitCode = 1; });
}
