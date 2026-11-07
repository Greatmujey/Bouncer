/**
 * Adapter from the existing native OutLayer runner to a phone-held key.
 * `requestPhoneSignature` is an explicitly supplied transport; this module
 * neither opens a UI nor sends a transaction. The phone returns one exact
 * signed transaction only after its local original-hash record. The runner
 * MUST also durably retain that original before its single broadcast.
 *
 * The callback's acknowledgement, phone storage and signed bytes are NOT an
 * independent backup or distributed payment fence. A lost/unknown result is
 * never automatically requested a second time. Not mounted by default.
 */
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import nearApi from 'near-api-js';
import { validateOracleGoal } from './oracle-outlayer.mjs';
import { verifyNativeOracleWalletReview } from './native-oracle-wallet-evidence.mjs';
import { assertNativeOracleCompletion } from '../web-src/native-oracle-completion.mjs';
import { decodeNativeHash32 } from '../web-src/native-oracle-transaction.mjs';

const {transactions,utils}=nearApi;
const GAS=300n*10n**12n;
const fail=()=>new Error('phone signature unavailable or uncertain; retain the original and never retry automatically');

export function createNativeOraclePhoneSigner({review:rawReview,wasmBytes,trustedReviewHash,trustedOwnerPublicKey,requestPhoneSignature}={}) {
  const review=structuredClone(rawReview);
  if(typeof requestPhoneSignature!=='function')throw fail();
  let identity;
  try{identity=verifyNativeOracleWalletReview({review,wasmBytes,trustedReviewHash,trustedOwnerPublicKey})}catch{throw fail()}
  const key=utils.PublicKey.from(identity.agent_public_key);
  if(key.keyType!==0)throw fail();
  // Rebuild JSON in the same order as validateOracleGoal and the phone codec;
  // a JSONB-backed review can legally return keys in a different order.
  const p=review.project,project={project_id:p.project_id,version_key:p.version_key,input_data:p.input_data,
    max_instructions:p.max_instructions,max_memory_mb:p.max_memory_mb,max_execution_seconds:p.max_execution_seconds};
  const args={policy_id:review.policy_id,amount:review.per_tx_cap_yocto,expected_route:{project,
    route_revision:1,policy_revision:1,payee_revision:1,active:true}};
  let used=false;
  return Object.freeze({
    async getPublicKey(){return key},
    async signTransaction(transaction){
      if(used)throw fail();
      let unsigned,expected;
      try {
        if(!transaction || transaction.signerId!==identity.owner || transaction.receiverId!==identity.vault ||
            String(transaction.publicKey)!==identity.agent_public_key || typeof transaction.nonce!=='bigint' || transaction.nonce<1n ||
            !(transaction.blockHash instanceof Uint8Array) || transaction.blockHash.length!==32)throw Error();
        unsigned=Buffer.from(transactions.encodeTransaction(transaction));
        const canonical=transactions.createTransaction(identity.owner,key,identity.vault,transaction.nonce,
          [transactions.functionCall('execute_outlayer_native_project',args,GAS,0n)],Buffer.from(transaction.blockHash));
        expected=Buffer.from(transactions.encodeTransaction(canonical));
        if(!unsigned.equals(expected))throw Error();
      }catch{throw fail()}
      const hash=crypto.createHash('sha256').update(unsigned).digest(),txHash=utils.serialize.base_encode(hash);
      used=true; // before invoking an external transport, including synchronous throws
      let result;
      try{result=await requestPhoneSignature({transactionHash:txHash,owner:identity.owner,vault:identity.vault,
        agentPublicKey:identity.agent_public_key,reviewSha256:identity.review_sha256})}catch{throw fail()}
      if(result?.status!=='SIGNED_NOT_BROADCAST' || result.tx_hash!==txHash || result.local_original_retained!==true ||
          result.do_not_retry!==true || result.broadcast_authorized!==false || result.transaction_sent!==false ||
          !(result.signed_transaction instanceof Uint8Array) || result.signed_transaction.length>16_384)throw fail();
      let decoded,signature;
      try {
        decoded=transactions.SignedTransaction.decode(result.signed_transaction);
        const rawSignature=decoded.signature?.ed25519Signature?.data;
        if(!Array.isArray(rawSignature) || rawSignature.length!==64 || rawSignature.some(n=>!Number.isInteger(n) || n<0 || n>255))throw Error();
        signature=Uint8Array.from(rawSignature);
        if(!Buffer.from(transactions.encodeTransaction(decoded.transaction)).equals(unsigned) ||
            !Buffer.from(transactions.encodeTransaction(transaction)).equals(unsigned) || !key.verify(hash,signature))throw Error();
      }catch{throw fail()}
      const signed=new transactions.SignedTransaction({transaction,
        signature:new transactions.Signature({keyType:0,data:new Uint8Array(signature)})});
      if(!Buffer.from(transactions.encodeTransaction(signed)).equals(Buffer.from(result.signed_transaction)))throw fail();
      return [new Uint8Array(hash),signed];
    },
  });
}

