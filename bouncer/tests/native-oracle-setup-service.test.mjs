import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { buildNativeOracleWalletPlan, NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } from '../agent/native-oracle-wallet-plan.mjs';
import { createNativeOraclePromptWitness } from '../agent/git-native-oracle-prompt-witness.mjs';
import { createAuthenticatedNativeOracleSetupService } from '../agent/authenticated-native-oracle-setup-service.mjs';
import { createNativeOracleSetupClient } from '../web-src/native-oracle-setup-client.mjs';

const wasm=fs.readFileSync(new URL('../../bouncer.wasm',import.meta.url)),OWNER='great_mujey.testnet',VAULT=`native.${OWNER}`;
const key=()=>String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey()),hash=n=>nearApi.utils.serialize.base_encode(Buffer.alloc(32,n));
const reorder=x=>Array.isArray(x)?x.map(reorder):x && typeof x==='object' ? Object.fromEntries(Object.keys(x).reverse().map(k=>[k,reorder(x[k])])) : x;
function fixture({reorderedReview=false}={}){
  const ownerKey=key(),agentKey=key(),review=buildNativeOracleWalletPlan({wasmBytes:wasm,terms:{owner:OWNER,vault:VAULT,
    policy_id:'price',agent_public_key:agentKey,per_tx_cap_yocto:'100000000000000000000000',daily_cap_yocto:'100000000000000000000000',
    vault_deposit_yocto:'100000000000000000000000',agent_gas_allowance_yocto:NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE}}).review;
  const identity={owner:OWNER,owner_public_key:ownerKey,operation_id:crypto.randomBytes(16).toString('hex'),review_sha256:review.review_sha256,
    stages:review.stages.map(s=>({stage_id:s.id,action_commitment_sha256:s.action_commitment_sha256}))};
  const plan={...identity,review,stages:identity.stages.map(s=>({...s,claimed:false,original_hash:null}))};
  let head='0'.repeat(40),count=0,text='';
  const store={async read(){return {head,text}},async append(input){if(input.expectedHead!==head || input.expectedText!==text)throw Error();
    text=input.text;head=(++count).toString(16).padStart(40,'0');return {confirmed:true,head}}};
  const witness=createNativeOraclePromptWitness({store});let peerState=null;
  const otherWitness={async inspect(){return {head,state:peerState}}};
  let state='absent',issued=[];
  const fence={async inspect(){if(state==='absent'){const e=new Error();e.code='OWNER_FENCED';throw e}
    const output=structuredClone(plan);if(state==='mismatched')output.stages[0].claimed=true;return output}};
  const coordinator=Object.fromEntries(['reserve','claim','recordOriginal','verifyCompletion'].map(x=>[x,async()=>({})]));
  const auth={async issue(action){issued.push(action);return {action}}};
  const service=createAuthenticatedNativeOracleSetupService({auth,fence,witness,otherWitness,coordinator,
    getRetainedReview:async id=>id==='a'.repeat(32)?{review:reorderedReview?reorder(review):review}:null,wasmBytes:wasm,receiptProvider:{async viewNodeStatus(){return {chain_id:'testnet'}},
      async txStatusReceipts(){throw Error('not available')}},owner:OWNER});
  return {review,identity,plan,witness,otherWitness,service,ownerKey,issued,setState:v=>{state=v},setPeer:v=>{peerState=v}};
}

