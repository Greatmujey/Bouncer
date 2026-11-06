// This connection layer is explicitly testnet-only. Implicit account IDs have
// no network suffix; the connector and RPC are still pinned to testnet.
export function isTestnetAccount(value) {
  return typeof value === 'string' && value.length <= 64 && (
    /^[a-f0-9]{64}$/.test(value) ||
    /^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*\.testnet$/.test(value)
  );
}
