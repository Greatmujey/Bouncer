// Public dummy capability against a probe-only row. No wallet, signature,
// account, secret, or NEAR transaction is involved. Never uses the direct row.
import assert from 'node:assert/strict';
const endpoint='https://itzqbvbpmbnimvpyaige.supabase.co/functions/v1/bouncer-direct-one-shot';
const origin='https://8svrp7.csb.app',capability='p'.repeat(43),original='1'.repeat(32);
async function request(operation,extra={},from=origin){
  const response=await fetch(endpoint,{method:'POST',headers:{origin:from,'content-type':'application/json'},
    body:JSON.stringify({capability,operation,...extra}),signal:AbortSignal.timeout(30000)});
  let body;try{body=await response.json()}catch{body={}}
  return {status:response.status,cors:response.headers.get('access-control-allow-origin'),body};
}
const preflight=await fetch(endpoint,{method:'OPTIONS',headers:{origin,'access-control-request-method':'POST',
  'access-control-request-headers':'content-type'},signal:AbortSignal.timeout(30000)});
assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),origin);
const read=await request('read');assert.equal(read.status,200);assert.equal(read.cors,origin);
assert.deepEqual(read.body,{scope:'probe',state:'ready',original_hash:null,claim_acquired:false,expired:false});
const wrong=await request('read',{},'https://other123.csb.app');assert.equal(wrong.status,503);
assert.deepEqual(wrong.body,{error:'unavailable'});
const blocked=await request('read',{},'https://example.com');assert.equal(blocked.status,403);
const results=await Promise.all(Array.from({length:12},()=>request('claim')));
assert.ok(results.every(x=>x.status===200&&x.body.scope==='probe'&&x.body.state==='claimed'));
assert.equal(results.filter(x=>x.body.claim_acquired).length,1);
const saved=await request('retain',{original_hash:original});assert.equal(saved.status,200);assert.equal(saved.body.original_hash,original);
const again=await request('retain',{original_hash:original});assert.equal(again.status,200);
const mismatch=await request('retain',{original_hash:'2'.repeat(32)});assert.equal(mismatch.status,503);
const after=await request('read');assert.equal(after.body.state,'retained');assert.equal(after.body.original_hash,original);
console.log('Live probe-only journal passed: exact-origin CORS, one of 12 claims, immutable dummy hash. No wallet or transaction.');
