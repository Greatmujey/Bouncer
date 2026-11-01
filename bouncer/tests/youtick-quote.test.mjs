import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { extractYoutickV1QuoteKey, verifyYoutickQuote, YOUTICK_ADAPTIVE_PROFILE } from '../agent/youtick-quote.mjs';
import { TESTNET_CIRCLE_USDC, YOUTICK_MARKET } from '../agent/youtick-capabilities.mjs';
import { prepareYoutickFtCall, matchYoutickJob } from '../agent/youtick-ft-plan.mjs';

const sha = x => createHash('sha256').update(x).digest('hex');
const now = 1_770_000_000_000;
function fixture() {
  const request = { creator_id: 'vault.testnet', job_id: 'bouncer-test', title: 'Short test clip',
    price_usdc: '2000000', expected_source_bytes: '100000', profile_id: 'paid-media-livepeer-v1',
    profile_config_sha256: YOUTICK_ADAPTIVE_PROFILE, upload_public_key: 'ed25519:' + '1'.repeat(40),
    upload_key_expires_at_ms: String(now + 3600000) };
  const quote = { domain: 'youtick.sponsored-upload-quote', version: '1', network: 'testnet', contract_id: YOUTICK_MARKET,
    creator_id: request.creator_id, job_id: request.job_id, request_sha256: sha(JSON.stringify(request)),
    expected_source_bytes: request.expected_source_bytes, upload_fee_usdc: '500000', sponsor_fee_usdc: '100000',
    total_fee_usdc: '600000', delegate_receiver_id: TESTNET_CIRCLE_USDC, delegate_method: 'ft_transfer_call',
    delegate_gas: '100000000000000', delegate_deposit_yocto: '1', issued_at_ms: String(now - 1000),
    quote_block_height: '1000', max_delegate_block_height: '1200', expires_at_ms: String(now + 119000), quote_key_version: 1 };
  const message = Object.values(quote).join('\n');
  quote.quote_id = sha(message);
  const pair = generateKeyPairSync('ed25519');
  return { request, quote, signature: sign(null, Buffer.from(message), pair.privateKey).toString('base64'),
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32), quoteKeyVersion: 1,
    blockHeight: 1001, nowMs: now, maxFeeMicro: '600000' };
}
test('verifies a signed testnet offer for the exact vault, request, token and bounded fee', () => {
  const result = verifyYoutickQuote(fixture());
  assert.equal(result.status, 'VERIFIED_SIGNED_QUOTE');
  assert.equal(result.fee_micro, '600000');
  assert.match(result.scope, /no payment, upload, fulfillment/);
});

test('rejects forged, expired, over-budget or differently bound quotes', () => {
  const mutations = [
    f => { f.request.creator_id = 'attacker.testnet'; }, f => { f.request.expected_source_bytes = '100001'; },
    f => { f.request.profile_config_sha256 = 'a'.repeat(64); }, f => { f.request.extra = 'ignored'; },
    f => { f.quote.network = 'mainnet'; }, f => { f.quote.contract_id = 'attacker.testnet'; },
    f => { f.quote.request_sha256 = '0'.repeat(64); }, f => { f.quote.total_fee_usdc = '600001'; },
    f => { f.quote.delegate_receiver_id = 'attacker.testnet'; }, f => { f.quote.delegate_deposit_yocto = '0'; },
    f => { f.quote.quote_key_version = 2; }, f => { f.quote.issued_at_ms = String(now + 1); },
    f => { f.nowMs = now + 120000; }, f => { f.blockHeight = 1201; }, f => { f.maxFeeMicro = '599999'; },
    f => { f.quote.quote_id = '0'.repeat(64); }, f => { f.signature = Buffer.alloc(64).toString('base64'); },
    f => { f.publicKey = Buffer.alloc(32); }, f => { f.quote.extra = 'ignored'; },
  ];
  for (const mutate of mutations) { const f = fixture(); mutate(f); assert.throws(() => verifyYoutickQuote(f)); }
});

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function vec(value) { const b = Buffer.from(value); return Buffer.concat([u32(b.length), b]); }
function state(key) {
  return Buffer.concat([u32(2), ...['platform.testnet','admin.testnet','guardian.testnet','bridge.testnet'].map(vec),
    Buffer.from([0, 0, 0]), vec('takedown.testnet'), ...Array.from({ length: 7 }, (_, i) => vec(String(i))),
    Buffer.alloc(16), vec('publications'), Buffer.alloc(8), Buffer.alloc(16), vec(key), u32(1), Buffer.alloc(16)]);
}
test('extracts the expected key from a bounded reviewed V1 state layout and fails closed on drift', () => {
  const key = Buffer.alloc(32, 7), bytes = state(key);
  assert.deepEqual(extractYoutickV1QuoteKey(bytes, 1), key);
  assert.throws(() => extractYoutickV1QuoteKey(bytes, 2), /mismatch/);
  assert.throws(() => extractYoutickV1QuoteKey(bytes.subarray(0, -1), 1), /truncated/);
  assert.throws(() => extractYoutickV1QuoteKey(Buffer.concat([bytes, Buffer.from([0])]), 1), /mismatch/);
  const wrong = Buffer.from(bytes); wrong.writeUInt32LE(3, 0);
  assert.throws(() => extractYoutickV1QuoteKey(wrong, 1), /version/);
  const bogusLength = Buffer.from(bytes); bogusLength.writeUInt32LE(4000000, 4);
  assert.throws(() => extractYoutickV1QuoteKey(bogusLength, 1), /field/);
});

