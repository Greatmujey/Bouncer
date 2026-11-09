/**
 * Browser reconstruction of the complete UNSIGNED V14 phone setup review.
 * It verifies the exact action commitments and pinned public artifacts before
 * producing wallet-shaped actions. It never prompts, signs, sends or proves a
 * receipt. The caller must independently retain the reviewed digest and
 * artifact pins; accepting a server's own pins as trust is not verification.
 * This research loader is still disabled on the live wallet path.
 */
import {actionCreators,createTransaction,encodeTransaction} from '@near-js/transactions';
import {PublicKey} from '@near-js/crypto';
import {inflateSync} from 'fflate';
import {V14_PHONE_RESEARCH_STAGE_IDS} from '../shared/v14-phone-stages.mjs';
import {isV14CheckpointAccountPair} from './v14-checkpoint-enrollment.mjs';

const HEX=/^[a-f0-9]{64}$/,ID=/^[A-Za-z0-9_-]{1,64}$/,MAX_U128=(1n<<128n)-1n,MAX_ALLOWANCE=10n**24n;
const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAGIC=[0,97,115,109,1,0,0,0],encoder=new TextEncoder();
const REVIEW_FIELDS=['format','status','network','owner','owner_public_key','vault','mission','mission_sha256','agent_public_keys',
  'agent_gas_allowances_yocto','rolling_caps_yocto','vault_storage_funding_yocto','native_deposit_yocto','artifacts','stages',
  'limitations','signing_authorized','transaction_sent','review_sha256'];
