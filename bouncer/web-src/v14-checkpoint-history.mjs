// Browser-compatible, read-only validation of an independently retained V14
// checkpoint history. It checks the public binding, hash chain and ordering;
// it does NOT verify chain receipts, current state, consent, non-execution,
// checkpoint freshness against an independent latest head, or authorization.
import {V14_PHONE_RESEARCH_STAGE_IDS} from '../shared/v14-phone-stages.mjs';
import {isV14CheckpointAccountPair} from './v14-checkpoint-enrollment.mjs';

const HEX=/^[a-f0-9]{64}$/,SCOPE=/^[a-f0-9]{32}$/,ID=/^[A-Za-z0-9_-]{1,64}$/;
const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const exact=(x,keys)=>x && typeof x==='object' && !Array.isArray(x) && Object.keys(x).length===keys.length && keys.every(k=>Object.hasOwn(x,k));
const fail=()=>new Error('V14 checkpoint history is invalid or uncertain; never invent or resend an original');
const hex=bytes=>[...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join('');
const sha=async(crypto,text)=>hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));
function txHash(value) {
  if(typeof value!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))return false;
  let n=0n;for(const c of value)n=n*58n+BigInt(B58.indexOf(c));let length=0;
  while(n>0n){length++;n>>=8n;}for(let i=0;value[i]==='1';i++)length++;
  return length===32;
}
function containsSecretField(value,depth=0) {
  if(depth>32)return true;
  if(!value || typeof value!=='object')return false;
  return Object.entries(value).some(([key,child])=>/private|secret|seed|mnemonic|signature|capability|password|bearer|recovery/i.test(key)||containsSecretField(child,depth+1));
}
async function validateBinding(binding,{scope,owner,vault,crypto}) {
  const fields=['format','scope_id','network','owner','vault','review_sha256','mission_sha256','stages','goals','public_review'];
  const reviewFields=['format','status','network','owner','owner_public_key','vault','mission','mission_sha256','agent_public_keys',
    'agent_gas_allowances_yocto','rolling_caps_yocto','vault_storage_funding_yocto','native_deposit_yocto','artifacts','stages',
    'limitations','signing_authorized','transaction_sent','review_sha256'];
  if(!exact(binding,fields)||binding.format!=='bouncer-v14-original-binding-v1'||binding.scope_id!==scope||binding.network!=='testnet'||
     binding.owner!==owner||binding.vault!==vault||!HEX.test(binding.review_sha256??'')||!HEX.test(binding.mission_sha256??'')||
     !Array.isArray(binding.stages)||binding.stages.length!==V14_PHONE_RESEARCH_STAGE_IDS.length||
     !binding.stages.every((stage,i)=>exact(stage,['id','action_commitment_sha256'])&&stage.id===V14_PHONE_RESEARCH_STAGE_IDS[i]&&HEX.test(stage.action_commitment_sha256??''))||
     !Array.isArray(binding.goals)||binding.goals.length!==3||!binding.goals.every(goal=>exact(goal,['id','kind'])&&ID.test(goal.id??''))||
     new Set(binding.goals.map(goal=>goal.id)).size!==3||
     !['random,oracle,storage','oracle,market,storage'].includes(binding.goals.map(goal=>goal.kind).join(',')))throw fail();
  const review=binding.public_review;
  if(!exact(review,reviewFields)||review.format!=='bouncer-research-v14-phone-plan-v1'||review.status!=='UNSIGNED_OFFLINE_PLAN_ONLY'||
     review.network!=='testnet'||review.owner!==owner||review.vault!==vault||review.signing_authorized!==false||review.transaction_sent!==false||
     review.review_sha256!==binding.review_sha256||review.mission_sha256!==binding.mission_sha256||!review.mission||
     !Array.isArray(review.mission.goals)||!Array.isArray(review.stages)||new TextEncoder().encode(JSON.stringify(review)).length>20_000||
     containsSecretField(review))throw fail();
  const unsigned={...review};delete unsigned.review_sha256;
  if(await sha(crypto,JSON.stringify(unsigned))!==binding.review_sha256||await sha(crypto,JSON.stringify(review.mission))!==binding.mission_sha256||
     JSON.stringify(review.stages.map(stage=>({id:stage.id,action_commitment_sha256:stage.action_commitment_sha256})))!==JSON.stringify(binding.stages)||
     JSON.stringify(review.mission.goals.map(({kind,goal})=>({id:goal?.id,kind})))!==JSON.stringify(binding.goals))throw fail();
  try {for(const {goal} of review.mission.goals)if(goal?.program?.url&&new URL(goal.program.url).search)throw fail();}catch{throw fail();}
  return binding;
}

