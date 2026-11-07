import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import {createBufferFixedOrderPreflight} from '../agent/buffer-fixed-order-preflight.mjs';
import {buildBufferWalletSpendingPlan} from '../agent/buffer-wallet-spending-plan.mjs';
import {wasm,OWNER,VAULT,KEY,hash,fixture} from './buffer-wallet-setup-fixture.mjs';
import {firstSetupPreflightFixture,setSyntheticSetupStage} from './fixtures/wallet-setup-preflight-provider.mjs';
const check=(name,fn)=>test(name,{skip:!wasm && 'reviewed V12 fixture not supplied'},fn);
function sample() {
  const base=fixture(0,30),originals=[0,1,2].map(i=>{const f=fixture(i,30+i);return {trustedOriginalHash:f.trustedOriginalHash,attempt:f.attempt,result:f.result}});
  const {provider,state,blockHash}=firstSetupPreflightFixture({owner:OWNER,ownerKey:KEY,sellerHash:hash(5)});setSyntheticSetupStage(state,blockHash,3);
  const keys=[0,1].map(()=>String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey()));
  const {review}=buildBufferWalletSpendingPlan({owner:OWNER,vault:VAULT,adapter:`forward.${OWNER}`,policy_id:'research',
    vault_agent_public_key:keys[0],forwarder_agent_public_key:keys[1],per_tx_cap_atoms:'20000000',daily_cap_atoms:'20000000',
    vault_agent_gas_allowance_yocto:'1',forwarder_agent_gas_allowance_yocto:'1'});
  const identity={owner:OWNER,owner_public_key:KEY,attempt_id:'a'.repeat(32),site:'https://site.example.test',key_sha256:'b'.repeat(64),
    key_record_sha256:'c'.repeat(64),review_sha256:review.review_sha256,request_commitment_sha256:'d'.repeat(64),draft_sha256:'e'.repeat(64)};
  const config={setupReview:base.review,setupSnapshot:base.snapshot,wasmBytes:wasm,trustedSetupReviewHash:base.trustedReviewHash,
    trustedOwnerPublicKey:KEY,trustedSellerCodeHash:hash(5),priorOriginals:originals,provider};
  return {state,blockHash,review,identity,config};
}
check('fixed order preflight requires funded vault, all originals and one current testnet FINAL block',async()=>{
  const f=sample(),preflight=createBufferFixedOrderPreflight(f.config);
  const result=await preflight({identity:f.identity,review:f.review,sku:'weekly-market-brief'});
  assert.equal(result.status,'READ_ONLY_BUFFER_ORDER_PROFILE_MATCH');assert.equal(result.owner,OWNER);assert.equal(result.block_hash,f.blockHash);
  assert.equal(result.seller_code_hash,hash(5));assert.equal(result.amount_atoms,'20000000');
  for(const [name,...args] of f.state.calls) {
    if(['status','block'].includes(name)) continue;
    if(name==='vaultPresence') assert.equal(args.at(-1),f.blockHash);else assert.deepEqual(args.at(-1),{blockId:f.blockHash});
  }
});
check('price, code, access key, funding and original-receipt drift fail closed',async()=>{
  const cases=[
    f=>{f.state.sellerConfig.paused=true},f=>{f.state.sellerProducts[0][1].price='21000000'},
    f=>{f.state.seller.code_hash=hash(6)},f=>{f.state.ownerKey.permission={FunctionCall:{}}},
    f=>{f.state.tracked='19999999'},f=>{f.state.blockAgeMs=121_000},
    f=>{f.config.priorOriginals[2].result.transaction.hash=hash(44)},
  ];
  for(const change of cases) {const f=sample();change(f);await assert.rejects(createBufferFixedOrderPreflight(f.config)({identity:f.identity,review:f.review,sku:'weekly-market-brief'}),/PREFLIGHT_UNAVAILABLE/)}
});
check('a substituted owner, review or other SKU cannot use the funded setup preflight',async()=>{
  const f=sample(),preflight=createBufferFixedOrderPreflight(f.config);
  await assert.rejects(preflight({identity:f.identity,review:f.review,sku:'crosschain-brief'}));
  await assert.rejects(preflight({identity:{...f.identity,owner:'other.testnet'},review:f.review,sku:'weekly-market-brief'}));
  await assert.rejects(preflight({identity:f.identity,review:{...f.review,adapter:'evil.testnet'},sku:'weekly-market-brief'}));
});
