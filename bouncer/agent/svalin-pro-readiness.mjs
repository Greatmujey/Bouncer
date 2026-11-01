/** Read-only discovery and offline checkout validation for one Svalin testnet
 * Pro offer. This module NEVER creates a checkout, holds a bearer code, sends
 * a transaction or calls a paid route. Published source and an HTTP offer do
 * not attest the deployed seller or establish delivery. */
import { readBoundedJson } from '../shared/bounded-json.mjs';
import { CIRCLE_TESTNET_USDC } from '../scripts/circle-testnet-setup.mjs';

export const SVALIN_ORIGIN = 'https://svalin-api.noobshole.workers.dev';
export const SVALIN_PAYEE = 'svalin-agent.testnet';
export const SVALIN_NETWORK = 'near:testnet';
const MONTH_PRICE_ATOMS = 5_000_000n;
const MAX_SUFFIX_ATOMS = 9_999n;
const MAX_RESERVATION_MS = 48 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const MIN_REVIEW_TIME_MS = 10 * 60 * 1000;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** This pins the small monthly TESTNET offer, not a mutable mainnet endpoint.
 * Any changed terms require a fresh review rather than silent acceptance. */
export function summarizeSvalinProOffer(offer, nowMs = Date.now()) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 1 || !Number.isFinite(new Date(nowMs).getTime())) {
    throw new Error('invalid observation time');
  }
  if (!record(offer) || !Array.isArray(offer.plans) || offer.plans.length > 10 ||
      !record(offer.near) || offer.near.network !== SVALIN_NETWORK || offer.near.environment !== 'testnet' ||
      offer.near.payTo !== SVALIN_PAYEE || offer.near.token !== CIRCLE_TESTNET_USDC || offer.callsPerDay !== 100) {
    throw new Error('seller offer is not the reviewed NEAR testnet profile');
  }
  const month = offer.plans.filter(plan => record(plan) && plan.id === 'month');
  if (month.length !== 1 || month[0].usd !== 5 || month[0].days !== 30) {
    throw new Error('seller monthly price or duration differs from the reviewed profile');
  }
  return {
    status: 'PUBLIC_OFFER_ONLY', observed_at: new Date(nowMs).toISOString(),
    network: SVALIN_NETWORK, environment: 'testnet', token: CIRCLE_TESTNET_USDC,
    payee: SVALIN_PAYEE, plan: 'month', price_atoms: MONTH_PRICE_ATOMS.toString(),
    checkout_amount_min_atoms: (MONTH_PRICE_ATOMS + 1n).toString(),
    checkout_amount_max_atoms: (MONTH_PRICE_ATOMS + MAX_SUFFIX_ATOMS).toString(),
    duration_days: 30, advertised_calls_per_day: 100,
    signed_offer: false, reservation_created: false, payment_sent: false,
    fulfillment_verified: false,
  };
}

/** Validate a later reservation OFFLINE. The checkout is unsigned and this
 * alone cannot authorize a payment or prove that the seller bound it to our
 * secret code. Do not store or print the bearer code in this data structure. */
export function validateSvalinProCheckout({ offer, checkout, nowMs = Date.now() }) {
  summarizeSvalinProOffer(offer, nowMs);
  if (!record(checkout) || checkout.plan !== 'month' || checkout.network !== SVALIN_NETWORK ||
      checkout.payTo !== SVALIN_PAYEE || checkout.token !== CIRCLE_TESTNET_USDC ||
      typeof checkout.amount !== 'string' || !/^5\.\d{6}$/.test(checkout.amount)) {
    throw new Error('checkout terms differ from the reviewed monthly testnet profile');
  }
  const amount = MONTH_PRICE_ATOMS + BigInt(checkout.amount.slice(2));
  if (amount <= MONTH_PRICE_ATOMS || amount > MONTH_PRICE_ATOMS + MAX_SUFFIX_ATOMS) {
    throw new Error('checkout amount is outside the reviewed exact-amount range');
  }
  const expiresMs = typeof checkout.expiresAt === 'string' ? Date.parse(checkout.expiresAt) : NaN;
  if (!Number.isSafeInteger(expiresMs) || !Number.isFinite(new Date(expiresMs).getTime()) ||
      new Date(expiresMs).toISOString() !== checkout.expiresAt ||
      expiresMs < nowMs + MIN_REVIEW_TIME_MS || expiresMs > nowMs + MAX_RESERVATION_MS + CLOCK_SKEW_MS) {
    throw new Error('checkout expiry is invalid or insufficient for safe review');
  }
  return {
    network: SVALIN_NETWORK, environment: 'testnet', token: CIRCLE_TESTNET_USDC,
    payee: SVALIN_PAYEE, plan: 'month', amount_atoms: amount.toString(), expires_at: checkout.expiresAt,
    authorization: 'NOT_APPROVED', quote_signed: false,
    warning: 'Keep the bearer code encrypted and backed up; exact-amount matching does not authenticate the sender.',
  };
}

/** Exactly one bounded public GET; no checkout, activation, authentication,
 * provider code, paid request or transaction is made. */
export async function probeSvalinProOffer({ fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const response = await fetchImpl(`${SVALIN_ORIGIN}/v1/pro`, {
    method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000),
    headers: { accept: 'application/json' },
  });
  try {
    if (!response.ok) throw new Error(`seller offer returned HTTP ${response.status}`);
    const offer = await readBoundedJson(response, { maxBytes: 64 * 1024, label: 'seller offer' });
    return summarizeSvalinProOffer(offer, nowMs);
  } finally { await response.body?.cancel().catch(() => {}); }
}
