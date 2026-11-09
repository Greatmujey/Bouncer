// Synthetic NEP-413 owner enrollment; no real NEAR account, database or wallet.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import nearApi from 'near-api-js';
import {nep413Payload} from '../web-src/cli-login.mjs';
import {prepareV14Enrollment,V14_ENROLLMENT_SITE} from '../web-src/v14-checkpoint-enrollment.mjs';
import {createV14EnrollmentHandler} from '../infrastructure/v14-enrollment-edge.mjs';

const clock=1_800_000_000_000,owner='owner.testnet',vault='native.owner.testnet',pair=nearApi.KeyPair.fromRandom('ed25519');
const publicKey=String(pair.getPublicKey()),blockHash=nearApi.utils.serialize.base_encode(Buffer.alloc(32,7)),zero='0'.repeat(64);
const project='https://jiouaqwxkvlkmvyumzwc.supabase.co',serviceSecret='synthetic-service-role';
const env=(enabled=true)=>key=>({BOUNCER_V14_ENROLLMENT_ENABLE:enabled?'1':'0',SUPABASE_URL:project,SUPABASE_SERVICE_ROLE_KEY:serviceSecret})[key];
const request=(input,origin=V14_ENROLLMENT_SITE)=>new Request('https://checkpoint.example.test/enroll',{method:'POST',
  headers:{origin,'content-type':'application/json'},body:JSON.stringify(input)});
async function signedDraft() {
  const d=await prepareV14Enrollment({owner,ownerPublicKey:publicKey,vault,reviewSha256:'a'.repeat(64),crypto:webcrypto,now:()=>clock});
  const hash=createHash('sha256').update(nep413Payload({message:d.message,nonce:d.nonce,recipient:d.recipient})).digest();
  return {draft:d,submission:{terms:d.terms,nonce_base64:Buffer.from(d.nonce).toString('base64'),signature_base64:Buffer.from(pair.sign(hash).signature).toString('base64')}};
}
function upstream({chain='testnet',blockTime=clock,permission='FullAccess',responseBlock=blockHash,dbResult} = {}) {
  const calls=[];
  const fetch=async(url,options)=>{
    const data=JSON.parse(options.body);calls.push({url,data,options});
    if(url==='https://test.rpc.fastnear.com') {
      let result;
      if(data.method==='status')result={chain_id:chain};
      else if(data.method==='block')result={header:{hash:blockHash,timestamp_nanosec:String(BigInt(blockTime)*1_000_000n)}};
      else if(data.method==='query')result={block_hash:responseBlock,permission};
      else throw Error('unexpected method');
      return new Response(JSON.stringify({jsonrpc:'2.0',id:'bouncer-v14-enrollment',result}));
    }
    if(url===`${project}/rest/v1/rpc/bouncer_v14_enroll_v1`) {
      return new Response(JSON.stringify(dbResult??{status:'ENROLLED',scope_id:data.p_scope_id,revision:0,head_sha256:zero}));
    }
    throw Error('unexpected host');
  };
  return {calls,fetch};
}

test('enrollment endpoint is disabled by default, and rejects a foreign browser origin',async()=>{
  const {submission}=await signedDraft(),u=upstream();
  const off=createV14EnrollmentHandler({getEnv:env(false),fetch:u.fetch,crypto:webcrypto,now:()=>clock});
  assert.equal((await off(request(submission))).status,503);assert.equal(u.calls.length,0);
  const on=createV14EnrollmentHandler({getEnv:env(),fetch:u.fetch,crypto:webcrypto,now:()=>clock});
  assert.equal((await on(request(submission,'https://evil.example'))).status,403);assert.equal(u.calls.length,0);
});

test('synthetic owner signature is verified against a fresh pinned FINAL FullAccess key before enrollment',async()=>{
  const {draft,submission}=await signedDraft(),u=upstream();
  const handler=createV14EnrollmentHandler({getEnv:env(),fetch:u.fetch,crypto:webcrypto,now:()=>clock});
  const response=await handler(request(submission));assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{status:'ENROLLED',scope_id:draft.terms.scope_id,revision:0,head_sha256:zero});
  assert.deepEqual(u.calls.map(x=>x.data.method??'database'),['status','block','query','database']);
  const query=u.calls[2].data.params;assert.equal(query.account_id,owner);assert.equal(query.public_key,publicKey);assert.equal(query.block_id,blockHash);
  const db=u.calls[3].data;assert.equal(db.p_capability_hash,draft.terms.capability_sha256);assert.equal(db.p_review_sha256,'a'.repeat(64));
  assert.ok(!JSON.stringify(u.calls).includes(draft.capability));assert.equal(response.headers.get('access-control-allow-origin'),V14_ENROLLMENT_SITE);
});

test('tampered, expired, wrong-key or malformed signatures never reach the network',async()=>{
  const {submission}=await signedDraft(),u=upstream(),handler=createV14EnrollmentHandler({getEnv:env(),fetch:u.fetch,crypto:webcrypto,now:()=>clock});
  for(const changed of [
    {...submission,terms:{...submission.terms,review_sha256:'f'.repeat(64)}},
    {...submission,terms:{...submission.terms,capability_sha256:'f'.repeat(64)}},
    {...submission,terms:{...submission.terms,vault:'other.owner.testnet'}},
    {...submission,nonce_base64:Buffer.alloc(32,1).toString('base64')},
    {...submission,signature_base64:Buffer.alloc(64).toString('base64')},
    {...submission,signature_base64:'bad'},
    {...submission,extra:'ignored'},
  ]) assert.equal((await handler(request(changed))).status,503);
  assert.equal(u.calls.length,0);
  const expired=createV14EnrollmentHandler({getEnv:env(),fetch:u.fetch,crypto:webcrypto,now:()=>clock+180_000});
  assert.equal((await expired(request(submission))).status,503);assert.equal(u.calls.length,0);
});

test('stale, wrong-chain, changed-block, restricted or unavailable RPC never creates a checkpoint',async()=>{
  const {submission}=await signedDraft();
  for(const options of [{chain:'mainnet'},{blockTime:clock-121_000},{blockTime:clock+31_000},
    {permission:{FunctionCall:{}}},{responseBlock:nearApi.utils.serialize.base_encode(Buffer.alloc(32,8))}]) {
    const u=upstream(options),handler=createV14EnrollmentHandler({getEnv:env(),fetch:u.fetch,crypto:webcrypto,now:()=>clock});
    assert.equal((await handler(request(submission))).status,503);
    assert.ok(!u.calls.some(x=>x.url.startsWith(project)));
  }
});

test('a conflicting or malformed SQL acknowledgment cannot be treated as enrollment',async()=>{
  const {submission}=await signedDraft();
  for(const dbResult of [{error:'unavailable'},{status:'ENROLLED',scope_id:'f'.repeat(32),revision:0,head_sha256:zero},
    {status:'ENROLLED',scope_id:submission.terms.scope_id,revision:0,head_sha256:'bad'}]) {
    const u=upstream({dbResult}),handler=createV14EnrollmentHandler({getEnv:env(),fetch:u.fetch,crypto:webcrypto,now:()=>clock});
    assert.equal((await handler(request(submission))).status,503);
  }
});
