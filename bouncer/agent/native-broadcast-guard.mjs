/**
 * Optional local guard for a dependent native sequence. The guard must be
 * synchronous: awaiting external work after the final freshness check would
 * introduce a gap before the single broadcast. It is not an on-chain policy.
 */
export function validateNativeBroadcastGuard(guard) {
  if (guard !== undefined && typeof guard !== 'function') throw new Error('invalid native pre-broadcast guard');
}

export function checkNativeBroadcastGuard(guard) {
  validateNativeBroadcastGuard(guard);
  if (!guard) return;
  const result = guard();
  if (result && (typeof result === 'object' || typeof result === 'function') && typeof result.then === 'function') {
    Promise.resolve(result).catch(() => {});
    throw new Error('native pre-broadcast guard must be synchronous; stop and reconcile');
  }
}
