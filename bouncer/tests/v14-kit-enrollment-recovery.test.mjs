// Synthetic off-chain owner signatures, HTTP and database only. No real wallet,
// scope, paid call, chain transaction or journal restoration occurs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,webcrypto} from 'node:crypto';
import nearApi from 'near-api-js';
import {buildV14PhoneResearchPlan} from '../agent/native-v14-phone-plan.mjs';
import {fixture,owner,vault} from './v14-witness-fixture.mjs';
import {nep413Payload} from '../web-src/cli-login.mjs';
import {prepareV14Enrollment,V14_ENROLLMENT_SITE} from '../web-src/v14-checkpoint-enrollment.mjs';
import {sealV14SecretKit,openV14SecretKit} from '../web-src/v14-secret-recovery-kit.mjs';
import {prepareV14KitEnrollment,signV14KitEnrollment,verifyV14KitAttestation} from '../web-src/v14-checkpoint-enrollment-kit.mjs';
import {prepareV14KitRecovery,signV14KitRecovery} from '../web-src/v14-checkpoint-kit-recovery.mjs';
import {createV14KitClient,V14_KIT_ENROLLMENT_ENDPOINT,V14_KIT_RECOVERY_ENDPOINT} from '../web-src/v14-checkpoint-kit-client.mjs';
import {createV14KitEnrollmentHandler} from '../infrastructure/v14-kit-enrollment-edge.mjs';
import {createV14KitRecoveryHandler} from '../infrastructure/v14-kit-recovery-edge.mjs';

const now=1_800_000_000_000,clock=()=>now,password='synthetic-recovery-passphrase',sha=s=>createHash('sha256').update(s).digest('hex');
const random=()=>randomBytes(32).toString('hex'),location={origin:V14_ENROLLMENT_SITE,host:'bouncer-near.vercel.app'};
const project='https://jiouaqwxkvlkmvyumzwc.supabase.co',block=nearApi.utils.serialize.base_encode(Buffer.alloc(32,7)),zero='0'.repeat(64);
const key=pair=>String(pair.getPublicKey());
function signer(pair,counter) {
  return {async signMessage({signerId,message,nonce,recipient}) {
    counter.count++;const digest=createHash('sha256').update(nep413Payload({message,nonce,recipient})).digest();
    return {accountId:signerId,publicKey:key(pair),signature:Buffer.from(pair.sign(digest).signature).toString('base64')};
  },async signAndSendTransaction(){throw Error('must not send a transaction')}};
}
async function context() {
  const {inputs}=fixture(),ownerKey=nearApi.KeyPair.fromRandom('ed25519'),rotated=nearApi.KeyPair.fromRandom('ed25519');
  const agents=Object.fromEntries(['compute','price','store'].map(id=>[id,nearApi.KeyPair.fromRandom('ed25519')]));
  inputs.ownerPublicKey=key(ownerKey);inputs.agentPublicKeys=Object.fromEntries(Object.entries(agents).map(([id,p])=>[id,key(p)]));
  const review=buildV14PhoneResearchPlan(inputs).review,draft=await prepareV14Enrollment({owner,ownerPublicKey:key(ownerKey),vault,
    reviewSha256:review.review_sha256,crypto:webcrypto,now:clock});
  const secrets={capability:draft.capability,witnessJournalKey:random(),missionJournalKey:random(),
    restrictedAgentKeys:Object.fromEntries(Object.entries(agents).map(([id,p])=>[id,p.toString()]))};
  const envelope=await sealV14SecretKit({review,trustedReviewSha256:review.review_sha256,scopeId:draft.terms.scope_id,
    capabilitySha256:draft.terms.capability_sha256,...secrets,passphrase:password,crypto:webcrypto});
  const enrollment=await prepareV14KitEnrollment({draft,envelope,review,trustedReviewSha256:review.review_sha256,
    passphrase:password,crypto:webcrypto,now:clock});
  let activeKey=key(ownerKey),stored=null,dbCalls=0;
  const endpointEnv=flag=>name=>({BOUNCER_V14_KIT_ENROLLMENT_ENABLE:flag?'1':'0',BOUNCER_V14_KIT_RECOVERY_ENABLE:flag?'1':'0',
    SUPABASE_URL:project,SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-only'})[name];
  const upstream=async(url,options)=>{
    const data=JSON.parse(options.body);
    if(url==='https://test.rpc.fastnear.com') {
      const result=data.method==='status'?{chain_id:'testnet'}:data.method==='block'?{header:{hash:block,timestamp_nanosec:String(BigInt(now)*1_000_000n)}}:
        data.method==='query'?{block_hash:block,permission:data.params.public_key===activeKey?'FullAccess':{FunctionCall:{}}}:null;
      return new Response(JSON.stringify({jsonrpc:'2.0',id:data.id,result}));
    }
    if(url===`${project}/rest/v1/rpc/bouncer_v14_enroll_kit_v2`) {
      dbCalls++;
      const candidate={owner:data.p_owner_id,vault:data.p_vault_id,scope:data.p_scope_id,review:data.p_review_sha256,
        capability:data.p_capability_hash,kit_hash:data.p_kit_sha256,kit:data.p_sealed_kit,
        att_hash:data.p_attestation_sha256,att:data.p_owner_attestation};
      if(stored&&JSON.stringify(stored)!==JSON.stringify(candidate))return new Response(JSON.stringify({error:'unavailable'}));
      const status=stored?'EXISTING_KIT':'ENROLLED_WITH_KIT';stored=candidate;
      return new Response(JSON.stringify({status,scope_id:candidate.scope,revision:0,head_sha256:zero,
        kit_sha256:candidate.kit_hash,attestation_sha256:candidate.att_hash}));
    }
    if(url===`${project}/rest/v1/rpc/bouncer_v14_owner_kit_inspect_v2`) {
      dbCalls++;
      if(!stored||data.p_owner_id!==stored.owner||data.p_vault_id!==stored.vault)return new Response(JSON.stringify({error:'unavailable'}));
      return new Response(JSON.stringify({status:'EXISTING_ENCRYPTED_KIT',scope_id:stored.scope,review_sha256:stored.review,
        capability_sha256:stored.capability,kit_sha256:stored.kit_hash,sealed_kit:stored.kit,
        attestation_sha256:stored.att_hash,owner_attestation:stored.att}));
    }
    throw Error('unexpected synthetic URL');
  };
  const enrollHandler=createV14KitEnrollmentHandler({getEnv:endpointEnv(true),fetch:upstream,crypto:webcrypto,now:clock});
  const recoveryHandler=createV14KitRecoveryHandler({getEnv:endpointEnv(true),fetch:upstream,crypto:webcrypto,now:clock});
  const calls=[];
  const browserFetch=async(url,options)=>{
    calls.push({url,body:options.body});
    if(url==='https://test.rpc.fastnear.com') {
      const req=JSON.parse(options.body);
      return new Response(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{permission:req.params.public_key===activeKey?'FullAccess':{FunctionCall:{}}}}));
    }
    const request=new Request(url,{method:'POST',headers:{origin:V14_ENROLLMENT_SITE,'content-type':'application/json'},body:options.body});
    if(url===V14_KIT_ENROLLMENT_ENDPOINT)return enrollHandler(request);
    if(url===V14_KIT_RECOVERY_ENDPOINT)return recoveryHandler(request);
    throw Error('unexpected synthetic browser URL');
  };
  return {review,draft,enrollment,envelope,secrets,ownerKey,rotated,endpointEnv,upstream,enrollHandler,recoveryHandler,browserFetch,calls,
    activate:pair=>{activeKey=key(pair)},stored:()=>stored,dbCalls:()=>dbCalls};
}