function planFixture() {
  const offer = fixture(), plan = prepareYoutickFtCall({ offer, id: 'video1', ownerAccountId: 'owner.testnet',
    policyId: 'storage', policyRevision: 1, routeRevision: 3 });
  const { request, quote } = offer;
  const job = { job_id: request.job_id, creator_id: request.creator_id, title: request.title, price_usdc: request.price_usdc,
    expected_source_bytes: request.expected_source_bytes, profile_id: request.profile_id, profile_config_sha256: request.profile_config_sha256,
    upload_public_key: request.upload_public_key, upload_key_expires_at_ms: request.upload_key_expires_at_ms,
    generation: 1, status: 'Authorized', published_at_ms: null, fee_asset: 'USDC', fee_amount: quote.total_fee_usdc,
    fee_usd_micro: quote.total_fee_usdc, fee_quote_hash: quote.quote_id };
  return { offer, plan, job };
}
test('prepares only an exact bounded owner-reviewed FT route, not an approval or payment', () => {
  const { offer, plan } = planFixture(), { goal } = plan, msg = JSON.parse(goal.msg);
  assert.equal(goal.contract_id, offer.request.creator_id); assert.equal(goal.payee, YOUTICK_MARKET);
  assert.equal(goal.token, TESTNET_CIRCLE_USDC); assert.equal(goal.amount, '600000');
  assert.ok(Buffer.byteLength(goal.msg) <= 2048); assert.equal(msg.action, 'create_paid_job');
  assert.equal(msg.sponsor_quote.quote_id, offer.quote.quote_id); assert.equal(msg.sponsor_quote_signature, offer.signature);
  assert.ok(!Object.hasOwn(msg, 'creator_id')); // provider derives creator from FT sender
  assert.match(plan.warning, /approve exact route with 1 yocto/);
  const options = { offer, id: 'video1', ownerAccountId: 'owner.testnet', policyId: 'storage', policyRevision: 1, routeRevision: 3 };
  assert.throws(() => prepareYoutickFtCall({ ...options, offer: { ...offer, market: 'attacker.testnet' } }), /fixed reviewed market/);
  assert.throws(() => prepareYoutickFtCall({ ...options, offer: { ...offer, signature: Buffer.alloc(64).toString('base64') } }), /signature/);
  assert.throws(() => prepareYoutickFtCall({ ...options, ownerAccountId: 'owner.near' }), /testnet/);
});

test('matching provider job is a state observation, not proof of payment or delivery', () => {
  const { plan, job } = planFixture();
  assert.equal(matchYoutickJob(plan.goal, job).status, 'MATCHING_AUTHORIZED_JOB');
  assert.match(matchYoutickJob(plan.goal, job).scope, /not payment-receipt, uploaded-content or retrieval/);
  assert.equal(matchYoutickJob(plan.goal, { ...job, status: 'Published', published_at_ms: now }).status, 'MATCHING_PUBLISHED_JOB');
  for (const mutate of [
    j => { j.creator_id = 'attacker.testnet'; }, j => { j.job_id = 'different'; }, j => { j.fee_amount = '1'; },
    j => { j.expected_source_bytes = '999'; }, j => { j.profile_config_sha256 = 'a'.repeat(64); },
    j => { j.upload_public_key = 'ed25519:other'; }, j => { j.fee_quote_hash = 'b'.repeat(64); },
    j => { j.status = 'Published'; }, j => { j.status = 'Cancelled'; }, j => { j.generation = 2; },
  ]) { const copy = structuredClone(job); mutate(copy); assert.throws(() => matchYoutickJob(plan.goal, copy)); }
  assert.throws(() => matchYoutickJob({ ...plan.goal, payee: 'attacker.testnet' }, job));
  assert.throws(() => matchYoutickJob({ ...plan.goal, msg: '{"action":"steal"}' }, job));
});
