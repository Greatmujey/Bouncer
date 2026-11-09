// Synthetic keys and data only. These tests do not contact a checkpoint or send a transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {KeyPair} from '@near-js/crypto';
import {createV14BootstrapCandidate} from '../web-src/v14-bootstrap-candidate.mjs';
import {prepareBootstrapEnrollment} from '../web-src/v14-bootstrap-checkpoint.mjs';
import {createBootstrapRecoveryReadClient} from '../web-src/v14-bootstrap-recovery-read.mjs';
import {openV14BootstrapRecoveryKit} from '../web-src/v14-bootstrap-recovery-kit.mjs';
import {nep413Payload} from '../web-src/cli-login.mjs';

const webcrypto=crypto.webcrypto,owner='great_mujey.testnet',vault=`native.${owner}`;
const site='https://bouncer-production-6df1.up.railway.app',location={origin:site,host:new URL(site).host};
const ownerKey=KeyPair.fromRandom('ed25519'),ownerPublicKey=String(ownerKey.getPublicKey());
const passphrase='synthetic candidate recovery passphrase',now=()=>1_800_000_000_000;
const compressedV14=new Uint8Array(fs.readFileSync(new URL('../web/artifacts/v14-research.deflate',import.meta.url)));
const makeCandidate=()=>createV14BootstrapCandidate({owner,ownerPublicKey,vault,vaultFundingYocto:String(6n*10n**24n),
  compressedV14,passphrase,crypto:webcrypto});
const first=await makeCandidate(),second=await makeCandidate();
async function online(candidate) {
  const {review,sealed_kit:kit}=JSON.parse(candidate.text);
  const draft=await prepareBootstrapEnrollment({review,kit,passphrase,compressedV14,site,crypto:webcrypto,now});
  const digest=crypto.createHash('sha256').update(nep413Payload({message:draft.message,nonce:draft.nonce,recipient:draft.recipient})).digest();
  const owner_attestation=JSON.stringify({terms:draft.terms,nonce_base64:Buffer.from(draft.nonce).toString('base64'),
    signature_base64:Buffer.from(ownerKey.sign(digest).signature).toString('base64')});
  return {status:'EXISTING_RECOVERY_ONLY',scope_id:kit.scope_id,review_text:draft.review_text,sealed_kit:draft.sealed_kit,
    owner_attestation,revision:0,head_sha256:'0'.repeat(64),events:[],transaction_authorized:false,
    latest_head_independently_verified:false};
}
const firstOnline=await online(first),secondOnline=await online(second);
const args=(candidate=first,overrides={})=>({text:candidate.text,expectedFingerprint:candidate.fingerprint,
  passphrase,compressedV14,...overrides});
function harness({key=ownerPublicKey,valid=()=>true,selectedWallet}={}) {
  let remote=structuredClone(firstOnline),available=true,signatures=0,prompts=0;
  const requests=[];
  const wallet=selectedWallet||{manifest:{id:'meteor'},async signMessage({message,nonce,recipient,signerId,network}){
    signatures++;assert.equal(signerId,owner);assert.equal(network,'testnet');assert.match(message,/does not decrypt a key, restore authorization, or permit another transaction/i);
    const digest=crypto.createHash('sha256').update(nep413Payload({message,nonce,recipient})).digest();
    return {accountId:owner,publicKey:ownerPublicKey,signature:Buffer.from(ownerKey.sign(digest).signature).toString('base64')};
  }};
  const fetch=async(url,options={})=>{
    requests.push({url:String(url),method:options.method||'GET',body:options.body||''});
    if(String(url)==='https://test.rpc.fastnear.com')return Response.json({jsonrpc:'2.0',id:'bouncer-cli-login',result:{permission:'FullAccess'}});
    if(options.method==='OPTIONS')return new Response(null,{status:available?204:503});
    assert.equal(options.method,'POST');assert.equal(JSON.parse(options.body).operation,'recover');
    return Response.json(remote);
  };
  const client=createBootstrapRecoveryReadClient({wallet,owner,ownerPublicKey:key,location,isTopLevel:true,
    crypto:webcrypto,fetch,isCurrent:valid,now});
  return {client,requests,signatures:()=>signatures,prompts:()=>prompts,options:()=>({onWalletPrompt:()=>{prompts++}}),
    setRemote:value=>{remote=value},setAvailable:value=>{available=value}};
}

