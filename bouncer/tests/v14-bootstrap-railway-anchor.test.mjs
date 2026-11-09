import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {KeyPair} from '@near-js/crypto';
import {buildV14TemporaryBootstrapPlan} from '../web-src/v14-bootstrap-plan.mjs';
import {sealV14BootstrapRecoveryKit,openV14BootstrapRecoveryKit} from '../web-src/v14-bootstrap-recovery-kit.mjs';
import {prepareBootstrapEnrollment,prepareBootstrapRecovery} from '../web-src/v14-bootstrap-checkpoint.mjs';
import {bootstrapSha256} from '../shared/v14-bootstrap-protocol.mjs';
import {deriveBootstrapAnchorCredentials,verifyBootstrapAnchorInitialization} from '../shared/v14-bootstrap-anchor-auth.mjs';
import {createV14BootstrapRailwayAnchor} from '../agent/v14-bootstrap-railway-anchor.mjs';
import {createV14BootstrapRailwayAnchorHttp,V14_RAILWAY_ANCHOR_PATH} from '../agent/v14-bootstrap-railway-anchor-http.mjs';
import {createV14BootstrapRailwayStore,recoverV14BootstrapRailwayAnchor,V14_RAILWAY_ANCHOR_ENDPOINT} from '../web-src/v14-bootstrap-railway-store.mjs';
import {createBootstrapRecoveryReadClient} from '../web-src/v14-bootstrap-recovery-read.mjs';
import {V14_BOOTSTRAP_ENDPOINT} from '../web-src/v14-bootstrap-remote-store.mjs';
import {createRailwayNativeStandby} from '../scripts/start-railway-native.mjs';
import {createBootstrapTwoCopyWitness} from '../web-src/v14-bootstrap-originals.mjs';
import {nep413Payload} from '../web-src/cli-login.mjs';
import {encodeBase58} from '../web-src/native-oracle-transaction.mjs';

