import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import {nep413Payload} from '../web-src/cli-login.mjs';
import {createPrivateOrderKey,preparePrivateOrderDraft,openPrivateOrderDraft,openPrivateOrder,inspectPrivateOrderKeyRecord} from '../web-src/buffer-private-order-capsule.mjs';
import {buildBufferWalletSpendingPlan} from '../agent/buffer-wallet-spending-plan.mjs';
import {createFixedBufferOrderOnce} from '../agent/buffer-fixed-order-once.mjs';
import {CIRCLE_TESTNET_CODE_HASH} from '../agent/keyless-vault-v12-readiness.mjs';
import {CIRCLE_TESTNET_USDC} from '../scripts/circle-testnet-setup.mjs';
import {BUFFER_TESTNET_CONTRACT} from '../experiments/buffer-forwarder/build.mjs';
const wc=crypto.webcrypto,site='https://site.example.test',location={origin:site,host:'site.example.test'},owner='buyer.testnet';
const sellerHash=nearApi.utils.serialize.base_encode(Buffer.alloc(32,29)),blockHash=nearApi.utils.serialize.base_encode(Buffer.alloc(32,31));
async function fixture() {
  const pair=nearApi.KeyPair.fromRandom('ed25519'),ownerPublicKey=String(pair.getPublicKey());
  const wallet={async signMessage(params){const digest=crypto.createHash('sha256').update(nep413Payload(params)).digest();
    return {accountId:owner,publicKey:ownerPublicKey,signature:Buffer.from(pair.sign(digest).signature).toString('base64')}}};
  const keyFetch=async()=>new Response(JSON.stringify({jsonrpc:'2.0',id:'bouncer-cli-login',result:{permission:'FullAccess'}}));
  const keyRecord=await createPrivateOrderKey({wallet,owner,ownerPublicKey,location,crypto:wc,fetch:keyFetch});
  const attemptId=crypto.randomBytes(16).toString('hex'), brief='Private synthetic research brief about testnet markets.';
  const request={brief,sku:'weekly-market-brief',customerAccount:`forward.${owner}`};
  const prepared=await preparePrivateOrderDraft({keyRecord,attemptId,request,crypto:wc});
  const draft=await openPrivateOrderDraft({wallet,keyRecord,capsule:prepared.capsule,trustedCapsuleSha256:prepared.draft_sha256,
    trustedRequestCommitmentSha256:prepared.request_commitment_sha256,location,crypto:wc,fetch:keyFetch});
  const key1=String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey()),key2=String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
  const {review}=buildBufferWalletSpendingPlan({owner,vault:`vault.${owner}`,adapter:`forward.${owner}`,policy_id:'research',
    vault_agent_public_key:key1,forwarder_agent_public_key:key2,per_tx_cap_atoms:'20000000',daily_cap_atoms:'20000000',
    vault_agent_gas_allowance_yocto:'1',forwarder_agent_gas_allowance_yocto:'1'});
  const info=await inspectPrivateOrderKeyRecord({keyRecord,crypto:wc});
  const identity={owner,owner_public_key:ownerPublicKey,attempt_id:attemptId,site,key_sha256:info.public_key_sha256,
    key_record_sha256:info.key_record_sha256,review_sha256:review.review_sha256,
    request_commitment_sha256:prepared.request_commitment_sha256,draft_sha256:prepared.draft_sha256};
  const config={intent_id:'order-trial',expires_at_ms:Date.now()+20*60_000,native_return_cap:'1000000000000000000000000',native_reserve:'1000000000000000000000000'};
  const seller={orderId:'01234567-89ab-cdef-0123-456789abcdef',onchainOrderId:'o-123456abcdef',accessToken:'ab'.repeat(24),
    payment:{tokenContract:CIRCLE_TESTNET_USDC,method:'ft_transfer_call',args:{receiver_id:BUFFER_TESTNET_CONTRACT,amount:'20000000',
      msg:JSON.stringify({order_id:'o-123456abcdef',sku:'weekly-market-brief'})},attachedDeposit:'1 yoctoNEAR',gas:'100 Tgas'},nearCliCommand:'unused'};
  let state='reserved',stored,loseRetention=false;const claims=new WeakSet();
  const journal={async claim(){if(state!=='reserved')throw Error();state='claimed';const claim={status:'CLAIMED_NO_RESULT',independently_witnessed:true,do_not_retry:true};claims.add(claim);return claim},
    async retainClaimedResult({claim,capsule}) {if(!claims.has(claim))throw Error();claims.delete(claim);if(loseRetention)throw Error();
      state='sealed';stored=capsule;const {privateOrderCapsuleCommitment}=await import('../web-src/buffer-private-order-capsule.mjs');
      return {status:'SEALED',capsule_sha256:await privateOrderCapsuleCommitment({capsule,crypto:wc})}},
    get state(){return state},get stored(){return stored},loseRetention(){loseRetention=true}};
  const preflight=async ({identity,review,sku})=>({status:'READ_ONLY_BUFFER_ORDER_PROFILE_MATCH',network:'testnet',owner:identity.owner,
    adapter:review.adapter,review_sha256:identity.review_sha256,sku,amount_atoms:'20000000',seller:BUFFER_TESTNET_CONTRACT,
    seller_code_hash:sellerHash,circle_code_hash:CIRCLE_TESTNET_CODE_HASH,block_hash:blockHash,checked_at_ms:Date.now()});
  return {wallet,keyFetch,keyRecord,identity,draft,review,config,seller,journal,preflight,request};
}
const setup=(f,fetch,preflight=f.preflight)=>createFixedBufferOrderOnce({journal:f.journal,preflight,fetch,crypto:wc,trustedSellerCodeHash:sellerHash});
const args=f=>({identity:f.identity,keyRecord:f.keyRecord,draft:f.draft,review:f.review,config:f.config,claimEvidence:'synthetic'});

