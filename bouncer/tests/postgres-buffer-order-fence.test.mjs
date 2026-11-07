import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import nearApi from 'near-api-js';
import {nep413Payload} from '../web-src/cli-login.mjs';
import {createPrivateOrderKey,preparePrivateOrderDraft,sealPrivateOrder,inspectPrivateOrderKeyRecord} from '../web-src/buffer-private-order-capsule.mjs';
import {initializePostgresBufferOrderFence,createPostgresBufferOrderFence} from '../agent/postgres-buffer-order-fence.mjs';
import {wasm as v12, fixture as setupFixture, hash as setupHash} from './buffer-wallet-setup-fixture.mjs';
const url=process.env.BOUNCER_TEST_POSTGRES_URL;
if(process.env.BOUNCER_REQUIRE_POSTGRES_TESTS==='1' && !url) throw Error('PostgreSQL integration test URL required');
const dbtest=url ? test : test.skip;
const artifactDbtest=url && v12 ? test : test.skip;
const site='https://site.example.test', location={origin:site,host:'site.example.test'};
async function fixture() {
  const owner=`order-${crypto.randomBytes(6).toString('hex')}.testnet`, pair=nearApi.KeyPair.fromRandom('ed25519'),ownerPublicKey=String(pair.getPublicKey());
  const wallet={async signMessage(params) {
    const digest=crypto.createHash('sha256').update(nep413Payload(params)).digest();
    return {accountId:owner,publicKey:ownerPublicKey,signature:Buffer.from(pair.sign(digest).signature).toString('base64')};
  }};
  const fetch=async()=>new Response(JSON.stringify({jsonrpc:'2.0',id:'bouncer-cli-login',result:{permission:'FullAccess'}}));
  const keyRecord=await createPrivateOrderKey({wallet,owner,ownerPublicKey,location,crypto:crypto.webcrypto,fetch});
  const attemptId=crypto.randomBytes(16).toString('hex'), brief='Sensitive synthetic research request, never a real order.';
  const draft=await preparePrivateOrderDraft({keyRecord,attemptId,crypto:crypto.webcrypto,
    request:{brief,sku:'weekly-market-brief',customerAccount:`forward.${owner}`}});
  const {key_record_sha256}=await inspectPrivateOrderKeyRecord({keyRecord,crypto:crypto.webcrypto});
  const identity={owner,owner_public_key:ownerPublicKey,attempt_id:attemptId,site,key_sha256:keyRecord.public_key_sha256,key_record_sha256,
    review_sha256:'a'.repeat(64),request_commitment_sha256:draft.request_commitment_sha256,draft_sha256:draft.draft_sha256};
  const order={brief,sku:'weekly-market-brief',orderId:'01234567-89ab-cdef-0123-456789abcdef',onchainOrderId:'o-123456abcdef',accessToken:'ab'.repeat(24)};
  const capsule=await sealPrivateOrder({keyRecord,attemptId,privateOrder:order,crypto:crypto.webcrypto});
  return {owner,keyRecord,draft,identity,capsule,order,wallet,fetch};
}
function auth({evidence}) {return evidence==='synthetic-auth';}

