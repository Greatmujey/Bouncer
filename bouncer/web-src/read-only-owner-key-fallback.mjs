/** Phone-preview fallback when the browser cannot reach the public testnet
 * key-view RPC. Only the exact CLI/NEP-413 key check can be relayed. Signature
 * verification still happens locally and the backend checks a pinned fresh
 * FINAL block. This cannot sign, broadcast or grant spending permission. */
import { isTestnetAccount } from './wallet-utils.mjs';
import { withReadOnlyRelay } from './buffer-readiness-preview.mjs';
const RPC = 'https://test.rpc.fastnear.com';
const headers = {'x-bouncer-preview':'read-only','content-type':'application/json'};
export function createOwnerKeyFallbackFetch({ fetch: fetchImpl = globalThis.fetch, enabled = false } = {}) {
  if (typeof fetchImpl !== 'function' || typeof enabled !== 'boolean') throw Error('owner key check unavailable');
  return async (url, options = {}) => {
    if (!enabled || url !== RPC || options.method !== 'POST') return fetchImpl(url, options);
    let body;
    try { body = JSON.parse(options.body); } catch { return fetchImpl(url, options); }
    const p = body?.params;
    const exact = body && Object.keys(body).sort().join(',') === 'id,jsonrpc,method,params' &&
      body.jsonrpc === '2.0' && body.id === 'bouncer-cli-login' && body.method === 'query' && p &&
      Object.keys(p).sort().join(',') === 'account_id,finality,public_key,request_type' &&
      p.request_type === 'view_access_key' && p.finality === 'final' && isTestnetAccount(p.account_id) &&
      typeof p.public_key === 'string' && /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p.public_key);
    if (!exact) return fetchImpl(url, options);
    try { const response = await fetchImpl(url, options); if (response?.ok) return response; } catch { /* try the read-only relay */ }
    const result = await withReadOnlyRelay({ fetch:fetchImpl, work:async () => {
      const response = await fetchImpl('/api/read-only/owner-key', { method:'POST', credentials:'same-origin', cache:'no-store', headers,
        body:JSON.stringify({owner:p.account_id,publicKey:p.public_key}) });
      if (!response.ok) throw Error('owner key check unavailable');
      const text = await response.text(); if (text.length > 2048) throw Error('owner key check unavailable');
      return JSON.parse(text);
    } });
    if (typeof result?.full_access !== 'boolean') throw Error('owner key check unavailable');
    return new Response(JSON.stringify({jsonrpc:'2.0',id:'bouncer-cli-login',result:{
      permission:result.full_access ? 'FullAccess' : {FunctionCall:{}} }}), {status:200,headers:{'content-type':'application/json'}});
  };
}
