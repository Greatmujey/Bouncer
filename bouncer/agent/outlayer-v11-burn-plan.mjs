/**
 * UNSIGNED, OFFLINE testnet plan for one OutLayer connector-probe burn. This
 * is deliberately not a sender, signer, journal, readiness decision or proof
 * of delivery. A fresh FINAL snapshot, durable original-hash fence, strict
 * receipt checks, separate one-method keys, and recovery are required before
 * any stage can be made live. The provider uses fake USDC.e, not Circle.
 */
import nearApi from 'near-api-js';
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { newTestnetVaultId } from './keyless-vault-bootstrap-readiness.mjs';
import { V11_NEAR_CODE_HASH } from './keyless-vault-bootstrap.mjs';
import { OUTLAYER_FAKE_USD as TOKEN, OUTLAYER_TESTNET as SELLER, OUTLAYER_PROBE as PROJECT } from './outlayer-v11-readiness.mjs';

const { transactions:tx, utils }=nearApi, TGAS=10n**12n;
const VERSION='2d406ed8005a422c38aec0616990989970e2c444c1386d4f09d54cce59468fb9';
const AUTHOR='zavodil.testnet', REF='ref-finance-101.testnet', WRAP='wrap.testnet';
const STORAGE=1250000000000000000000n, WRAP_INPUT='100000000000000', MIN_OUTPUT='15000', FT_AMOUNT='10000';
const NATIVE='20000000000000000000000', ALLOWANCE=500000000000000000000000n; // 0.5 test NEAR per single-method key
const FUND='ol-funding', USD='ol-project-usd', NEAR='ol-project-native';
const DEPOSIT_MSG='{"action":"deposit_balance"}', INPUT='{"operation":"burn","rounds":50}';
const key=(value,label)=>{
  let k;try{k=utils.PublicKey.from(value)}catch{throw new Error(`invalid ${label} key`)}
  if(k.keyType!==0||String(k)!==value)throw new Error(`invalid ${label} key`);return k;
};
const action=(name,args,gas=20n,deposit=1n)=>tx.functionCall(name,args,gas*TGAS,deposit);
const project={project_id:PROJECT,version_key:VERSION,usd_policy_id:USD,token:TOKEN,attached_usd:FT_AMOUNT,
  input_data:INPUT,max_instructions:1_000_000_000,max_memory_mb:256,max_execution_seconds:60};
const projectRoute={project,route_revision:1,native_policy_revision:1,usd_policy_revision:1,native_payee_revision:1,usd_payee_revision:1,active:true};
const exactFields=['version','purpose','network','owner','owner_public_key','vault','vault_code_hash','existing_resource_public_key','funding_public_key','project_public_key'];

export function createOutlayerBurnPlan({ownerPlan,existingResourcePublicKey,fundingPublicKey,projectPublicKey}={}){
  const owner=validateOwnerBootstrapPlan(ownerPlan);
  const plan={version:1,purpose:'unsigned-v11-outlayer-burn-diagnostic',network:'testnet',owner:owner.account_id,
    owner_public_key:owner.public_key,vault:newTestnetVaultId(owner),vault_code_hash:V11_NEAR_CODE_HASH,
    existing_resource_public_key:existingResourcePublicKey,funding_public_key:fundingPublicKey,project_public_key:projectPublicKey};
  return validateOutlayerBurnPlan(plan,owner);
}
export function validateOutlayerBurnPlan(p,ownerPlan){
  const owner=validateOwnerBootstrapPlan(ownerPlan);
  if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).sort().join(',')!==[...exactFields].sort().join(',')||
    p.version!==1||p.purpose!=='unsigned-v11-outlayer-burn-diagnostic'||p.network!=='testnet'||p.owner!==owner.account_id||
    p.owner_public_key!==owner.public_key||p.vault!==newTestnetVaultId(owner)||p.vault_code_hash!==V11_NEAR_CODE_HASH||
    new Set([p.owner_public_key,p.existing_resource_public_key,p.funding_public_key,p.project_public_key]).size!==4){
    throw new Error('invalid bounded OutLayer burn plan');
  }
  key(p.existing_resource_public_key,'existing resource');key(p.funding_public_key,'funding');key(p.project_public_key,'project');return {...p};
}

/** Produce reviewed action objects, not transactions; no nonce, block, hash,
 * signature, private key or broadcast. Stage order is descriptive only: a
 * future coordinator must prove every preceding ORIGINAL at FINAL. */