test('one signed enrollment retains ciphertext and a rotated owner can recover and decrypt it locally',async()=>{
  const f=await context(),signatures={count:0};
  const submission=await signV14KitEnrollment({draft:f.enrollment,wallet:signer(f.ownerKey,signatures),location,
    crypto:webcrypto,fetch:f.browserFetch,now:clock});
  assert.equal(signatures.count,1);assert.ok(!JSON.stringify(submission).includes(f.secrets.capability));
  const client=createV14KitClient({location,crypto:webcrypto,fetch:f.browserFetch,now:clock});
  const enrolled=await client.enroll(submission);assert.equal(enrolled.status,'ENROLLED_WITH_KIT');
  const stored=JSON.stringify(f.stored());
  for(const secret of [password,f.secrets.capability,f.secrets.witnessJournalKey,f.secrets.missionJournalKey,...Object.values(f.secrets.restrictedAgentKeys)])
    assert.ok(!stored.includes(secret));
  assert.equal((await client.enroll(submission)).status,'EXISTING_KIT');
  f.activate(f.rotated);
  const draft=prepareV14KitRecovery({owner,ownerPublicKey:key(f.rotated),vault,crypto:webcrypto,now:clock});
  const request=await signV14KitRecovery({draft,wallet:signer(f.rotated,signatures),location,crypto:webcrypto,fetch:f.browserFetch,now:clock});
  const recovered=await client.read(request,{review:f.review,scopeId:f.draft.terms.scope_id,trustedReviewSha256:f.review.review_sha256});
  assert.equal(signatures.count,2);assert.equal(recovered.journal_restored,false);assert.equal(recovered.wallet_transaction_authorized,false);
  assert.equal(recovered.attestation.terms.owner_public_key,key(f.ownerKey));
  const unlocked=await openV14SecretKit({envelope:recovered.envelope,review:f.review,trustedReviewSha256:f.review.review_sha256,
    scopeId:recovered.scope_id,capabilitySha256:recovered.capability_sha256,passphrase:password,crypto:webcrypto});
  assert.equal(unlocked.capability,f.secrets.capability);assert.deepEqual(unlocked.restricted_agent_keys,f.secrets.restrictedAgentKeys);
  assert.equal(f.calls.filter(call=>call.url===V14_KIT_RECOVERY_ENDPOINT).length,1);
});

