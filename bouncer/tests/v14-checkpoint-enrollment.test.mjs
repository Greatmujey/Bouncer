// Research only: synthetic NEP-413 messages, no real wallet or transactions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import nearApi from 'near-api-js';
import {nep413Payload} from '../web-src/cli-login.mjs';
import {prepareV14Enrollment,signV14Enrollment,validateV14EnrollmentTerms,v14EnrollmentMessage,
  V14_ENROLLMENT_SITE,V14_ENROLLMENT_RECIPIENT,V14_ENROLLMENT_LIFETIME_MS} from '../web-src/v14-checkpoint-enrollment.mjs';

const now=1_800_000_000_000,owner='owner.testnet',vault='native.owner.testnet',key=nearApi.KeyPair.fromRandom('ed25519'),publicKey=String(key.getPublicKey());
const location={origin:V14_ENROLLMENT_SITE,host:V14_ENROLLMENT_RECIPIENT};
const rpc=async()=>new Response(JSON.stringify({jsonrpc:'2.0',id:'bouncer-cli-login',result:{permission:'FullAccess'}}),{status:200});
const draft=()=>prepareV14Enrollment({owner,ownerPublicKey:publicKey,vault,reviewSha256:'a'.repeat(64),crypto:webcrypto,now:()=>now});
function wallet(calls=[]) {
  return {manifest:{id:'meteor'},async signMessage(request){
    calls.push(request);const digest=createHash('sha256').update(nep413Payload(request)).digest();
    return {accountId:owner,publicKey,signature:Buffer.from(key.sign(digest).signature).toString('base64')};
  }};
}

test('browser prepares a random non-wallet capability and clear, non-spending owner message',async()=>{
  const first=await draft(),second=await draft();
  assert.match(first.capability,/^[a-f0-9]{64}$/);assert.notEqual(first.capability,second.capability);
  assert.notEqual(first.terms.scope_id,second.terms.scope_id);assert.equal(first.nonce.length,32);
  assert.equal(first.terms.capability_sha256,createHash('sha256').update(first.capability).digest('hex'));
  assert.equal(first.terms.expires_ms-first.terms.issued_ms,V14_ENROLLMENT_LIFETIME_MS);
  assert.match(first.message,/does not deploy a vault, install a key, or authorize a payment/);
  assert.ok(!first.message.includes(first.capability));assert.ok(first.message.includes(first.terms.capability_sha256));
});

test('one synthetic NEP-413 wallet message binds the review and returns no capability or wallet key',async()=>{
  const d=await draft(),calls=[],w=wallet(calls);
  const submission=await signV14Enrollment({draft:d,wallet:w,location,crypto:webcrypto,fetch:rpc,now:()=>now});
  assert.equal(calls.length,1);assert.equal(calls[0].recipient,V14_ENROLLMENT_RECIPIENT);assert.equal(calls[0].signerId,owner);
  assert.ok(!JSON.stringify(calls[0]).includes(d.capability));assert.ok(!JSON.stringify(submission).includes(d.capability));
  assert.equal(submission.terms.review_sha256,'a'.repeat(64));assert.equal(Buffer.from(submission.nonce_base64,'base64').length,32);
  assert.equal(Buffer.from(submission.signature_base64,'base64').length,64);
  assert.equal(Object.hasOwn(w,'signAndSendTransaction'),false);
});

test('wrong origin, altered terms/capability and expired requests are rejected before any wallet prompt',async()=>{
  const d=await draft(),calls=[],w=wallet(calls),sign=(overrides={})=>signV14Enrollment({draft:d,wallet:w,location,crypto:webcrypto,fetch:rpc,now:()=>now,...overrides});
  await assert.rejects(sign({location:{origin:'https://evil.example',host:'evil.example'}}),/unavailable/);
  await assert.rejects(sign({draft:{...d,capability:'f'.repeat(64)}}),/unavailable/);
  await assert.rejects(sign({draft:{...d,message:'approve payment'}}),/unavailable/);
  await assert.rejects(sign({now:()=>now+V14_ENROLLMENT_LIFETIME_MS}),/unavailable/);
  assert.equal(calls.length,0);
  assert.throws(()=>validateV14EnrollmentTerms({...d.terms,vault:'elsewhere.testnet'}),/unavailable/);
  assert.throws(()=>v14EnrollmentMessage({...d.terms,owner:'alice.near'}),/unavailable/);
  assert.throws(()=>validateV14EnrollmentTerms({...d.terms,extra:'private'}),/unavailable/);
});

test('a mismatched signature, owner, restricted key or unavailable RPC never establishes enrollment',async()=>{
  const d=await draft(),bad=wallet();
  bad.signMessage=async()=>({accountId:owner,publicKey,signature:Buffer.alloc(64).toString('base64')});
  await assert.rejects(signV14Enrollment({draft:d,wallet:bad,location,crypto:webcrypto,fetch:rpc,now:()=>now}),/signature/);
  const restricted=async()=>new Response(JSON.stringify({jsonrpc:'2.0',id:'bouncer-cli-login',result:{permission:{FunctionCall:{}}}}));
  await assert.rejects(signV14Enrollment({draft:d,wallet:wallet(),location,crypto:webcrypto,fetch:restricted,now:()=>now}),/FULL_ACCESS/);
  await assert.rejects(signV14Enrollment({draft:d,wallet:wallet(),location,crypto:webcrypto,fetch:async()=>{throw Error('offline')},now:()=>now}),/RPC_UNAVAILABLE/);
});

test('mutable draft cannot change the nonce after the wallet prompt starts',async()=>{
  const d=await draft(),original=Buffer.from(d.nonce),w=wallet();
  const signed=w.signMessage;w.signMessage=async request=>{d.nonce.fill(0);return signed(request)};
  const submission=await signV14Enrollment({draft:d,wallet:w,location,crypto:webcrypto,fetch:rpc,now:()=>now});
  assert.deepEqual(Buffer.from(submission.nonce_base64,'base64'),original);
});
