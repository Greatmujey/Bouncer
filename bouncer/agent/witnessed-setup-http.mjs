/**
 * Opt-in, same-origin HTTP bridge to the authenticated testnet setup journal.
 * This endpoint never holds a wallet key, signs a transaction, broadcasts, or
 * creates a seller order. A claim is a one-shot journal entry, not approval.
 * Route bodies may include public identity, hashes and off-chain signatures;
 * never log them. All amounts, contracts, RPC and artifacts remain fixed by
 * the trusted backend, not selected in HTTP input.
 */
import crypto from 'node:crypto';

const SHA = '033f255c5822ff97495809f7d60fddf66f266f20c36285fe71296b66decc6d12';
const MAX = 24_576;
const specs = Object.freeze({
  'reserve-challenge': ['issueReservation', ['taskId', 'ownerPublicKey']],
  reserve: ['reserve', ['taskId', 'ownerPublicKey', 'evidence']],
  'claim-challenge': ['issueClaim', ['identity', 'stageId']],
  claim: ['claim', ['identity', 'stageId', 'evidence']],
  'original-challenge': ['issueOriginal', ['identity', 'stageId', 'originalHash']],
  original: ['recordOriginal', ['identity', 'stageId', 'originalHash', 'evidence']],
  'reconcile-challenge': ['issueReconcile', ['identity', 'stageId', 'originalHash']],
  reconcile: ['reconcile', ['identity', 'stageId', 'originalHash', 'evidence']],
  'funded-challenge': ['issueVerifyFunded', ['identity']],
  funded: ['verifyFunded', ['identity', 'evidence']],
  'inspect-challenge': ['issueInspect', ['ownerPublicKey']],
  inspect: ['inspect', ['ownerPublicKey', 'evidence']],
  'preview-original': ['previewOriginal', ['ownerPublicKey', 'stageId', 'originalHash', 'evidence']],
});
const safeCodes = new Set(['UNAUTHENTICATED','OWNER_ALREADY_WITNESSED','OWNER_FENCED','ALREADY_CLAIMED',
  'WITNESS_NOT_CLAIMABLE','WITNESS_COMMIT_UNKNOWN','WITNESS_MISMATCH','SETUP_UNAVAILABLE','SETUP_PREFLIGHT_BLOCKED',
  'SETUP_PREFLIGHT_UNAVAILABLE','SETUP_PREFLIGHT_STALE','CLAIM_COMMITTED_PREFLIGHT_STALE','WITNESSED_CLAIM_STALE',
  'PRIOR_STAGE_UNRESOLVED','RECEIPT_UNAVAILABLE','RECEIPT_UNKNOWN','MISMATCH','DATABASE_UNKNOWN']);
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
function reply(res, code, body) {
  res.writeHead(code, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store',
    'x-content-type-options':'nosniff', 'referrer-policy':'no-referrer' });
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  if (req.headers['content-length'] && (!/^\d+$/.test(req.headers['content-length']) || Number(req.headers['content-length']) > MAX)) throw Error();
  const chunks = []; let total = 0;
  for await (const chunk of req) { total += chunk.length; if (total > MAX) throw Error(); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
}

export function createWitnessedSetupHttpHandler({ service, siteOrigin, wasmBytes, owner, now = Date.now, bodyTimeoutMs = 10_000 } = {}) {
  let site; try { site = new URL(siteOrigin); } catch { throw Error('fixed setup origin required'); }
  if (site.protocol !== 'https:' || site.origin !== siteOrigin || site.username || site.password ||
      site.pathname !== '/' || site.search || site.hash || !service || typeof now !== 'function' ||
      !Number.isSafeInteger(bodyTimeoutMs) || bodyTimeoutMs < 10 || bodyTimeoutMs > 10_000 ||
      Object.values(specs).some(([method]) => typeof service[method] !== 'function') ||
      owner !== 'great_mujey.testnet' || !(wasmBytes instanceof Uint8Array) || wasmBytes.length !== 536651 ||
      crypto.createHash('sha256').update(wasmBytes).digest('hex') !== SHA) throw Error('fixed origin, reviewed artifact and authenticated setup service required');
  const wasm = Buffer.from(wasmBytes); let pending = 0, windowStart = now(), requests = 0;
  return async function handle(req, res, pathname) {
    if (req.headers['x-bouncer-preview'] !== 'witnessed-setup-v1' || (req.headers.origin && req.headers.origin !== siteOrigin)) {
      return reply(res, 403, { error:'unavailable' });
    }
    if (pathname === '/api/wallet-setup/config' && req.method === 'GET') {
      return reply(res, 200, { enabled:true, network:'testnet', owner,
        scope:'Experimental setup only. No policy, seller purchase or delivery is provided.' });
    }
    if (pathname === '/api/wallet-setup/artifact' && req.method === 'GET') {
      res.writeHead(200, { 'content-type':'application/wasm', 'content-length':String(wasm.length),
        'cache-control':'no-store', 'x-content-type-options':'nosniff', 'referrer-policy':'no-referrer' });
      return res.end(wasm);
    }
    const match = /^\/api\/wallet-setup\/([a-z-]+)$/.exec(pathname), spec = match && specs[match[1]];
    if (!spec || req.method !== 'POST') return reply(res, 404, { error:'unavailable' });
    if (req.headers.origin !== siteOrigin || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
      return reply(res, 403, { error:'unavailable' });
    }
    const clock = now();
    if (!Number.isSafeInteger(clock) || clock < windowStart) return reply(res, 503, { error:'unavailable' });
    if (clock - windowStart >= 120_000) { windowStart = clock; requests = 0; }
    if (pending >= 4 || requests >= 80) return reply(res, 429, { error:'unavailable' });
    pending++; requests++;
    try {
      // Bound body upload time, not the authenticated operation. A legitimate
      // setup preflight may wait for several relayed RPC reads; destroying its
      // response socket mid-claim can leave a committed, unrecoverable prompt.
      const timer = setTimeout(() => req.destroy(), bodyTimeoutMs); timer.unref?.();
      let input;
      try { input = await readBody(req); } finally { clearTimeout(timer); }
      const [method, fields] = spec;
      if (!record(input) || Object.keys(input).length !== fields.length || fields.some(k => !Object.hasOwn(input, k))) {
        return reply(res, 400, { error:'invalid request' });
      }
      const result = await service[method](input);
      return reply(res, 200, result);
    } catch (e) {
      const code = safeCodes.has(e?.code) ? e.code : 'SETUP_UNAVAILABLE';
      return reply(res, 409, { error:code, do_not_retry_wallet_prompt:true,
        message:'Stop and reconcile any existing original before another wallet prompt.' });
    } finally { pending--; }
  };
}
