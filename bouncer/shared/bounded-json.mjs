/** Read a bounded HTTP body without trusting Content-Length. */
export async function readBoundedBytes(response, { maxBytes = 64 * 1024, label = 'HTTP' } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('invalid response byte limit');
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
  return Buffer.concat(chunks);
}

/** Read bounded JSON without trusting Content-Length. */
export async function readBoundedJson(response, { maxBytes = 64 * 1024, label = 'HTTP' } = {}) {
  const bytes = await readBoundedBytes(response, { maxBytes, label });
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error(`${label} returned invalid JSON`); }
}
