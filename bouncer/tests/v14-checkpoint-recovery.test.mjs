// Synthetic read-only recovery; no real wallet, chain, paid call or reset.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import nearApi from 'near-api-js';
import {nep413Payload} from '../web-src/cli-login.mjs';
import {V14_ENROLLMENT_SITE,V14_ENROLLMENT_RECIPIENT} from '../web-src/v14-checkpoint-enrollment.mjs';
import {prepareV14Recovery,signV14Recovery} from '../web-src/v14-checkpoint-recovery.mjs';
import {createV14RecoveryHandler} from '../infrastructure/v14-recovery-edge.mjs';
import {createV14CheckpointRecoveryClient,V14_CHECKPOINT_RECOVERY_ENDPOINT} from '../web-src/v14-checkpoint-recovery-client.mjs';
import {fixture,scope} from './v14-witness-fixture.mjs';

const now=1_800_000_000_000,owner='owner.testnet',vault='native.owner.testnet',pair=nearApi.KeyPair.fromRandom('ed25519');
const publicKey=String(pair.getPublicKey()),zero='0'.repeat(64),project='https://jiouaqwxkvlkmvyumzwc.supabase.co';
const block=nearApi.utils.serialize.base_encode(Buffer.alloc(32,7)),sha=s=>createHash('sha256').update(s).digest('hex');
const env=(enabled=true)=>key=>({BOUNCER_V14_RECOVERY_ENABLE:enabled?'1':'0',SUPABASE_URL:project,SUPABASE_SERVICE_ROLE_KEY:'synthetic'})[key];
const req=(body,origin=V14_ENROLLMENT_SITE)=>new Request('https://checkpoint.example.test/recover',{method:'POST',
  headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});
function history() {
  const {binding}=fixture();
  const line=JSON.stringify({format:'bouncer-v14-original-event-v1',seq:1,previous_sha256:zero,type:'reserve',data:binding});
  return {status:'EXISTING_CHECKPOINT',scope_id:scope,revision:1,head_sha256:sha(line),events:[line]};
}
async function signed() {
  const d=prepareV14Recovery({owner,ownerPublicKey:publicKey,vault,crypto:webcrypto,now:()=>now});
  const digest=createHash('sha256').update(nep413Payload({message:d.message,nonce:d.nonce,recipient:d.recipient})).digest();
  return {draft:d,submission:{terms:d.terms,nonce_base64:Buffer.from(d.nonce).toString('base64'),signature_base64:Buffer.from(pair.sign(digest).signature).toString('base64')}};
}
function upstream(result=history()) {
  const calls=[];return {calls,fetch:async(url,options)=>{
    const data=JSON.parse(options.body);calls.push({url,data});
    if(url==='https://test.rpc.fastnear.com') {
      const response=data.method==='status'?{chain_id:'testnet'}:data.method==='block'?{header:{hash:block,timestamp_nanosec:String(BigInt(now)*1_000_000n)}}:
        {block_hash:block,permission:'FullAccess'};
      return new Response(JSON.stringify({jsonrpc:'2.0',id:'bouncer-v14-enrollment',result:response}));
    }
    if(url===`${project}/rest/v1/rpc/bouncer_v14_owner_inspect_v1`)return new Response(JSON.stringify(result));
    throw Error('unexpected host');
  }};
}

test('browser signs a read-only recovery request without a capability or spending authority',async()=>{
  const {draft}=await signed(),calls=[];
  const wallet={async signMessage(params){calls.push(params);const digest=createHash('sha256').update(nep413Payload(params)).digest();
    return {accountId:owner,publicKey,signature:Buffer.from(pair.sign(digest).signature).toString('base64')};}};
  const rpc=async()=>new Response(JSON.stringify({jsonrpc:'2.0',id:'bouncer-cli-login',result:{permission:'FullAccess'}}));
  const result=await signV14Recovery({draft,wallet,location:{origin:V14_ENROLLMENT_SITE,host:V14_ENROLLMENT_RECIPIENT},crypto:webcrypto,fetch:rpc,now:()=>now});
  assert.equal(calls.length,1);assert.match(draft.message,/cannot reset a checkpoint or authorize a payment/);
  assert.ok(!JSON.stringify(result).includes('capability'));assert.equal(Buffer.from(result.signature_base64,'base64').length,64);
  await assert.rejects(signV14Recovery({draft,wallet,location:{origin:'https://evil.example',host:'evil.example'},crypto:webcrypto,fetch:rpc,now:()=>now}),/unavailable/);
  assert.equal(calls.length,1);
});

