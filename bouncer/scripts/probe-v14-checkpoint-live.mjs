// Public read-only deployment probe: CORS OPTIONS, hosted HTML and health only.
// No wallet, enrollment, checkpoint row, key, signature or transaction is used.
import assert from 'node:assert/strict';

const site='https://bouncer-production-6df1.up.railway.app';
const endpoint='https://jiouaqwxkvlkmvyumzwc.supabase.co/functions/v1/bouncer-v14-bootstrap-checkpoint';
const origins=[site,'https://bouncer-near.vercel.app'];
const read=(url,options={})=>fetch(url,{...options,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20_000)});

const page=await read(`${site}/workspace?checkpoint-probe=1`);
assert.equal(page.status,200);
const html=await page.text();
assert.match(html,/id="wallet-bootstrap-candidate-enroll"/);
assert.match(html,/id="wallet-bootstrap-recovery-compare"/);
assert.match(html,/wallet\.bundle\.js\?v=\d+/);
const health=await read(`${site}/healthz`);assert.equal(health.status,200);
const state=await health.json();
assert.equal(state.status,'STANDBY');assert.equal(state.mission_enabled,false);assert.equal(state.transactions_enabled,false);
const responses=[];
for(const origin of [...origins,'https://invalid.example']) {
  const response=await read(endpoint,{method:'OPTIONS',headers:{origin,'access-control-request-method':'POST',
    'access-control-request-headers':'content-type'}});
  responses.push({origin,status:response.status,allowOrigin:response.headers.get('access-control-allow-origin'),
    allowMethods:response.headers.get('access-control-allow-methods'),allowHeaders:response.headers.get('access-control-allow-headers')});
}
const enabled=responses[0].status===204;
assert([204,503].includes(responses[0].status),'checkpoint must be enabled or explicitly disabled');
for(const response of responses.slice(0,2)) {
  assert.equal(response.status,enabled?204:503);
  if(enabled) {
    assert.equal(response.allowOrigin,response.origin);
    assert.match(response.allowMethods??'',/\bOPTIONS\b/i);
    assert.match(response.allowMethods??'',/\bPOST\b/i);
    assert.match(response.allowHeaders??'',/\bcontent-type\b/i);
  }
}
assert.equal(responses[2].status,enabled?403:503,'unapproved origin must not be enabled');
console.log(`::notice title=Live recovery-only preflight::${JSON.stringify({hosted_ui:true,checkpoint_enabled:enabled,
  allowed_origins:responses.slice(0,2).map(({status})=>status),unapproved_origin:responses[2].status,
  railway_standby:true,no_wallet:true,no_enrollment:true,no_transaction:true})}`);
