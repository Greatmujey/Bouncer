import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {IDBFactory} from 'fake-indexeddb';
import {KeyPair} from '@near-js/crypto';
import {buildV14TemporaryBootstrapPlan} from '../web-src/v14-bootstrap-plan.mjs';
import {sealV14BootstrapRecoveryKit} from '../web-src/v14-bootstrap-recovery-kit.mjs';
import {prepareBootstrapEnrollment,signBootstrapEnrollment,prepareBootstrapRecovery,signBootstrapRecovery,
  bootstrapEnrollmentMessage,verifyBootstrapAttestation,verifyBootstrapEnrollmentContents,bootstrapSha256} from '../web-src/v14-bootstrap-checkpoint.mjs';
import {bootstrapLocalJournalKey,createBootstrapTwoCopyWitness,inspectBootstrapOriginals} from '../web-src/v14-bootstrap-originals.mjs';
import {enrollBootstrapCheckpoint,createBootstrapRemoteStore,recoverBootstrapCheckpoint} from '../web-src/v14-bootstrap-remote-store.mjs';
import {openV14BootstrapRecoveryKit} from '../web-src/v14-bootstrap-recovery-kit.mjs';
import {createBootstrapRecoveryReadClient} from '../web-src/v14-bootstrap-recovery-read.mjs';
import {createBootstrapCandidateEnrollmentClient} from '../web-src/v14-bootstrap-candidate-enrollment.mjs';
import {createV14BootstrapCheckpointHandler} from '../infrastructure/v14-bootstrap-checkpoint-edge.mjs';
import {createV14BrowserWitnessStore} from '../web-src/v14-browser-witness-store.mjs';
import {nep413Payload} from '../web-src/cli-login.mjs';
import {encodeBase58} from '../web-src/native-oracle-transaction.mjs';

const webcrypto=crypto.webcrypto,scopeId='ab'.repeat(16),capability='cd'.repeat(32),site='https://bouncer-production-6df1.up.railway.app';
const passphrase='fixture-only long passphrase',originOwner='great_mujey.testnet',vault=`native.${originOwner}`;
const compressed=new Uint8Array(fs.readFileSync(new URL('../web/artifacts/v14-research.deflate',import.meta.url)));
const owner=KeyPair.fromRandom('ed25519'),temporary=KeyPair.fromRandom('ed25519');
const now=()=>1_800_000_000_000;
async function fixture(){
  const plan=await buildV14TemporaryBootstrapPlan({owner:originOwner,ownerPublicKey:String(owner.getPublicKey()),vault,
    temporaryPublicKey:String(temporary.getPublicKey()),vaultFundingYocto:String(6n*10n**24n),compressedV14:compressed,crypto:webcrypto});
  const kit=await sealV14BootstrapRecoveryKit({review:plan.review,temporaryKey:temporary,scopeId,checkpointCapability:capability,passphrase,crypto:webcrypto});
  const draft=await prepareBootstrapEnrollment({review:plan.review,kit,passphrase,compressedV14:compressed,site,crypto:webcrypto,now});
  const digest=crypto.createHash('sha256').update(nep413Payload({message:draft.message,nonce:draft.nonce,recipient:draft.recipient})).digest();
  const signature=Buffer.from(owner.sign(digest).signature).toString('base64');
  const attestation=JSON.stringify({terms:draft.terms,nonce_base64:Buffer.from(draft.nonce).toString('base64'),signature_base64:signature});
  return {plan,kit,draft,attestation};
}
function memoryRemote(initial={revision:0,head_sha256:'0'.repeat(64),events:[]}) {
  let snapshot=structuredClone(initial),lose=false;
  return {loseNext:()=>{lose=true},replaceForTest:value=>{snapshot=structuredClone(value)},
    read:async()=>structuredClone(snapshot),append:async({expected_revision,expected_head_sha256,record})=>{
    if(snapshot.revision!==expected_revision||snapshot.head_sha256!==expected_head_sha256)throw Error('CAS failed');
    snapshot={revision:expected_revision+1,head_sha256:await bootstrapSha256(webcrypto,record),events:[...snapshot.events,record]};
    if(lose){lose=false;throw Error('lost response after commit')}
    return structuredClone(snapshot);
  }};
}

