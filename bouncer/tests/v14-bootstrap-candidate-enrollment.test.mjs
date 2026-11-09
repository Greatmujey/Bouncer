import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash,webcrypto} from 'node:crypto';
import {KeyPair} from '@near-js/crypto';
import {nep413Payload} from '../web-src/cli-login.mjs';
import {createV14BootstrapCandidate} from '../web-src/v14-bootstrap-candidate.mjs';
import {openV14BootstrapRecoveryKit} from '../web-src/v14-bootstrap-recovery-kit.mjs';
import {createBootstrapCandidateEnrollmentClient} from '../web-src/v14-bootstrap-candidate-enrollment.mjs';
import {V14_BOOTSTRAP_ENDPOINT} from '../web-src/v14-bootstrap-remote-store.mjs';
import {V14_EXAMPLE_VAULT_FUNDING_YOCTO as funding} from '../shared/v14-bootstrap-budget.mjs';

const owner='great_mujey.testnet',vault=`native.${owner}`,site='https://bouncer-production-6df1.up.railway.app';
const location={origin:site,host:new URL(site).host},pair=KeyPair.fromRandom('ed25519'),ownerPublicKey=String(pair.getPublicKey());
const passphrase='synthetic-only long recovery passphrase',now=()=>1_800_000_000_000;
const compressedV14=new Uint8Array(fs.readFileSync(new URL('../web/artifacts/v14-research.deflate',import.meta.url)));
const candidate=await createV14BootstrapCandidate({owner,ownerPublicKey,vault,vaultFundingYocto:funding,compressedV14,passphrase,crypto:webcrypto});
const file=JSON.parse(candidate.text);
const opened=await openV14BootstrapRecoveryKit({kit:file.sealed_kit,passphrase,crypto:webcrypto,expected:{owner,vault,ownerPublicKey,
  temporaryPublicKey:file.review.temporary_vault_public_key,reviewSha256:file.review.review_sha256,scopeId:file.sealed_kit.scope_id}});
const secrets=await opened.useSecrets(({temporaryKey,checkpointCapability})=>[String(temporaryKey),checkpointCapability,passphrase]);
opened.dispose();

function fixture({available=true,loseResponse=false,wrongAck=false,afterSign}={}) {
  let signatures=0,posts=0,markers=0,payload=null,current=true;
  const wallet={async signMessage({message,nonce,recipient,signerId,network}) {
    signatures++;assert.equal(signerId,owner);assert.equal(network,'testnet');
    assert.match(message,/does not create a vault/i);
    const hash=createHash('sha256').update(nep413Payload({message,nonce,recipient})).digest();
    const signature=Buffer.from(pair.sign(hash).signature).toString('base64');
    afterSign?.();return {accountId:owner,publicKey:ownerPublicKey,signature};
  }};
  const fetch=async(url,options={})=>{
    if(String(url)==='https://test.rpc.fastnear.com')return Response.json({jsonrpc:'2.0',id:'bouncer-cli-login',result:{permission:'FullAccess'}});
    assert.equal(String(url),V14_BOOTSTRAP_ENDPOINT);
    if(options.method==='OPTIONS')return new Response(null,{status:available?204:503});
    assert.equal(options.method,'POST');assert.equal(options.credentials,'omit');
    posts++;payload=options.body;
    for(const secret of secrets)assert.equal(payload.includes(secret),false,'a passphrase, key or capability must never be sent');
    const body=JSON.parse(payload);assert.equal(body.operation,'enroll');assert.equal(body.terms.owner,owner);assert.equal(body.terms.vault,vault);
    const attestation=JSON.stringify({terms:body.terms,nonce_base64:body.nonce_base64,signature_base64:body.signature_base64});
    if(loseResponse)throw Error('synthetic lost acknowledgement after possible commit');
    return Response.json({status:'ENROLLED',scope_id:body.terms.scope_id,revision:0,head_sha256:'0'.repeat(64),
      kit_sha256:body.terms.kit_sha256,attestation_sha256:wrongAck?'f'.repeat(64):createHash('sha256').update(attestation).digest('hex')});
  };
  const client=createBootstrapCandidateEnrollmentClient({wallet,owner,ownerPublicKey,location,isTopLevel:true,
    fetch,crypto:webcrypto,now,isCurrent:()=>current});
  const args={text:candidate.text,expectedFingerprint:candidate.fingerprint,passphrase,compressedV14,
    beforePublish:async()=>{markers++;return true}};
  return {client,args,counts:()=>({signatures,posts,markers,payload}),invalidate:()=>{current=false}};
}

