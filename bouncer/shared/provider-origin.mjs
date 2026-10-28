/** Validate an operator-pinned provider origin without contacting it. */
export function validateProviderOrigin(baseUrl) {
  if (typeof baseUrl !== 'string' || Buffer.byteLength(baseUrl) > 2048) throw new Error('provider URL must be a bare origin without credentials');
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error('provider URL must be a bare origin without credentials'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('provider must use HTTPS or loopback HTTP');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('provider URL must be a bare origin without credentials');
  return url;
}
