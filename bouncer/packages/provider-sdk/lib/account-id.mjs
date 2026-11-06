/** Account IDs used by this testnet-only prototype. A 64-hex implicit ID does
 * not encode its network, so only accept it as a token when the caller also
 * checks the RPC reports testnet and pins the contract/token in its policy. */
export function isTestnetAccount(value) {
  return typeof value === 'string' && value.length <= 64 &&
    /^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*\.testnet$/.test(value);
}
/** An implicit account ID does not identify a network. Callers accepting one
 * must separately establish that their RPC and evidence are testnet. */
export function isImplicitNearAccount(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function isTestnetToken(value) {
  return isTestnetAccount(value) || isImplicitNearAccount(value);
}