const webcrypto=crypto.webcrypto,scopeId='ab'.repeat(16),remoteCapability='cd'.repeat(32),zero='0'.repeat(64);
const site='https://bouncer-production-6df1.up.railway.app',ownerId='great_mujey.testnet',vault=`native.${ownerId}`;
const passphrase='disposable-only recovery passphrase',now=()=>1_800_000_000_000;
const compressed=new Uint8Array(fs.readFileSync(new URL('../web/artifacts/v14-research.deflate',import.meta.url)));
async function fixture(){
  const owner=KeyPair.fromRandom('ed25519'),temporary=KeyPair.fromRandom('ed25519');
  const plan=await buildV14TemporaryBootstrapPlan({owner:ownerId,ownerPublicKey:String(owner.getPublicKey()),vault,
    temporaryPublicKey:String(temporary.getPublicKey()),vaultFundingYocto:String(6n*10n**24n),compressedV14:compressed,crypto:webcrypto});
  const kit=await sealV14BootstrapRecoveryKit({review:plan.review,temporaryKey:temporary,scopeId,
    checkpointCapability:remoteCapability,passphrase,crypto:webcrypto});
  const draft=await prepareBootstrapEnrollment({review:plan.review,kit,passphrase,compressedV14:compressed,site,crypto:webcrypto,now});
  const digest=crypto.createHash('sha256').update(nep413Payload({message:draft.message,nonce:draft.nonce,recipient:draft.recipient})).digest();
  const attestation=JSON.stringify({terms:draft.terms,nonce_base64:Buffer.from(draft.nonce).toString('base64'),
    signature_base64:Buffer.from(owner.sign(digest).signature).toString('base64')});
  const credentials=await deriveBootstrapAnchorCredentials({temporaryKey:temporary,scopeId,reviewSha256:plan.review.review_sha256,crypto:webcrypto});
  const input={scope_id:scopeId,review_sha256:plan.review.review_sha256,capability:credentials.capability,
    initialization_signature:credentials.initialization_signature,review_text:draft.review_text,sealed_kit:draft.sealed_kit,owner_attestation:attestation};
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-anchor-fixture-'));
  const open=()=>createV14BootstrapRailwayAnchor({volumePath:dir,compressedV14:compressed,crypto:webcrypto});
  return {owner,temporary,plan,kit,draft,attestation,credentials,input,dir,open,cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
const empty={revision:0,head_sha256:zero,events:[]};
function remoteStore(){let snapshot=structuredClone(empty);return {
  read:async()=>structuredClone(snapshot),append:async({expected_revision,expected_head_sha256,record})=>{
    if(snapshot.revision!==expected_revision||snapshot.head_sha256!==expected_head_sha256)throw Error('conflict');
    const head=await bootstrapSha256(webcrypto,record);
    if(snapshot.revision!==expected_revision||snapshot.head_sha256!==expected_head_sha256)throw Error('conflict');
    snapshot={revision:expected_revision+1,head_sha256:head,events:[...snapshot.events,record]};return structuredClone(snapshot);
  }};}
const hash=()=>encodeBase58(crypto.randomBytes(32));

test('independent capability is deterministic, domain-separated, and requires the temporary private key',async()=>{
  const x=await fixture();try{
    const again=await deriveBootstrapAnchorCredentials({temporaryKey:x.temporary,scopeId,reviewSha256:x.plan.review.review_sha256,crypto:webcrypto});
    assert.deepEqual(again,x.credentials);assert.notEqual(again.capability,remoteCapability);
    assert.equal(await verifyBootstrapAnchorInitialization({scopeId,reviewSha256:x.plan.review.review_sha256,
      capabilitySha256:again.capability_sha256,temporaryPublicKey:String(x.temporary.getPublicKey()),signature:again.initialization_signature,crypto:webcrypto}),true);
    for(const change of [{scopeId:'aa'.repeat(16)},{reviewSha256:'00'.repeat(32)},{capabilitySha256:'00'.repeat(32)},
      {temporaryPublicKey:String(x.owner.getPublicKey())},{signature:'A'.repeat(86)+'=='}]){
      await assert.rejects(verifyBootstrapAnchorInitialization({scopeId,reviewSha256:x.plan.review.review_sha256,
        capabilitySha256:again.capability_sha256,temporaryPublicKey:String(x.temporary.getPublicKey()),
        signature:again.initialization_signature,crypto:webcrypto,...change}));
    }
  }finally{x.cleanup()}
});

test('an owner-signed encrypted kit can be explicitly saved and restored on a separate local volume',async()=>{
  const x=await fixture();try{
    const anchor=x.open();await assert.rejects(anchor.read({capability:x.credentials.capability}));
    assert.deepEqual(await anchor.initialize(x.input),empty);await assert.rejects(anchor.initialize(x.input));
    await assert.rejects(anchor.read({capability:remoteCapability}));
    const backup=await x.open().recover({capability:x.credentials.capability});
    assert.equal(backup.sealed_kit,x.draft.sealed_kit);assert.equal(backup.owner_attestation,x.attestation);
    assert.equal(backup.latest_head_independently_verified,false);assert.equal(backup.transaction_authorized,false);
    const restored=await openV14BootstrapRecoveryKit({kit:JSON.parse(backup.sealed_kit),passphrase,crypto:webcrypto,
      expected:{owner:ownerId,vault,ownerPublicKey:x.plan.review.owner_public_key,temporaryPublicKey:x.plan.review.temporary_vault_public_key,
        reviewSha256:x.plan.review.review_sha256,scopeId}});
    await restored.useSecrets(async({temporaryKey,checkpointCapability})=>{
      assert.equal(String(temporaryKey.getPublicKey()),String(x.temporary.getPublicKey()));assert.equal(checkpointCapability,remoteCapability);
      const recovered=await deriveBootstrapAnchorCredentials({temporaryKey,scopeId,reviewSha256:x.plan.review.review_sha256,crypto:webcrypto});
      assert.equal(recovered.capability,x.credentials.capability);
    });restored.dispose();
    const disk=fs.readFileSync(path.join(x.dir,'v14-bootstrap-anchor-v1','metadata.json'),'utf8');
    for(const secret of [String(x.temporary),remoteCapability,x.credentials.capability,passphrase])assert.equal(disk.includes(secret),false);
  }finally{x.cleanup()}
});

test('fresh owner signature and FINAL key can restore the encrypted backup without the temporary key',async()=>{
  const x=await fixture();try{
    const anchor=x.open();await anchor.initialize(x.input);
    const draft=prepareBootstrapRecovery({owner:ownerId,ownerPublicKey:String(x.owner.getPublicKey()),vault,site,crypto:webcrypto,now});
    const digest=crypto.createHash('sha256').update(nep413Payload({message:draft.message,nonce:draft.nonce,recipient:draft.recipient})).digest();
    const signed={terms:draft.terms,nonce_base64:Buffer.from(draft.nonce).toString('base64'),
      signature_base64:Buffer.from(x.owner.sign(digest).signature).toString('base64')};
    const block=hash();let permission='FullAccess',network='testnet',calls=[];
    const fetch=async(url,options)=>{
      assert.equal(url,'https://test.rpc.fastnear.com');const req=JSON.parse(options.body);calls.push(req.method);
      let result;
      if(req.method==='status')result={chain_id:network};
      else if(req.method==='block')result={header:{hash:block,height:100,timestamp_nanosec:String(BigInt(now())*1_000_000n)}};
      else if(req.method==='query'){
        assert.equal(req.params.account_id,ownerId);assert.equal(req.params.public_key,String(x.owner.getPublicKey()));
        assert.equal(req.params.block_id,block);result={block_hash:block,permission};
      } else throw Error('no transaction RPC allowed');
      return Response.json({jsonrpc:'2.0',id:req.id,result});
    };
    const result=await anchor.recoverByOwner({signed,origin:site,fetch,now});
    assert.equal(result.sealed_kit,x.draft.sealed_kit);assert.equal(result.transaction_authorized,false);
    assert.deepEqual(calls,['status','block','query']);
    permission={FunctionCall:{}};await assert.rejects(anchor.recoverByOwner({signed,origin:site,fetch,now}));
    permission='FullAccess';network='mainnet';await assert.rejects(anchor.recoverByOwner({signed,origin:site,fetch,now}));
    network='testnet';await assert.rejects(anchor.recoverByOwner({signed,origin:'https://evil.invalid',fetch,now}));
    await assert.rejects(anchor.recoverByOwner({signed,origin:site,fetch,now:()=>now()+181_000}));
    await assert.rejects(anchor.recoverByOwner({signed:{...signed,signature_base64:'A'.repeat(86)+'=='},origin:site,fetch,now}));
  }finally{x.cleanup()}
});

test('two distinct stores retain claims and hashes, survive reopening, and never replace history',async()=>{
  const x=await fixture();try{
    const anchor=x.open();await anchor.initialize(x.input);
    const local={read:()=>anchor.read({capability:x.credentials.capability}),
      append:args=>anchor.append({capability:x.credentials.capability,...args})};
    const remote=remoteStore(),original=hash();
    const witness=createBootstrapTwoCopyWitness({scopeId,reviewSha256:x.plan.review.review_sha256,localStore:local,remoteStore:remote,crypto:webcrypto});
    assert.equal((await witness.claimCreate()).revision,1);
    assert.equal((await witness.retainCreateOriginal(original)).create_original,original);
    assert.deepEqual(await local.read(),await remote.read());
    assert.deepEqual(await x.open().read({capability:x.credentials.capability}),await remote.read());
    await assert.rejects(anchor.initialize(x.input));
    await assert.rejects(anchor.append({capability:x.credentials.capability,expected_revision:0,expected_head_sha256:zero,record:'{}'}));
    assert.equal((await local.read()).revision,2);
  }finally{x.cleanup()}
});

test('wrong signatures, changed owner attestation, unrelated kits or plans never initialize',async()=>{
  const x=await fixture();try{
    const anchor=x.open();
    for(const patch of [{capability:remoteCapability},{scope_id:'aa'.repeat(16)},{review_sha256:'00'.repeat(32)},
      {initialization_signature:'A'.repeat(86)+'=='},{owner_attestation:x.attestation+' '},
      {sealed_kit:x.draft.sealed_kit+' '},{review_text:x.draft.review_text+' '},{extra:true}])await assert.rejects(anchor.initialize({...x.input,...patch}));
    assert.equal(fs.readdirSync(x.dir).length,0);
  }finally{x.cleanup()}
});

test('partial, missing, extra, corrupted and conflicting records fail closed without repair',async()=>{
  for(const damage of ['partial','gap','extra','changed','missing-meta','stale-lock','changed-capability']){
    const x=await fixture();try{
      const anchor=x.open();await anchor.initialize(x.input);
      const dir=path.join(x.dir,'v14-bootstrap-anchor-v1');
      if(damage==='partial')fs.writeFileSync(path.join(dir,'1.event'),'{');
      if(damage==='gap')fs.writeFileSync(path.join(dir,'2.event'),'{}');
      if(damage==='extra')fs.writeFileSync(path.join(dir,'unexpected'),'x');
      if(damage==='changed')fs.writeFileSync(path.join(dir,'1.event'),JSON.stringify({format:'invalid'}));
      if(damage==='missing-meta')fs.unlinkSync(path.join(dir,'metadata.json'));
      if(damage==='stale-lock')fs.writeFileSync(path.join(dir,'write.lock'),'locked');
      if(damage==='changed-capability'){
        const file=path.join(dir,'metadata.json'),meta=JSON.parse(fs.readFileSync(file,'utf8'));
        meta.capability_sha256='0'.repeat(64);fs.writeFileSync(file,JSON.stringify(meta));
      }
      await assert.rejects(anchor.read({capability:x.credentials.capability}));
      await assert.rejects(anchor.initialize(x.input));
    }finally{x.cleanup()}
  }
});

test('competing writers cannot both acquire the same durable claim',async()=>{
  const x=await fixture();try{
    const anchor=x.open();await anchor.initialize(x.input);
    const remote=remoteStore(),make=()=>createBootstrapTwoCopyWitness({scopeId,reviewSha256:x.plan.review.review_sha256,
      localStore:{read:()=>anchor.read({capability:x.credentials.capability}),append:args=>anchor.append({capability:x.credentials.capability,...args})},
      remoteStore:remote,crypto:webcrypto});
    const [one,two]=[make(),make()],results=await Promise.allSettled([one.claimCreate(),two.claimCreate()]);
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
    assert.equal((await anchor.read({capability:x.credentials.capability})).revision,1);
    assert.deepEqual(await anchor.read({capability:x.credentials.capability}),await remote.read());
  }finally{x.cleanup()}
});

async function testServer(handler){
  // Node's fetch overrides Host for loopback; emulate the hosted proxy header
  // ONLY inside this disposable test harness, never in production code.
  const adapter=handler?(req,res)=>{req.headers.host=req.headers['x-synthetic-host'];return handler(req,res)}:undefined;
  const server=createRailwayNativeStandby(adapter?{bootstrapAnchorHandler:adapter}:{});
  await new Promise((resolve,reject)=>server.listen(0,'127.0.0.1',resolve).once('error',reject));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=(opts={})=>fetch(base+V14_RAILWAY_ANCHOR_PATH,{...opts,headers:{'x-synthetic-host':new URL(site).host,origin:site,...opts.headers}});
  return {server,request,close:()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))};
}