/** `snapshot` is the public SQL result, not evidence that it is the latest
 * independent copy. Empty history always remains inconclusive. */
export async function inspectV14PublicHistory({snapshot,owner,vault,crypto=globalThis.crypto}={}) {
  try {
    if(!crypto?.subtle||!isV14CheckpointAccountPair(vault,owner)||!exact(snapshot,['status','scope_id','revision','head_sha256','events'])||
       snapshot.status!=='EXISTING_CHECKPOINT'||!SCOPE.test(snapshot.scope_id??'')||!Number.isSafeInteger(snapshot.revision)||
       snapshot.revision<0||snapshot.revision>32||!HEX.test(snapshot.head_sha256??'')||!Array.isArray(snapshot.events)||
       snapshot.events.length!==snapshot.revision)throw fail();
    const {scope_id:scope,events}=snapshot;
    let head='0'.repeat(64),binding=null,pending=null,setupIndex=0,missionIndex=0;
    const setup=[],mission=[];
    for(let i=0;i<events.length;i++) {
      const line=events[i];
      if(typeof line!=='string'||new TextEncoder().encode(line).length>24_576||/[\r\n]/.test(line))throw fail();
      const event=JSON.parse(line);
      if(!exact(event,['format','seq','previous_sha256','type','data'])||JSON.stringify(event)!==line||
         event.format!=='bouncer-v14-original-event-v1'||event.seq!==i+1||event.previous_sha256!==head)throw fail();
      const d=event.data;
      if(i===0) {
        if(event.type!=='reserve')throw fail();binding=await validateBinding(d,{scope,owner,vault,crypto});
      } else if(!binding)throw fail();
      else if(event.type==='wallet_claim') {
        const stage=binding.stages[setupIndex];
        if(pending||missionIndex!==0||!stage||!exact(d,['stage_id','action_commitment_sha256'])||
           d.stage_id!==stage.id||d.action_commitment_sha256!==stage.action_commitment_sha256)throw fail();
        pending={type:'wallet',stage_id:stage.id,tx_hash:null};
      } else if(event.type==='wallet_original') {
        if(!pending||pending.type!=='wallet'||pending.tx_hash!==null||!exact(d,['stage_id','tx_hash'])||d.stage_id!==pending.stage_id||
           !txHash(d.tx_hash)||setup.some(previous=>previous.tx_hash===d.tx_hash))throw fail();
        pending.tx_hash=d.tx_hash;
      } else if(event.type==='wallet_verified') {
        if(!pending||pending.type!=='wallet'||!pending.tx_hash||!exact(d,['stage_id','tx_hash','final_block_hash'])||
           d.stage_id!==pending.stage_id||d.tx_hash!==pending.tx_hash||!txHash(d.final_block_hash))throw fail();
        setup.push({stage_id:d.stage_id,tx_hash:d.tx_hash,recorded_final_block_hash:d.final_block_hash});setupIndex++;pending=null;
      } else if(event.type==='mission_original') {
        const goal=binding.goals[missionIndex];
        if(pending||setupIndex!==binding.stages.length||!goal||!exact(d,['goal_id','kind','tx_hash','fingerprint'])||
           d.goal_id!==goal.id||d.kind!==goal.kind||!txHash(d.tx_hash)||!HEX.test(d.fingerprint??'')||
           [...setup,...mission].some(previous=>previous.tx_hash===d.tx_hash))throw fail();
        pending={type:'mission',goal_id:d.goal_id,kind:d.kind,tx_hash:d.tx_hash,fingerprint:d.fingerprint};
      } else if(event.type==='mission_verified') {
        if(!pending||pending.type!=='mission'||!exact(d,['goal_id','tx_hash','final_block_hash'])||
           d.goal_id!==pending.goal_id||d.tx_hash!==pending.tx_hash||!txHash(d.final_block_hash))throw fail();
        mission.push({goal_id:d.goal_id,kind:pending.kind,tx_hash:d.tx_hash,fingerprint:pending.fingerprint,
          recorded_final_block_hash:d.final_block_hash});missionIndex++;pending=null;
      } else throw fail();
      head=await sha(crypto,line);
    }
    if(head!==snapshot.head_sha256)throw fail();
    return {status:'PUBLIC_CHECKPOINT_HISTORY',scope_id:scope,revision:snapshot.revision,head_sha256:head,
      review:binding?.public_review??null,setup,mission,pending,next_setup_stage:binding?.stages[setupIndex]?.id??null,
      next_mission_goal:binding?.goals[missionIndex]?.id??null,absence_verified:false,receipts_verified:false,
      latest_head_independently_verified:false,wallet_transaction_authorized:false};
  }catch{throw fail();}
}
