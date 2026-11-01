/** Stable, owner-assigned economic operation ID; it is not a secret. */
export function validBuyerIntentId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
}
