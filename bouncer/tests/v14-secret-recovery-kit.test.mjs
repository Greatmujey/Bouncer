// Synthetic keys and reviews only: no wallet, chain, network, storage or live kit.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { buildV14PhoneResearchPlan } from '../agent/native-v14-phone-plan.mjs';
import { fixture,scope } from './v14-witness-fixture.mjs';
import { openV14SecretKit,sealV14SecretKit,V14_KIT_ITERATIONS } from '../web-src/v14-secret-recovery-kit.mjs';

const password='synthetic-test-passphrase-only';
const hex=n=>crypto.randomBytes(n).toString('hex');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
function kitFixture() {
  const {inputs}=fixture(),pairs=Object.fromEntries(['compute','price','store'].map(id=>[id,nearApi.KeyPair.fromRandom('ed25519')]));
  inputs.agentPublicKeys=Object.fromEntries(Object.entries(pairs).map(([id,pair])=>[id,String(pair.getPublicKey())]));
  const review=buildV14PhoneResearchPlan(inputs).review,capability=hex(32);
  const secrets={capability,witnessJournalKey:hex(32),missionJournalKey:hex(32),
    restrictedAgentKeys:Object.fromEntries(Object.entries(pairs).map(([id,pair])=>[id,pair.toString()]))};
  const common={review,trustedReviewSha256:review.review_sha256,scopeId:scope,capabilitySha256:sha(capability),passphrase:password,crypto:crypto.webcrypto};
  return {...common,...secrets,common,secrets};
}

test('sealed device kit round-trips reviewed restricted keys, without exposing secrets or making a request',async()=>{
  const f=kitFixture(),envelope=await sealV14SecretKit(f),encoded=JSON.stringify(envelope);
  assert.equal(envelope.iterations,V14_KIT_ITERATIONS);assert.equal(envelope.cipher,'AES-256-GCM');
  for(const secret of [f.capability,f.witnessJournalKey,f.missionJournalKey,password,...Object.values(f.restrictedAgentKeys)])assert.ok(!encoded.includes(secret));
  const opened=await openV14SecretKit({...f.common,envelope});
  assert.deepEqual(opened,{format:'bouncer-v14-restricted-secrets-v1',capability:f.capability,witness_journal_key:f.witnessJournalKey,
    mission_journal_key:f.missionJournalKey,restricted_agent_keys:f.restrictedAgentKeys});
  // It is only a key kit: it intentionally contains no journal records or head.
  assert.equal(Object.hasOwn(opened,'journal'),false);assert.equal(Object.hasOwn(opened,'head_sha256'),false);
  const another=await sealV14SecretKit(f);
  assert.notEqual(envelope.salt_base64,another.salt_base64);assert.notEqual(envelope.iv_base64,another.iv_base64);
  assert.notEqual(envelope.ciphertext_base64,another.ciphertext_base64);
});

test('wrong password, substituted review, scope, capability hash, metadata or ciphertext fail closed',async()=>{
  const f=kitFixture(),envelope=await sealV14SecretKit(f);
  await assert.rejects(openV14SecretKit({...f.common,envelope,passphrase:'wrong-but-long-test-passphrase'}),/could not be unlocked/);
  await assert.rejects(openV14SecretKit({...f.common,envelope,scopeId:'4'.repeat(32)}),/could not be unlocked/);
  await assert.rejects(openV14SecretKit({...f.common,envelope,capabilitySha256:'4'.repeat(64)}),/could not be unlocked/);
  await assert.rejects(openV14SecretKit({...f.common,envelope,trustedReviewSha256:'4'.repeat(64)}),/could not be unlocked/);
  const changed=structuredClone(f.review);changed.native_deposit_yocto='999';
  await assert.rejects(openV14SecretKit({...f.common,envelope,review:changed}),/could not be unlocked/);
  for(const patch of [{iterations:1},{cipher:'none'},{owner:'attacker.testnet'},{scope_id:'5'.repeat(32)},{extra:true},
    {iv_base64:'AAAAAAAAAAAAAAAAA'}, {ciphertext_base64:'%%%%'}]) {
    await assert.rejects(openV14SecretKit({...f.common,envelope:{...envelope,...patch}}),/could not be unlocked/);
  }
  const ciphertext=Buffer.from(envelope.ciphertext_base64,'base64');ciphertext[0]^=1;
  await assert.rejects(openV14SecretKit({...f.common,envelope:{...envelope,ciphertext_base64:ciphertext.toString('base64')}}),/could not be unlocked/);
});

test('only matching reviewed keys are sealed; the reviewed owner signing key and extra secret fields are rejected',async()=>{
  const f=kitFixture(),owner=nearApi.KeyPair.fromRandom('ed25519');
  await assert.rejects(sealV14SecretKit({...f,restrictedAgentKeys:{...f.restrictedAgentKeys,compute:owner.toString()}}),/could not be unlocked/);
  await assert.rejects(sealV14SecretKit({...f,restrictedAgentKeys:{...f.restrictedAgentKeys,owner:owner.toString()}}),/could not be unlocked/);
  await assert.rejects(sealV14SecretKit({...f,restrictedAgentKeys:{...f.restrictedAgentKeys,compute:f.restrictedAgentKeys.price}}),/could not be unlocked/);
  await assert.rejects(sealV14SecretKit({...f,missionJournalKey:f.witnessJournalKey}),/could not be unlocked/);
  await assert.rejects(sealV14SecretKit({...f,capabilitySha256:'5'.repeat(64)}),/could not be unlocked/);
  await assert.rejects(sealV14SecretKit({...f,passphrase:'short'}),/could not be unlocked/);
  // Even a self-consistent hash cannot make an owner FullAccess public key an agent key.
  const changed=structuredClone(f.review);changed.owner_public_key=changed.agent_public_keys.compute;
  delete changed.review_sha256;changed.review_sha256=sha(JSON.stringify(changed));
  await assert.rejects(sealV14SecretKit({...f,review:changed,trustedReviewSha256:changed.review_sha256}),/could not be unlocked/);
});
