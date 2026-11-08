/** Fixed WASI calculation for an owner-reviewed testnet market mission.
 * The source hash binds the input to the already verified OutLayer oracle
 * transaction; it does not itself prove the price, freshness or TEE execution.
 */
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

export { MARKET_SUMMARY_SHA256, MARKET_SUMMARY_PROGRAM } from '../shared/market-summary-constants.mjs';
const exact = (x, keys) => x && typeof x === 'object' && !Array.isArray(x) &&
  Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
export function marketQuantity(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000) throw new Error('market quantity must be an integer from 1 to 1000');
  return value;
}
export function validateMarketInput(raw) {
  if (!exact(raw, ['price_usd_micros','quantity','oracle_tx_hash']) ||
      !Number.isSafeInteger(raw.price_usd_micros) || raw.price_usd_micros < 1 || raw.price_usd_micros > 1_000_000_000_000 ||
      !isTransactionHash(raw.oracle_tx_hash)) throw new Error('invalid market calculation input');
  // This order matches the canonical JSON accepted by the executable.
  return { price_usd_micros: raw.price_usd_micros, quantity: marketQuantity(raw.quantity), oracle_tx_hash: raw.oracle_tx_hash };
}

/** Convert the shortest decimal representation of the verified JS price to
 * micro-USD, rounding half up. This is deterministic, not a claim that the
 * source's observation is accurate or represents an executable market quote. */
export function priceToMicros(price) {
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0 || price > 1_000_000) {
    throw new Error('oracle price is outside the market calculation range');
  }
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(price));
  if (!match) throw new Error('oracle price has an unsupported decimal form');
  const fraction = match[2] ?? '', exponent = Number(match[3] ?? 0) - fraction.length + 6;
  const digits = BigInt(match[1] + fraction);
  let micros;
  if (exponent >= 0) micros = digits * 10n ** BigInt(exponent);
  else {
    const divisor = 10n ** BigInt(-exponent);
    micros = (digits + divisor / 2n) / divisor;
  }
  if (micros < 1n || micros > 1_000_000_000_000n) throw new Error('rounded oracle price is outside the market calculation range');
  return Number(micros);
}

export function marketInputFromOracle(quantity, delivery) {
  return validateMarketInput({ price_usd_micros: priceToMicros(delivery?.result?.price_usd),
    quantity: marketQuantity(quantity), oracle_tx_hash: delivery?.tx_hash });
}

export function verifyMarketOutput(input, output) {
  const safe = validateMarketInput(input);
  const expected = BigInt(safe.price_usd_micros) * BigInt(safe.quantity);
  if (!exact(output, ['value_usd_micros']) || !Number.isSafeInteger(output.value_usd_micros) ||
      BigInt(output.value_usd_micros) !== expected) throw new Error('provider market calculation does not match the verified inputs');
  return output;
}