/** Adapt the existing runner's account interface to a one-block completion.
 * `getFreshCompletion` can supply the authenticated snapshot just after the
 * runner's view preflights, rather than consuming its five-second lifetime
 * while those views are in flight. The coordinator, completion source and
 * signature transport must be trustworthy; no RPC, authorization, independent
 * backup or broadcast occurs here. The exact snapshot is delivered to the
 * phone along with the expected unsigned hash for independent checking. */
export function createNativeOraclePhoneAccount({review:rawReview,completion:rawCompletion,getFreshCompletion,
  wasmBytes,trustedReviewHash,trustedOwnerPublicKey,requestPhoneSignature,now=Date.now}={}) {
  const review=structuredClone(rawReview),hasStatic=rawCompletion!==undefined,hasProvider=getFreshCompletion!==undefined;
  if(typeof now!=='function' || typeof requestPhoneSignature!=='function' || hasStatic===hasProvider ||
      (hasProvider && typeof getFreshCompletion!=='function'))throw fail();
  const staticCompletion=hasStatic?structuredClone(rawCompletion):undefined;
  if(hasStatic){try{assertNativeOracleCompletion(staticCompletion,review,now())}catch{throw fail()}}
  let preparedCompletion,preparedHash,preparationStarted=false;
  const signer=createNativeOraclePhoneSigner({review,wasmBytes,trustedReviewHash,trustedOwnerPublicKey,
    requestPhoneSignature:async request=>{
      if(!preparedCompletion || request.transactionHash!==preparedHash)throw fail();
      assertNativeOracleCompletion(preparedCompletion,review,now());
      return requestPhoneSignature({...request,completion:structuredClone(preparedCompletion)});
    }});
  return Object.freeze({accountId:review.owner,signer,
    async createTransaction(receiver,actions,publicKey){
      if(preparationStarted || receiver!==review.vault || String(publicKey)!==review.agent_public_key || !Array.isArray(actions))throw fail();
      preparationStarted=true;
      try {
        const completion=structuredClone(hasStatic?staticCompletion:await getFreshCompletion());
        assertNativeOracleCompletion(completion,review,now());
        const block=decodeNativeHash32(completion.block_hash),nonce=BigInt(completion.agent_key_nonce)+1n;
        const tx=transactions.createTransaction(review.owner,publicKey,receiver,nonce,actions,new Uint8Array(block));
        preparedHash=utils.serialize.base_encode(crypto.createHash('sha256').update(transactions.encodeTransaction(tx)).digest());
        preparedCompletion=completion;return tx;
      }catch{throw fail()}
    },
  });
}

/** Reconstruct the exact native trial shared by the phone, runner and witness.
 * This checks identity and reviewed arguments, not owner consent or an RPC. */
export function validateWitnessedNativeOracleTrial({goal:rawGoal,review:rawReview,identity:rawIdentity,
  wasmBytes,trustedReviewHash,trustedOwnerPublicKey}={}) {
  const review=structuredClone(rawReview),identity=structuredClone(rawIdentity);
  let trusted,goal,expected;
  try {
    trusted=verifyNativeOracleWalletReview({review,wasmBytes,trustedReviewHash,trustedOwnerPublicKey});
    const expectedIdentity={owner:review.owner,owner_public_key:trustedOwnerPublicKey,operation_id:identity.operation_id,
      review_sha256:trustedReviewHash,stages:review.stages.map(stage=>({stage_id:stage.id,action_commitment_sha256:stage.action_commitment_sha256}))};
    if(!/^[a-f0-9]{32}$/.test(identity.operation_id??'') || !isDeepStrictEqual(identity,expectedIdentity))throw Error();
    goal=validateOracleGoal(structuredClone(rawGoal));
    expected=validateOracleGoal({id:goal.id,contract_id:review.vault,owner_account_id:review.owner,policy_id:review.policy_id,
      amount:review.per_tx_cap_yocto,route:{project:review.project,route_revision:1,policy_revision:1,payee_revision:1,active:true},max_age_seconds:300});
    if(!isDeepStrictEqual(goal,expected) || trusted.agent_public_key!==review.agent_public_key)throw Error();
  }catch{throw fail()}
  const goalSha256=crypto.createHash('sha256').update(JSON.stringify(goal)).digest('hex');
  return {goal,identity,review,goalSha256,agentPublicKey:trusted.agent_public_key};
}

