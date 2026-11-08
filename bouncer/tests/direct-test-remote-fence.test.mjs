import test from 'node:test';
import assert from 'node:assert/strict';
import {createRemoteDirectFence,directTestCapability,isVerifiedRemoteDirectFence} from '../web-src/direct-test-remote-fence.mjs';
const origin='https://abcd1234.csb.app',capability='a'.repeat(43);
const ok={scope:'direct',state:'ready',original_hash:null,claim_acquired:false,expired:false};

test('a temporary-origin capability survives route changes in the same tab, but never authorizes another host',()=>{
  const data=new Map(),storage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)};
  assert.equal(directTestCapability({origin,hash:`#bouncer-direct=${capability}`},storage),capability);
  assert.equal(directTestCapability({origin,hash:'#connect'},storage),capability);
  assert.equal(directTestCapability({origin:'https://bouncer-near.vercel.app',hash:`#bouncer-direct=${capability}`},storage),capability);
  assert.equal(directTestCapability({origin:'https://other.vercel.app',hash:`#bouncer-direct=${capability}`},storage),'');
  assert.equal(directTestCapability({origin:'https://evil.example',hash:`#bouncer-direct=${capability}`},storage),'');
  assert.equal(directTestCapability({origin,hash:'#bouncer-direct=short'},storage),'');
});
test('only a successful exact-scope response verifies a privately held fence',async()=>{
  let request;
  const fence=createRemoteDirectFence({origin,capability,fetch:async(url,options)=>{request={url,options};return new Response(JSON.stringify(ok))}});
  assert.equal(isVerifiedRemoteDirectFence(fence,origin),false);
  assert.deepEqual(await fence.read(),ok);assert.equal(isVerifiedRemoteDirectFence(fence,origin),true);
  assert.equal(isVerifiedRemoteDirectFence(fence,'https://other123.csb.app'),false);
  assert.equal(isVerifiedRemoteDirectFence({},origin),false);
  assert.equal(request.url,'https://itzqbvbpmbnimvpyaige.supabase.co/functions/v1/bouncer-direct-one-shot');
  assert.equal(request.options.credentials,'omit');assert.equal(request.options.referrerPolicy,'no-referrer');
  assert.deepEqual(JSON.parse(request.options.body),{operation:'read',capability});
});
test('wrong origins, malformed server replies, scope and hashes fail closed',async()=>{
  assert.throws(()=>createRemoteDirectFence({origin:'https://bad.example',capability,fetch(){}}));
  assert.throws(()=>createRemoteDirectFence({origin:'https://other.vercel.app',capability,fetch(){}}));
  const allowed=createRemoteDirectFence({origin:'https://bouncer-near.vercel.app',capability,fetch:async()=>new Response(JSON.stringify(ok))});
  await allowed.read();assert.equal(isVerifiedRemoteDirectFence(allowed,'https://bouncer-near.vercel.app'),true);
  assert.throws(()=>createRemoteDirectFence({origin,capability:'short',fetch(){}}));
  for(const result of [
    {...ok,scope:'probe'},{...ok,extra:true},{...ok,original_hash:'invalid'},
    {...ok,claim_acquired:true},{...ok,state:'claimed',original_hash:'1'.repeat(32)},
    {...ok,state:'retained',original_hash:null}, {...ok,expired:'false'},null,
  ]){
    const fence=createRemoteDirectFence({origin,capability,fetch:async()=>new Response(JSON.stringify(result))});
    await assert.rejects(fence.read());assert.equal(isVerifiedRemoteDirectFence(fence,origin),false);
  }
  const fence=createRemoteDirectFence({origin,capability,fetch:async()=>new Response('{}',{status:503})});
  await assert.rejects(fence.claim());assert.throws(()=>fence.retain('invalid'));
});
