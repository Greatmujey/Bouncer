import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import {createOutlayerBurnPlan} from '../agent/outlayer-v11-burn-plan.mjs';
import {signOutlayerBurnStage} from '../agent/outlayer-v11-burn-signed.mjs';
import {signOutlayerRegistrationControl,verifySignedOutlayerRegistrationControl} from '../agent/outlayer-registration-control.mjs';
const key=()=>nearApi.KeyPair.fromRandom('ed25519'),ownerKey=key(),existing=key(),fund=key(),project=key();
const owner={version:1,purpose:'new-bouncer-testnet-owner',network:'testnet',account_id:'bouncer-owner-0123456789abcdef01234567.testnet',public_key:String(ownerKey.getPublicKey())};
const plan=createOutlayerBurnPlan({ownerPlan:owner,existingResourcePublicKey:String(existing.getPublicKey()),fundingPublicKey:String(fund.getPublicKey()),projectPublicKey:String(project.getPublicKey())});
const now=Date.parse('2026-11-02T23:00:00.000Z'),hash=n=>nearApi.utils.serialize.base_encode(Buffer.alloc(32,n)),block=hash(3);
const snap=()=>({version:1,stage:'register-fake',network:'testnet',owner:owner.account_id,vault:plan.vault,block_hash:block,
 block_timestamp_nanosec:String(BigInt(now)*1000000n),signer_public_key:owner.public_key,signer_key_nonce:'123',eligible:true,blockers:[],
 control_policy:null,control_eligible:true,signed:false,sent:false,seller_contacted:false,independent_fulfillment_verified:false});
async function original(){return signOutlayerBurnStage({plan,ownerPlan:owner,stage:'register-fake',snapshot:snap(),keyPair:ownerKey,nowMs:now})}
test('distinct control is bound to the uncertain original and skips its nonce with zero yocto',async()=>{
 const prior=await original(),control=await signOutlayerRegistrationControl({plan,ownerPlan:owner,original:prior,snapshot:snap(),keyPair:ownerKey,nowMs:now});
 const signed=verifySignedOutlayerRegistrationControl(control,prior,plan,owner),action=signed.transaction.actions[0].functionCall;
 assert.equal(prior.nonce,'124');assert.equal(control.nonce,'125');assert.equal(control.original_tx_hash,prior.tx_hash);
 assert.equal(signed.transaction.receiverId,plan.vault);assert.equal(action.methodName,'set_policy');assert.equal(action.deposit,0n);
 assert.equal(JSON.parse(Buffer.from(action.args).toString()).policy_id,'ol-register-nonce-control');
 assert.equal(control.do_not_blindly_resend,true);assert.ok(!JSON.stringify(control).includes(ownerKey.toString()));
});
test('a changed or already occupied policy, different original and stale nonce cannot authorize a control',async()=>{
 const prior=await original();
 for(const mutate of [s=>{s.network='mainnet'},s=>{s.control_policy={token:'native'}},s=>{s.control_eligible=false},s=>{s.eligible=false},
  s=>{s.signer_key_nonce='124'},s=>{s.block_timestamp_nanosec=String(BigInt(now-121000)*1000000n)},s=>{s.vault='attacker.testnet'}]){
  const s=snap();mutate(s);await assert.rejects(signOutlayerRegistrationControl({plan,ownerPlan:owner,original:prior,snapshot:s,keyPair:ownerKey,nowMs:now}));
 }
 await assert.rejects(signOutlayerRegistrationControl({plan,ownerPlan:owner,original:prior,snapshot:snap(),keyPair:fund,nowMs:now}));
 const control=await signOutlayerRegistrationControl({plan,ownerPlan:owner,original:prior,snapshot:snap(),keyPair:ownerKey,nowMs:now});
 for(const mutate of [e=>{e.original_tx_hash=hash(9)},e=>{e.original_nonce='123'},e=>{e.nonce='126'},e=>{e.policy_id='circle-resources'},
  e=>{e.network='mainnet'},e=>{e.signed_tx_base64=e.signed_tx_base64.slice(4)}]){
  const e=structuredClone(control);mutate(e);assert.throws(()=>verifySignedOutlayerRegistrationControl(e,prior,plan,owner));
 }
});