/** Verify what the anchored store currently retains, not merely its previous
 * acknowledgment. The configured witness must itself use an independently
 * operated, rollback-monitored anchor; this function cannot create one. */
export function assertWitnessedNativeOracleTrial(snapshot,identity,trial) {
  if(!snapshot || !/^[a-f0-9]{40}$/.test(snapshot.head??'') || snapshot.state?.phase!=='trial_claimed' ||
      !isDeepStrictEqual(snapshot.state.identity,identity) || !isDeepStrictEqual(snapshot.state.trial,trial))throw fail();
  return true;
}

/** Phone account that requires an anchored original BEFORE asking the phone
 * to sign, then refreshes completion at the now-witnessed head. The witness
 * claim is write-once: a lost response, changed nonce, stale recheck or phone
 * failure never creates a replacement. The existing runner must re-read this
 * same witness after its local journal commit and before the one send. */
export function createWitnessedNativeOraclePhoneAccount({goal,review,identity,wasmBytes,trustedReviewHash,trustedOwnerPublicKey,
  getFreshCompletion,requestPhoneSignature,witness,now=Date.now}={}) {
  const checked=validateWitnessedNativeOracleTrial({goal,review,identity,wasmBytes,trustedReviewHash,trustedOwnerPublicKey});
  if(!witness || typeof witness.claimTrial!=='function' || typeof witness.inspect!=='function' ||
      typeof getFreshCompletion!=='function' || typeof requestPhoneSignature!=='function' || typeof now!=='function')throw fail();
  let retained;
  const account=createNativeOraclePhoneAccount({review:checked.review,wasmBytes,trustedReviewHash,trustedOwnerPublicKey,
    getFreshCompletion,now,requestPhoneSignature:async request=>{
      const trial={goal_id:checked.goal.id,goal_sha256:checked.goalSha256,agent_public_key:checked.agentPublicKey,
        original_hash:request.transactionHash};
      // Only a complete witnessed setup at the precise completion head can
      // produce this claim. No signature leaves the phone before readback.
      const saved=await witness.claimTrial(checked.identity,trial,request.completion.witness_head);
      assertWitnessedNativeOracleTrial(saved,checked.identity,trial);
      const reread=await witness.inspect(checked.identity.owner);
      assertWitnessedNativeOracleTrial(reread,checked.identity,trial);
      if(reread.head!==saved.head)throw fail();
      retained=structuredClone(trial);
      const fresh=structuredClone(await getFreshCompletion());
      assertNativeOracleCompletion(fresh,checked.review,now());
      if(fresh.witness_head!==saved.head || fresh.agent_key_nonce!==request.completion.agent_key_nonce ||
          fresh.block_height<request.completion.block_height ||
          (fresh.block_height===request.completion.block_height && (fresh.block_hash!==request.completion.block_hash ||
            fresh.block_timestamp_nanosec!==request.completion.block_timestamp_nanosec)) ||
          (fresh.block_height>request.completion.block_height && (fresh.block_hash===request.completion.block_hash ||
            BigInt(fresh.block_timestamp_nanosec)<BigInt(request.completion.block_timestamp_nanosec))) ||
          Date.parse(fresh.observed_at)<Date.parse(request.completion.observed_at) ||
          !isDeepStrictEqual(fresh.prior_original_hashes,request.completion.prior_original_hashes))throw fail();
      const proof={status:'TRIAL_ORIGINAL_WITNESSED',owner:checked.identity.owner,operation_id:checked.identity.operation_id,
        review_sha256:checked.identity.review_sha256,...trial,witness_head:saved.head,independently_witnessed:true,
        do_not_retry:true,execution_authorized:false,transaction_sent:false};
      const result=await requestPhoneSignature({...request,freshCompletion:fresh,witness:proof});
      if(result?.witnessed_original_matched!==true)throw fail();
      return result;
    }});
  return Object.freeze({...account,requiresWitnessedOriginal:true,
    async assertWitnessedOriginal(txHash){
      if(!retained || retained.original_hash!==txHash)throw fail();
      const snapshot=await witness.inspect(checked.identity.owner);
      assertWitnessedNativeOracleTrial(snapshot,checked.identity,retained);
      return {status:'WITNESSED_ORIGINAL_MATCH',owner:checked.identity.owner,original_hash:txHash,witness_head:snapshot.head};
    },
  });
}