test('native service binds challenge to retained plan and never treats absent or disagreeing journals as permission',async()=>{
  const f=fixture();await assert.rejects(f.service.issueReservation({taskId:'f'.repeat(32),ownerPublicKey:f.ownerKey}));
  const reservation=await f.service.issueReservation({taskId:'a'.repeat(32),ownerPublicKey:f.ownerKey});
  assert.equal(reservation.action.purpose,'reserve_native_setup');assert.equal(reservation.action.review_sha256,f.review.review_sha256);
  const none=await f.service.inspect({ownerPublicKey:f.ownerKey,evidence:'synthetic'});assert.equal(none.status,'NO_LOCAL_RECORD');
  assert.match(none.scope,/not proof/);assert.equal(none.execution_authorized,false);
  await f.witness.reserve(f.identity);f.setState('mismatched');
  const mismatch=await f.service.inspect({ownerPublicKey:f.ownerKey,evidence:'synthetic'});
  assert.equal(mismatch.status,'RECOVERY_REQUIRED');assert.equal(mismatch.database_stages[0].claimed,true);
  assert.equal(mismatch.witnessed_records[0].event,'reserve');
  await assert.rejects(f.service.previewOriginal({ownerPublicKey:f.ownerKey,stageId:f.review.stages[0].id,originalHash:hash(9),evidence:'synthetic'}));
  f.setState('present');assert.equal((await f.service.inspect({ownerPublicKey:f.ownerKey,evidence:'synthetic'})).status,'WITNESSED');
  const challenge=await f.service.issueClaim({identity:f.identity,stageId:f.review.stages[0].id});
  assert.equal(challenge.action.purpose,'claim_native_setup_stage');assert.equal(challenge.action.operation_id,f.identity.operation_id);
  await assert.rejects(f.service.issueClaim({identity:{...f.identity,review_sha256:'f'.repeat(64)},stageId:f.review.stages[0].id}));
  await assert.rejects(f.service.issueCompletion({identity:f.identity}));
});

test('a JSONB-reordered retained review remains valid, but an existing peer witness requires recovery',async()=>{
  const f=fixture({reorderedReview:true});
  assert.equal((await f.service.issueReservation({taskId:'a'.repeat(32),ownerPublicKey:f.ownerKey})).action.review_sha256,f.review.review_sha256);
  f.setPeer({phase:'claimed'});
  const status=await f.service.inspect({ownerPublicKey:f.ownerKey,evidence:'synthetic'});
  assert.equal(status.status,'RECOVERY_REQUIRED');assert.match(status.scope,/different setup flow/);
  await assert.rejects(f.service.issueReservation({taskId:'a'.repeat(32),ownerPublicKey:f.ownerKey}));
});

test('a device-key mismatch or changed review blocks before any wallet transaction or server claim',async()=>{
  const f=fixture(),site={origin:'https://bouncer.example',host:'bouncer.example'},calls=[];let walletCalls=0,validDevice=false;
  const device={async inspect(){return validDevice?{status:'LOCAL_DEVICE_KEY_AVAILABLE',origin:site.origin,owner:OWNER,vault:VAULT,
    public_key:f.review.agent_public_key,expected_public_key_matched:true,private_key_exportable:false,local_storage_only:true,signing_authorized:false}
    :{status:'NO_LOCAL_DEVICE_KEY'}}};
  const wallet={manifest:{features:{signAndSendTransaction:true}},async signMessage(){walletCalls++;throw Error('unexpected')},
    async signAndSendTransaction(){walletCalls++;throw Error('unexpected')}};
  const fetchImpl=async(address)=>{calls.push(address);if(address.endsWith('/artifact'))return new Response(wasm);
    throw Error('server claim should not be called')};
  const client=createNativeOracleSetupClient({wallet,accountId:OWNER,ownerPublicKey:f.ownerKey,deviceStore:device,location:site,
    crypto:crypto.webcrypto,fetch:fetchImpl,isCurrent:()=>true,isTopLevel:true,relay:({work})=>work()});
  await assert.rejects(client.reserve({taskId:'a'.repeat(32),review:f.review}),e=>e.code==='NATIVE_DEVICE_KEY_UNAVAILABLE');
  assert.deepEqual(calls,[]);
  validDevice=true;const changed=structuredClone(f.review);changed.payee='evil.testnet';
  await assert.rejects(client.approveStage({identity:f.identity,review:changed,stageId:changed.stages[0].id}));
  assert.deepEqual(calls,['/api/native-oracle-setup/artifact']);assert.equal(walletCalls,0);
  const switched=createNativeOracleSetupClient({wallet,accountId:OWNER,ownerPublicKey:f.ownerKey,deviceStore:device,location:site,
    crypto:crypto.webcrypto,fetch:fetchImpl,isCurrent:()=>false,isTopLevel:true,relay:({work})=>work()});
  await assert.rejects(switched.reserve({taskId:'a'.repeat(32),review:f.review}),e=>e.code==='NATIVE_SETUP_SESSION_CHANGED');
});
