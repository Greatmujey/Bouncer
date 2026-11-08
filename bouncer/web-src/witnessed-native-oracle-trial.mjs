/**
 * Phone-side composition for one fixed native-oracle trial. It builds the
 * original hash locally, asks the authenticated setup API to witness it,
 * refreshes completion, and asks the non-extractable device key to sign.
 * It never broadcasts or uploads the signed transaction. A real owner UI
 * must display the returned terms and capture explicit consent; the boolean
 * passed to sign() is only an integration guard, not proof of consent.
 *
 * The setup API, RPC, same-origin scripts, device storage and separately
 * operated witness/checkpoint remain trust boundaries. Unknown or lost results
 * require original-hash reconciliation, never an automatic replacement.
 */
import { verifyNativeOracleSetupReview } from './native-oracle-setup-wallet-prompt.mjs';
import { assertNativeOracleCompletion } from './native-oracle-completion.mjs';
import { buildNativeOracleTrialBytes, encodeBase58, NATIVE_ORACLE_TRIAL_GAS } from './native-oracle-transaction.mjs';

const fail=()=>new Error('native oracle trial unavailable or uncertain; stop and reconcile, never retry automatically');
const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');

export async function prepareWitnessedNativeOracleTrial({client,deviceStore,identity:rawIdentity,review:rawReview,goalId,
  origin,isTopLevel,crypto,isCurrent,now=Date.now}={}) {
  if(!client || typeof client.verifyCompletion!=='function' || typeof client.claimTrial!=='function' ||
      !deviceStore || typeof deviceStore.inspect!=='function' || typeof deviceStore.signNativeOracleTrial!=='function' ||
      typeof goalId!=='string' || !/^[A-Za-z0-9_-]{1,64}$/.test(goalId) || isTopLevel!==true ||
      typeof origin!=='string' || !crypto?.subtle || typeof crypto.subtle.digest!=='function' ||
      typeof isCurrent!=='function' || typeof now!=='function')throw fail();
  const identity=structuredClone(rawIdentity),review=structuredClone(rawReview);
  const current=()=>{if(isCurrent()!==true)throw fail()};current();
  const device=await deviceStore.inspect({owner:review?.owner,vault:review?.vault,expected_public_key:review?.agent_public_key});current();
  const canonical=await verifyNativeOracleSetupReview({review,identity,deviceKey:device,origin,crypto});current();
  const goal={id:goalId,contract_id:canonical.vault,owner_account_id:canonical.owner,policy_id:canonical.policy_id,
    amount:canonical.per_tx_cap_yocto,route:{project:canonical.project,route_revision:1,policy_revision:1,payee_revision:1,active:true},
    max_age_seconds:300};
  const goalSha256=hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(goal)))));current();
  const terms=Object.freeze({network:'testnet',owner:canonical.owner,vault:canonical.vault,policy_id:canonical.policy_id,
    agent_public_key:canonical.agent_public_key,asset:'native',payee:canonical.payee,project:Object.freeze({...canonical.project}),
    maximum_native_yocto:canonical.per_tx_cap_yocto,rolling_day_cap_yocto:canonical.daily_cap_yocto,
    method:'execute_outlayer_native_project',gas_limit:NATIVE_ORACLE_TRIAL_GAS,
    agent_gas_allowance_yocto:canonical.agent_gas_allowance_yocto,attached_deposit_yocto:'0',goal_id:goalId,goal_sha256:goalSha256,
    review_sha256:review.review_sha256,refund_destination:canonical.owner,transaction_sent:false,signing_authorized:false,
    limitations:Object.freeze([
      'OutLayer receives the maximum; a verified unused refund returns to the owner, not the vault.',
      'The full maximum counts toward the rolling daily budget even if a refund is returned.',
      'Gas is paid separately from the agent allowance; actual cost may differ.',
      'This single-source price task does not guarantee price accuracy, freshness or independent storage delivery.',
    ])});
  let started=false;
  return Object.freeze({terms,
    async sign({ownerConfirmed}={}) {
      if(started || ownerConfirmed!==true)throw fail();
      current();started=true; // before any remote action; this object is never retried
      const completion=structuredClone(await client.verifyCompletion({identity}));current();
      assertNativeOracleCompletion(completion,review,now());
      const built=buildNativeOracleTrialBytes(canonical,completion);
      const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',built.unsigned));current();
      if(digest.length!==32)throw fail();
      const trial={goal_id:goalId,goal_sha256:goalSha256,agent_public_key:canonical.agent_public_key,original_hash:encodeBase58(digest)};
      const witness=structuredClone(await client.claimTrial({identity,goal,trial,expectedWitnessHead:completion.witness_head}));current();
      const freshCompletion=structuredClone(await client.verifyCompletion({identity}));current();
      const result=await deviceStore.signNativeOracleTrial({review,identity,completion,freshCompletion,witness,
        ownerConfirmed:true,expectedTransactionHash:trial.original_hash});current();
      if(result?.status!=='SIGNED_NOT_BROADCAST' || result.tx_hash!==trial.original_hash ||
          !(result.signed_transaction instanceof Uint8Array) || result.signed_transaction.length>16_384 ||
          result.witnessed_original_matched!==true || result.local_original_retained!==true || result.do_not_retry!==true ||
          result.broadcast_authorized!==false || result.transaction_sent!==false)throw fail();
      return result;
    },
  });
}
