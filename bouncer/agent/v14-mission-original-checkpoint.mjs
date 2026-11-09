/** Research-only adapter from native runners to the V14 two-copy witness.
 * The runner must fsync the exact pending hash locally before invoking this.
 * It writes the independent copy first, confirms both, and never broadcasts.
 * Stores must be genuinely independent; two adapter names are not evidence.
 * No live mission service currently enables this adapter. */
import {isV14OriginalWitness} from './v14-original-witness.mjs';
const fail=()=>new Error('V14 mission original checkpoint is uncertain; no new broadcast is authorized');
const exact=(x,fields)=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&
  Object.keys(x).length===fields.length&&fields.every(field=>Object.hasOwn(x,field));
const requireBoundInput=(input,binding)=>{
  if(!exact(input,['goal_id','kind','tx_hash','fingerprint','owner','vault','mission_sha256'])||
      input.owner!==binding.owner||input.vault!==binding.vault||input.mission_sha256!==binding.mission_sha256||
      !binding.goals.some(goal=>goal.id===input.goal_id&&goal.kind===input.kind))throw fail();
};

export function createV14MissionOriginalCheckpoint({witness}={}) {
  if(!isV14OriginalWitness(witness))throw fail();
  const binding=witness.binding();
  return async input=>{
    requireBoundInput(input,binding);
    const {goal_id:goalId,kind,tx_hash:txHash,fingerprint}=input;
    const before=await witness.inspect();
    if(!before.reserved||before.pending!==null||before.next_setup_stage!==null||before.next_mission_goal!==goalId)throw fail();
    const after=await witness.retainMissionOriginal({goalId,kind,txHash,fingerprint});
    if(after.revision!==before.revision+1||after.pending?.type!=='mission'||after.pending.goal_id!==goalId||
        after.pending.kind!==kind||after.pending.tx_hash!==txHash||after.pending.fingerprint!==fingerprint)throw fail();
    // retainMissionOriginal has read both stores back. The caller still
    // rechecks its local mission journal and a synchronous freshness guard.
    return Object.freeze({status:'V14_MISSION_ORIGINAL_RETAINED',goal_id:goalId,tx_hash:txHash});
  };
}

/** Recheck the retained hash with the witness's independently configured real
 * receipt/state verifier. If the exact original was already verified, return
 * an idempotent acknowledgement; never manufacture or resend a transaction. */
export function createV14MissionOriginalVerifier({witness}={}) {
  if(!isV14OriginalWitness(witness))throw fail();
  const binding=witness.binding();
  return async input=>{
    requireBoundInput(input,binding);
    const {goal_id:goalId,kind,tx_hash:txHash,fingerprint}=input;
    let state=await witness.inspect();
    const existing=state.mission.find(item=>item.goal_id===goalId);
    if(existing) {
      if(existing.kind!==kind||existing.tx_hash!==txHash||existing.fingerprint!==fingerprint)throw fail();
    } else {
      if(state.pending?.type!=='mission'||state.pending.goal_id!==goalId||state.pending.kind!==kind||
          state.pending.tx_hash!==txHash||state.pending.fingerprint!==fingerprint)throw fail();
      state=await witness.verifyMissionOriginal({goalId});
      const verified=state.mission.find(item=>item.goal_id===goalId);
      if(!verified||verified.kind!==kind||verified.tx_hash!==txHash||verified.fingerprint!==fingerprint)throw fail();
    }
    return Object.freeze({status:'V14_MISSION_ORIGINAL_VERIFIED',goal_id:goalId,tx_hash:txHash});
  };
}
