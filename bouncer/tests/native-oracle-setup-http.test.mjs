import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createNativeOracleSetupHttpHandler } from '../agent/native-oracle-setup-http.mjs';
import { createReadOnlyPreviewService } from '../agent/read-only-preview-service.mjs';

const wasm=fs.readFileSync(new URL('../../bouncer.wasm',import.meta.url)),SITE='https://phone.example.test';
const HEADERS={origin:SITE,'x-bouncer-preview':'native-oracle-setup-v1','content-type':'application/json'};
const methods=['issueReservation','reserve','issueClaim','claim','issueOriginal','recordOriginal','issueCompletion','verifyCompletion',
  'issueTrial','claimTrial','issueInspect','inspect','previewOriginal'];
const bridge={pending:()=>[],take:()=>null,submit:()=>false,takeForBrowser:()=>null,submitEncrypted:()=>false};
function synthetic(calls){return Object.fromEntries(methods.map(method=>[method,async input=>{calls.push([method,input]);
  if(input.evidence==='bad'){const error=new Error('private detail');error.code='UNAUTHENTICATED';throw error}return {method,execution_authorized:false}}]));}
async function withServer(run,enable=true){const calls=[],service=synthetic(calls);
  const server=createReadOnlyPreviewService({bridge,siteOrigin:SITE,inspectReadiness:async()=>({}),makeReview:async()=>({}),
    ...(enable?{nativeSetupFactory:()=>createNativeOracleSetupHttpHandler({service,siteOrigin:SITE,wasmBytes:wasm,owner:'great_mujey.testnet'})}:{})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  try{await run({base,calls,service})}finally{await new Promise(resolve=>server.close(resolve))}}
const post=(base,route,data,headers=HEADERS)=>fetch(`${base}/api/native-oracle-setup/${route}`,{method:'POST',headers,body:JSON.stringify(data)});

test('native setup is off by default and opt-in routes enforce exact same-origin bodies',async()=>{
  await withServer(async({base})=>assert.equal((await fetch(`${base}/api/native-oracle-setup/config`,{headers:HEADERS})).status,404),false);
  await withServer(async({base,calls})=>{
    const config=await fetch(`${base}/api/native-oracle-setup/config`,{headers:{'x-bouncer-preview':'native-oracle-setup-v1'}});
    const body=await config.json();assert.equal(body.enabled,true);assert.equal(body.ready_for_real_spending,false);
    assert.equal(config.headers.get('cache-control'),'no-store');
    assert.equal((await post(base,'claim',{identity:{},stageId:'x',evidence:{}},{...HEADERS,origin:'https://evil.test'})).status,403);
    assert.equal((await post(base,'claim',{identity:{},stageId:'x',evidence:{}},{...HEADERS,'x-bouncer-preview':'read-only'})).status,403);
    assert.equal((await post(base,'claim',{identity:{},stageId:'x',evidence:{},extra:1})).status,400);
    assert.equal((await post(base,'claim',{identity:{},stageId:'x',evidence:'x'.repeat(30_000)})).status,409);
    assert.equal((await post(base,'broadcast',{payload:'not allowed'})).status,404);assert.equal(calls.length,0);
    const ok=await post(base,'claim',{identity:{},stageId:'x',evidence:'synthetic'});assert.equal(ok.status,200);
    assert.equal((await ok.json()).execution_authorized,false);assert.equal(calls[0][0],'claim');
    const trial={identity:{},goal:{},trial:{},expectedWitnessHead:'synthetic',evidence:'synthetic',completionEvidence:'synthetic'};
    assert.equal((await post(base,'trial',trial,{...HEADERS,origin:'https://evil.test'})).status,403);
    assert.equal((await post(base,'trial',{...trial,unexpected:true})).status,400);
    assert.equal((await post(base,'trial',{...trial,completionEvidence:undefined})).status,400);
    assert.equal((await post(base,'trial',trial)).status,200);assert.equal(calls.at(-1)[0],'claimTrial');
    const bad=await post(base,'claim',{identity:{},stageId:'x',evidence:'bad'}),text=await bad.text();
    assert.equal(bad.status,409);assert.match(text,/UNAUTHENTICATED/);assert.doesNotMatch(text,/private detail|evidence/);
  });
});

test('only pinned V9 bytes, the intended owner and a dedicated HTTPS origin can enable the bridge',async()=>{
  const service=synthetic([]),base={service,siteOrigin:SITE,wasmBytes:wasm,owner:'great_mujey.testnet'};
  assert.throws(()=>createNativeOracleSetupHttpHandler({...base,owner:'other.testnet'}));
  assert.throws(()=>createNativeOracleSetupHttpHandler({...base,siteOrigin:'https://owner.github.io'}));
  assert.throws(()=>createNativeOracleSetupHttpHandler({...base,siteOrigin:'https://phone.example.test/path'}));
  const changed=Buffer.from(wasm);changed[100]^=1;assert.throws(()=>createNativeOracleSetupHttpHandler({...base,wasmBytes:changed}));
  await withServer(async({base})=>{const response=await fetch(`${base}/api/native-oracle-setup/artifact`,
    {headers:{'x-bouncer-preview':'native-oracle-setup-v1'}});const bytes=Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length,452675);assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),
      '835f0baa51d08ddf3af6812df0caefb93283480735a63e3d382073e04fbaf8ee')});
});
