/**
 * Read-only assessment of an independently operated testnet video-upload
 * candidate. Source observations and mutable health/chain views are not a
 * deployed-code attestation or an order. The bridge and NEAR RPC are trusted
 * for their responses; no quote, reservation, payment or upload is made.
 */
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { YOUTICK_ADAPTIVE_PROFILE } from './youtick-profiles.mjs';

export const YOUTICK_MARKET = 'video-market-v1-260907.youtick-dev-v3.testnet';
export const YOUTICK_ACCESS = 'video-access-v1-260907.youtick-dev-v3.testnet';
export const YOUTICK_HEALTH = 'https://bridge-public-testnet.youtick.net/__health';
export const TESTNET_CIRCLE_USDC = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';

/** A necessary-only, point-in-time legacy playback probe. Health does not
 * reveal which access contract the bridge actually uses, and these views do
 * not establish deployment/source equivalence, caller eligibility or delivery. */
export function assessYoutickPlaybackReadiness({ chain, blockHash, marketCodeHash, accessCodeHash, health, state, playPolicy, uploadPolicy }) {
  const reasons = [];
  const policyValid = uploadPolicy?.version === 1 && uploadPolicy.environment === 'public-testnet' &&
    uploadPolicy.network === 'testnet' && uploadPolicy.market_contract_id === YOUTICK_MARKET &&
    uploadPolicy.signed_quote_required === true && Array.isArray(uploadPolicy.profiles) && uploadPolicy.profiles.length <= 10 &&
    uploadPolicy.profiles.every(profile => profile && typeof profile === 'object' && !Array.isArray(profile) &&
      typeof profile.profile_id === 'string' && typeof profile.profile_config_sha256 === 'string' && /^[a-f0-9]{64}$/.test(profile.profile_config_sha256));
  const adaptiveOffered = policyValid ? uploadPolicy.profiles.some(profile => profile.profile_id === 'paid-media-livepeer-v1' &&
    profile.profile_config_sha256 === YOUTICK_ADAPTIVE_PROFILE) : null;
  if (chain !== 'testnet') reasons.push('RPC did not establish the testnet chain');
  if (!isTransactionHash(blockHash)) reasons.push('shared FINAL block hash unavailable');
  if (!isTransactionHash(marketCodeHash) || !isTransactionHash(accessCodeHash)) reasons.push('FINAL contract code hashes unavailable');
  if (health?.status !== 'ok' || health?.service !== 'livepeer-bridge' || health?.compactUpload?.network !== 'testnet' ||
      health?.compactUpload?.market !== YOUTICK_MARKET || health?.playbackReady !== true) {
    reasons.push('bridge health does not report legacy playback readiness');
  }
  // The inspected source maps the adaptive profile to Studio, but health does
  // not attest which code is deployed or which adapter a future job will use.
  if (!adaptiveOffered) reasons.push('FINAL public upload policy does not establish the source-reviewed adaptive profile');
  // The inspected legacy /v1 token path rejects Stream-backed publications.
  // A missing kind is unknown, not evidence of Studio compatibility.
  if (health?.mediaProvider?.kind !== 'studio') reasons.push('Studio-backed legacy playback is not established by bridge health');
  if (!state || state.market_contract_id !== YOUTICK_MARKET || state.paused !== false || state.grant_issuance_enabled !== true) {
    reasons.push('pinned access state is unavailable, paused, issuance-disabled or references another market');
  }
  if (!playPolicy || !Number.isSafeInteger(playPolicy.max_ttl_ms) || playPolicy.max_ttl_ms < 600_000 ||
      playPolicy.require_origin !== true || playPolicy.require_device !== true) {
    reasons.push('pinned Play policy does not establish the reviewed origin/device-bound 10-minute grant');
  }
  return { status: reasons.length ? 'BLOCKED_OR_UNPROVEN' : 'NECESSARY_CHECKS_PASSED', reasons,
    chain: chain === 'testnet' ? chain : null, market: YOUTICK_MARKET, access: YOUTICK_ACCESS,
    observed_final_block_hash: isTransactionHash(blockHash) ? blockHash : null,
    observed_market_code_hash: isTransactionHash(marketCodeHash) ? marketCodeHash : null,
    observed_access_code_hash: isTransactionHash(accessCodeHash) ? accessCodeHash : null,
    bridge_playback_ready: health?.playbackReady === true, media_provider: ['studio', 'stream'].includes(health?.mediaProvider?.kind) ? health.mediaProvider.kind : null,
    adaptive_profile_advertised: adaptiveOffered, source_reviewed_adaptive_family: 'studio',
    access_paused: typeof state?.paused === 'boolean' ? state.paused : null,
    grant_issuance_enabled: typeof state?.grant_issuance_enabled === 'boolean' ? state.grant_issuance_enabled : null,
    play_max_ttl_ms: Number.isSafeInteger(playPolicy?.max_ttl_ms) ? playPolicy.max_ttl_ms : null,
    scope: 'read-only necessary checks only; no proof of bridge/access binding, deployed code, grant, playback, payment or delivery' };
}

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