const DOMAIN=encoder.encode('bouncer-research-v14-phone-batch-v1\0');
const DUMMY=PublicKey.from('ed25519:11111111111111111111111111111111');
const exact=(value,fields)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===fields.length&&fields.every(field=>Object.hasOwn(value,field));
const fail=()=>new Error('V14 phone setup review or pinned artifact differs; no wallet prompt is authorized');
const copy=value=>structuredClone(value);
const equal=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
const toHex=bytes=>[...bytes].map(byte=>byte.toString(16).padStart(2,'0')).join('');
async function digest(crypto,bytes) {return new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));}
async function shaText(crypto,value) {return toHex(await digest(crypto,encoder.encode(value)));}
function base58(bytes) {
  let number=0n;for(const byte of bytes)number=(number<<8n)+BigInt(byte);
  let value='';while(number){value=B58[Number(number%58n)]+value;number/=58n}
  let leading=0;while(leading<bytes.length&&bytes[leading]===0)leading++;
  return '1'.repeat(leading)+value;
}
function positive(value) {
  if(typeof value!=='string'||!/^[1-9][0-9]{0,38}$/.test(value)||BigInt(value)>MAX_U128)throw fail();
  return BigInt(value);
}
function canonicalKey(value) {
  try {
    if(typeof value!=='string'||!value.startsWith('ed25519:'))throw Error();
    const key=PublicKey.from(value);
    if(String(key)!==value||key.keyType!==0||key.ed25519Key?.data?.length!==32)throw Error();
    return key;
  }catch{throw fail()}
}
function call(method,args,deposit='1',gas='30000000000000') {
  return {type:'function_call',method,args,gas,deposit_yocto:deposit};
}
function validMagic(bytes) {return bytes.length>=8&&MAGIC.every((byte,index)=>bytes[index]===byte);}
function validateMission(review) {
  const mission=review.mission;
  if(!exact(mission,['version','id','contract_id','owner_account_id','max_native_amount','required_resources','goals'])||
      mission.version!==1||!ID.test(mission.id??'')||mission.contract_id!==review.vault||mission.owner_account_id!==review.owner||
      !Array.isArray(mission.required_resources)||mission.required_resources.length!==3||
      new Set(mission.required_resources).size!==3||!['compute','api','storage'].every(x=>mission.required_resources.includes(x))||
      !Array.isArray(mission.goals)||mission.goals.length!==3||
      !['random,oracle,storage','oracle,market,storage'].includes(mission.goals.map(item=>item?.kind).join(',')))throw fail();
  const maximum=positive(mission.max_native_amount),ids=[],policies=[],goals=mission.goals;
  let total=0n;
  for(const item of goals) {
    if(!exact(item,['kind','goal'])||!item.goal||typeof item.goal!=='object'||Array.isArray(item.goal)||
        item.goal.contract_id!==review.vault||item.goal.owner_account_id!==review.owner||!ID.test(item.goal.id??'')||
        !ID.test(item.goal.policy_id??''))throw fail();
    ids.push(item.goal.id);policies.push(item.goal.policy_id);total+=positive(item.goal.amount);
  }
  if(new Set(ids).size!==3||new Set(policies).size!==3||total>maximum||positive(review.native_deposit_yocto)<total||
      !exact(review.agent_public_keys,ids)||!exact(review.agent_gas_allowances_yocto,ids)||!exact(review.rolling_caps_yocto,ids))throw fail();
  const ownerKey=canonicalKey(review.owner_public_key),seen=new Set([String(ownerKey)]);
  for(const {goal} of goals) {
    const agent=String(canonicalKey(review.agent_public_keys[goal.id]));
    if(seen.has(agent)||positive(review.agent_gas_allowances_yocto[goal.id])>MAX_ALLOWANCE||
        positive(review.rolling_caps_yocto[goal.id])<BigInt(goal.amount))throw fail();
    seen.add(agent);
  }
  const compute=goals.find(item=>['random','market'].includes(item.kind)).goal;
  const oracle=goals.find(item=>item.kind==='oracle').goal,storage=goals.find(item=>item.kind==='storage').goal;
  if(!compute.program||typeof compute.program!=='object'||!HEX.test(compute.program.sha256??''))throw fail();
  try {const url=new URL(compute.program.url);if(url.protocol!=='https:'||url.search||url.hash)throw Error();}catch{throw fail()}
  if(!oracle.route||!storage.route||oracle.route.route_revision!==1||oracle.route.policy_revision!==1||oracle.route.payee_revision!==1||
      storage.route.route_revision!==1||storage.route.policy_revision!==1||storage.route.payee_revision!==1||
      oracle.route.active!==true||storage.route.active!==true||storage.route.max_value_bytes!==4096||
      !equal(storage.value,{from_goal_ids:ids.slice(0,2)})||!oracle.route.project||typeof oracle.route.project!=='object')throw fail();
  positive(review.vault_storage_funding_yocto);
  return {mission,compute,oracle,storage};
}
function expectedStages(review,{mission,compute,oracle,storage}) {
  const owner=review.owner,vault=review.vault,a=review.artifacts;
  const configure=(goal,payee,method,args)=>[
    call('set_policy',{policy_id:goal.policy_id,token:'native',per_tx_cap:goal.amount,daily_cap:review.rolling_caps_yocto[goal.id]}),
    call('allow_payee',{policy_id:goal.policy_id,payee}),call(method,args),
    call('grant_agent_key',{policy_id:goal.policy_id,public_key:review.agent_public_keys[goal.id]}),
  ];
  return [
    [{type:'create_account'},{type:'transfer',deposit_yocto:review.vault_storage_funding_yocto},
      {type:'deploy_contract',bytes:a.loader_bytes,sha256:a.loader_sha256,near_code_hash:a.loader_code_hash},
      call('loader_init',{},'1','20000000000000'),
      {type:'function_call',method:'loader_deploy',args_encoding:'raw-deflate',args_bytes:a.compressed_bytes,
        args_sha256:a.compressed_sha256,gas:'240000000000000',deposit_yocto:'1',
        expected_self_deploy_sha256:a.vault_sha256,expected_owner:owner}],
    configure(compute,'outlayer.testnet','set_outlayer_program',{policy_id:compute.policy_id,program:compute.program}),
    configure(oracle,'outlayer.testnet','set_outlayer_native_project',{policy_id:oracle.policy_id,project:oracle.route.project}),
    configure(storage,vault,'set_native_storage_route',{policy_id:storage.policy_id,prefix:storage.route.prefix,max_value_bytes:storage.route.max_value_bytes}),
    [call('deposit_native',{},review.native_deposit_yocto)],
    mission.goals.map(({kind,goal})=>({type:'add_function_call_key',public_key:review.agent_public_keys[goal.id],receiver_id:vault,
      method_names:[['random','market'].includes(kind)?'execute_outlayer':kind==='oracle'?'execute_outlayer_native_project':'execute_native_storage'],
      allowance_yocto:review.agent_gas_allowances_yocto[goal.id]})),
  ];
}
function encodedActions(summaries,loader,compressed) {
  const t=actionCreators;
  return summaries.map(action=>{
    if(action.type==='create_account')return t.createAccount();
    if(action.type==='transfer')return t.transfer(BigInt(action.deposit_yocto));
    if(action.type==='deploy_contract')return t.deployContract(loader);
    if(action.type==='function_call') {
      const args=action.args_encoding==='raw-deflate'?compressed:encoder.encode(JSON.stringify(action.args));
      return t.functionCall(action.method,args,BigInt(action.gas),BigInt(action.deposit_yocto));
    }
    if(action.type==='add_function_call_key')return t.addKey(canonicalKey(action.public_key),
      t.functionCallAccessKey(action.receiver_id,action.method_names,BigInt(action.allowance_yocto)));
    throw fail();
  });
}
function walletActions(summaries,loader,compressed) {
  return summaries.map(action=>{
    if(action.type==='create_account')return {type:'CreateAccount'};
    if(action.type==='transfer')return {type:'Transfer',params:{deposit:action.deposit_yocto}};
    if(action.type==='deploy_contract')return {type:'DeployContract',params:{code:new Uint8Array(loader)}};
    if(action.type==='function_call')return {type:'FunctionCall',params:{methodName:action.method,
      args:action.args_encoding==='raw-deflate'?new Uint8Array(compressed):copy(action.args),gas:action.gas,deposit:action.deposit_yocto}};
    if(action.type==='add_function_call_key')return {type:'AddKey',params:{publicKey:action.public_key,accessKey:{nonce:0,
      permission:{receiverId:action.receiver_id,allowance:action.allowance_yocto,methodNames:[...action.method_names]}}}};
    throw fail();
  });
}
/** Verify and reconstruct all stages. `trustedArtifacts` comes from an independently
 * reviewed pin, not the review itself or a response from the same server. */
