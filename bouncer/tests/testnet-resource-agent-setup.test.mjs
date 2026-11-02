import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import {createTestnetResourceAgentKeyring} from '../agent/testnet-resource-agent-keyring.mjs';
import {signTestnetResourceAgentSetup,verifySignedTestnetResourceAgentSetup} from '../agent/testnet-resource-agent-setup.mjs';
import {V11_NEAR_CODE_HASH} from '../agent/keyless-vault-bootstrap.mjs';
const hash=nearApi.utils.serialize.base_encode(Buffer.alloc(32,8));
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-plan-'));fs.chmodSync(root,0o700);
 const key=nearApi.KeyPair.fromRandom('ed25519');
 const owner={version:1,purpose:'new-bouncer-testnet-owner',network:'testnet',account_id:'bouncer-owner-0123456789abcdef01234567.testnet',public_key:String(key.getPublicKey())};
 const p=createTestnetResourceAgentKeyring({dir:path.join(root,'agent'),ownerPlan:owner}).plan,now=Date.now();
 const snapshot={network:'testnet',owner:owner.account_id,public_key:owner.public_key,vault:p.vault,agent_public_key:p.public_key,
  circle_token:p.token,vault_code_hash:V11_NEAR_CODE_HASH,vault_key_count:0,vault_circle_registration:'REGISTERED_AT_VIEW',owner_circle_atoms:'0',
  vault_actual_circle_atoms:'6907',vault_tracked_circle_atoms:'6907',signed:false,sent:false,seller_contacted:false,
  owner_key_nonce:'42',block_hash:hash,block_timestamp_nanosec:(BigInt(now)*1000000n).toString(),
  policy:null,agent_granted:false,guard_probe_eligible:true,configure_eligible:true,install_eligible:false};
 return {root,key,owner,p,now,snapshot,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
test('probe, owner policy and restricted access-key actions are exact, independently signed and testnet-only',async()=>{
 const f=fixture();try{
  for(const stage of ['guard-probe','configure','install']){
   const s=structuredClone(f.snapshot);
   if(stage==='install'){s.policy={token:f.p.token,per_tx_cap:'3000',daily_cap:'6907'};s.agent_granted=true;s.install_eligible=true}
   const e=await signTestnetResourceAgentSetup({ownerPlan:f.owner,agentPlan:f.p,snapshot:s,stage,keyPair:f.key,nowMs:f.now});
   const tx=verifySignedTestnetResourceAgentSetup(e,f.owner,f.p).transaction;
   assert.equal(e.nonce,'43');assert.equal(e.do_not_blindly_resend,true);assert.ok(!JSON.stringify(e).includes('private_key'));
   if(stage==='guard-probe'){assert.equal(tx.receiverId,f.p.vault);assert.equal(tx.actions.length,1);assert.equal(tx.actions[0].functionCall.deposit,0n)}
   if(stage==='configure'){
    assert.equal(tx.actions.length,2);assert.deepEqual(tx.actions.map(x=>x.functionCall.methodName),['set_policy','grant_agent_key']);
    assert.deepEqual(tx.actions.map(x=>x.functionCall.deposit),[1n,1n]);
   }
   if(stage==='install'){
    assert.equal(tx.receiverId,f.owner.account_id);const add=tx.actions[0].addKey;
    assert.deepEqual(Buffer.from(add.publicKey.ed25519Key.data),Buffer.from(nearApi.utils.PublicKey.from(f.p.public_key).ed25519Key.data));
    const perm=add.accessKey.permission.functionCall;
    assert.equal(perm.receiverId,f.p.vault);assert.deepEqual(perm.methodNames,['execute','execute_ft_call']);
    assert.equal(perm.allowance,100000000000000000000000n);
   }
   const bad={...e,signed_tx_base64:e.signed_tx_base64.slice(0,-4)+'AAAA'};
   assert.throws(()=>verifySignedTestnetResourceAgentSetup(bad,f.owner,f.p));
   assert.throws(()=>verifySignedTestnetResourceAgentSetup({...e,stage:stage==='install'?'configure':'install'},f.owner,f.p));
  }
 }finally{f.cleanup()}
});
test('refuses stale, inconsistent, wrong-key or not-yet-configured snapshots',async()=>{
 const f=fixture();try{
  for(const patch of [{vault_key_count:1},{vault_actual_circle_atoms:'6906'},{seller_contacted:true},{policy:{}},
    {circle_token:'fake.testnet'},{owner_key_nonce:'9007199254740992'},{block_timestamp_nanosec:'1'}]){
   await assert.rejects(signTestnetResourceAgentSetup({ownerPlan:f.owner,agentPlan:f.p,snapshot:{...f.snapshot,...patch},stage:'configure',keyPair:f.key,nowMs:f.now}));
  }
  await assert.rejects(signTestnetResourceAgentSetup({ownerPlan:f.owner,agentPlan:f.p,snapshot:f.snapshot,stage:'install',keyPair:f.key,nowMs:f.now}));
  await assert.rejects(signTestnetResourceAgentSetup({ownerPlan:f.owner,agentPlan:f.p,snapshot:f.snapshot,stage:'configure',keyPair:nearApi.KeyPair.fromRandom('ed25519'),nowMs:f.now}));
 }finally{f.cleanup()}
});