test('checkpoint is default-off and rejects other origins before touching a backend',async()=>{
  let calls=0;const fetch=async()=>{calls++;throw Error('must not reach network')};
  const request=origin=>new Request('https://example.test/',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'});
  const off=createV14BootstrapCheckpointHandler({getEnv:()=>undefined,fetch,crypto:webcrypto,now});
  assert.equal((await off(request(site))).status,503);
  const on=createV14BootstrapCheckpointHandler({getEnv:key=>key==='BOUNCER_V14_BOOTSTRAP_ENABLE'?'1':undefined,fetch,crypto:webcrypto,now});
  assert.equal((await on(request('https://evil.invalid'))).status,403);assert.equal(calls,0);
});

test('recovery-only client makes no wallet request when the independent endpoint is disabled',async()=>{
  let signatures=0;
  const client=createBootstrapRecoveryReadClient({wallet:{async signMessage(){signatures++;throw Error('must not sign')}},
    owner:originOwner,ownerPublicKey:String(owner.getPublicKey()),location:{origin:site,host:new URL(site).host},isTopLevel:true,
    crypto:webcrypto,now,fetch:async()=>new Response('{"error":"unavailable"}',{status:503})});
  assert.equal(await client.enabled(),false);await assert.rejects(client.read());assert.equal(signatures,0);
  assert.throws(()=>client.exportEncrypted());client.destroy();
});

test('off-chain enrollment binds the pinned review, temporary key and encrypted kit without deploying',async()=>{
  const {plan,kit,draft,attestation}=await fixture();
  assert.match(bootstrapEnrollmentMessage(draft.terms),/does not create a vault/);
  assert.match(draft.message,/FullAccess to the new vault until deleted/);
  assert.equal((await verifyBootstrapAttestation({text:attestation,crypto:webcrypto})).terms.review_sha256,plan.review.review_sha256);
  await verifyBootstrapEnrollmentContents({terms:draft.terms,reviewText:draft.review_text,kitText:draft.sealed_kit,crypto:webcrypto});
  assert.equal(draft.sealed_kit.includes(String(temporary)),false);assert.equal(draft.sealed_kit.includes(capability),false);
  await assert.rejects(prepareBootstrapEnrollment({review:plan.review,kit,passphrase:'wrong fixture passphrase',compressedV14:compressed,site,crypto:webcrypto,now}));
  await assert.rejects(verifyBootstrapEnrollmentContents({terms:draft.terms,reviewText:draft.review_text,kitText:draft.sealed_kit+' ',crypto:webcrypto}));
  const parsed=JSON.parse(attestation);parsed.terms.site='https://bouncer-near.vercel.app';
  await assert.rejects(verifyBootstrapAttestation({text:JSON.stringify(parsed),crypto:webcrypto}));
});

test('encrypted browser and separate remote CAS must agree before each original can advance',async()=>{
  const {plan}=await fixture(),indexedDB=new IDBFactory(),reviewSha256=plan.review.review_sha256;
  const local=await createV14BrowserWitnessStore({indexedDB,crypto:webcrypto,owner:originOwner,vault,scopeId,
    journalKeyHex:await bootstrapLocalJournalKey({capability,crypto:webcrypto}),initializeBrandNew:true});
  const remote=memoryRemote(),w=createBootstrapTwoCopyWitness({scopeId,reviewSha256,localStore:local,remoteStore:remote,crypto:webcrypto,
    verifyCreateFinal:async binding=>({status:'CREATE_FINAL_AND_VAULT_KEY_VERIFIED',network:'testnet',...binding,
      final_block_hash:encodeBase58(crypto.randomBytes(32)),checked_at_ms:Date.now(),final_execution_verified:true,
      temporary_full_access_key_present:true,transaction_sent:false})});
  const createHash=encodeBase58(crypto.randomBytes(32)),deployHash=encodeBase58(crypto.randomBytes(32));
  assert.equal((await w.inspect()).next_event,'create_claim');
  assert.equal((await w.claimCreate()).revision,1);
  assert.equal((await w.retainCreateOriginal(createHash)).create_original,createHash);
  assert.equal((await w.claimDeployment()).next_event,'deploy_original');
  const last=await w.retainDeploymentOriginal(deployHash);assert.equal(last.deploy_original,deployHash);assert.equal(last.next_event,null);
  await assert.rejects(w.claimCreate());
  local.close();
});

test('a changed two-copy history during receipt verification cannot advance on the old proof',async()=>{
  const {plan}=await fixture(),reviewSha256=plan.review.review_sha256,local=memoryRemote(),remote=memoryRemote();
  const createHash=encodeBase58(crypto.randomBytes(32)),otherHash=encodeBase58(crypto.randomBytes(32));
  const verifyCreateFinal=async binding=>{
    const prior=await local.read(),changed=JSON.parse(prior.events[1]);changed.data.tx_hash=otherHash;
    const line=JSON.stringify(changed),replacement={revision:2,head_sha256:await bootstrapSha256(webcrypto,line),
      events:[prior.events[0],line]};
    // Simulate both stores being replaced or rolled back to a different valid
    // chain while verification is in flight. This is not a freshness proof.
    local.replaceForTest(replacement);remote.replaceForTest(replacement);
    return {status:'CREATE_FINAL_AND_VAULT_KEY_VERIFIED',network:'testnet',...binding,
      final_block_hash:encodeBase58(crypto.randomBytes(32)),checked_at_ms:Date.now(),final_execution_verified:true,
      temporary_full_access_key_present:true,transaction_sent:false};
  };
  const witness=createBootstrapTwoCopyWitness({scopeId,reviewSha256,localStore:local,remoteStore:remote,
    verifyCreateFinal,crypto:webcrypto});
  await witness.claimCreate();await witness.retainCreateOriginal(createHash);
  await assert.rejects(witness.claimDeployment());
  assert.equal((await local.read()).revision,2);assert.deepEqual(await local.read(),await remote.read());
  await assert.rejects(witness.claimDeployment());
});

test('a lost remote acknowledgement stops and does not permit a second prompt',async()=>{
  const {plan}=await fixture(),indexedDB=new IDBFactory(),reviewSha256=plan.review.review_sha256;
  const key=await bootstrapLocalJournalKey({capability,crypto:webcrypto});
  const local=await createV14BrowserWitnessStore({indexedDB,crypto:webcrypto,owner:originOwner,vault,scopeId,journalKeyHex:key,initializeBrandNew:true});
  const remote=memoryRemote(),w=createBootstrapTwoCopyWitness({scopeId,reviewSha256,localStore:local,remoteStore:remote,crypto:webcrypto});
  remote.loseNext();await assert.rejects(w.claimCreate());await assert.rejects(w.claimCreate());
  const retained=await remote.read();assert.equal(retained.revision,1);
  assert.equal((await inspectBootstrapOriginals({snapshot:retained,scopeId,reviewSha256,crypto:webcrypto})).next_event,'create_original');
  await assert.rejects(createV14BrowserWitnessStore({indexedDB,crypto:webcrypto,owner:originOwner,vault,scopeId,journalKeyHex:key,initializeBrandNew:true}));
  local.close();
});

test('offline recovery hides originals until the file MAC matches, rejects forged chains, and clears stale sessions',async()=>{
  const {plan,draft,attestation}=await fixture(),original=encodeBase58(crypto.randomBytes(32));
  let head='0'.repeat(64);
  const events=[];
  for(const [index,type] of ['create_claim','create_original'].entries()) {
    const event=JSON.stringify({format:'bouncer-v14-original-event-v1',seq:index+1,previous_sha256:head,type,
      data:{scope_id:scopeId,review_sha256:plan.review.review_sha256,tx_hash:index?original:null}});
    events.push(event);head=await bootstrapSha256(webcrypto,event);
  }
  const body={format:'bouncer-v14-bootstrap-recovery-export-v1',network:'testnet',owner:originOwner,vault,scope_id:scopeId,
    review_text:draft.review_text,sealed_kit:draft.sealed_kit,owner_attestation:attestation,revision:2,head_sha256:head,events,
    latest_head_independently_verified:false,transaction_authorized:false};
  const mac=crypto.createHmac('sha256',Buffer.from(capability,'hex')).update(`bouncer-v14-bootstrap-export-v1\0${JSON.stringify(body)}`).digest('hex');
  const exported=JSON.stringify({...body,history_hmac_sha256:mac});
  const location={origin:site,host:new URL(site).host};let network=0,signatures=0,valid=true;
  const client=createBootstrapRecoveryReadClient({wallet:{async signMessage(){signatures++;throw Error('offline')}},
    owner:originOwner,ownerPublicKey:String(owner.getPublicKey()),location,isTopLevel:true,crypto:webcrypto,now,isCurrent:()=>valid,
    fetch:async()=>{network++;throw Error('offline')}});
  const imported=await client.importEncrypted(exported);
  assert.equal(imported.create_original,null);assert.equal(imported.history_authentication_verified,false);
  assert.throws(()=>client.exportEncrypted());
  await assert.rejects(client.verifyPassphrase('incorrect fixture passphrase'));assert.throws(()=>client.exportEncrypted());
  const opened=await client.verifyPassphrase(passphrase);
  assert.equal(opened.create_original,original);assert.equal(opened.history_authentication_verified,true);
  assert.equal(opened.latest_head_independently_verified,false);assert.equal(opened.transaction_authorized,false);
  const saved=client.exportEncrypted();
  for(const secret of [String(temporary),capability,passphrase])assert(!saved.includes(secret));
  await assert.rejects(client.verifyPassphrase('incorrect fixture passphrase'));assert.throws(()=>client.exportEncrypted());
  await client.verifyPassphrase(passphrase);
  await assert.rejects(client.importEncrypted('{invalid'));assert.throws(()=>client.exportEncrypted());
  const altered=JSON.parse(exported),event=JSON.parse(altered.events[1]);
  event.data.tx_hash=encodeBase58(crypto.randomBytes(32));altered.events[1]=JSON.stringify(event);
  altered.head_sha256=await bootstrapSha256(webcrypto,altered.events[1]); // plausible, fully recomputed unkeyed chain
  const unverified=await client.importEncrypted(JSON.stringify(altered));
  assert.equal(unverified.create_original,null);assert.throws(()=>client.exportEncrypted());
  await assert.rejects(client.verifyPassphrase(passphrase));assert.throws(()=>client.exportEncrypted());
  await client.importEncrypted(exported);
  const pending=client.verifyPassphrase(passphrase);valid=false;await assert.rejects(pending);assert.throws(()=>client.exportEncrypted());
  assert.equal(network,0);assert.equal(signatures,0);client.destroy();
});

test('a verified saved file compares read-only snapshots without claiming freshness',async()=>{
  const {plan,draft,attestation}=await fixture(),zero='0'.repeat(64),original=encodeBase58(crypto.randomBytes(32));
  const events=[];let head=zero;
  for(const [i,type] of ['create_claim','create_original'].entries()) {
    const event=JSON.stringify({format:'bouncer-v14-original-event-v1',seq:i+1,previous_sha256:head,type,
      data:{scope_id:scopeId,review_sha256:plan.review.review_sha256,tx_hash:i?original:null}});
    events.push(event);head=await bootstrapSha256(webcrypto,event);
  }
  const snapshot0={revision:0,head_sha256:zero,events:[]},snapshot2={revision:2,head_sha256:head,events};
  const makeFile=snapshot=>{
    const body={format:'bouncer-v14-bootstrap-recovery-export-v1',network:'testnet',owner:originOwner,vault,scope_id:scopeId,
      review_text:draft.review_text,sealed_kit:draft.sealed_kit,owner_attestation:attestation,...snapshot,
      latest_head_independently_verified:false,transaction_authorized:false};
    const mac=crypto.createHmac('sha256',Buffer.from(capability,'hex')).update(`bouncer-v14-bootstrap-export-v1\0${JSON.stringify(body)}`).digest('hex');
    return JSON.stringify({...body,history_hmac_sha256:mac});
  };
  const makeRemote=snapshot=>({status:'EXISTING_RECOVERY_ONLY',scope_id:scopeId,review_text:draft.review_text,
    sealed_kit:draft.sealed_kit,owner_attestation:attestation,...snapshot,transaction_authorized:false,latest_head_independently_verified:false});
  let remote=makeRemote(snapshot2),available=true,signatures=0,posts=0;
  const wallet={manifest:{id:'meteor'},async signMessage({message,nonce,recipient,signerId,network}){
    signatures++;assert.equal(signerId,originOwner);assert.equal(network,'testnet');
    const digest=crypto.createHash('sha256').update(nep413Payload({message,nonce,recipient})).digest();
    return {accountId:originOwner,publicKey:String(owner.getPublicKey()),signature:Buffer.from(owner.sign(digest).signature).toString('base64')};
  }};
  const fetch=async(url,options={})=>{
    if(String(url)==='https://test.rpc.fastnear.com')return Response.json({jsonrpc:'2.0',id:'bouncer-cli-login',result:{permission:'FullAccess'}});
    if(options.method==='OPTIONS')return new Response(null,{status:available?204:503});
    posts++;assert.equal(options.method,'POST');assert.equal(JSON.parse(options.body).operation,'recover');
    for(const secret of [String(temporary),capability,passphrase])assert(!options.body.includes(secret));
    return Response.json(remote);
  };
  const client=createBootstrapRecoveryReadClient({wallet,owner:originOwner,ownerPublicKey:String(owner.getPublicKey()),
    location:{origin:site,host:new URL(site).host},isTopLevel:true,crypto:webcrypto,fetch,now});
  const file2=makeFile(snapshot2);await client.importEncrypted(file2);
  await assert.rejects(client.compareOnline());assert.equal(signatures,0);assert.equal(posts,0);
  await client.verifyPassphrase(passphrase);
  const match=await client.compareOnline();assert.equal(match.status,'MATCHED');assert.equal(match.file_integrity_verified,true);
  assert.equal(match.latest_head_independently_verified,false);assert.equal(match.independent_backup_verified,false);
  assert.equal(match.vault_or_receipts_checked,false);assert.equal(match.transaction_authorized,false);assert.equal(match.transaction_sent,false);
  remote=makeRemote(snapshot0);assert.equal((await client.compareOnline()).status,'FILE_AHEAD');
  const differentEvents=[...events],changed=JSON.parse(differentEvents[1]);changed.data.tx_hash=encodeBase58(crypto.randomBytes(32));
  differentEvents[1]=JSON.stringify(changed);remote=makeRemote({revision:2,head_sha256:await bootstrapSha256(webcrypto,differentEvents[1]),events:differentEvents});
  assert.equal((await client.compareOnline()).status,'DIVERGED');
  remote=makeRemote({...snapshot0,head_sha256:'1'.repeat(64)});await assert.rejects(client.compareOnline());
  assert.equal(client.exportEncrypted(),file2,'a bad online response does not replace the saved file');
  available=false;const previous=signatures;await assert.rejects(client.compareOnline());assert.equal(signatures,previous);
  available=true;remote=makeRemote(snapshot2);await client.importEncrypted(makeFile(snapshot0));await client.verifyPassphrase(passphrase);
  assert.equal((await client.compareOnline()).status,'ONLINE_AHEAD');
  assert.equal(signatures,posts,'the disabled check made no wallet request; every prompt was a read-only POST');
  client.destroy();
});

// PGlite is installed separately only for disposable schema tests; the
// standard suite does not require or download it.
if(process.env.BOUNCER_PGLITE_MODULE) {
  test('disposable PostgreSQL checkpoint atomically binds enrollment and append-only originals',async()=>{
    const {PGlite}=await import(process.env.BOUNCER_PGLITE_MODULE),db=new PGlite();
    try {
      await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;');
      await db.exec(fs.readFileSync(new URL('../infrastructure/v14-bootstrap-checkpoint.sql',import.meta.url),'utf8'));
      const {plan,kit,draft,attestation}=await fixture(),terms=draft.terms;
      const attHash=await bootstrapSha256(webcrypto,attestation),args=[scopeId,terms.capability_sha256,terms.owner,terms.vault,
        terms.owner_public_key,terms.temporary_public_key,terms.review_sha256,draft.review_text,terms.kit_sha256,draft.sealed_kit,attHash,attestation];
      const enrolled=await db.query('SELECT public.bouncer_v14_bootstrap_enroll_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) AS value',args);
      assert.equal(enrolled.rows[0].value.status,'ENROLLED');
      assert.equal((await db.query('SELECT public.bouncer_v14_bootstrap_enroll_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) AS value',args)).rows[0].value.status,'EXISTING');
      const collision=[...args];collision[0]='ef'.repeat(16);
      assert.deepEqual((await db.query('SELECT public.bouncer_v14_bootstrap_enroll_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) AS value',collision)).rows[0].value,{error:'unavailable'});
      let head='0'.repeat(64),events=[];
      for(const [i,type] of ['create_claim','create_original','deploy_claim','deploy_original'].entries()){
        const original=i%2===0?null:encodeBase58(crypto.randomBytes(32));
        const record=JSON.stringify({format:'bouncer-v14-original-event-v1',seq:i+1,previous_sha256:head,type,
          data:{scope_id:scopeId,review_sha256:plan.review.review_sha256,tx_hash:original}});
        const call=[scopeId,terms.capability_sha256,'append',i,head,record];
        const r=(await db.query('SELECT public.bouncer_v14_bootstrap_events_v1($1,$2,$3,$4,$5,$6) AS value',call)).rows[0].value;
        assert.equal(r.status,'APPENDED');assert.equal(r.revision,i+1);events.push(record);head=await bootstrapSha256(webcrypto,record);
        assert.equal(r.head_sha256,head);assert.deepEqual(r.events,events);
        const replay=(await db.query('SELECT public.bouncer_v14_bootstrap_events_v1($1,$2,$3,$4,$5,$6) AS value',call)).rows[0].value;
        assert.deepEqual(replay,{error:'unavailable'});
      }
      const recovered=(await db.query('SELECT public.bouncer_v14_bootstrap_owner_read_v1($1,$2) AS value',[originOwner,vault])).rows[0].value;
      assert.equal(recovered.sealed_kit,JSON.stringify(kit));assert.equal(recovered.head_sha256,head);assert.deepEqual(recovered.events,events);
      await assert.rejects(db.exec("DELETE FROM bouncer_v14_bootstrap_v1.events"));
      await db.exec('SET ROLE anon');
      await assert.rejects(db.query('SELECT public.bouncer_v14_bootstrap_owner_read_v1($1,$2)',[originOwner,vault]));
      await db.exec('RESET ROLE');await db.exec('SET ROLE service_role');
      await assert.rejects(db.query('SELECT * FROM bouncer_v14_bootstrap_v1.streams'));
      assert.equal((await db.query('SELECT public.bouncer_v14_bootstrap_owner_read_v1($1,$2) AS value',[originOwner,vault])).rows[0].value.status,'EXISTING');
      await db.exec('RESET ROLE');
    } finally {await db.close()}
  });
}

if(process.env.BOUNCER_PGLITE_MODULE) {
  test('owner-signed browser/edge/database recovery round trip remains read-only and preserves originals',async()=>{
    const {PGlite}=await import(process.env.BOUNCER_PGLITE_MODULE),db=new PGlite();
    try {
      await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;');
      await db.exec(fs.readFileSync(new URL('../infrastructure/v14-bootstrap-checkpoint.sql',import.meta.url),'utf8'));
      const {plan,kit}=await fixture(),blockHash=encodeBase58(crypto.randomBytes(32));
      const location={origin:site,host:new URL(site).host};let permission='FullAccess',seenCapabilityInDb=false;
      const fieldMap={
        bouncer_v14_bootstrap_enroll_v1:['p_scope_id','p_capability_hash','p_owner_id','p_vault_id','p_owner_public_key',
          'p_temporary_public_key','p_review_sha256','p_review_text','p_kit_sha256','p_sealed_kit','p_attestation_sha256','p_owner_attestation'],
        bouncer_v14_bootstrap_events_v1:['p_scope_id','p_capability_hash','p_operation','p_expected_revision','p_expected_head_sha256','p_record'],
        bouncer_v14_bootstrap_owner_read_v1:['p_owner_id','p_vault_id'],
      };
      const backendFetch=async(url,opts)=>{
        const address=String(url),body=JSON.parse(opts.body);
        if(address==='https://test.rpc.fastnear.com'){
          let result;
          if(body.method==='status')result={chain_id:'testnet'};
          else if(body.method==='block')result={header:{hash:blockHash,timestamp_nanosec:String(BigInt(now())*1_000_000n)}};
          else if(body.method==='query')result={block_hash:blockHash,permission};
          else throw Error('unexpected RPC');
          return Response.json({jsonrpc:'2.0',id:body.id,result});
        }
        const name=address.split('/').at(-1),fields=fieldMap[name];if(!fields)throw Error('unexpected database route');
        if(JSON.stringify(body).includes(capability)||JSON.stringify(body).includes(String(temporary))||JSON.stringify(body).includes(passphrase))seenCapabilityInDb=true;
        const query=`SELECT public.${name}(${fields.map((_,i)=>`$${i+1}`).join(',')}) AS value`;
        try{return Response.json((await db.query(query,fields.map(key=>body[key]??null))).rows[0].value)}catch{return new Response(null,{status:500})}
      };
      const env={BOUNCER_V14_BOOTSTRAP_ENABLE:'1',SUPABASE_URL:'https://jiouaqwxkvlkmvyumzwc.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test-service-only'};
      const makeHandler=process.env.BOUNCER_EDGE_BUNDLE
        ? (await import(process.env.BOUNCER_EDGE_BUNDLE)).createV14BootstrapCheckpointHandler : createV14BootstrapCheckpointHandler;
      const handler=makeHandler({getEnv:key=>env[key],fetch:backendFetch,crypto:webcrypto,now});
      let publishMarked=false,signed,earlyRemote=null,overrideRemote=null,signatures=0;
      const browserFetch=async(url,opts)=>{
        let operation;
        if(opts.method==='POST'&&opts.body) {
          const parsed=JSON.parse(opts.body);operation=parsed.operation;
          const {operation:ignored,...rest}=parsed;
          if(operation==='enroll'&&!signed){assert.equal(publishMarked,true);signed=rest;}
          if(operation==='recover')for(const secret of [String(temporary),capability,passphrase])assert(!opts.body.includes(secret));
        }
        const headers=new Headers(opts.headers);headers.set('origin',site);
        const response=await handler(new Request(url,{...opts,headers}));
        if(operation==='recover'&&response.ok) {
          if(overrideRemote)return Response.json(overrideRemote);
          if(!earlyRemote)earlyRemote=await response.clone().json();
        }
        return response;
      };
      const wallet={manifest:{id:'meteor'},async signMessage({message,nonce,recipient}){
        signatures++;
        const hash=crypto.createHash('sha256').update(nep413Payload({message,nonce,recipient})).digest();
        return {accountId:originOwner,publicKey:String(owner.getPublicKey()),signature:Buffer.from(owner.sign(hash).signature).toString('base64')};
      }};
      const combinedFetch=(url,opts)=>String(url).startsWith('https://jiouaqwxkvlkmvyumzwc.supabase.co/functions/')
        ? browserFetch(url,opts):backendFetch(url,opts);
      const text=JSON.stringify({format:'bouncer-v14-local-bootstrap-candidate-v1',network:'testnet',review:plan.review,sealed_kit:kit});
      const expectedFingerprint=crypto.createHash('sha256').update(`bouncer-v14-local-bootstrap-candidate-file-v1\0${text}`).digest('hex');
      const enrollmentClient=createBootstrapCandidateEnrollmentClient({wallet,owner:originOwner,ownerPublicKey:String(owner.getPublicKey()),
        location,isTopLevel:true,crypto:webcrypto,fetch:combinedFetch,now});
      const enrollment=await enrollmentClient.enroll({text,expectedFingerprint,passphrase,compressedV14:compressed,
        beforePublish:async()=>{publishMarked=true;return true}});
      assert.equal(enrollment.status,'ENROLLED');assert.equal(enrollment.independent_backup_verified,false);
      assert.equal(enrollment.transaction_authorized,false);assert.ok(signed);enrollmentClient.destroy();
      assert.equal((await enrollBootstrapCheckpoint({signed,location,crypto:webcrypto,fetch:browserFetch,now})).status,'EXISTING');
      const makeReader=()=>createBootstrapRecoveryReadClient({wallet,owner:originOwner,ownerPublicKey:String(owner.getPublicKey()),
        location,isTopLevel:true,crypto:webcrypto,fetch:combinedFetch,now});
      const earlyReader=makeReader();await earlyReader.read();await earlyReader.verifyPassphrase(passphrase);
      const earlyFile=earlyReader.exportEncrypted();earlyReader.destroy();
      assert.equal(earlyRemote.revision,0);
      const local=await createV14BrowserWitnessStore({indexedDB:new IDBFactory(),crypto:webcrypto,owner:originOwner,vault,scopeId,
        journalKeyHex:await bootstrapLocalJournalKey({capability,crypto:webcrypto}),initializeBrandNew:true});
      const remote=createBootstrapRemoteStore({location,scopeId,capability,reviewSha256:plan.review.review_sha256,crypto:webcrypto,fetch:browserFetch});
      const witness=createBootstrapTwoCopyWitness({scopeId,reviewSha256:plan.review.review_sha256,localStore:local,remoteStore:remote,crypto:webcrypto});
      await witness.claimCreate();const original=encodeBase58(crypto.randomBytes(32));await witness.retainCreateOriginal(original);
      await assert.rejects(witness.claimDeployment()); // no trusted real receipt verifier is wired
      const recoveryDraft=prepareBootstrapRecovery({owner:originOwner,ownerPublicKey:String(owner.getPublicKey()),vault,site,crypto:webcrypto,now});
      const recoverySigned=await signBootstrapRecovery({draft:recoveryDraft,wallet,location,crypto:webcrypto,fetch:backendFetch,now});
      const recovered=await recoverBootstrapCheckpoint({signed:recoverySigned,location,crypto:webcrypto,fetch:browserFetch,now});
      assert.equal(recovered.revision,2);assert.equal(recovered.latest_head_independently_verified,false);
      assert.equal(recovered.transaction_authorized,false);assert.equal(JSON.parse(recovered.events[1]).data.tx_hash,original);
      const opened=await openV14BootstrapRecoveryKit({kit:JSON.parse(recovered.sealed_kit),expected:{owner:originOwner,vault,
        ownerPublicKey:String(owner.getPublicKey()),temporaryPublicKey:String(temporary.getPublicKey()),
        reviewSha256:plan.review.review_sha256,scopeId},passphrase,crypto:webcrypto});
      await opened.useSecrets(({temporaryKey,checkpointCapability})=>{
        assert.equal(String(temporaryKey.getPublicKey()),String(temporary.getPublicKey()));assert.equal(checkpointCapability,capability);
      });opened.dispose();
      const client=createBootstrapRecoveryReadClient({wallet,owner:originOwner,ownerPublicKey:String(owner.getPublicKey()),
        location,isTopLevel:true,crypto:webcrypto,fetch:combinedFetch,now});
      assert.equal(await client.enabled(),true);
      const view=await client.read();assert.equal(view.create_original,null);assert.equal(view.transaction_authorized,false);
      assert.equal(view.latest_head_independently_verified,false);
      assert.throws(()=>client.exportEncrypted());
      await assert.rejects(client.verifyPassphrase('wrong fixture passphrase'));
      const unlocked=await client.verifyPassphrase(passphrase);
      assert.equal(unlocked.status,'KIT_UNLOCKED_LOCALLY_NOT_AUTHORIZED');assert.equal(unlocked.create_original,original);
      assert.equal(unlocked.history_authentication_verified,false,'an online hash chain has no previous MAC to check');
      const exported=client.exportEncrypted();assert.equal(exported.includes(String(temporary)),false);
      assert.equal(exported.includes(capability),false);assert.equal(exported.includes(passphrase),false);
      client.destroy();assert.throws(()=>client.exportEncrypted());
      const compare=makeReader();await compare.importEncrypted(exported);
      const beforeCompare=signatures;await assert.rejects(compare.compareOnline());assert.equal(signatures,beforeCompare,'locked files cannot prompt');
      await compare.verifyPassphrase(passphrase);
      const matching=await compare.compareOnline();
      assert.equal(matching.status,'MATCHED');assert.equal(matching.file_integrity_verified,true);
      assert.equal(matching.independent_backup_verified,false);assert.equal(matching.latest_head_independently_verified,false);
      assert.equal(matching.vault_or_receipts_checked,false);assert.equal(matching.transaction_authorized,false);assert.equal(matching.transaction_sent,false);
      overrideRemote=earlyRemote;
      assert.equal((await compare.compareOnline()).status,'FILE_AHEAD','a rolled-back service cannot match a newer file');
      const divergent=structuredClone(recovered),changed=JSON.parse(divergent.events[1]);
      changed.data.tx_hash=encodeBase58(crypto.randomBytes(32));divergent.events[1]=JSON.stringify(changed);
      divergent.head_sha256=await bootstrapSha256(webcrypto,divergent.events[1]);overrideRemote=divergent;
      assert.equal((await compare.compareOnline()).status,'DIVERGED');
      const alternateScope='ef'.repeat(16),alternateKit=await sealV14BootstrapRecoveryKit({review:plan.review,temporaryKey:temporary,
        scopeId:alternateScope,checkpointCapability:'12'.repeat(32),passphrase,crypto:webcrypto});
      const alternateDraft=await prepareBootstrapEnrollment({review:plan.review,kit:alternateKit,passphrase,compressedV14:compressed,site,crypto:webcrypto,now});
      const alternateHash=crypto.createHash('sha256').update(nep413Payload({message:alternateDraft.message,
        nonce:alternateDraft.nonce,recipient:alternateDraft.recipient})).digest();
      const alternateAttestation=JSON.stringify({terms:alternateDraft.terms,nonce_base64:Buffer.from(alternateDraft.nonce).toString('base64'),
        signature_base64:Buffer.from(owner.sign(alternateHash).signature).toString('base64')});
      overrideRemote={...earlyRemote,scope_id:alternateScope,review_text:alternateDraft.review_text,sealed_kit:alternateDraft.sealed_kit,
        owner_attestation:alternateAttestation};
      assert.equal((await compare.compareOnline()).status,'DIFFERENT_SETUP');
      overrideRemote={...earlyRemote,head_sha256:'1'.repeat(64)};
      await assert.rejects(compare.compareOnline());assert.equal(compare.exportEncrypted(),exported,'a failed comparison keeps the authenticated file');
      overrideRemote=null;
      const earlyCompare=makeReader();await earlyCompare.importEncrypted(earlyFile);await earlyCompare.verifyPassphrase(passphrase);
      assert.equal((await earlyCompare.compareOnline()).status,'ONLINE_AHEAD');
      earlyCompare.destroy();compare.destroy();
      let offlineNetworkCalls=0,offlineSignatures=0;
      const offline=createBootstrapRecoveryReadClient({wallet:{async signMessage(){offlineSignatures++;throw Error('offline')}},
        owner:originOwner,ownerPublicKey:String(owner.getPublicKey()),location,isTopLevel:true,crypto:webcrypto,now,
        fetch:async()=>{offlineNetworkCalls++;throw Error('offline')}});
      const offlineView=await offline.importEncrypted(exported);
      assert.equal(offlineView.create_original,null);assert.equal(offlineView.latest_head_independently_verified,false);
      const checked=await offline.verifyPassphrase(passphrase);
      assert.equal(checked.transaction_authorized,false);assert.equal(checked.create_original,original);
      assert.equal(checked.history_authentication_verified,true);
      assert.equal(offlineNetworkCalls,0);assert.equal(offlineSignatures,0);
      const altered=JSON.parse(exported);altered.head_sha256='1'.repeat(64);
      await assert.rejects(offline.importEncrypted(JSON.stringify(altered)));
      const badMac=JSON.parse(exported);badMac.history_hmac_sha256='1'.repeat(64);
      await offline.importEncrypted(JSON.stringify(badMac));assert.throws(()=>offline.exportEncrypted());
      await assert.rejects(offline.verifyPassphrase(passphrase));
      offline.destroy();
      permission={FunctionCall:{receiver_id:vault,method_names:[]}};
      await assert.rejects(recoverBootstrapCheckpoint({signed:recoverySigned,location,crypto:webcrypto,fetch:browserFetch,now}));
      assert.equal(seenCapabilityInDb,false);local.close();
    } finally {await db.close()}
  });
}
