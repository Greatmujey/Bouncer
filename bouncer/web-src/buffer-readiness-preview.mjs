/** Experimental phone preview: public testnet readiness and an unsigned review.
 * This is deliberately not a wallet prompt, transaction, quote or purchase. */
const RELAY = 'https://bouncer-testnet-readonly-relay-tau.vercel.app/api/read';
const HEADERS = { 'x-bouncer-preview': 'read-only' };
const jobId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function readJson(response, max = 1_900_000) {
  if (!response.ok) throw new Error('READ_ONLY_UNAVAILABLE');
  const text = await response.text();
  if (text.length > max) throw new Error('READ_ONLY_UNAVAILABLE');
  try { return JSON.parse(text); } catch { throw new Error('READ_ONLY_UNAVAILABLE'); }
}

/** Each server-signed read-only job is sent to one pinned relay. Only the
 * encrypted result returns through the browser; OIDC bearer tokens and the
 * relay's upstream response are never exposed to JavaScript. */
export async function fetchBufferReadinessPreview({ fetch: fetchImpl = globalThis.fetch, onProgress = () => {}, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function' || typeof onProgress !== 'function' || typeof now !== 'function') throw new Error('READ_ONLY_UNAVAILABLE');
  const get = (url, init = {}) => fetchImpl(url, { cache: 'no-store', credentials: 'same-origin', ...init,
    headers: { ...HEADERS, ...(init.headers || {}) } });
  const config = await readJson(await get('/api/read-only/config'));
  if (config.relay_url !== RELAY) throw new Error('READ_ONLY_UNAVAILABLE');
  const start = await readJson(await get('/api/read-only/review', { method: 'POST' }));
  if (!jobId(start.task_id)) throw new Error('READ_ONLY_UNAVAILABLE');
  const running = new Map(), deadline = now() + 90_000;
  let failed = false, lastTask = 0;
  async function run(id) {
    const signedJob = await readJson(await get(`/api/read-only/jobs/${id}`), 24_000);
    if (signedJob.job_id !== id) throw new Error('READ_ONLY_UNAVAILABLE');
    const remote = await fetchImpl(RELAY, { method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedJob) });
    const envelope = await readJson(remote);
    if (envelope.job_id !== id || envelope.version !== 1) throw new Error('READ_ONLY_UNAVAILABLE');
    await readJson(await get('/api/read-only/results', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope) }));
  }
  while (now() < deadline) {
    if (failed) throw new Error('READ_ONLY_UNAVAILABLE');
    const pending = await readJson(await get('/api/read-only/pending'), 8_000);
    if (!Array.isArray(pending.jobs) || pending.jobs.length > 32 || !pending.jobs.every(jobId)) throw new Error('READ_ONLY_UNAVAILABLE');
    for (const id of pending.jobs) if (!running.has(id) && running.size < 32) {
      const promise = run(id).catch(() => { failed = true; }).finally(() => running.delete(id));
      running.set(id, promise);
    }
    if (now() - lastTask > 500) {
      const result = await readJson(await get(`/api/read-only/review/${start.task_id}`), 64_000);
      lastTask = now();
      if (result.state === 'complete') return result;
      if (result.state !== 'checking') throw new Error('READ_ONLY_UNAVAILABLE');
      onProgress('Checking one final testnet block and preparing an unsigned review…');
    }
    await sleep(180);
  }
  throw new Error('READ_ONLY_TIMEOUT');
}
