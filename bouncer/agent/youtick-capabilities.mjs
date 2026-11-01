/**
 * Read-only assessment of an independently operated testnet video-upload
 * candidate. Source observations and mutable health/chain views are not a
 * deployed-code attestation or an order. The bridge and NEAR RPC are trusted
 * for their responses; no quote, reservation, payment or upload is made.
 */
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

export const YOUTICK_MARKET = 'video-market-v1-260907.youtick-dev-v3.testnet';
export const YOUTICK_HEALTH = 'https://bridge-public-testnet.youtick.net/__health';
export const TESTNET_CIRCLE_USDC = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';

/** Deliberately returns a candidate, never a claim that a service was bought. */
export function assessYoutickCapabilities({ chain, codeHash, token, policy, governance, quoteKeyVersion, health }) {
  const reasons = [];
  if (chain !== 'testnet') reasons.push('RPC did not establish the testnet chain');
  if (!isTransactionHash(codeHash)) reasons.push('market code hash unavailable');
  if (token !== TESTNET_CIRCLE_USDC) reasons.push('market token is not the expected Circle testnet USDC');
  if (!policy || policy.version !== 1 || policy.environment !== 'public-testnet' || policy.network !== 'testnet' ||
      policy.market_contract_id !== YOUTICK_MARKET || policy.signed_quote_required !== true ||
      !Array.isArray(policy.profiles) || !policy.profiles.length ||
      typeof policy.max_source_bytes !== 'string' || !/^[1-9][0-9]{0,19}$/.test(policy.max_source_bytes)) {
    reasons.push('public upload policy is unavailable or does not match the reviewed testnet market');
  }
  if (!governance || governance.new_purchases_paused !== false || governance.bridge_frozen !== false) {
    reasons.push('market purchases or bridge may be paused');
  }
  if (!Number.isSafeInteger(quoteKeyVersion) || quoteKeyVersion < 1) reasons.push('on-chain quote-key version unavailable');
  if (!health || health.status !== 'ok' || health.service !== 'livepeer-bridge' ||
      health.compactUpload?.network !== 'testnet' || health.compactUpload?.market !== YOUTICK_MARKET ||
      health.sponsoredUploadQuoteReady !== true || health.newUploadReady !== true ||
      health.providerMutationEnabled !== true || health.operatorMutationEnabled !== true) {
    reasons.push('independent bridge health does not establish an enabled upload and signed-quote path');
  }
  return { status: reasons.length ? 'BLOCKED_OR_UNPROVEN' : 'CANDIDATE_FOR_REVIEW', reasons,
    chain: chain === 'testnet' ? chain : null, market: YOUTICK_MARKET,
    observed_code_hash: isTransactionHash(codeHash) ? codeHash : null,
    circle_testnet_token: token === TESTNET_CIRCLE_USDC ? token : null,
    quote_key_version: Number.isSafeInteger(quoteKeyVersion) && quoteKeyVersion > 0 ? quoteKeyVersion : null,
    signed_quote_required: policy?.signed_quote_required === true,
    max_source_bytes: typeof policy?.max_source_bytes === 'string' && /^[1-9][0-9]{0,19}$/.test(policy.max_source_bytes) ? policy.max_source_bytes : null,
    profile_count: Array.isArray(policy?.profiles) ? Math.min(policy.profiles.length, 100) : null,
    health: health ? { status: health.status === 'ok' ? 'ok' : 'not_ok', quote_ready: health.sponsoredUploadQuoteReady === true,
      new_upload_ready: health.newUploadReady === true, provider_mutations: health.providerMutationEnabled === true,
      operator_mutations: health.operatorMutationEnabled === true } : null,
    scope: 'read-only capability discovery; no signed quote, payment, upload, independent fulfillment, deployed-code attestation or production claim' };
}
