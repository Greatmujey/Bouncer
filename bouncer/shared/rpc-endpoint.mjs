/** Operator-selected RPC endpoint: TLS remotely, HTTP only on loopback. */
export function validateRpcEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('invalid NEAR RPC endpoint'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('NEAR RPC must use HTTPS or loopback HTTP');
  if (url.username || url.password || url.search || url.hash) throw new Error('NEAR RPC must not include credentials, query or fragment');
  return url.href;
}
