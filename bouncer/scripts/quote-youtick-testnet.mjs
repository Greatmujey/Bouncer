#!/usr/bin/env node
// One quote-only POST to a public testnet provider. No payments, uploads,
// signed chain transactions, reservations, retry loop or retained credentials.
import { randomBytes } from 'node:crypto';
import nearApi from 'near-api-js';
import { PaymentRpcProvider } from '../agent/near-account.mjs';
import { readBoundedJson } from '../shared/bounded-json.mjs';
import { assessYoutickCapabilities, YOUTICK_HEALTH, YOUTICK_MARKET } from '../agent/youtick-capabilities.mjs';
import { extractYoutickV1QuoteKey, verifyYoutickQuote, YOUTICK_V1_CODE_HASH, YOUTICK_ADAPTIVE_PROFILE } from '../agent/youtick-quote.mjs';

if (process.argv.length !== 2) throw new Error('usage: node quote-youtick-testnet.mjs');
const VAULT = 'bouncer-ref-44f619d9.testnet';
const BRIDGE = 'https://bridge-public-testnet.youtick.net/v1/sponsored-upload-quotes';
const ORIGIN = 'https://public-testnet.youtick.net';
const provider = new PaymentRpcProvider(process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com');
async function main() {
  const [status, account, healthResponse] = await Promise.all([
    provider.viewNodeStatus(), provider.query({ request_type: 'view_account', account_id: YOUTICK_MARKET, finality: 'final' }),
    fetch(YOUTICK_HEALTH, { redirect: 'error', signal: AbortSignal.timeout(15_000) }),
  ]);
  if (!healthResponse.ok || status?.chain_id !== 'testnet' || account?.code_hash !== YOUTICK_V1_CODE_HASH || !account?.block_hash) throw new Error('testnet market code or health precondition failed');
  const block = { blockId: account.block_hash };
  const view = (method, args = {}) => provider.callFunction(YOUTICK_MARKET, method, args, block);
  const [state, token, policy, governance, quoteKeyVersion, health] = await Promise.all([
    provider.query({ request_type: 'view_state', account_id: YOUTICK_MARKET, prefix_base64: Buffer.from('STATE').toString('base64'), ...block }),
    view('get_usdc_contract_id'), view('get_public_upload_policy'), view('get_governance_state'), view('get_quote_key_version'),
    readBoundedJson(healthResponse, { maxBytes: 65_536, label: 'testnet bridge health' }),
  ]);
  const capability = assessYoutickCapabilities({ chain: status.chain_id, codeHash: account.code_hash, token, policy, governance, quoteKeyVersion, health });
  if (capability.status !== 'CANDIDATE_FOR_REVIEW' || !policy.profiles.some(p => p.profile_id === 'paid-media-livepeer-v1' && p.profile_config_sha256 === YOUTICK_ADAPTIVE_PROFILE)) throw new Error('testnet provider is not ready for the reviewed profile');
  if (state?.block_hash !== account.block_hash || !Array.isArray(state.values) || state.values.length !== 1 ||
      state.values[0].key !== Buffer.from('STATE').toString('base64')) throw new Error('unexpected FINAL market state');
  const encoded = state.values[0].value, bytes = typeof encoded === 'string' ? Buffer.from(encoded, 'base64') : Buffer.alloc(0);
  if (bytes.toString('base64') !== encoded) throw new Error('invalid market state encoding');
  const key = extractYoutickV1QuoteKey(bytes, quoteKeyVersion);
  const request = { creator_id: VAULT, job_id: `bouncer-quote-${randomBytes(10).toString('hex')}`,
    title: 'Bouncer testnet quote probe', price_usdc: '2000000', expected_source_bytes: '100000',
    profile_id: 'paid-media-livepeer-v1', profile_config_sha256: YOUTICK_ADAPTIVE_PROFILE,
    upload_public_key: nearApi.KeyPair.fromRandom('ed25519').getPublicKey().toString(),
    upload_key_expires_at_ms: String(Date.now() + 3_600_000) };
  // One bounded POST. A quote can consume provider rate limits; it is not a purchase.
  const response = await fetch(BRIDGE, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ request }), redirect: 'error', signal: AbortSignal.timeout(15_000) });
  const body = await readBoundedJson(response, { maxBytes: 65_536, label: 'testnet signed quote response' });
  if (!response.ok) {
    const code = typeof body?.error === 'string' && /^[a-z0-9_]{1,80}$/.test(body.error) ? body.error : 'unavailable';
    throw new Error(`provider quote request returned HTTP ${response.status}: ${code}`);
  }
  if (JSON.stringify(body.request) !== JSON.stringify(request) || body.public_key_version !== quoteKeyVersion) throw new Error('provider response changed the request or quote key version');
  const finalBlock = await provider.block({ finality: 'final' });
  const result = verifyYoutickQuote({ request, quote: body.quote, signature: body.signature, publicKey: key, quoteKeyVersion,
    blockHeight: finalBlock?.header?.height, nowMs: Date.now(), maxFeeMicro: '600000' });
  console.log(`::notice title=Independent provider signed testnet quote::${JSON.stringify({ ...result, market_code_hash: account.code_hash,
    quote_requests: 1, sends: 0, uploads: 0, note: 'hypothetical 100000-byte clip; upload key discarded; no order placed' })}`);
}
main().catch(error => {
  const text = String(error.message).slice(0, 1000).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.error(`[youtick-quote-only] ${error.message}`);
  console.log(`::error title=Independent provider quote probe stopped::${text}`); process.exitCode = 1;
});
