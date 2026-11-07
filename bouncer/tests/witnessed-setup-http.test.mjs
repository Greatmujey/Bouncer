import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { createWitnessedSetupHttpHandler } from '../agent/witnessed-setup-http.mjs';
import { createReadOnlyPreviewService } from '../agent/read-only-preview-service.mjs';
import { wasm } from './buffer-wallet-setup-fixture.mjs';

const enabledTest = wasm ? test : test.skip;
const SITE = 'https://phone.example.test', HEADER = { origin:SITE, 'x-bouncer-preview':'witnessed-setup-v1', 'content-type':'application/json' };
const methods = ['issueReservation','reserve','issueClaim','claim','issueOriginal','recordOriginal','issueReconcile','reconcile',
  'issueVerifyFunded','verifyFunded','issueInspect','inspect','previewOriginal'];
function syntheticService(calls) {
  return Object.fromEntries(methods.map(method => [method, async input => { calls.push([method,input]);
    if (input.evidence === 'bad') { const e = new Error('synthetic secret'); e.code = 'UNAUTHENTICATED'; throw e; }
    return { method, execution_authorized:false }; }]));
}
async function withServer(fn) {
  const calls = [], refs = {}, id = 'a'.repeat(32);
  const bridge = { pending:()=>[], take:()=>null, submit:()=>false, takeForBrowser:()=>null, submitEncrypted:()=>false };
  const server = createReadOnlyPreviewService({ bridge, siteOrigin:SITE, inspectReadiness:async()=>({ owner:'synthetic.testnet' }),
    makeReview:async()=>({ owner:'synthetic.testnet', signed:false }), setupFactory:({ getRetainedReview }) => {
      refs.getRetainedReview = getRetainedReview;
      return createWitnessedSetupHttpHandler({ service:syntheticService(calls), siteOrigin:SITE, wasmBytes:wasm, owner:'great_mujey.testnet' });
    } });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn({ base, calls, refs, id }); } finally { await new Promise(resolve => server.close(resolve)); }
}
const post = (base, route, data, headers=HEADER) => fetch(`${base}/api/wallet-setup/${route}`, {
  method:'POST', headers, body:JSON.stringify(data) });

enabledTest('only same-origin, bounded, allowlisted owner-authenticated setup calls are exposed', async () => withServer(async ({base,calls}) => {
  const config = await fetch(`${base}/api/wallet-setup/config`, { headers:{'x-bouncer-preview':'witnessed-setup-v1'} });
  assert.deepEqual(await config.json(), { enabled:true, network:'testnet', owner:'great_mujey.testnet',
    scope:'Experimental setup only. No policy, seller purchase or delivery is provided.' });
  assert.equal((await post(base,'claim',{identity:{},stageId:'create_keyless_vault',evidence:{}}, { ...HEADER, origin:'https://attacker.test' })).status,403);
  assert.equal((await post(base,'claim',{identity:{},stageId:'create_keyless_vault',evidence:{}}, { ...HEADER, 'x-bouncer-preview':'read-only' })).status,403);
  assert.equal((await post(base,'claim',{identity:{},stageId:'create_keyless_vault',evidence:{}, extra:'no'})).status,400);
  assert.equal((await post(base,'broadcast',{payload:'not allowed'})).status,404);
  assert.equal((await post(base,'claim',{identity:{},stageId:'x',evidence:'x'.repeat(30_000)})).status,409);
  assert.equal(calls.length,0);
  const ok = await post(base,'claim',{identity:{operation_id:'a'.repeat(32)},stageId:'create_keyless_vault',evidence:'synthetic'});
  assert.equal(ok.status,200); assert.equal((await ok.json()).execution_authorized,false);
  assert.equal(calls[0][0],'claim');
  const bad = await post(base,'claim',{identity:{},stageId:'create_keyless_vault',evidence:'bad'});
  const text = await bad.text(); assert.equal(bad.status,409); assert.match(text,/UNAUTHENTICATED/);
  assert.doesNotMatch(text,/synthetic secret|evidence/);
}));

enabledTest('the exact reviewed artifact is public and review storage cannot be mutated through the handler', async () => withServer(async ({base,refs}) => {
  const response = await fetch(`${base}/api/wallet-setup/artifact`, { headers:{'x-bouncer-preview':'witnessed-setup-v1'} });
  assert.equal(response.status,200); const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length,536651);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),'033f255c5822ff97495809f7d60fddf66f266f20c36285fe71296b66decc6d12');
  const started = await fetch(`${base}/api/read-only/review`, { method:'POST', headers:{origin:SITE,'x-bouncer-preview':'read-only'} });
  const {task_id} = await started.json();
  await fetch(`${base}/api/read-only/review/${task_id}`, { headers:{'x-bouncer-preview':'read-only'} });
  const retained = refs.getRetainedReview(task_id); assert.equal(retained.snapshot.owner,'synthetic.testnet');
  retained.snapshot.owner = 'attacker.testnet'; retained.review.signed = true;
  assert.deepEqual(refs.getRetainedReview(task_id), { snapshot:{owner:'synthetic.testnet'}, review:{owner:'synthetic.testnet',signed:false} });
}));

enabledTest('a mismatched artifact or owner cannot enable the setup endpoint', () => {
  const service = syntheticService([]), common = { service, siteOrigin:SITE, wasmBytes:wasm, owner:'great_mujey.testnet' };
  assert.throws(() => createWitnessedSetupHttpHandler({ ...common, owner:'other.testnet' }));
  const changed = Buffer.from(wasm); changed[300] ^= 1;
  assert.throws(() => createWitnessedSetupHttpHandler({ ...common, wasmBytes:changed }));
  assert.throws(() => createWitnessedSetupHttpHandler({ ...common, siteOrigin:'https://phone.example.test/path' }));
});


enabledTest('the body deadline stops slow uploads without cutting off longer authenticated work', async () => {
  const calls = [], service = syntheticService(calls);
  service.issueInspect = async input => { await new Promise(resolve=>setTimeout(resolve,700)); calls.push(['issueInspect',input]); return {issued:true}; };
  const handler = createWitnessedSetupHttpHandler({service,siteOrigin:SITE,wasmBytes:wasm,owner:'great_mujey.testnet',bodyTimeoutMs:250});
  const server = http.createServer((req,res)=>handler(req,res,new URL(req.url,'http://test').pathname));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await post(base,'inspect-challenge',{ownerPublicKey:'synthetic'});
    assert.equal(response.status,200); assert.equal((await response.json()).issued,true);
    assert.equal(calls.length,1, 'the authenticated work may outlast the body deadline');
    const failure = await new Promise(resolve => {
      const req = http.request(`${base}/api/wallet-setup/inspect-challenge`,{method:'POST',headers:HEADER});
      req.on('error',error=>resolve(error.code)); req.on('response',res=>{res.resume();resolve(`http-${res.statusCode}`);});
      req.write('{'); setTimeout(()=>{if(!req.destroyed) req.end('}');},700);
    });
    assert.ok(['ECONNRESET','EPIPE'].includes(failure)); assert.equal(calls.length,1, 'a slow partial body must not reach the service');
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