test('Railway route is off by default and denies untrusted origins and cookies before touching state',async()=>{
  const disabled=await testServer();try{
    const response=await disabled.request({method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    assert.equal(response.status,404);
  }finally{await disabled.close()}
  const x=await fixture();let requests=0;
  const anchor=x.open(),handler=createV14BootstrapRailwayAnchorHttp({anchor,fetch:async()=>{requests++;throw Error('not called')},now});
  const server=await testServer(handler);
  try {
    const options=await server.request({method:'OPTIONS'});assert.equal(options.status,204);
    assert.equal(options.headers.get('access-control-allow-origin'),site);
    const vercel=await server.request({method:'OPTIONS',headers:{origin:'https://bouncer-near.vercel.app'}});
    assert.equal(vercel.status,204);assert.equal(vercel.headers.get('access-control-allow-origin'),'https://bouncer-near.vercel.app');
    const denied=await server.request({method:'POST',headers:{origin:'https://evil.invalid','content-type':'application/json'},body:'{}'});
    assert.equal(denied.status,403);assert.equal(denied.headers.get('access-control-allow-origin'),null);
    const cookie=await server.request({method:'POST',headers:{'content-type':'application/json',cookie:'x=y'},body:'{}'});
    assert.equal(cookie.status,403);assert.equal(requests,0);assert.equal(fs.readdirSync(x.dir).length,0);
  }finally{await server.close();x.cleanup()}
});

test('browser client and independent volume round-trip an encrypted kit and append without transactions',async()=>{
  const x=await fixture();const anchor=x.open(),handler=createV14BootstrapRailwayAnchorHttp({anchor,fetch:async()=>{throw Error('not used')},now});
  const server=await testServer(handler),remote=remoteStore();
  try {
    const location={origin:site,host:new URL(site).host};let calls=0,marked=0;
    const localFetch=(url,options)=>{
      assert.equal(url,V14_RAILWAY_ANCHOR_ENDPOINT);calls++;
      return server.request({...options,headers:{...options.headers}});
    };
    const store=await createV14BootstrapRailwayStore({location,isTopLevel:true,scopeId,reviewSha256:x.plan.review.review_sha256,
      temporaryKey:x.temporary,compressedV14:compressed,fetch:localFetch,crypto:webcrypto});
    await assert.rejects(store.read());
    const result=await store.initializeNew({reviewText:x.draft.review_text,sealedKit:x.draft.sealed_kit,ownerAttestation:x.attestation,
      remoteStore:remote,markBeforeInitialize:async()=>{marked++;return true}});
    assert.equal(result.status,'INDEPENDENT_ANCHOR_CREATED');assert.equal(result.independent_restore_verified,false);assert.equal(marked,1);
    await assert.rejects(store.initializeNew({}));assert.deepEqual(await store.read(),empty);
    const witness=createBootstrapTwoCopyWitness({scopeId,reviewSha256:x.plan.review.review_sha256,localStore:store,remoteStore:remote,crypto:webcrypto});
    await witness.claimCreate();const original=hash();await witness.retainCreateOriginal(original);
    assert.deepEqual(await store.read(),await remote.read());assert.equal((await store.read()).revision,2);
    assert.ok(calls>=5);store.destroy();await assert.rejects(store.read());
  }finally{await server.close();x.cleanup()}
});

test('an initialization acknowledgement lost after the write cannot be retried on the client',async()=>{
  const x=await fixture();const anchor=x.open(),handler=createV14BootstrapRailwayAnchorHttp({anchor,fetch:async()=>{throw Error('not used')},now});
  const server=await testServer(handler),remote=remoteStore();
  try {
    const location={origin:site,host:new URL(site).host};let attempts=0,markers=0;
    const lossy=async(url,options)=>{
      assert.equal(url,V14_RAILWAY_ANCHOR_ENDPOINT);const response=await server.request(options);
      if(JSON.parse(options.body).operation==='initialize'){attempts++;assert.equal(response.status,200);throw Error('ack lost after write')}
      return response;
    };
    const store=await createV14BootstrapRailwayStore({location,isTopLevel:true,scopeId,reviewSha256:x.plan.review.review_sha256,
      temporaryKey:x.temporary,compressedV14:compressed,fetch:lossy,crypto:webcrypto});
    const params={reviewText:x.draft.review_text,sealedKit:x.draft.sealed_kit,ownerAttestation:x.attestation,
      remoteStore:remote,markBeforeInitialize:async()=>{markers++;return true}};
    await assert.rejects(store.initializeNew(params));await assert.rejects(store.initializeNew(params));
    assert.equal(attempts,1);assert.equal(markers,1);assert.deepEqual(await anchor.read({capability:x.credentials.capability}),empty);
  }finally{await server.close();x.cleanup()}
});

test('owner-signed browser recovery can unlock the other provider without exposing secrets or trusting its head',async()=>{
  const x=await fixture(),anchor=x.open();await anchor.initialize(x.input);
  const block=hash();
  const rpc=async(url,options)=>{
    assert.equal(url,'https://test.rpc.fastnear.com');const req=JSON.parse(options.body);let result;
    if(req.method==='status')result={chain_id:'testnet'};
    else if(req.method==='block')result={header:{hash:block,height:100,timestamp_nanosec:String(BigInt(now())*1_000_000n)}};
    else if(req.method==='query')result={block_hash:block,permission:'FullAccess'};
    else throw Error('unexpected RPC');
    return Response.json({jsonrpc:'2.0',id:req.id,result});
  };
  const server=await testServer(createV14BootstrapRailwayAnchorHttp({anchor,fetch:rpc,now}));
  try {
    const draft=prepareBootstrapRecovery({owner:ownerId,ownerPublicKey:String(x.owner.getPublicKey()),vault,site,crypto:webcrypto,now});
    const digest=crypto.createHash('sha256').update(nep413Payload({message:draft.message,nonce:draft.nonce,recipient:draft.recipient})).digest();
    const signed={terms:draft.terms,nonce_base64:Buffer.from(draft.nonce).toString('base64'),
      signature_base64:Buffer.from(x.owner.sign(digest).signature).toString('base64')};
    const localFetch=(url,options)=>{assert.equal(url,V14_RAILWAY_ANCHOR_ENDPOINT);return server.request(options)};
    const recovered=await recoverV14BootstrapRailwayAnchor({signed,location:{origin:site,host:new URL(site).host},isTopLevel:true,
      compressedV14:compressed,fetch:localFetch,crypto:webcrypto});
    assert.equal(recovered.status,'ENCRYPTED_ANCHOR_READ_ONLY');assert.equal(Object.hasOwn(recovered,'events'),false);
    assert.throws(()=>recovered.readEncryptedCopy());
    assert.equal(recovered.history_authentication_verified,false);await assert.rejects(recovered.unlock('incorrect recovery passphrase'));
    assert.throws(()=>recovered.readEncryptedCopy());const unlocked=await recovered.unlock(passphrase);
    assert.equal(unlocked.status,'ANCHOR_KIT_UNLOCKED_AND_SNAPSHOT_MATCHED');assert.equal(unlocked.capability_read_matches,true);
    assert.equal(unlocked.history_authentication_verified,false);assert.equal(unlocked.latest_head_independently_verified,false);
    assert.equal(unlocked.independent_recovery_verified,false);assert.equal(unlocked.transaction_authorized,false);
    assert.equal(recovered.readEncryptedCopy().sealed_kit,x.draft.sealed_kit);
    for(const secret of [String(x.temporary),remoteCapability,x.credentials.capability,passphrase])
      assert.equal(JSON.stringify(unlocked).includes(secret),false);
    recovered.destroy();await assert.rejects(recovered.unlock(passphrase));
  }finally{await server.close();x.cleanup()}
});

test('existing online recovery can add a distinct encrypted anchor without re-enrollment or a wallet transaction',async()=>{
  const x=await fixture(),anchor=x.open(),block=hash();
  const server=await testServer(createV14BootstrapRailwayAnchorHttp({anchor,fetch:async(url,options)=>{
    assert.equal(url,'https://test.rpc.fastnear.com');const req=JSON.parse(options.body);
    const result=req.method==='status'?{chain_id:'testnet'}:req.method==='block'
      ?{header:{hash:block,height:100,timestamp_nanosec:String(BigInt(now())*1_000_000n)}}:{block_hash:block,permission:'FullAccess'};
    return Response.json({id:req.id,jsonrpc:'2.0',result});
  },now}));
  try {
    let signatures=0,transactions=0,enrollments=0,markers=0,ownerRestores=0,primaryOnline=true;
    const wallet={async signMessage({message,nonce,recipient}){
      signatures++;const digest=crypto.createHash('sha256').update(nep413Payload({message,nonce,recipient})).digest();
      return {accountId:ownerId,publicKey:String(x.owner.getPublicKey()),signature:Buffer.from(x.owner.sign(digest).signature).toString('base64')};
    },async signAndSendTransaction(){transactions++;throw Error('must not send')}};
    const fetch=async(url,options)=>{
      if(url===V14_RAILWAY_ANCHOR_ENDPOINT){
        if(options.method==='POST'&&JSON.parse(options.body).operation==='recover_owner')ownerRestores++;
        return server.request(options);
      }
      if(url==='https://test.rpc.fastnear.com'){
        const req=JSON.parse(options.body);assert.equal(req.method,'query');
        return Response.json({jsonrpc:'2.0',id:req.id,result:{permission:'FullAccess'}});
      }
      assert.equal(url,V14_BOOTSTRAP_ENDPOINT);assert.equal(primaryOnline,true,'restoring must not contact the primary provider');
      if(options.method==='OPTIONS')return new Response(null,{status:204});
      const data=JSON.parse(options.body);
      if(data.operation==='recover')return Response.json({status:'EXISTING_RECOVERY_ONLY',scope_id:scopeId,
        review_text:x.draft.review_text,sealed_kit:x.draft.sealed_kit,owner_attestation:x.attestation,...empty,
        transaction_authorized:false,latest_head_independently_verified:false});
      if(data.operation==='read')return Response.json(empty);
      if(data.operation==='enroll')enrollments++;
      throw Error('unexpected checkpoint operation');
    };
    const client=createBootstrapRecoveryReadClient({wallet,owner:ownerId,ownerPublicKey:String(x.owner.getPublicKey()),
      location:{origin:site,host:new URL(site).host},isTopLevel:true,fetch,crypto:webcrypto,now});
    assert.equal(await client.anchorEnabled(),true);assert.equal((await client.read()).revision,0);
    const marker=async()=>{markers++;return true};
    await assert.rejects(client.saveIndependentAnchor({passphrase:'incorrect recovery passphrase',compressedV14:compressed,markBeforeInitialize:marker}));
    assert.equal(markers,0);assert.equal(fs.readdirSync(x.dir).length,0);
    const copied=await client.saveIndependentAnchor({passphrase,compressedV14:compressed,markBeforeInitialize:marker});
    assert.equal(copied.status,'INDEPENDENT_ANCHOR_CREATED');assert.equal(copied.independent_restore_verified,false);
    assert.equal(markers,1);assert.equal(signatures,1);assert.equal(transactions,0);assert.equal(enrollments,0);
    assert.equal((await anchor.recover({capability:x.credentials.capability})).sealed_kit,x.draft.sealed_kit);
    client.destroy();primaryOnline=false;
    const separate=createBootstrapRecoveryReadClient({wallet,owner:ownerId,ownerPublicKey:String(x.owner.getPublicKey()),
      location:{origin:site,host:new URL(site).host},isTopLevel:true,fetch,crypto:webcrypto,now});
    const restored=await separate.restoreIndependentAnchor({passphrase,compressedV14:compressed});
    assert.equal(restored.status,'KIT_UNLOCKED_LOCALLY_NOT_AUTHORIZED');assert.equal(restored.revision,0);
    assert.equal(restored.latest_head_independently_verified,false);assert.equal(restored.history_authentication_verified,false);
    assert.equal(JSON.parse(separate.exportEncrypted()).sealed_kit,x.draft.sealed_kit);
    assert.equal(signatures,2);assert.equal(transactions,0);assert.equal(enrollments,0);assert.equal(ownerRestores,1);separate.destroy();
    let selected=true;const staleWallet={...wallet,async signMessage(args){const response=await wallet.signMessage(args);selected=false;return response}};
    const stale=createBootstrapRecoveryReadClient({wallet:staleWallet,owner:ownerId,ownerPublicKey:String(x.owner.getPublicKey()),
      location:{origin:site,host:new URL(site).host},isTopLevel:true,fetch,crypto:webcrypto,now});
    await assert.rejects(stale.restoreIndependentAnchor({passphrase,compressedV14:compressed,stillSelected:()=>selected}));
    assert.equal(ownerRestores,1,'a late or stale wallet result must not read the anchor');
    assert.throws(()=>stale.exportEncrypted());stale.destroy();
  }finally{await server.close();x.cleanup()}
});
