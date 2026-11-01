/**
 * Testnet-only verification of a direct Bouncer NEP-141 payment for a seller.
 * This library does not ask a seller to trust a buyer-provided result or payee:
 * every expected field must come from the seller's own reviewed order/config.
 * It trusts the chosen RPC, the pinned Bouncer deployment and the token code;
 * it is not a light-client proof, a replay database, or evidence of delivery.
 */
import nearApi from 'near-api-js';
import { isTestnetAccount, isTestnetToken } from './lib/account-id.mjs';
import { isTransactionHash, verifyDirectPayment } from './lib/direct-payment-settlement.mjs';
import { validateClaimTerms, verifyClaimAuthorization } from './lib/resource-claim.mjs';
export { normalizeOrder, orderMemo, orderMemoV2, challengeFromOrderMemo, orderMemoV3, challengeFromOrderMemoV3 } from './lib/resource-order.mjs';
export { CLAIM_SCHEME, canonicalClaimOrigin, validateClaimTerms, claimMessage, claimDigest,
  verifyClaimAuthorization, signClaimAuthorization } from './lib/resource-claim.mjs';

const U128_MAX = (1n << 128n) - 1n;

/** Validate a seller-owned payment expectation; no fields may be inferred from the buyer's transaction. */
export function validatePaymentExpectation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('payment expectation must be an object');
  const fields = ['tx_hash', 'contract_id', 'owner_account_id', 'policy_id', 'token', 'payee', 'amount', 'memo'];
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) {
    throw new Error('payment expectation must contain exactly the reviewed fields');
  }
  if (!isTransactionHash(value.tx_hash) || !isTestnetAccount(value.contract_id) ||
      !isTestnetAccount(value.owner_account_id) || !isTestnetAccount(value.payee) || !isTestnetToken(value.token)) {
    throw new Error('payment expectation must pin a valid hash and testnet accounts/token');
  }
  if (typeof value.policy_id !== 'string' || !value.policy_id.trim() || Buffer.byteLength(value.policy_id) > 128 ||
      typeof value.memo !== 'string' || !value.memo.trim() || Buffer.byteLength(value.memo) > 256 ||
      typeof value.amount !== 'string' || !/^[1-9][0-9]{0,38}$/.test(value.amount) || BigInt(value.amount) > U128_MAX) {
    throw new Error('invalid payment policy, memo or token amount');
  }
  return Object.fromEntries(fields.map(field => [field, value[field]]));
}

/** Verify FINAL raw receipts, signed call, exact transfer and Bouncer callback. */
export function verifyProviderPayment(result, rawExpectation) {
  const expected = validatePaymentExpectation(rawExpectation);
  // A seller need not know the buyer's individual agent key. The RPC supplies
  // it; the pinned Bouncer contract, not this library, enforces agent grants.
  const publicKey = result?.transaction?.public_key;
  try {
    if (typeof publicKey !== 'string' || nearApi.utils.PublicKey.from(publicKey).toString() !== publicKey) throw new Error();
  } catch { throw new Error('missing or invalid transaction signing key'); }
  return verifyDirectPayment({ result, contractId: expected.contract_id, ownerAccountId: expected.owner_account_id,
    request: { policy_id: expected.policy_id, token: expected.token, payee: expected.payee,
      amount: expected.amount, memo: expected.memo }, publicKey, txHash: expected.tx_hash });
}

/** Check testnet and fetch receipt-inclusive FINAL data before verification. */
export async function readAndVerifyProviderPayment({ provider, expectation }) {
  const expected = validatePaymentExpectation(expectation);
  if (!provider || typeof provider.viewNodeStatus !== 'function' || typeof provider.txStatusReceipts !== 'function') {
    throw new Error('a testnet RPC with receipt-inclusive transaction status is required');
  }
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('provider RPC must report testnet');
  const result = await provider.txStatusReceipts(expected.tx_hash, expected.owner_account_id, 'FINAL');
  return verifyProviderPayment(result, expected);
}

/** Verify both seller-owned payment terms and an off-chain claim by the actual transaction key. */
export function verifyAuthenticatedProviderPayment(result, rawExpectation, rawTerms, authorization) {
  const expected = validatePaymentExpectation(rawExpectation), terms = validateClaimTerms(rawTerms);
  for (const field of ['tx_hash', 'contract_id', 'owner_account_id', 'policy_id', 'token', 'payee', 'amount', 'memo']) {
    if (terms[field] !== expected[field]) throw new Error('authenticated claim does not match the seller payment expectation');
  }
  const settlement = verifyProviderPayment(result, expected);
  const publicKey = result.transaction.public_key;
  verifyClaimAuthorization(terms, authorization, publicKey);
  return { settlement, agent_public_key: publicKey };
}

/** Read FINAL testnet receipts once and authenticate against their signing key. */
export async function readAndVerifyAuthenticatedProviderPayment({ provider, expectation, terms, authorization }) {
  const expected = validatePaymentExpectation(expectation);
  if (!provider || typeof provider.viewNodeStatus !== 'function' || typeof provider.txStatusReceipts !== 'function') {
    throw new Error('a testnet RPC with receipt-inclusive transaction status is required');
  }
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('provider RPC must report testnet');
  const result = await provider.txStatusReceipts(expected.tx_hash, expected.owner_account_id, 'FINAL');
  return verifyAuthenticatedProviderPayment(result, expected, terms, authorization);
}
