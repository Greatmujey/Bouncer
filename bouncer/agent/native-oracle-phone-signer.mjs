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
import nearApi from 'near-api-js';
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
