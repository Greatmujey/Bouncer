/**
 * Owner-authenticated, one-shot claim of the native trial's ORIGINAL hash.
 * This composes an existing NEP-413 authenticator with both anchored setup
 * witnesses. It does not sign a transaction or grant spending consent. A
 * trusted completion supplier must independently verify every reviewed setup
 * original and current state; the caller must separately obtain human consent.
 *
 * Each challenge is single-use. An uncertain witness acknowledgement,
 * conflicting state or failed postcheck is reconciliation-only. Never issue
 * a substitute transaction on the assumption that an earlier claim was unused.
 */
import { isDeepStrictEqual } from 'node:util';
import { nativeSetupAuthAction } from '../web-src/native-oracle-setup-auth.mjs';
import { assertNativeOracleCompletion } from '../web-src/native-oracle-completion.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { validateWitnessedNativeOracleTrial, assertWitnessedNativeOracleTrial } from './native-oracle-phone-signer.mjs';

const fail=()=>new Error('authenticated native trial claim unavailable or uncertain; stop and reconcile, never retry automatically');
const exact=(value,keys)=>value!==null && typeof value==='object' && !Array.isArray(value) &&
  [Object.prototype,null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).length===keys.length &&
  keys.every(k=>Object.hasOwn(Object.getOwnPropertyDescriptor(value,k)??{},'value'));

export function createAuthenticatedNativeOracleTrialClaim({goal,review,identity,wasmBytes,loaderBytes,compressedBytes,trustedReviewHash,trustedOwnerPublicKey,
  auth,witness,otherWitness,getFreshCompletion,now=Date.now}={}) {
  const checked=validateWitnessedNativeOracleTrial({goal,review,identity,wasmBytes,loaderBytes,compressedBytes,trustedReviewHash,trustedOwnerPublicKey});
  if(!auth || typeof auth.issue!=='function' || typeof auth.authenticate!=='function' ||
      !witness || typeof witness.inspect!=='function' || typeof witness.claimTrial!=='function' ||
      !otherWitness || otherWitness===witness || typeof otherWitness.inspect!=='function' ||
      typeof getFreshCompletion!=='function' || typeof now!=='function')throw fail();

  function input(raw,head) {
    if(!exact(raw,['goal_id','goal_sha256','agent_public_key','original_hash']) ||
        raw.goal_id!==checked.goal.id || raw.goal_sha256!==checked.goalSha256 ||
        raw.agent_public_key!==checked.agentPublicKey || !isTransactionHash(raw.original_hash) ||
        typeof head!=='string' || !/^[a-f0-9]{40}$/.test(head))throw fail();
    const trial=structuredClone(raw);
    const action=nativeSetupAuthAction({purpose:'claim_native_oracle_trial',owner:checked.identity.owner,
      ownerPublicKey:checked.identity.owner_public_key,identity:checked.identity,trial,expectedWitnessHead:head});
    return {trial,action};
  }
  async function prior(head) {
    const current=await witness.inspect(checked.identity.owner);
    if(current?.head!==head || current.state?.phase!=='complete' || !isDeepStrictEqual(current.state.identity,checked.identity))throw fail();
    const peer=await otherWitness.inspect(checked.identity.owner);
    if(!peer || peer.head!==head || !Object.hasOwn(peer,'state') || peer.state!==null)throw fail();
    return current;
  }
  return Object.freeze({
    async inspect(owner) {
      if(owner!==checked.identity.owner)throw fail();
      return witness.inspect(owner);
    },
    async issue({trial:raw,expectedWitnessHead}={}) {
      const {action}=input(raw,expectedWitnessHead);
      await prior(expectedWitnessHead);
      return auth.issue(action);
    },
    async claim({trial:raw,expectedWitnessHead,evidence}={}) {
      const {trial,action}=input(raw,expectedWitnessHead);
      try { if(await auth.authenticate({action,evidence})!==true)throw fail(); } catch { throw fail(); }
      const before=await prior(expectedWitnessHead);
      const completion=structuredClone(await getFreshCompletion());
      try { assertNativeOracleCompletion(completion,checked.review,now()); } catch { throw fail(); }
      const originals=before.state.records.filter(record=>record.event==='original').map(record=>record.original_hash);
      if(completion.witness_head!==expectedWitnessHead || !isDeepStrictEqual(completion.prior_original_hashes,originals))throw fail();
      const saved=await witness.claimTrial(checked.identity,trial,expectedWitnessHead);
      assertWitnessedNativeOracleTrial(saved,checked.identity,trial);
      const after=await witness.inspect(checked.identity.owner);
      assertWitnessedNativeOracleTrial(after,checked.identity,trial);
      const peer=await otherWitness.inspect(checked.identity.owner);
      if(after.head!==saved.head || !peer || peer.head!==saved.head || !Object.hasOwn(peer,'state') || peer.state!==null)throw fail();
      return after;
    },
  });
}

/** Adapt the authenticated service to the guarded phone account's witness
 * interface. requestOwnerEvidence is a transport for the exact NEP-413
 * challenge, not proof of consent; the service verifies and consumes the
 * returned owner signature before appending the claim. There is no retry. */
export function createOwnerAuthorizedNativeTrialWitness({claimService,identity:rawIdentity,requestOwnerEvidence}={}) {
  const identity=structuredClone(rawIdentity);
  if(!identity || typeof identity.owner!=='string' || !claimService ||
      ['inspect','issue','claim'].some(k=>typeof claimService[k]!=='function') || typeof requestOwnerEvidence!=='function')throw fail();
  return Object.freeze({
    async inspect(owner) {
      if(owner!==identity.owner)throw fail();
      return claimService.inspect(owner);
    },
    async claimTrial(raw,rawTrial,expectedWitnessHead) {
      if(!isDeepStrictEqual(raw,identity))throw fail();
      const trial=structuredClone(rawTrial);
      const challenge=await claimService.issue({trial,expectedWitnessHead});
      const evidence=await requestOwnerEvidence({identity:structuredClone(identity),trial:structuredClone(trial),expectedWitnessHead,challenge});
      return claimService.claim({trial,expectedWitnessHead,evidence});
    },
  });
}
