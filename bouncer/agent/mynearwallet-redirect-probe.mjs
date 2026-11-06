/**
 * Read-only testnet MyNearWallet URL-size probe. The probe sends only HEAD
 * requests to a fixed official host with inert padding; no transaction, wallet
 * account, callback, key, or approval request is sent. A successful HTTP
 * response does not prove a wallet session or that the wallet can sign.
 */
const WALLET_ORIGIN = 'https://testnet.mynearwallet.com';
const WALLET_PATH = '/sign/';
const MAX_REQUEST_PATH_BYTES = 900_000;
const TIMEOUT_MS = 15_000;

/** Return a non-transaction request path of exactly the requested byte length. */
export function inertWalletProbePath(bytes) {
  const prefix = `${WALLET_PATH}?bouncer_readonly_probe=`;
  if (!Number.isSafeInteger(bytes) || bytes < Buffer.byteLength(prefix) || bytes > MAX_REQUEST_PATH_BYTES) {
    throw new Error('bounded wallet probe path length required');
  }
  return prefix + 'a'.repeat(bytes - Buffer.byteLength(prefix));
}

/** Probe fixed lengths sequentially to avoid imposing concurrent load. Unknown
 * network results remain unknown: the measurements do not choose a limit or
 * authorize a retry of any actual transaction. */
export async function inspectMyNearWalletRedirectSizes({ pathBytes, fetchImpl = globalThis.fetch } = {}) {
  if (!Array.isArray(pathBytes) || pathBytes.length < 1 || pathBytes.length > 6 ||
      new Set(pathBytes).size !== pathBytes.length || typeof fetchImpl !== 'function') {
    throw new Error('one to six distinct wallet probe lengths are required');
  }
  // Validate every input before making even the first network request.
  const paths = pathBytes.map(inertWalletProbePath);
  const results = [];
  for (let i = 0; i < paths.length; i++) {
    let response;
    try {
      response = await fetchImpl(WALLET_ORIGIN + paths[i], {
        method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'user-agent': 'Bouncer-testnet-read-only-url-probe/1.0' },
      });
      if (!Number.isInteger(response?.status) || response.status < 100 || response.status > 599) {
        throw new Error('invalid HTTP response status');
      }
      results.push({ path_bytes: pathBytes[i], http_status: response.status });
    } catch {
      results.push({ path_bytes: pathBytes[i], http_status: null, outcome: 'NETWORK_OR_CLIENT_ERROR' });
    } finally {
      await response?.body?.cancel().catch(() => {});
    }
  }
  return { version: 1, target: `${WALLET_ORIGIN}${WALLET_PATH}`, method: 'HEAD', results,
    sign_in_checked: false, transaction_submitted: false, wallet_approval_obtained: false,
    scope: 'Inert request lengths and HTTP status only. HEAD behavior, intermediaries, browser limits and live signing can differ.' };
}
