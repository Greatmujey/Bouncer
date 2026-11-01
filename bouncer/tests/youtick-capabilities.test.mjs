import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { assessYoutickCapabilities, YOUTICK_MARKET, TESTNET_CIRCLE_USDC } from '../agent/youtick-capabilities.mjs';

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

test('untrusted health payloads are reduced to a bounded evidence summary', () => {
  const value = input(); value.health = { ...value.health, secret: 'do-not-copy', status: 'ok' };
  const result = assessYoutickCapabilities(value);
  assert(!JSON.stringify(result).includes('do-not-copy'));
  assert(!JSON.stringify(result).includes('providerMutationEnabled'));
});