test('altered ciphertext, wrong origin, expired evidence and missing owner authorization stay closed',async()=>{
  const f=await context(),counter={count:0};
  const invalid=structuredClone(f.envelope);invalid.scope_id='f'.repeat(32);
  await assert.rejects(prepareV14KitEnrollment({draft:f.draft,envelope:invalid,review:f.review,trustedReviewSha256:f.review.review_sha256,
    passphrase:password,crypto:webcrypto,now:clock}),/could not be unlocked/);
  await assert.rejects(prepareV14KitEnrollment({draft:f.draft,envelope:f.envelope,review:f.review,trustedReviewSha256:f.review.review_sha256,
    passphrase:'wrong-but-long-test-passphrase',crypto:webcrypto,now:clock}),/could not be unlocked/);
  assert.equal(counter.count,0);
  const submission=await signV14KitEnrollment({draft:f.enrollment,wallet:signer(f.ownerKey,counter),location,
    crypto:webcrypto,fetch:f.browserFetch,now:clock});
  const req=(body,origin=V14_ENROLLMENT_SITE)=>new Request(V14_KIT_ENROLLMENT_ENDPOINT,{method:'POST',
    headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});
  const off=createV14KitEnrollmentHandler({getEnv:f.endpointEnv(false),fetch:f.upstream,crypto:webcrypto,now:clock});
  assert.equal((await off(req(submission))).status,503);
  assert.equal((await f.enrollHandler(req(submission,'https://evil.example'))).status,403);
  assert.equal((await f.enrollHandler(req({...submission,sealed_kit:submission.sealed_kit.replace('AES-256-GCM','AES-128-GCM')}))).status,503);
  assert.equal((await f.enrollHandler(req({...submission,signature_base64:Buffer.alloc(64).toString('base64')}))).status,503);
  const expired=createV14KitEnrollmentHandler({getEnv:f.endpointEnv(true),fetch:f.upstream,crypto:webcrypto,now:()=>now+180_000});
  assert.equal((await expired(req(submission))).status,503);
  const wrongChain=createV14KitEnrollmentHandler({getEnv:f.endpointEnv(true),crypto:webcrypto,now:clock,fetch:async(url,options)=>{
    const input=JSON.parse(options.body);
    if(url==='https://test.rpc.fastnear.com'&&input.method==='status')return new Response(JSON.stringify({jsonrpc:'2.0',id:input.id,result:{chain_id:'mainnet'}}));
    return f.upstream(url,options);
  }});
  assert.equal((await wrongChain(req(submission))).status,503);
  f.activate(f.rotated);assert.equal((await f.enrollHandler(req(submission))).status,503); // old key no longer FullAccess
  assert.equal(f.dbCalls(),0);
});

test('ciphertext recovery binds the historical signature to the retained review and never retries an ambiguous request',async()=>{
  const f=await context(),counter={count:0},client=createV14KitClient({location,crypto:webcrypto,fetch:f.browserFetch,now:clock});
  const submission=await signV14KitEnrollment({draft:f.enrollment,wallet:signer(f.ownerKey,counter),location,
    crypto:webcrypto,fetch:f.browserFetch,now:clock});
  await client.enroll(submission);
  const saved=f.stored(),forged=JSON.parse(saved.att);forged.terms.kit_sha256='f'.repeat(64);
  await assert.rejects(verifyV14KitAttestation({text:JSON.stringify(forged),owner,vault,ownerPublicKey:key(f.ownerKey),scopeId:saved.scope,
    reviewSha256:saved.review,capabilitySha256:saved.capability,kitSha256:saved.kit_hash,crypto:webcrypto}),/unavailable/);
  const foreignReview=structuredClone(f.review);foreignReview.owner_public_key=key(f.rotated);
  const draft=prepareV14KitRecovery({owner,ownerPublicKey:key(f.ownerKey),vault,crypto:webcrypto,now:clock});
  const request=await signV14KitRecovery({draft,wallet:signer(f.ownerKey,counter),location,crypto:webcrypto,fetch:f.browserFetch,now:clock});
  await assert.rejects(client.read(request,{review:foreignReview,scopeId:saved.scope,trustedReviewSha256:saved.review}),/unavailable/);
  const corrupted=JSON.parse(saved.att);corrupted.signature_base64=Buffer.alloc(64).toString('base64');
  saved.att=JSON.stringify(corrupted);saved.att_hash=sha(saved.att);
  await assert.rejects(client.read(request,{review:f.review,scopeId:saved.scope,trustedReviewSha256:saved.review}),/unavailable/);
  assert.equal(f.calls.filter(call=>call.url===V14_KIT_RECOVERY_ENDPOINT).length,1);
  let calls=0;
  const failing=createV14KitClient({location,crypto:webcrypto,now:clock,fetch:async()=>{calls++;throw Error('response lost')}});
  await assert.rejects(failing.enroll(submission),/uncertain/);assert.equal(calls,1);
});
