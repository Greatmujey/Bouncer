import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { webcrypto, createHash, randomBytes } from 'node:crypto';
import nearApi from 'near-api-js';
import nearConnect from '@hot-labs/near-connect';
import { NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } from '../agent/native-oracle-wallet-plan.mjs';
import { buildResearchPhonePlan } from '../agent/native-phone-loader-research.mjs';
import { prepareCompressedNativeOracleSetupWalletPrompt, prepareNativeOracleSetupWalletPrompt,
  verifyCompressedNativeOracleRetainedReview } from '../web-src/native-oracle-setup-wallet-prompt.mjs';

const wasm=fs.readFileSync(new URL('../../bouncer.wasm',import.meta.url));
const loader=fs.readFileSync(new URL('../contracts/native-phone-loader/fixtures/native-phone-loader-research.wasm',import.meta.url));
const compressed=fs.readFileSync(new URL('../contracts/native-phone-loader/fixtures/native-v9.deflate',import.meta.url));
const key=()=>String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const hash=n=>nearApi.utils.serialize.base_encode(Buffer.alloc(32,n));
const owner='buyer.testnet',vault='native.buyer.testnet',time=1_800_000_000_000,origin='https://bouncer.example';
function fixture(index=0){
  const ownerKey=key(),agentKey=key(),terms={owner,vault,policy_id:'price',agent_public_key:agentKey,
    per_tx_cap_yocto:'100000000000000000000000',daily_cap_yocto:'100000000000000000000000',
    vault_deposit_yocto:'100000000000000000000000',agent_gas_allowance_yocto:NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE};
  const plan=buildResearchPhonePlan({terms,wasmBytes:wasm,loaderBytes:loader,compressedBytes:compressed,trustedOwnerPublicKey:ownerKey});
  const review=plan.review,identity={owner,owner_public_key:ownerKey,operation_id:randomBytes(16).toString('hex'),
    review_sha256:review.review_sha256,stages:review.stages.map(s=>({stage_id:s.id,action_commitment_sha256:s.action_commitment_sha256}))};
  const deviceKey={status:'LOCAL_DEVICE_KEY_AVAILABLE',origin,owner,vault,public_key:agentKey,
    expected_public_key_matched:true,private_key_exportable:false,local_storage_only:true,signing_authorized:false};
  const claim={status:'PROMPT_CLAIMED_NO_HASH',independently_witnessed:true,do_not_retry:true,execution_authorized:false,
    owner,operation_id:identity.operation_id,review_sha256:review.review_sha256,stage_id:review.stages[index].id,
    action_commitment_sha256:review.stages[index].action_commitment_sha256,witness_head:'c'.repeat(40),
    preflight_block_hash:hash(9),preflight_checked_at:new Date(time).toISOString()};
  const calls=[],wallet={manifest:{id:'meteor-wallet',features:{signAndSendTransaction:true}},async signAndSendTransaction(request){
    calls.push(request);return {transaction:{hash:hash(4)},transaction_outcome:{id:hash(4)}};
  }};
  return {plan,review,identity,deviceKey,claim,calls,wallet,args:{wallet,review,identity,deviceKey,stageId:review.stages[index].id,
    loaderBytes:loader,compressedBytes:compressed,location:{origin},isTopLevel:true,crypto:webcrypto,now:()=>time}};
}
function reorder(x){if(Array.isArray(x))return x.map(reorder);if(x&&typeof x==='object')return Object.fromEntries(Object.keys(x).reverse().map(k=>[k,reorder(x[k])]));return x;}

test('compressed review reconstructs and all three reviewed stages map to the exact connector actions',async()=>{
  for(let i=0;i<3;i++){
    const f=fixture(i),canonical=await verifyCompressedNativeOracleRetainedReview({review:reorder(f.review),identity:reorder(f.identity),crypto:webcrypto});
    assert.equal(canonical.owner,owner);
    const prompt=await prepareCompressedNativeOracleSetupWalletPrompt(f.args);assert.equal(f.calls.length,0);
    const result=await prompt.invoke(f.claim);assert.equal(result.original_hash,hash(4));assert.equal(result.do_not_retry,true);
    assert.equal(result.final_execution_verified,false);assert.equal(f.calls.length,1);
    const expected=nearConnect.nearActionsToConnectorActions(f.plan.batches[i].actions);
    if(i===0){expected[2].params.code=new Uint8Array(expected[2].params.code);expected[4].params.args=new Uint8Array(expected[4].params.args);}
    assert.deepEqual(f.calls[0].actions,expected);assert.equal(f.calls[0].receiverId,i===2?owner:vault);
    if(i===0){assert.equal(f.calls[0].actions.length,5);
      assert.equal(createHash('sha256').update(f.calls[0].actions[2].params.code).digest('hex'),f.review.loader.sha256);
      assert.equal(createHash('sha256').update(f.calls[0].actions[4].params.args).digest('hex'),f.review.compressed.sha256);}
    await assert.rejects(prompt.invoke(f.claim));assert.equal(f.calls.length,1);
  }
});

test('compressed research review cannot pass direct-deploy adapter; modified terms and code are rejected before any wallet call',async()=>{
  const f=fixture();await assert.rejects(prepareNativeOracleSetupWalletPrompt(f.args));
  for(const change of [r=>{r.loader.sha256='0'.repeat(64)},r=>{r.compressed.sha256='0'.repeat(64)},
    r=>{r.stages[0].actions[4].self_deployment.args.owner='evil.testnet'},
    r=>{r.stages[0].actions[4].gas='1'},r=>{r.per_tx_cap_yocto='100000000000000000000001'},
    r=>{r.stages[2].actions[0].method_names.push('set_policy')},r=>{r.limitations[1]='Refund is guaranteed'},r=>{r.extra=true}]){
    const review=structuredClone(f.review),identity=structuredClone(f.identity);change(review);
    const {review_sha256:_old,...unsigned}=review;review.review_sha256=createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
    identity.review_sha256=review.review_sha256;
    await assert.rejects(prepareCompressedNativeOracleSetupWalletPrompt({...f.args,review,identity}));
  }
  for(const patch of [{loaderBytes:new Uint8Array(loader.length)},{compressedBytes:new Uint8Array(compressed.length)},
    {deviceKey:{...f.deviceKey,private_key_exportable:true}},{location:{origin:'http://bouncer.example'}},{isTopLevel:false}]){
    await assert.rejects(prepareCompressedNativeOracleSetupWalletPrompt({...f.args,...patch}));
  }
  assert.equal(f.calls.length,0);
});

test('unwitnessed, stale and uncertain compressed wallet prompts cannot be repeated',async()=>{
  const f=fixture(),prompt=await prepareCompressedNativeOracleSetupWalletPrompt(f.args);
  for(const patch of [{independently_witnessed:false},{action_commitment_sha256:'f'.repeat(64)},
    {preflight_checked_at:new Date(time-5001).toISOString()}])await assert.rejects(prompt.invoke({...f.claim,...patch}));
  f.wallet.signAndSendTransaction=async()=>{f.calls.push('called');throw Error('unknown')};
  const result=await prompt.invoke(f.claim);assert.equal(result.status,'WALLET_RESULT_UNKNOWN');assert.equal(result.do_not_retry,true);
  await assert.rejects(prompt.invoke(f.claim));assert.equal(f.calls.length,1);
});