export async function verifyV14BrowserPhonePlan({review:rawReview,trustedReviewSha256,trustedArtifacts,
    loaderBytes,compressedBytes,crypto=globalThis.crypto}={}) {
  try {
    if(!crypto?.subtle||!HEX.test(trustedReviewSha256??'')||!exact(trustedArtifacts,['vault_sha256','loader_sha256','compressed_sha256'])||
        Object.values(trustedArtifacts).some(value=>!HEX.test(value??''))||!(loaderBytes instanceof Uint8Array)||
        !(compressedBytes instanceof Uint8Array))throw fail();
    // Snapshot caller-owned review and bytes before the first asynchronous
    // digest, so action reconstruction cannot race changes by another task.
    const review=copy(rawReview),a=review?.artifacts;
    const loader=new Uint8Array(loaderBytes),compressed=new Uint8Array(compressedBytes);
    if(!exact(review,REVIEW_FIELDS)||review.format!=='bouncer-research-v14-phone-plan-v1'||review.status!=='UNSIGNED_OFFLINE_PLAN_ONLY'||review.network!=='testnet'||
        !isV14CheckpointAccountPair(review.vault,review.owner)||review.signing_authorized!==false||review.transaction_sent!==false||
        review.review_sha256!==trustedReviewSha256||!HEX.test(review.mission_sha256??'')||!Array.isArray(review.stages)||review.stages.length!==6||
        !exact(a,['vault_bytes','vault_sha256','vault_code_hash','loader_bytes','loader_sha256','loader_code_hash','compressed_bytes','compressed_sha256'])||
        a.vault_sha256!==trustedArtifacts.vault_sha256||a.loader_sha256!==trustedArtifacts.loader_sha256||
        a.compressed_sha256!==trustedArtifacts.compressed_sha256||!Number.isSafeInteger(a.vault_bytes)||a.vault_bytes<8||a.vault_bytes>1_000_000||
        !Number.isSafeInteger(a.loader_bytes)||a.loader_bytes<8||a.loader_bytes>200_000||a.loader_bytes!==loaderBytes.length||
        !Number.isSafeInteger(a.compressed_bytes)||a.compressed_bytes<1||a.compressed_bytes>200_000||a.compressed_bytes!==compressedBytes.length)throw fail();
    // Conservative envelope allowance, not proof that a wallet accepts the
    // request. Meteor's mobile bridge caps the whole request at 400,000 bytes.
    const encodedLowerBound=4*Math.ceil(loader.length/3)+4*Math.ceil(compressed.length/3);
    if(encodedLowerBound+40_000>400_000)throw fail();
    const unsigned={...review};delete unsigned.review_sha256;
    if(await shaText(crypto,JSON.stringify(unsigned))!==trustedReviewSha256||
        await shaText(crypto,JSON.stringify(review.mission))!==review.mission_sha256)throw fail();
    const [loaderDigest,compressedDigest]=await Promise.all([digest(crypto,loader),digest(crypto,compressed)]);
    if(!validMagic(loader)||toHex(loaderDigest)!==a.loader_sha256||base58(loaderDigest)!==a.loader_code_hash||
        toHex(compressedDigest)!==a.compressed_sha256)throw fail();
    // One extra byte detects an oversized expansion; the pinned compressed
    // digest is checked before decompression to reject arbitrary zip bombs.
    const vault=inflateSync(compressed,{out:new Uint8Array(a.vault_bytes+1)}),vaultDigest=await digest(crypto,vault);
    if(vault.length!==a.vault_bytes||!validMagic(vault)||toHex(vaultDigest)!==a.vault_sha256||base58(vaultDigest)!==a.vault_code_hash)throw fail();
    const parsed=validateMission(review),expected=expectedStages(review,parsed),stages=[];
    for(let i=0;i<V14_PHONE_RESEARCH_STAGE_IDS.length;i++) {
      const stage=review.stages[i],receiver=i===5?review.owner:review.vault;
      if(!exact(stage,['id','signer_id','receiver_id','actions','action_commitment_sha256'])||stage.id!==V14_PHONE_RESEARCH_STAGE_IDS[i]||
          stage.signer_id!==review.owner||stage.receiver_id!==receiver||!equal(stage.actions,expected[i])||
          !HEX.test(stage.action_commitment_sha256??''))throw fail();
      const actions=encodedActions(expected[i],loader,compressed);
      const tx=createTransaction(review.owner,DUMMY,receiver,1n,actions,new Uint8Array(32)),encoded=encodeTransaction(tx);
      const bytes=new Uint8Array(DOMAIN.length+encoded.length);bytes.set(DOMAIN);bytes.set(encoded,DOMAIN.length);
      if(toHex(await digest(crypto,bytes))!==stage.action_commitment_sha256)throw fail();
      stages.push({id:stage.id,signer_id:review.owner,receiver_id:receiver,
        action_commitment_sha256:stage.action_commitment_sha256,actions:walletActions(expected[i],loader,compressed)});
    }
    return {review,stages,wallet_prompt_authorized:false,transaction_sent:false};
  }catch{throw fail();}
}
