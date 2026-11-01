/** Public FINAL RPC results can include the original transaction signature.
 * Retain the outcome and reviewed action for inspection, but not fields that
 * would allow a retained receipt to reconstruct replayable signed bytes. */
export function redactProbeReceipt(result) {
  const copy = structuredClone(result);
  if (copy?.transaction && typeof copy.transaction === 'object') {
    delete copy.transaction.signature;
    delete copy.transaction.nonce;
    delete copy.transaction.block_hash;
  }
  return copy;
}
