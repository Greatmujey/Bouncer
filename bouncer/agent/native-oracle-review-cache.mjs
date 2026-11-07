/**
 * Experimental, bounded, process-local retention for a single fixed testnet
 * native trial review. No signing or network call. A review is NOT a durable
 * cross-instance reservation: restart/eviction/expiry makes it unavailable;
 * after authenticated reservation the separately fenced DB retains the review.
 * Deployments must replace this with a trustworthy retained review service and
 * must never interpret a missing review as proof that no prompt was opened.
 */
import crypto from 'node:crypto';
import { buildNativeOracleWalletPlan,NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE,NATIVE_ORACLE_V9_BYTES,NATIVE_ORACLE_V9_SHA256 } from './native-oracle-wallet-plan.mjs';

const OWNER='great_mujey.testnet',VAULT=`native.${OWNER}`,MAX=16,TTL=30*60_000;
const fail=()=>new Error('NATIVE_REVIEW_UNAVAILABLE');
export function createNativeOracleReviewCache({wasmBytes,now=Date.now}={}){
  if(!(wasmBytes instanceof Uint8Array) || wasmBytes.length!==NATIVE_ORACLE_V9_BYTES ||
     crypto.createHash('sha256').update(wasmBytes).digest('hex')!==NATIVE_ORACLE_V9_SHA256 || typeof now!=='function')throw fail();
  const wasm=Buffer.from(wasmBytes),tasks=new Map();let last=0;
  function prune(){const time=now();if(!Number.isSafeInteger(time) || time<1 || time>Number.MAX_SAFE_INTEGER-TTL || time<last)throw fail();last=time;
    for(const [id,row] of tasks)if(time>=row.expires)tasks.delete(id);return time}
  return Object.freeze({
    async create(input={}){
      const time=prune();if(!input || Object.getPrototypeOf(input)!==Object.prototype || Object.keys(input).length!==1 ||
        !Object.hasOwn(input,'agentPublicKey') || tasks.size>=MAX || typeof input.agentPublicKey!=='string')throw fail();
      const {agentPublicKey}=input;
      let review;try{review=buildNativeOracleWalletPlan({wasmBytes:wasm,terms:{owner:OWNER,vault:VAULT,policy_id:'price',
        agent_public_key:agentPublicKey,per_tx_cap_yocto:'100000000000000000000000',daily_cap_yocto:'100000000000000000000000',
        vault_deposit_yocto:'100000000000000000000000',agent_gas_allowance_yocto:NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE}}).review}
      catch{throw fail()}
      const taskId=crypto.randomBytes(16).toString('hex');if(tasks.has(taskId))throw fail();
      tasks.set(taskId,{review:structuredClone(review),expires:time+TTL});
      return {task_id:taskId,review:structuredClone(review),expires_at_ms:time+TTL,signing_authorized:false,transaction_sent:false};
    },
    async getRetainedReview(taskId){
      prune();if(typeof taskId!=='string' || !/^[a-f0-9]{32}$/.test(taskId))return null;
      const row=tasks.get(taskId);return row?{review:structuredClone(row.review)}:null;
    },
  });
}