test('signed owner can read independently retained history without the lost capability',async()=>{
  const {submission}=await signed(),u=upstream(),handler=createV14RecoveryHandler({getEnv:env(),fetch:u.fetch,crypto:webcrypto,now:()=>now});
  const response=await handler(req(submission));assert.equal(response.status,200);const value=await response.json();
  assert.equal(value.status,'CHECKPOINT_HISTORY_READ');assert.equal(value.scope_id,scope);assert.equal(value.revision,1);
  assert.equal(value.absence_verified,false);assert.equal(value.wallet_transaction_authorized,false);
  assert.deepEqual(u.calls.map(x=>x.data.method??'database'),['status','block','query','database']);
  assert.deepEqual(u.calls.at(-1).data,{p_owner_id:owner,p_vault_id:vault});
});

test('empty recovery is not proof of non-execution; disabled or foreign origin stays closed',async()=>{
  const {submission}=await signed(),u=upstream({status:'EXISTING_CHECKPOINT',scope_id:scope,revision:0,head_sha256:zero,events:[]});
  const off=createV14RecoveryHandler({getEnv:env(false),fetch:u.fetch,crypto:webcrypto,now:()=>now});
  assert.equal((await off(req(submission))).status,503);assert.equal(u.calls.length,0);
  const handler=createV14RecoveryHandler({getEnv:env(),fetch:u.fetch,crypto:webcrypto,now:()=>now});
  assert.equal((await handler(req(submission,'https://evil.example'))).status,403);assert.equal(u.calls.length,0);
  const value=await (await handler(req(submission))).json();assert.equal(value.revision,0);assert.equal(value.absence_verified,false);
});

test('corrupt history, wrong owner, forged signatures and wrong head cannot be read as valid recovery',async()=>{
  const {submission}=await signed(),good=history();
  for(const bad of [{...good,head_sha256:'f'.repeat(64)}, {...good,events:[good.events[0].replace('owner.testnet','other.testnet')]},
    {...good,revision:2}, {error:'unavailable'}]) {
    const u=upstream(bad),handler=createV14RecoveryHandler({getEnv:env(),fetch:u.fetch,crypto:webcrypto,now:()=>now});
    assert.equal((await handler(req(submission))).status,503);
  }
  const u=upstream(),handler=createV14RecoveryHandler({getEnv:env(),fetch:u.fetch,crypto:webcrypto,now:()=>now});
  assert.equal((await handler(req({...submission,signature_base64:Buffer.alloc(64).toString('base64')}))).status,503);assert.equal(u.calls.length,0);
});

test('phone-friendly recovery client checks returned history and never automatically retries',async()=>{
  const {submission}=await signed(),u=upstream(),handler=createV14RecoveryHandler({getEnv:env(),fetch:u.fetch,crypto:webcrypto,now:()=>now});
  let calls=0;const throughEdge=async(url,options)=>{
    calls++;assert.equal(url,V14_CHECKPOINT_RECOVERY_ENDPOINT);assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
    return handler(new Request(url,{...options,headers:{...options.headers,origin:V14_ENROLLMENT_SITE}}));
  };
  const location={origin:V14_ENROLLMENT_SITE,host:V14_ENROLLMENT_RECIPIENT};
  const client=createV14CheckpointRecoveryClient({location,crypto:webcrypto,fetch:throughEdge,now:()=>now});
  const checked=await client.read(submission);
  assert.equal(checked.status,'PUBLIC_CHECKPOINT_HISTORY');assert.equal(checked.review.owner,owner);assert.equal(checked.wallet_transaction_authorized,false);
  assert.equal(checked.receipts_verified,false);assert.equal(checked.latest_head_independently_verified,false);assert.equal(calls,1);
  let failures=0;
  const broken=createV14CheckpointRecoveryClient({location,crypto:webcrypto,fetch:async()=>{failures++;throw Error('offline')},now:()=>now});
  await assert.rejects(broken.read(submission),/originals must not be resent/);assert.equal(failures,1);
  assert.throws(()=>createV14CheckpointRecoveryClient({location:{origin:'https://evil.example',host:'evil.example'},crypto:webcrypto}),/unavailable/);
});
