/** Optional pre-broadcast independent-original hook for native resource legs.
 * A caller must provide a genuinely independent, durable implementation; a
 * callback alone is not proof of durability, review or authorization. */
import {isTransactionHash} from '../shared/direct-payment-settlement.mjs';
import {isTestnetAccount} from '../shared/account-id.mjs';
const ID=/^[A-Za-z0-9_-]{1,64}$/,HEX=/^[a-f0-9]{64}$/;
export function validateNativeOriginalCheckpoint(checkpoint) {
  if(checkpoint!==undefined&&typeof checkpoint!=='function')throw new Error('invalid independent native original checkpoint');
}
const details=({goalId,kind,txHash,fingerprint,owner,vault}={})=>{
  if(!ID.test(goalId??'')||!['random','market','oracle','storage'].includes(kind)||!isTestnetAccount(owner)||!isTestnetAccount(vault)||
      !isTransactionHash(txHash)||!HEX.test(fingerprint??''))throw new Error('invalid native original checkpoint details');
  return Object.freeze({goal_id:goalId,kind,tx_hash:txHash,fingerprint,owner,vault});
};
export async function retainNativeOriginalBeforeBroadcast(checkpoint,{goalId,kind,txHash,fingerprint,owner,vault}={}) {
  validateNativeOriginalCheckpoint(checkpoint);if(!checkpoint)return;
  const request=details({goalId,kind,txHash,fingerprint,owner,vault});
  try {
    const result=await checkpoint(request);
    if(!result||typeof result!=='object'||Array.isArray(result)||Object.keys(result).length!==3||
        result.status!=='V14_MISSION_ORIGINAL_RETAINED'||result.goal_id!==goalId||result.tx_hash!==txHash)throw Error();
  } catch {throw new Error(`${goalId}: independent original checkpoint is uncertain; no broadcast was attempted, preserve the pending hash and reconcile`)}
}
/** A completed local receipt never advances the independent witness by itself. */
export async function verifyNativeOriginalCheckpoint(checkpoint,{goalId,kind,txHash,fingerprint,owner,vault}={}) {
  validateNativeOriginalCheckpoint(checkpoint);if(!checkpoint)return;
  const request=details({goalId,kind,txHash,fingerprint,owner,vault});
  try {
    const result=await checkpoint(request);
    if(!result||typeof result!=='object'||Array.isArray(result)||Object.keys(result).length!==3||
        result.status!=='V14_MISSION_ORIGINAL_VERIFIED'||result.goal_id!==goalId||result.tx_hash!==txHash)throw Error();
  } catch {throw new Error(`${goalId}: independent original verification is uncertain; preserve the original and do not continue or resend`)}
}
