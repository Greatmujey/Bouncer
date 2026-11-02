import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import {createOutlayerBurnPlan,buildOutlayerBurnStage} from '../agent/outlayer-v11-burn-plan.mjs';
import {OUTLAYER_BURN_STAGES,signOutlayerBurnStage,verifySignedOutlayerBurnStage} from '../agent/outlayer-v11-burn-signed.mjs';
const key=()=>nearApi.KeyPair.fromRandom('ed25519'),ownerKey=key(),existing=key(),fund=key(),project=key();
const owner={version:1,purpose:'new-bouncer-testnet-owner',network:'testnet',account_id:'bouncer-owner-0123456789abcdef01234567.testnet',public_key:String(ownerKey.getPublicKey())};
const plan=createOutlayerBurnPlan({ownerPlan:owner,existingResourcePublicKey:String(existing.getPublicKey()),
 fundingPublicKey:String(fund.getPublicKey()),projectPublicKey:String(project.getPublicKey())});
const now=Date.parse('2026-11-02T23:00:00.000Z'),block=nearApi.utils.serialize.base_encode(Buffer.alloc(32,3));
const snapshot=stage=>({version:1,stage,network:'testnet',owner:owner.account_id,vault:plan.vault,block_hash:block,
 block_timestamp_nanosec:String(BigInt(now)*1000000n),signer_public_key:buildOutlayerBurnStage({ownerPlan:owner,plan,stage}).signer_public_key,
 signer_key_nonce:'123',eligible:true,blockers:[],signed:false,sent:false,seller_contacted:false,independent_fulfillment_verified:false});
const pair=stage=>stage==='fund-provider'?fund:stage==='run-project'?project:ownerKey;
test('offline signatures contain only each reviewed fixed action and the correct single-purpose key',async()=>{
 for(const stage of OUTLAYER_BURN_STAGES){
  const e=await signOutlayerBurnStage({plan,ownerPlan:owner,stage,snapshot:snapshot(stage),keyPair:pair(stage),nowMs:now});
  const signed=verifySignedOutlayerBurnStage(e,plan,owner);
  assert.equal(e.stage,stage);assert.equal(e.nonce,'124');assert.equal(e.network,'testnet');assert.equal(e.do_not_blindly_resend,true);
  assert.equal(signed.transaction.signerId,owner.account_id);
  assert.equal('ed25519:'+nearApi.utils.serialize.base_encode(Uint8Array.from(signed.transaction.publicKey.ed25519Key.data)),e.signer_public_key);
  assert.equal(signed.transaction.receiverId,buildOutlayerBurnStage({plan,ownerPlan:owner,stage}).receiver_id);
  assert.ok(!JSON.stringify(e).includes(pair(stage).toString()));
 }
});
test('unknown, stale, changed or incorrectly keyed snapshots cannot be signed',async()=>{
 const stage='register-fake';for(const mutate of [
  s=>{s.network='mainnet'},s=>{s.owner='attacker.testnet'},s=>{s.vault='attacker.testnet'},s=>{s.stage='wrap'},
  s=>{s.eligible=false},s=>{s.blockers=['unknown']},s=>{s.signed=true},s=>{s.sent=true},s=>{s.seller_contacted=true},
  s=>{s.signer_key_nonce='not-a-nonce'},s=>{s.signer_public_key=String(fund.getPublicKey())},
  s=>{s.block_timestamp_nanosec=String(BigInt(now-121000)*1000000n)},s=>{s.block_hash='garbage'}
 ]){const s=snapshot(stage);mutate(s);await assert.rejects(signOutlayerBurnStage({plan,ownerPlan:owner,stage,snapshot:s,keyPair:ownerKey,nowMs:now}))}
 await assert.rejects(signOutlayerBurnStage({plan,ownerPlan:owner,stage,snapshot:snapshot(stage),keyPair:fund,nowMs:now}));
});
test('a changed stage, signer, action, reference block, nonce, hash or signature is rejected',async()=>{
 const stage='register-fake',e=await signOutlayerBurnStage({plan,ownerPlan:owner,stage,snapshot:snapshot(stage),keyPair:ownerKey,nowMs:now});
 for(const mutate of [x=>{x.stage='wrap'},x=>{x.network='mainnet'},x=>{x.receiver='attacker.testnet'},x=>{x.vault='attacker.testnet'},
  x=>{x.signer_public_key=String(fund.getPublicKey())},x=>{x.nonce='125'},x=>{x.block_hash=nearApi.utils.serialize.base_encode(Buffer.alloc(32,4))},
  x=>{x.tx_hash=nearApi.utils.serialize.base_encode(Buffer.alloc(32,5))},x=>{x.do_not_blindly_resend=false},x=>{x.extra='anything'},
  x=>{const b=Buffer.from(x.signed_tx_base64,'base64');b[b.length-1]^=1;x.signed_tx_base64=b.toString('base64')}
 ]){const altered=structuredClone(e);mutate(altered);assert.throws(()=>verifySignedOutlayerBurnStage(altered,plan,owner))}
});