dbtest('durable private order journal atomically fences concurrency and encrypts persisted data',async()=>{
  const pool=new pg.Pool({connectionString:url,max:10});
  try {
    await initializePostgresBufferOrderFence({pool}); const f=await fixture();
    const fence=createPostgresBufferOrderFence({pool,authenticate:auth,crypto:crypto.webcrypto});
    const reserve={identity:f.identity,keyRecord:f.keyRecord,draftCapsule:f.draft.capsule,evidence:'synthetic-auth'};
    await assert.rejects(fence.reserve({...reserve,evidence:'bad'}),e=>e.code==='UNAUTHENTICATED');
    const changed=Buffer.from(f.keyRecord.wrapped_private,'base64'); changed[10]^=1;
    await assert.rejects(fence.reserve({...reserve,keyRecord:{...f.keyRecord,wrapped_private:changed.toString('base64')}}),e=>e.code==='INVALID_ATTEMPT');
    await fence.reserve(reserve); await assert.rejects(fence.reserve(reserve),e=>e.code==='ALREADY_RESERVED');
    const outcomes=await Promise.allSettled(Array.from({length:5},()=>fence.claim({identity:f.identity,evidence:'synthetic-auth'})));
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
    assert.equal((await fence.inspect({identity:f.identity,evidence:'synthetic-auth'})).state,'claimed');
    const saved=await pool.query('SELECT * FROM bouncer_buffer_order_v1.orders WHERE owner=$1',[f.owner]);
    assert.ok(!JSON.stringify(saved.rows[0]).includes(f.order.brief)); assert.ok(!JSON.stringify(saved.rows[0]).includes(f.order.accessToken));
    await assert.rejects(pool.query('DELETE FROM bouncer_buffer_order_v1.orders WHERE owner=$1',[f.owner]));
    await assert.rejects(pool.query("UPDATE bouncer_buffer_order_v1.orders SET state='reserved' WHERE owner=$1",[f.owner]));
    const record={identity:f.identity,keyRecord:f.keyRecord,capsule:f.capsule,evidence:'synthetic-auth'};
    const first=await fence.record(record), same=await fence.record(record);
    assert.equal(first.state,'sealed'); assert.equal(first.capsule_sha256,same.capsule_sha256);
    await assert.rejects(fence.claim({identity:f.identity,evidence:'synthetic-auth'}),e=>e.code==='NOT_CLAIMABLE');
    const replacement=await sealPrivateOrder({keyRecord:f.keyRecord,attemptId:f.identity.attempt_id,privateOrder:f.order,crypto:crypto.webcrypto});
    await assert.rejects(fence.record({...record,capsule:replacement}),e=>e.code==='NOT_CLAIMABLE');
    assert.equal((await fence.inspect({identity:f.identity,evidence:'synthetic-auth'})).state,'sealed');
  } finally { await pool.end(); }
});

dbtest('a lost database COMMIT acknowledgement leaves the claim consumed',async()=>{
  const pool=new pg.Pool({connectionString:url,max:5});
  try {
    await initializePostgresBufferOrderFence({pool}); const f=await fixture();
    const safe=createPostgresBufferOrderFence({pool,authenticate:auth,crypto:crypto.webcrypto});
    await safe.reserve({identity:f.identity,keyRecord:f.keyRecord,draftCapsule:f.draft.capsule,evidence:'synthetic-auth'});
    let lose=true;
    const flaky={async connect(){const client=await pool.connect();return {async query(...args){
      const result=await client.query(...args); if(lose && args[0]==='COMMIT'){lose=false;throw Error('synthetic lost commit ack');} return result;
    },release:destroy=>client.release(destroy)}}};
    const fence=createPostgresBufferOrderFence({pool:flaky,authenticate:auth,crypto:crypto.webcrypto});
    await assert.rejects(fence.claim({identity:f.identity,evidence:'synthetic-auth'}),e=>e.code==='DATABASE_UNKNOWN');
    assert.equal((await safe.inspect({identity:f.identity,evidence:'synthetic-auth'})).state,'claimed');
    await assert.rejects(safe.claim({identity:f.identity,evidence:'synthetic-auth'}),e=>e.code==='NOT_CLAIMABLE');
  } finally {await pool.end();}
});

dbtest('disabled database guard blocks journal operations',async()=>{
  const pool=new pg.Pool({connectionString:url,max:5});
  try {
    await initializePostgresBufferOrderFence({pool}); const f=await fixture();
    const fence=createPostgresBufferOrderFence({pool,authenticate:auth,crypto:crypto.webcrypto});
    await pool.query('ALTER TABLE bouncer_buffer_order_v1.orders DISABLE TRIGGER orders_guard');
    try { await assert.rejects(fence.reserve({identity:f.identity,keyRecord:f.keyRecord,draftCapsule:f.draft.capsule,evidence:'synthetic-auth'}),e=>e.code==='UNSAFE_SCHEMA'); }
    finally { await pool.query('ALTER TABLE bouncer_buffer_order_v1.orders ENABLE TRIGGER orders_guard'); }
  } finally {await pool.end();}
});