test('candidate matches an owner-attested kit without sending the file, ID, passphrase or decrypted secrets',async()=>{
  const h=harness();
  const file=JSON.parse(first.text),opened=await openV14BootstrapRecoveryKit({kit:file.sealed_kit,passphrase,crypto:webcrypto,
    expected:{owner,vault,ownerPublicKey,temporaryPublicKey:first.temporary_public_key,
      reviewSha256:first.review_sha256,scopeId:file.sealed_kit.scope_id}});
  let temporarySecret,capability;
  await opened.useSecrets(({temporaryKey,checkpointCapability})=>{temporarySecret=String(temporaryKey);capability=checkpointCapability});opened.dispose();
  const match=await h.client.compareSavedCandidate(args(first,h.options()));
  assert.equal(match.status,'MATCHED');assert.equal(match.file_integrity_verified,true);
  for(const field of ['history_authentication_verified','independent_backup_verified','latest_head_independently_verified',
    'vault_or_receipts_checked','transaction_authorized','transaction_sent'])assert.equal(match[field],false,field);
  assert.equal(match.service_reported_revision,0);assert.equal(h.signatures(),1);assert.equal(h.prompts(),1);
  const posts=h.requests.filter(request=>request.method==='POST'&&!request.url.includes('rpc.fastnear'));
  assert.equal(posts.length,1);assert.equal(JSON.parse(posts[0].body).operation,'recover');
  for(const request of h.requests)for(const secret of [first.text,first.fingerprint,passphrase,temporarySecret,capability])
    assert.equal(request.body.includes(secret),false,'read request must not transmit local material');
  h.client.destroy();
});

test('bad local inputs, missing pinned artifact, changed key and disabled endpoint do not prompt the wallet',async()=>{
  const h=harness(),badArtifact=compressedV14.slice();badArtifact[10]^=1;
  for(const overrides of [{text:'{not json'}, {expectedFingerprint:'0'.repeat(64)},
    {passphrase:'wrong synthetic recovery passphrase'}, {compressedV14:badArtifact}, {compressedV14:null},
    {text:first.text+'\n',expectedFingerprint:crypto.createHash('sha256').update(`bouncer-v14-local-bootstrap-candidate-file-v1\0${first.text}\n`).digest('hex')}]) {
    await assert.rejects(h.client.compareSavedCandidate(args(first,{...overrides,...h.options()})));
  }
  assert.equal(h.signatures(),0);assert.equal(h.prompts(),0);assert.equal(h.requests.length,0);
  h.setAvailable(false);await assert.rejects(h.client.compareSavedCandidate(args(first,h.options())));
  assert.equal(h.signatures(),0);assert.equal(h.prompts(),0);
  const rotated=harness({key:String(KeyPair.fromRandom('ed25519').getPublicKey())});
  const result=await rotated.client.compareSavedCandidate(args(first,rotated.options()));
  assert.equal(result.status,'OWNER_KEY_CHANGED');assert.equal(result.transaction_authorized,false);
  assert.equal(rotated.signatures(),0);assert.equal(rotated.prompts(),0);assert.equal(rotated.requests.length,0);
  h.client.destroy();rotated.client.destroy();
});

test('different or uncertain online responses stop without replacing an unlocked recovery export',async()=>{
  const h=harness();
  await h.client.read();await h.client.verifyPassphrase(passphrase);
  const retained=h.client.exportEncrypted();
  h.setRemote(structuredClone(secondOnline));
  assert.equal((await h.client.compareSavedCandidate(args())).status,'DIFFERENT_SETUP');
  assert.equal(h.client.exportEncrypted(),retained);
  const invalid=structuredClone(firstOnline);invalid.owner_attestation=invalid.owner_attestation.replace('signature_base64','signature_tampered');
  h.setRemote(invalid);await assert.rejects(h.client.compareSavedCandidate(args()));assert.equal(h.client.exportEncrypted(),retained);
  h.setRemote({...firstOnline,head_sha256:'1'.repeat(64)});await assert.rejects(h.client.compareSavedCandidate(args()));
  assert.equal(h.client.exportEncrypted(),retained);
  for(const request of h.requests.filter(request=>request.method==='POST'&&!request.url.includes('rpc.fastnear'))) {
    assert.equal(JSON.parse(request.body).operation,'recover');
  }
  h.client.destroy();
});

test('stale sessions or changed selections cannot display success or send the recovery read',async()=>{
  let current=true;
  const h=harness({valid:()=>current}),pending=h.client.compareSavedCandidate(args(first,h.options()));
  current=false;await assert.rejects(pending);assert.equal(h.signatures(),0);assert.equal(h.prompts(),0);h.client.destroy();

  let resolveSignature,signalStarted,selected=true;
  const started=new Promise(resolve=>{signalStarted=resolve});
  const delayedWallet={manifest:{id:'meteor'},async signMessage({message,nonce,recipient}){
    signalStarted();await new Promise(resolve=>{resolveSignature=resolve});
    const digest=crypto.createHash('sha256').update(nep413Payload({message,nonce,recipient})).digest();
    return {accountId:owner,publicKey:ownerPublicKey,signature:Buffer.from(ownerKey.sign(digest).signature).toString('base64')};
  }};
  const delayed=harness({selectedWallet:delayedWallet});
  const reading=delayed.client.compareSavedCandidate(args(first,{stillSelected:()=>selected}));
  await started;selected=false;resolveSignature();await assert.rejects(reading);
  assert.equal(delayed.requests.filter(request=>request.method==='POST'&&!request.url.includes('rpc.fastnear')).length,0);
  delayed.client.destroy();
});