test('saved candidate can reach recovery-only enrollment with one identity signature and no secret or transaction',async()=>{
  const {client,args,counts}=fixture();const result=await client.enroll(args);
  assert.equal(result.status,'ENROLLED');assert.equal(result.revision,0);
  assert.equal(result.transaction_authorized,false);assert.equal(result.transaction_sent,false);
  assert.equal(result.independent_backup_verified,false);assert.equal(result.latest_head_independently_verified,false);
  assert.equal(result.vault_or_receipts_checked,false);
  assert.equal(counts().signatures,1);assert.equal(counts().markers,1);assert.equal(counts().posts,1);
  await assert.rejects(client.enroll(args));assert.equal(counts().signatures,1);assert.equal(counts().posts,1);
  client.destroy();
});

test('disabled endpoint and invalid files fail before a wallet signature or write',async()=>{
  const disabled=fixture({available:false});
  assert.equal(await disabled.client.enabled(),false);await assert.rejects(disabled.client.enroll(disabled.args));
  assert.deepEqual(disabled.counts(),{signatures:0,posts:0,markers:0,payload:null});disabled.client.destroy();
  for(const patch of [{expectedFingerprint:'0'.repeat(64)},{passphrase:'wrong synthetic recovery passphrase'},
    {text:`${candidate.text}\n`},{compressedV14:new Uint8Array([0])}]) {
    const f=fixture();await assert.rejects(f.client.enroll({...f.args,...patch}));
    assert.deepEqual(f.counts(),{signatures:0,posts:0,markers:0,payload:null});f.client.destroy();
  }
  assert.throws(()=>createBootstrapCandidateEnrollmentClient({owner:'someone.testnet'}));
});

test('rotated owner key and session changes stop before publishing',async()=>{
  const f=fixture(),other=String(KeyPair.fromRandom('ed25519').getPublicKey());
  const rotated=createBootstrapCandidateEnrollmentClient({wallet:{async signMessage(){throw Error('must not sign')}},owner,
    ownerPublicKey:other,location,isTopLevel:true,crypto:webcrypto,now,fetch:async()=>new Response(null,{status:204})});
  await assert.rejects(rotated.enroll(f.args),/owner key changed/);assert.equal(f.counts().markers,0);rotated.destroy();
  let stale;stale=fixture({afterSign:()=>stale.invalidate()});
  await assert.rejects(stale.client.enroll(stale.args));
  assert.equal(stale.counts().signatures,1);assert.equal(stale.counts().markers,0);assert.equal(stale.counts().posts,0);
  stale.client.destroy();f.client.destroy();
});

test('failed local barrier or uncertain server acknowledgement stops this client without an automatic retry',async()=>{
  const local=fixture();await assert.rejects(local.client.enroll({...local.args,beforePublish:async()=>false}),/may have been recorded/);
  assert.equal(local.counts().signatures,1);assert.equal(local.counts().posts,0);
  await assert.rejects(local.client.enroll(local.args));assert.equal(local.counts().signatures,1);local.client.destroy();
  for(const options of [{loseResponse:true},{wrongAck:true}]) {
    const f=fixture(options);await assert.rejects(f.client.enroll(f.args),/may have been recorded/);
    assert.equal(f.counts().posts,1);assert.equal(f.counts().markers,1);
    await assert.rejects(f.client.enroll(f.args));assert.equal(f.counts().signatures,1);assert.equal(f.counts().posts,1);
    f.client.destroy();
  }
});