test('one-shot seller response is checked, sealed, and cannot be submitted twice',async()=>{
  const f=await fixture();let posts=0;
  const fetch=async(url,options)=>{posts++;assert.equal(url,'https://buffer-zeta.vercel.app/api/orders');assert.equal(options.method,'POST');
    assert.deepEqual(JSON.parse(options.body),f.request);return new Response(JSON.stringify(f.seller),{status:200})};
  const executor=setup(f,fetch),result=await executor.submit(args(f));
  assert.equal(result.status,'ORDER_RESPONSE_SEALED');assert.equal(result.payment_sent,false);assert.equal(result.delivery_verified,false);
  assert.ok(!JSON.stringify(result).includes(f.seller.accessToken));assert.ok(!JSON.stringify(result).includes(f.request.brief));
  const opened=await openPrivateOrder({wallet:f.wallet,keyRecord:f.keyRecord,capsule:f.journal.stored,
    trustedCapsuleSha256:result.capsule_sha256,location,crypto:wc,fetch:f.keyFetch});
  assert.equal(opened.accessToken,f.seller.accessToken);assert.equal(opened.brief,f.request.brief);
  await assert.rejects(executor.submit(args(f)),e=>e.code==='BUFFER_ORDER_UNKNOWN');assert.equal(posts,1);
});

test('unknown seller response and malformed response leave the one claim consumed',async()=>{
  for(const mode of ['lost','bad-price']) {
    const f=await fixture();let posts=0;
    const executor=setup(f,async()=>{posts++;if(mode==='lost')throw Error('lost acknowledgement');
      return new Response(JSON.stringify({...f.seller,payment:{...f.seller.payment,tokenContract:'attacker.testnet'}}))});
    await assert.rejects(executor.submit(args(f)),e=>e.code==='BUFFER_ORDER_UNKNOWN' && e.claim_may_be_consumed && e.seller_post_may_have_occurred);
    assert.equal(f.journal.state,'claimed');await assert.rejects(executor.submit(args(f)));assert.equal(posts,1);
  }
});

test('changed draft and failed fresh preflight never contact seller',async()=>{
  const f=await fixture();let posts=0,checks=0;
  const fetch=async()=>{posts++;return new Response('{}')};
  await assert.rejects(setup(f,fetch).submit({...args(f),draft:{...f.draft,brief:'Changed private research request.'}}));
  assert.equal(f.journal.state,'reserved');
  const preflight=async input=>{checks++;return checks===1?f.preflight(input):{status:'BLOCKED'}};
  await assert.rejects(setup(f,fetch,preflight).submit(args(f)),e=>e.claim_may_be_consumed && !e.seller_post_may_have_occurred);
  assert.equal(f.journal.state,'claimed');assert.equal(posts,0);
});

test('lost retention acknowledgement returns only encrypted recovery material, never retries',async()=>{
  const f=await fixture();let posts=0;f.journal.loseRetention();
  const executor=setup(f,async()=>{posts++;return new Response(JSON.stringify(f.seller))});
  const result=await executor.submit(args(f));assert.equal(result.status,'ORDER_RETENTION_UNKNOWN');
  assert.ok(!JSON.stringify(result).includes(f.seller.accessToken));assert.ok(!JSON.stringify(result).includes(f.request.brief));
  await assert.rejects(executor.submit(args(f)));assert.equal(posts,1);
});

test('a lost claim acknowledgement is explicitly uncertain and never reaches the seller',async()=>{
  const f=await fixture();let posts=0;
  const claim=f.journal.claim.bind(f.journal);
  f.journal.claim=async input=>{await claim(input);throw Error('lost claim ack')};
  const executor=setup(f,async()=>{posts++;throw Error('should not call')});
  await assert.rejects(executor.submit(args(f)),e=>e.code==='BUFFER_ORDER_UNKNOWN' && e.claim_may_be_consumed && !e.seller_post_may_have_occurred);
  assert.equal(f.journal.state,'claimed');await assert.rejects(executor.submit(args(f)));assert.equal(posts,0);
});
