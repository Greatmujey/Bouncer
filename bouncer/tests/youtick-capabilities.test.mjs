import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { assessYoutickCapabilities, assessYoutickPlaybackReadiness, YOUTICK_MARKET, TESTNET_CIRCLE_USDC } from '../agent/youtick-capabilities.mjs';
import { YOUTICK_ADAPTIVE_PROFILE } from '../agent/youtick-profiles.mjs';

const input = () => ({ chain: 'testnet', codeHash: nearApi.utils.serialize.base_encode(Buffer.alloc(32, 7)),
  token: TESTNET_CIRCLE_USDC, quoteKeyVersion: 3,
  policy: { version: 1, environment: 'public-testnet', network: 'testnet', market_contract_id: YOUTICK_MARKET,
    signed_quote_required: true, max_source_bytes: '5000000000', profiles: [{ profile_id: 'paid-media-livepeer-v1' }] },
  governance: { new_purchases_paused: false, bridge_frozen: false },
  health: { status: 'ok', service: 'livepeer-bridge', compactUpload: { network: 'testnet', market: YOUTICK_MARKET },
    sponsoredUploadQuoteReady: true, newUploadReady: true, providerMutationEnabled: true, operatorMutationEnabled: true } });

test('read-only discovery reports a candidate, never an independent paid delivery', () => {
  const result = assessYoutickCapabilities(input());
  assert.equal(result.status, 'CANDIDATE_FOR_REVIEW'); assert.deepEqual(result.reasons, []);
  assert.equal(result.circle_testnet_token, TESTNET_CIRCLE_USDC);
  assert.match(result.scope, /no signed quote, payment, upload, independent fulfillment/);
});

test('unavailable, mismatched, paused or mainnet inputs remain blocked or unproven', () => {
  const variants = [
    { ...input(), chain: 'mainnet' }, { ...input(), codeHash: 'invalid' }, { ...input(), token: 'usdc.fakes.testnet' },
    { ...input(), policy: null }, { ...input(), policy: { ...input().policy, signed_quote_required: false } },
    { ...input(), policy: { ...input().policy, max_source_bytes: '0' } }, { ...input(), quoteKeyVersion: 0 },
    { ...input(), governance: { new_purchases_paused: true, bridge_frozen: false } },
    { ...input(), health: null }, { ...input(), health: { ...input().health, newUploadReady: false } },
    { ...input(), health: { ...input().health, compactUpload: { network: 'testnet', market: 'other.testnet' } } },
  ];
  for (const value of variants) {
    const result = assessYoutickCapabilities(value);
    assert.equal(result.status, 'BLOCKED_OR_UNPROVEN'); assert(result.reasons.length > 0);
  }
});

test('legacy playback discovery requires all necessary views without claiming actual readiness or delivery', () => {
  const codeHash = nearApi.utils.serialize.base_encode(Buffer.alloc(32, 8));
  const value = { chain: 'testnet', blockHash: codeHash, marketCodeHash: codeHash, accessCodeHash: codeHash,
    health: { status: 'ok', service: 'livepeer-bridge', compactUpload: { network: 'testnet', market: YOUTICK_MARKET }, playbackReady: true, mediaProvider: { kind: 'studio' } },
    state: { market_contract_id: YOUTICK_MARKET, paused: false, grant_issuance_enabled: true },
    playPolicy: { max_ttl_ms: 600_000, require_origin: true, require_device: true },
    uploadPolicy: { version: 1, environment: 'public-testnet', network: 'testnet', market_contract_id: YOUTICK_MARKET,
      signed_quote_required: true, profiles: [{ profile_id: 'paid-media-livepeer-v1', profile_config_sha256: YOUTICK_ADAPTIVE_PROFILE }] } };
  assert.equal(assessYoutickPlaybackReadiness(value).status, 'NECESSARY_CHECKS_PASSED');
  assert.equal(assessYoutickPlaybackReadiness(value).adaptive_profile_advertised, true);
  assert.equal(assessYoutickPlaybackReadiness(value).observed_final_block_hash, codeHash);
  assert.equal(assessYoutickPlaybackReadiness(value).source_reviewed_adaptive_family, 'studio');
  assert.match(assessYoutickPlaybackReadiness(value).scope, /no proof of bridge\/access binding/);
  const variants = [ { ...value, chain: 'mainnet' }, { ...value, blockHash: 'invalid' },
    { ...value, accessCodeHash: 'invalid' }, { ...value, health: null },
    { ...value, uploadPolicy: null },
    { ...value, uploadPolicy: { ...value.uploadPolicy, profiles: [] } },
    { ...value, uploadPolicy: { ...value.uploadPolicy, profiles: [{ profile_id: 'paid-media-livepeer-v1', profile_config_sha256: 'f'.repeat(64) }] } },
    { ...value, uploadPolicy: { ...value.uploadPolicy, market_contract_id: 'attacker.testnet' } },
    { ...value, health: { ...value.health, playbackReady: false } },
    { ...value, health: { ...value.health, mediaProvider: { kind: 'stream' } } },
    { ...value, health: { ...value.health, mediaProvider: null } }, { ...value, state: null },
    { ...value, state: { ...value.state, paused: true } }, { ...value, state: { ...value.state, grant_issuance_enabled: false } },
    { ...value, state: { ...value.state, market_contract_id: 'attacker.testnet' } },
    { ...value, playPolicy: { ...value.playPolicy, max_ttl_ms: 599_999 } },
    { ...value, playPolicy: { ...value.playPolicy, require_device: false } } ];
  for (const variant of variants) {
    const result = assessYoutickPlaybackReadiness(variant);
    assert.equal(result.status, 'BLOCKED_OR_UNPROVEN'); assert.ok(result.reasons.length);
  }
  const unknownProvider = assessYoutickPlaybackReadiness({ ...value, health: { ...value.health, mediaProvider: null } });
  assert.equal(unknownProvider.adaptive_profile_advertised, true); assert.equal(unknownProvider.media_provider, null);
  assert.equal(unknownProvider.status, 'BLOCKED_OR_UNPROVEN');
  assert.equal(assessYoutickPlaybackReadiness({ ...value, uploadPolicy: null }).adaptive_profile_advertised, null);
  assert.equal(assessYoutickPlaybackReadiness({ ...value, uploadPolicy: { ...value.uploadPolicy, profiles: [] } }).adaptive_profile_advertised, false);
});

test('untrusted health payloads are reduced to a bounded evidence summary', () => {
  const value = input(); value.health = { ...value.health, secret: 'do-not-copy', status: 'ok' };
  const result = assessYoutickCapabilities(value);
  assert(!JSON.stringify(result).includes('do-not-copy'));
  assert(!JSON.stringify(result).includes('providerMutationEnabled'));
});