export function buildOutlayerBurnStage({plan,ownerPlan,stage}={}){
  const p=validateOutlayerBurnPlan(plan,ownerPlan), fundKey=key(p.funding_public_key,'funding'), projectKey=key(p.project_public_key,'project');
  const msg=JSON.stringify({force:0,actions:[{pool_id:54,token_in:WRAP,token_out:TOKEN,amount_in:WRAP_INPUT,min_amount_out:MIN_OUTPUT}]});
  let receiver,signer=p.owner_public_key,actions;
  switch(stage){
    case 'register-fake':receiver=TOKEN;actions=[
      action('storage_deposit',{account_id:p.owner,registration_only:true},50n,STORAGE),
      action('storage_deposit',{account_id:p.vault,registration_only:true},50n,STORAGE),
    ];break;
    case 'wrap':receiver=WRAP;actions=[action('near_deposit',{},50n,BigInt(WRAP_INPUT))];break;
    case 'swap-fake':receiver=WRAP;actions=[action('ft_transfer_call',{receiver_id:REF,amount:WRAP_INPUT,msg},300n,1n)];break;
    case 'fund-vault':receiver=TOKEN;actions=[action('ft_transfer_call',{receiver_id:p.vault,amount:FT_AMOUNT,msg:''},200n,1n)];break;
    case 'configure':receiver=p.vault;actions=[
      action('deposit_native',{},10n,BigInt(NATIVE)),
      action('set_policy',{policy_id:FUND,token:TOKEN,per_tx_cap:FT_AMOUNT,daily_cap:FT_AMOUNT}),
      action('allow_payee',{policy_id:FUND,payee:SELLER}),action('grant_agent_key',{policy_id:FUND,public_key:p.funding_public_key}),
      action('set_ft_call_message',{policy_id:FUND,payee:SELLER,msg:DEPOSIT_MSG}),
      action('set_policy',{policy_id:USD,token:TOKEN,per_tx_cap:FT_AMOUNT,daily_cap:FT_AMOUNT}),
      action('allow_payee',{policy_id:USD,payee:SELLER}),action('grant_agent_key',{policy_id:USD,public_key:p.project_public_key}),
      action('set_policy',{policy_id:NEAR,token:'native',per_tx_cap:NATIVE,daily_cap:NATIVE}),
      action('allow_payee',{policy_id:NEAR,payee:SELLER}),action('grant_agent_key',{policy_id:NEAR,public_key:p.project_public_key}),
      action('set_outlayer_project',{native_policy_id:NEAR,project}),
    ];break;
    case 'install-keys':receiver=p.owner;actions=[
      tx.addKey(fundKey,tx.functionCallAccessKey(p.vault,['execute_ft_call'],ALLOWANCE)),
      tx.addKey(projectKey,tx.functionCallAccessKey(p.vault,['execute_outlayer_project'],ALLOWANCE)),
    ];break;
    case 'fund-provider':receiver=p.vault;signer=p.funding_public_key;actions=[action('execute_ft_call',{
      policy_id:FUND,payee:SELLER,amount:FT_AMOUNT,expected_token:TOKEN,expected_msg:DEPOSIT_MSG,
      expected_policy_revision:1,expected_route_revision:1},300n,0n)];break;
    case 'run-project':receiver=p.vault;signer=p.project_public_key;actions=[action('execute_outlayer_project',{
      native_policy_id:NEAR,amount:NATIVE,expected_route:projectRoute},300n,0n)];break;
    default:throw new Error('unsupported diagnostic stage');
  }
  return {stage,signer_id:p.owner,signer_public_key:signer,receiver_id:receiver,actions,
    scope:'offline unsigned stage only; no nonce, signature, seller request, transaction or delivery'};
}
export const OUTLAYER_BURN_REVIEW={asset:'fake USDC.e, not Circle',project:PROJECT,version:VERSION,author:AUTHOR,
  funding_atoms:FT_AMOUNT,wrap_input_yocto:WRAP_INPUT,min_fake_atoms:MIN_OUTPUT,project_native_max_yocto:NATIVE,
  storage_yocto_per_registration:STORAGE.toString(),agent_gas_allowance_yocto:ALLOWANCE.toString(),input:INPUT,prepaid_refund_risk:'provider credit may return without restoring V11 tracked allowance; no vault withdrawal path established',
  trust:'provider and token can upgrade; cached-worker availability and source/deployed equivalence are unproven'};
