/** Conservative testnet estimate for the V11 FT-call/project runners.
 * Restricted-key allowance pays gas, not FT/native value. The on-chain gas
 * price can move after the pinned view and nearcore calculates exact admission
 * costs separately: this is a fail-closed heuristic, not a reservation or a
 * guarantee of admission. All values are integer yoctoNEAR. */
export const V11_RESOURCE_GAS = 300n * 10n ** 12n;
const U128_MAX = (1n << 128n) - 1n;
export function estimateV11ResourceGasAllowance(price) {
  if (typeof price !== 'string' || !/^[1-9][0-9]{0,38}$/.test(price) || BigInt(price) > U128_MAX) {
    throw new Error('invalid pinned gas price');
  }
  // 30% over prepaid gas plus 0.001 test-NEAR for transaction overhead.
  const estimate = V11_RESOURCE_GAS * BigInt(price) * 13n / 10n + 10n ** 21n;
  if (estimate > U128_MAX) throw new Error('gas allowance estimate exceeds u128');
  return estimate;
}
