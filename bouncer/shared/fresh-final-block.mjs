/** Fail closed on a malformed, old or implausibly future FINAL snapshot.
 * This uses the local clock and trusts the RPC's block header; it is not a
 * cryptographic consensus proof and does not guarantee subsequent freshness. */
import { isTransactionHash } from './direct-payment-settlement.mjs';

export const MAX_FINAL_BLOCK_AGE_MS = 120_000;
export const MAX_FINAL_BLOCK_FUTURE_SKEW_MS = 30_000;
export function assertFreshFinalBlock(block, nowMs) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 1 || !Number.isFinite(new Date(nowMs).getTime())) {
    throw new Error('invalid local time');
  }
  const hash = block?.header?.hash, nanos = block?.header?.timestamp_nanosec;
  if (!isTransactionHash(hash) || typeof nanos !== 'string' || !/^[1-9][0-9]{0,19}$/.test(nanos)) {
    throw new Error('FINAL block is unavailable or invalid');
  }
  const blockMs = BigInt(nanos) / 1_000_000n, localMs = BigInt(nowMs);
  if (blockMs < localMs - BigInt(MAX_FINAL_BLOCK_AGE_MS) || blockMs > localMs + BigInt(MAX_FINAL_BLOCK_FUTURE_SKEW_MS)) {
    throw new Error('FINAL block is stale or local clock is incorrect');
  }
  return { hash, timestamp_ms: Number(blockMs) };
}
