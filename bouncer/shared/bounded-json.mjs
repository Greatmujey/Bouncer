/** Read a bounded JSON HTTP response without trusting Content-Length. */
export async function readBoundedJson(response, { maxBytes = 64 * 1024, label = 'HTTP' } = {}) {
  const header = response.headers?.get('content-length');
  if (header && /^\d+$/.test(header) && BigInt(header) > BigInt(maxBytes)) throw new Error(`${label} response too large`);
  if (!response.body || typeof response.body.getReader !== 'function') throw new Error(`${label} response has no body`);
  const reader = response.body.getReader(), chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new Error(`${label} response too large`); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error(`${label} returned invalid JSON`); }
}