dbtest('PostgreSQL and independent local Git witness reconcile a sealed synthetic order without a seller POST',async()=>{
  const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path'),{execFileSync}=await import('node:child_process');
  const {createGitBufferOrderWitnessStore}=await import('../agent/git-branch-witness-store.mjs');
  const {createBufferOrderWitness}=await import('../agent/git-buffer-order-witness.mjs');
  const {createWitnessedBufferOrderJournal}=await import('../agent/witnessed-buffer-order-journal.mjs');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-private-order-')),bare=path.join(dir,'remote.git'),work=path.join(dir,'work'),branch='arena/0ee9ab70-near-hub';
  const git=(cwd,args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const pool=new pg.Pool({connectionString:url,max:5});
  try {
    fs.mkdirSync(work);git(dir,['init','--bare','--initial-branch',branch,bare]);git(work,['init','--initial-branch',branch]);
    git(work,['config','user.email','synthetic@example.test']);git(work,['config','user.name','Synthetic test']);
    git(work,['remote','add','origin',bare]);fs.writeFileSync(path.join(work,'README.md'),'Synthetic only\n');
    git(work,['add','README.md']);git(work,['commit','-m','Initial']);git(work,['push','origin',branch]);
    const initialHead=git(work,['rev-parse','HEAD']); await initializePostgresBufferOrderFence({pool}); const f=await fixture();
    const fence=createPostgresBufferOrderFence({pool,authenticate:auth,crypto:crypto.webcrypto});
    const witness=createBufferOrderWitness({store:createGitBufferOrderWitnessStore({repo:work,branch,initialHead})});
    const journal=createWitnessedBufferOrderJournal({fence,witness});
    await journal.reserve({identity:f.identity,keyRecord:f.keyRecord,draftCapsule:f.draft.capsule,evidence:'synthetic-auth'});
    assert.equal((await journal.inspect({identity:f.identity,evidence:'synthetic-auth'})).status,'RESERVED');
    await journal.claim({identity:f.identity,evidence:'synthetic-auth'});
    await assert.rejects(journal.claim({identity:f.identity,evidence:'synthetic-auth'}));
    const first=await journal.record({identity:f.identity,keyRecord:f.keyRecord,capsule:f.capsule,evidence:'synthetic-auth'});
    const second=await journal.record({identity:f.identity,keyRecord:f.keyRecord,capsule:f.capsule,evidence:'synthetic-auth'});
    assert.equal(first.capsule_sha256,second.capsule_sha256);assert.equal(first.delivered,false);
    const state=await journal.inspect({identity:f.identity,evidence:'synthetic-auth'});
    assert.equal(state.status,'SEALED');assert.equal(state.seller_post_authorized,false);
    const log=git(work,['log','--oneline']); assert.equal(log.split('\n').length,4);
    const publicTree=git(work,['ls-tree','-r','--name-only','HEAD']);
    assert.ok(publicTree.includes('buffer-order-witness-v1')); assert.ok(!publicTree.includes(f.order.brief));
  } finally {await pool.end();fs.rmSync(dir,{recursive:true,force:true});}
});

dbtest('lost independent witness claim acknowledgement leaves the seller attempt permanently non-retryable',async()=>{
  const {createBufferOrderWitness}=await import('../agent/git-buffer-order-witness.mjs');
  const {createWitnessedBufferOrderJournal}=await import('../agent/witnessed-buffer-order-journal.mjs');
  const pool=new pg.Pool({connectionString:url,max:5});
  try {
    await initializePostgresBufferOrderFence({pool});const f=await fixture();let text='',head='0',lose=false;
    const store={async read(){return {text,head}},async append(input){if(input.expectedHead!==head || input.expectedText!==text)throw Error();
      text=input.text;head=String(+head+1);if(lose)throw Error('lost witness ack');return {head,confirmed:true}}};
    const witness=createBufferOrderWitness({store}),fence=createPostgresBufferOrderFence({pool,authenticate:auth,crypto:crypto.webcrypto});
    const journal=createWitnessedBufferOrderJournal({fence,witness});
    await journal.reserve({identity:f.identity,keyRecord:f.keyRecord,draftCapsule:f.draft.capsule,evidence:'synthetic-auth'});
    lose=true;await assert.rejects(journal.claim({identity:f.identity,evidence:'synthetic-auth'}));lose=false;
    assert.equal((await journal.inspect({identity:f.identity,evidence:'synthetic-auth'})).status,'CLAIMED');
    await assert.rejects(journal.claim({identity:f.identity,evidence:'synthetic-auth'}));
  } finally {await pool.end();}
});

dbtest('NEP-413 single-use challenges bind owner, encrypted draft, claim and exact sealed capsule',async()=>{
  const {createPostgresWalletPromptAuth,initializePostgresWalletPromptAuth}=await import('../agent/postgres-wallet-prompt-auth.mjs');
  const {createBufferOrderAuthenticator}=await import('../agent/buffer-order-auth.mjs');
  const {signReviewedBufferOrderChallenge}=await import('../web-src/witnessed-buffer-order-auth.mjs');
  const {privateOrderCapsuleCommitment}=await import('../web-src/buffer-private-order-capsule.mjs');
  const {firstSetupPreflightFixture}=await import('./fixtures/wallet-setup-preflight-provider.mjs');
  const pool=new pg.Pool({connectionString:url,max:6});
  try {
    await initializePostgresWalletPromptAuth({pool}); await initializePostgresBufferOrderFence({pool}); const f=await fixture();
    const {provider}=firstSetupPreflightFixture({owner:f.owner,ownerKey:f.identity.owner_public_key});
    const baseAuth=createPostgresWalletPromptAuth({pool,origin:site,provider}),orderAuth=createBufferOrderAuthenticator({auth:baseAuth});
    const fence=createPostgresBufferOrderFence({pool,authenticate:orderAuth.authenticate,crypto:crypto.webcrypto});
    // fixture's wallet is deliberately synthetic; it produces only off-chain messages.
    const signed=async (purpose,capsuleSha256) => {
      const context={purpose,identity:f.identity,...(purpose==='record'?{capsuleSha256}:{})};
      const challenge=await orderAuth.issue(context);
      return signReviewedBufferOrderChallenge({wallet:f.wallet,context,challenge,location,crypto:crypto.webcrypto,fetch:f.fetch});
    };
    const reserveEvidence=await signed('reserve');
    const reserve={identity:f.identity,keyRecord:f.keyRecord,draftCapsule:f.draft.capsule,evidence:reserveEvidence};
    await fence.reserve(reserve);
    await assert.rejects(fence.reserve(reserve),e=>e.code==='UNAUTHENTICATED');
    const claimEvidence=await signed('claim'); await fence.claim({identity:f.identity,evidence:claimEvidence});
    await assert.rejects(fence.claim({identity:f.identity,evidence:claimEvidence}),e=>e.code==='UNAUTHENTICATED');
    const digest=await privateOrderCapsuleCommitment({capsule:f.capsule,crypto:crypto.webcrypto});
    const recordEvidence=await signed('record',digest);
    const forged=await sealPrivateOrder({keyRecord:f.keyRecord,attemptId:f.identity.attempt_id,privateOrder:f.order,crypto:crypto.webcrypto});
    await assert.rejects(fence.record({identity:f.identity,keyRecord:f.keyRecord,capsule:forged,evidence:recordEvidence}),e=>e.code==='UNAUTHENTICATED');
    const recorded=await fence.record({identity:f.identity,keyRecord:f.keyRecord,capsule:f.capsule,evidence:recordEvidence});
    assert.equal(recorded.capsule_sha256,digest);
    await assert.rejects(fence.record({identity:f.identity,keyRecord:f.keyRecord,capsule:f.capsule,evidence:recordEvidence}),e=>e.code==='UNAUTHENTICATED');
    const inspectEvidence=await signed('inspect');
    assert.equal((await fence.inspect({identity:f.identity,evidence:inspectEvidence})).state,'sealed');
  } finally {await pool.end();}
});

dbtest('owner-signed order journal and real local Git witness complete without a wallet transaction',async()=>{
  const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path'),{execFileSync}=await import('node:child_process');
  const {createPostgresWalletPromptAuth,initializePostgresWalletPromptAuth}=await import('../agent/postgres-wallet-prompt-auth.mjs');
  const {createBufferOrderAuthenticator}=await import('../agent/buffer-order-auth.mjs');
  const {signReviewedBufferOrderChallenge}=await import('../web-src/witnessed-buffer-order-auth.mjs');
  const {privateOrderCapsuleCommitment}=await import('../web-src/buffer-private-order-capsule.mjs');
  const {firstSetupPreflightFixture}=await import('./fixtures/wallet-setup-preflight-provider.mjs');
  const {createGitBufferOrderWitnessStore}=await import('../agent/git-branch-witness-store.mjs');
  const {createBufferOrderWitness}=await import('../agent/git-buffer-order-witness.mjs');
  const {createWitnessedBufferOrderJournal}=await import('../agent/witnessed-buffer-order-journal.mjs');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-order-auth-')),bare=path.join(dir,'remote.git'),work=path.join(dir,'work'),branch='arena/0ee9ab70-near-hub';
  const git=(cwd,args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const pool=new pg.Pool({connectionString:url,max:5});
  try {
    fs.mkdirSync(work);git(dir,['init','--bare','--initial-branch',branch,bare]);git(work,['init','--initial-branch',branch]);
    git(work,['config','user.email','synthetic@example.test']);git(work,['config','user.name','Synthetic test']);
    git(work,['remote','add','origin',bare]);fs.writeFileSync(path.join(work,'README.md'),'Synthetic only\n');
    git(work,['add','README.md']);git(work,['commit','-m','Initial']);git(work,['push','origin',branch]);
    const initialHead=git(work,['rev-parse','HEAD']);await initializePostgresWalletPromptAuth({pool});await initializePostgresBufferOrderFence({pool});
    const f=await fixture(),{provider}=firstSetupPreflightFixture({owner:f.owner,ownerKey:f.identity.owner_public_key});
    const orderAuth=createBufferOrderAuthenticator({auth:createPostgresWalletPromptAuth({pool,origin:site,provider})});
    const fence=createPostgresBufferOrderFence({pool,authenticate:orderAuth.authenticate,crypto:crypto.webcrypto});
    const witness=createBufferOrderWitness({store:createGitBufferOrderWitnessStore({repo:work,branch,initialHead})});
    const journal=createWitnessedBufferOrderJournal({fence,witness});
    const signed=async (purpose,capsuleSha256)=>{
      const context={purpose,identity:f.identity,...(purpose==='record'?{capsuleSha256}:{})};
      return signReviewedBufferOrderChallenge({wallet:f.wallet,context,challenge:await orderAuth.issue(context),location,
        crypto:crypto.webcrypto,fetch:f.fetch});
    };
    await journal.reserve({identity:f.identity,keyRecord:f.keyRecord,draftCapsule:f.draft.capsule,evidence:await signed('reserve')});
    await journal.claim({identity:f.identity,evidence:await signed('claim')});
    const digest=await privateOrderCapsuleCommitment({capsule:f.capsule,crypto:crypto.webcrypto});
    await journal.record({identity:f.identity,keyRecord:f.keyRecord,capsule:f.capsule,evidence:await signed('record',digest)});
    const inspected=await journal.inspect({identity:f.identity,evidence:await signed('inspect')});
    assert.equal(inspected.status,'SEALED'); assert.equal(inspected.capsule_sha256,digest);
    assert.equal(inspected.seller_post_authorized,false); assert.equal(inspected.delivered,false);
  } finally {await pool.end();fs.rmSync(dir,{recursive:true,force:true});}
});

artifactDbtest('one synthetic seller POST is encrypted and witnessed after owner authentication and real preflight checks',async()=>{
  const {createPostgresWalletPromptAuth,initializePostgresWalletPromptAuth}=await import('../agent/postgres-wallet-prompt-auth.mjs');
  const {createBufferOrderAuthenticator}=await import('../agent/buffer-order-auth.mjs');
  const {signReviewedBufferOrderChallenge}=await import('../web-src/witnessed-buffer-order-auth.mjs');
  const {openPrivateOrderDraft,openPrivateOrder}=await import('../web-src/buffer-private-order-capsule.mjs');
  const {firstSetupPreflightFixture,setSyntheticSetupStage}=await import('./fixtures/wallet-setup-preflight-provider.mjs');
  const {createBufferOrderWitness}=await import('../agent/git-buffer-order-witness.mjs');
  const {createWitnessedBufferOrderJournal}=await import('../agent/witnessed-buffer-order-journal.mjs');
  const {buildBufferWalletSpendingPlan}=await import('../agent/buffer-wallet-spending-plan.mjs');
  const {createFixedBufferOrderOnce}=await import('../agent/buffer-fixed-order-once.mjs');
  const {createBufferFixedOrderPreflight}=await import('../agent/buffer-fixed-order-preflight.mjs');
  const {CIRCLE_TESTNET_CODE_HASH}=await import('../agent/keyless-vault-v12-readiness.mjs');
  const {CIRCLE_TESTNET_USDC}=await import('../scripts/circle-testnet-setup.mjs');
  const {BUFFER_TESTNET_CONTRACT}=await import('../experiments/buffer-forwarder/build.mjs');
  const pool=new pg.Pool({connectionString:url,max:5});
  try {
    await initializePostgresWalletPromptAuth({pool});await initializePostgresBufferOrderFence({pool});const f=await fixture();
    const agent1=String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey()),agent2=String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
    const {review}=buildBufferWalletSpendingPlan({owner:f.owner,vault:`vault.${f.owner}`,adapter:`forward.${f.owner}`,policy_id:'test',
      vault_agent_public_key:agent1,forwarder_agent_public_key:agent2,per_tx_cap_atoms:'20000000',daily_cap_atoms:'20000000',
      vault_agent_gas_allowance_yocto:'1',forwarder_agent_gas_allowance_yocto:'1'});
    f.identity.review_sha256=review.review_sha256;
    const {provider,state:chainState,blockHash}=firstSetupPreflightFixture({owner:f.owner,ownerKey:f.identity.owner_public_key,sellerHash:setupHash(5)});
    setSyntheticSetupStage(chainState,blockHash,3);
    const auth=createBufferOrderAuthenticator({auth:createPostgresWalletPromptAuth({pool,origin:site,provider})});
    const fence=createPostgresBufferOrderFence({pool,authenticate:auth.authenticate,crypto:crypto.webcrypto});
    let text='',head='0';const store={async read(){return {text,head}},async append(input){
      if(input.expectedHead!==head || input.expectedText!==text)throw Error();text=input.text;head=String(+head+1);return {head,confirmed:true}}};
    const witness=createBufferOrderWitness({store}),journal=createWitnessedBufferOrderJournal({fence,witness});
    const signed=async purpose=>{const context={purpose,identity:f.identity};
      return signReviewedBufferOrderChallenge({wallet:f.wallet,context,challenge:await auth.issue(context),location,crypto:crypto.webcrypto,fetch:f.fetch})};
    await journal.reserve({identity:f.identity,keyRecord:f.keyRecord,draftCapsule:f.draft.capsule,evidence:await signed('reserve')});
    const draft=await openPrivateOrderDraft({wallet:f.wallet,keyRecord:f.keyRecord,capsule:f.draft.capsule,
      trustedCapsuleSha256:f.draft.draft_sha256,trustedRequestCommitmentSha256:f.draft.request_commitment_sha256,
      location,crypto:crypto.webcrypto,fetch:f.fetch});
    const sellerHash=setupHash(5),setup=setupFixture(0,30,{owner:f.owner,ownerKey:f.identity.owner_public_key});
    const priorOriginals=[0,1,2].map(i=>{const item=setupFixture(i,30+i,{owner:f.owner,ownerKey:f.identity.owner_public_key});
      return {trustedOriginalHash:item.trustedOriginalHash,attempt:item.attempt,result:item.result}});
    const preflight=createBufferFixedOrderPreflight({setupReview:setup.review,setupSnapshot:setup.snapshot,wasmBytes:v12,
      trustedSetupReviewHash:setup.trustedReviewHash,trustedOwnerPublicKey:f.identity.owner_public_key,
      trustedSellerCodeHash:sellerHash,priorOriginals,provider});
    const seller={orderId:f.order.orderId,onchainOrderId:f.order.onchainOrderId,accessToken:f.order.accessToken,
      payment:{tokenContract:CIRCLE_TESTNET_USDC,method:'ft_transfer_call',args:{receiver_id:BUFFER_TESTNET_CONTRACT,amount:'20000000',
        msg:JSON.stringify({order_id:f.order.onchainOrderId,sku:f.order.sku})},attachedDeposit:'1 yoctoNEAR',gas:'100 Tgas'},nearCliCommand:'unused'};
    let posts=0;const executor=createFixedBufferOrderOnce({journal,preflight,crypto:crypto.webcrypto,trustedSellerCodeHash:sellerHash,
      fetch:async()=>{posts++;return new Response(JSON.stringify(seller))}});
    const config={intent_id:'synthetic',expires_at_ms:Date.now()+20*60_000,native_return_cap:'1000000000000000000000000',native_reserve:'1000000000000000000000000'};
    const input={identity:f.identity,keyRecord:f.keyRecord,draft,review,config,claimEvidence:await signed('claim')};
    const result=await executor.submit(input);assert.equal(result.status,'ORDER_RESPONSE_SEALED');assert.equal(posts,1);
    const state=await journal.inspect({identity:f.identity,evidence:await signed('inspect')});assert.equal(state.status,'SEALED');
    assert.equal((await witness.inspect(f.owner)).state.phase,'sealed');
    const opened=await openPrivateOrder({wallet:f.wallet,keyRecord:f.keyRecord,capsule:state.capsule,trustedCapsuleSha256:state.capsule_sha256,
      location,crypto:crypto.webcrypto,fetch:f.fetch});assert.equal(opened.accessToken,f.order.accessToken);
    await assert.rejects(executor.submit(input));assert.equal(posts,1);assert.equal(result.delivery_verified,false);
  } finally {await pool.end();}
});

dbtest('same-process retention handle is not reconstructible or reusable from JSON',async()=>{
  const {createBufferOrderWitness}=await import('../agent/git-buffer-order-witness.mjs');
  const {createWitnessedBufferOrderJournal}=await import('../agent/witnessed-buffer-order-journal.mjs');
  const pool=new pg.Pool({connectionString:url,max:5});
  try {
    await initializePostgresBufferOrderFence({pool});const f=await fixture();let text='',head='0';
    const store={async read(){return {text,head}},async append(input){if(input.expectedHead!==head || input.expectedText!==text)throw Error();
      text=input.text;head=String(+head+1);return {head,confirmed:true}}};
    const witness=createBufferOrderWitness({store}),fence=createPostgresBufferOrderFence({pool,authenticate:auth,crypto:crypto.webcrypto});
    const journal=createWitnessedBufferOrderJournal({fence,witness});
    await journal.reserve({identity:f.identity,keyRecord:f.keyRecord,draftCapsule:f.draft.capsule,evidence:'synthetic-auth'});
    const claim=await journal.claim({identity:f.identity,evidence:'synthetic-auth'});
    await assert.rejects(journal.retainClaimedResult({claim:JSON.parse(JSON.stringify(claim)),keyRecord:f.keyRecord,capsule:f.capsule}));
    assert.equal((await journal.retainClaimedResult({claim,keyRecord:f.keyRecord,capsule:f.capsule})).status,'SEALED');
    await assert.rejects(journal.retainClaimedResult({claim,keyRecord:f.keyRecord,capsule:f.capsule}));
  } finally {await pool.end();}
});
