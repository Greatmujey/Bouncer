/**
 * Adapt the phone's already-signed, independently witnessed native oracle
 * trial to the existing guarded runner. No signing, HTTP, journal write or
 * broadcast happens in this module. The runner must use a shared durable
 * journal and its bounded one-shot sender. An uncertain result is recovered
 * by the witnessed original, never signed or submitted again automatically.
 *
 * Consent, a trusted authenticated completion supplier, the independent
 * latest-head checkpoint and safe transport of signed bearer bytes are caller
 * responsibilities. This is not an HTTP endpoint or an owner interface.
 * Separate journals, restored/rolled-back state, bypassing clients, a
 * compromised host or simultaneous anchor rollback remain outside its scope.
 */
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import nearApi from 'near-api-js';
import { createNativeOraclePhoneSigner, validateWitnessedNativeOracleTrial,
  assertWitnessedNativeOracleTrial } from './native-oracle-phone-signer.mjs';
import { assertNativeOracleCompletion } from '../web-src/native-oracle-completion.mjs';
import { NATIVE_ORACLE_TRIAL_GAS } from '../web-src/native-oracle-transaction.mjs';

const {transactions,utils}=nearApi;
const fail=()=>new Error('witnessed phone original unavailable or uncertain; stop and reconcile, never retry automatically');
const GAS=BigInt(NATIVE_ORACLE_TRIAL_GAS);

export function createPresignedWitnessedNativeOracleAccount({goal,review,identity,wasmBytes,loaderBytes,compressedBytes,trustedReviewHash,trustedOwnerPublicKey,
  signedResult,witness,otherWitness,getFreshCompletion,now=Date.now}={}) {
  const checked=validateWitnessedNativeOracleTrial({goal,review,identity,wasmBytes,loaderBytes,compressedBytes,trustedReviewHash,trustedOwnerPublicKey});
  if(!signedResult || signedResult.status!=='SIGNED_NOT_BROADCAST' || signedResult.owner!==checked.identity.owner ||
      signedResult.vault!==checked.review.vault || signedResult.review_sha256!==trustedReviewHash ||
      signedResult.maximum_native_yocto!==checked.review.per_tx_cap_yocto || signedResult.attached_deposit_yocto!=='0' ||
      signedResult.witnessed_original_matched!==true || signedResult.local_original_retained!==true ||
      signedResult.do_not_retry!==true || signedResult.broadcast_authorized!==false || signedResult.transaction_sent!==false ||
      !(signedResult.signed_transaction instanceof Uint8Array) || signedResult.signed_transaction.length>16_384 ||
      !witness || typeof witness.inspect!=='function' || !otherWitness || otherWitness===witness ||
      typeof otherWitness.inspect!=='function' || typeof getFreshCompletion!=='function' || typeof now!=='function')throw fail();
  // Copy before any asynchronous calls: the caller may otherwise mutate a
  // shared typed array between validation, journaling and the runner's send.
  const bytes=Uint8Array.from(signedResult.signed_transaction);
  let tx,unsigned,txHash,nonce,block,key;
  try {
    const decoded=transactions.SignedTransaction.decode(bytes);tx=decoded.transaction;
    key=utils.PublicKey.from(checked.agentPublicKey);
    if(key.keyType!==0 || tx.signerId!==checked.identity.owner || tx.receiverId!==checked.review.vault ||
        !Array.isArray(tx.publicKey?.ed25519Key?.data) ||
        !Buffer.from(tx.publicKey.ed25519Key.data).equals(Buffer.from(key.ed25519Key.data)) ||
        typeof tx.nonce!=='bigint' || tx.nonce<1n || tx.nonce>BigInt(Number.MAX_SAFE_INTEGER))throw Error();
    nonce=tx.nonce;block=Uint8Array.from(tx.blockHash);
    if(block.length!==32)throw Error();
    unsigned=Buffer.from(transactions.encodeTransaction(tx));
    const args={policy_id:checked.goal.policy_id,amount:checked.goal.amount,expected_route:checked.goal.route};
    const canonical=transactions.createTransaction(checked.identity.owner,key,checked.review.vault,nonce,
      [transactions.functionCall('execute_outlayer_native_project',args,GAS,0n)],block);
    const rawSignature=decoded.signature?.ed25519Signature?.data,digest=crypto.createHash('sha256').update(unsigned).digest();
    if(!Buffer.from(transactions.encodeTransaction(canonical)).equals(unsigned) ||
        !Buffer.from(transactions.encodeTransaction(decoded)).equals(Buffer.from(bytes)) ||
        !Array.isArray(rawSignature) || rawSignature.length!==64 || rawSignature.some(n=>!Number.isInteger(n) || n<0 || n>255) ||
        !key.verify(digest,Uint8Array.from(rawSignature)))throw Error();
    txHash=utils.serialize.base_encode(digest);
    if(txHash!==signedResult.tx_hash)throw Error();
  } catch { throw fail(); }
  const trial=Object.freeze({goal_id:checked.goal.id,goal_sha256:checked.goalSha256,agent_public_key:checked.agentPublicKey,original_hash:txHash});
  const copiedResult={status:'SIGNED_NOT_BROADCAST',tx_hash:txHash,signed_transaction:bytes,
    local_original_retained:true,do_not_retry:true,broadcast_authorized:false,transaction_sent:false};
  const phoneSigner=createNativeOraclePhoneSigner({review:checked.review,wasmBytes,loaderBytes,compressedBytes,trustedReviewHash,trustedOwnerPublicKey,
    requestPhoneSignature:async request=>{
      if(request.transactionHash!==txHash)throw fail();
      return {...copiedResult,signed_transaction:Uint8Array.from(bytes)};
    }});
  async function inspectPair(expectedHead) {
    const main=await witness.inspect(checked.identity.owner);
    assertWitnessedNativeOracleTrial(main,checked.identity,trial);
    if(expectedHead!==undefined && main.head!==expectedHead)throw fail();
    const peer=await otherWitness.inspect(checked.identity.owner);
    if(!peer || peer.head!==main.head || !Object.hasOwn(peer,'state') || peer.state!==null)throw fail();
    return main;
  }
  async function confirmOriginalAndState() {
    const before=await inspectPair(),completion=structuredClone(await getFreshCompletion());
    assertNativeOracleCompletion(completion,checked.review,now());
    const originals=before.state.records.filter(record=>record.event==='original').map(record=>record.original_hash);
    if(completion.witness_head!==before.head || completion.agent_key_nonce!==(nonce-1n).toString() ||
        !isDeepStrictEqual(completion.prior_original_hashes,originals))throw fail();
    const after=await inspectPair(before.head);
    return after.head;
  }
  let started=false,prepared=false,signerUsed=false;
  const signer=Object.freeze({getPublicKey:()=>phoneSigner.getPublicKey(),
    async signTransaction(transaction) {
      if(!prepared || signerUsed)throw fail();signerUsed=true;
      return phoneSigner.signTransaction(transaction);
    }});
  return Object.freeze({accountId:checked.identity.owner,signer,requiresWitnessedOriginal:true,
    async createTransaction(receiver,actions,publicKey) {
      if(started || receiver!==checked.review.vault || String(publicKey)!==checked.agentPublicKey || !Array.isArray(actions))throw fail();
      started=true;
      await confirmOriginalAndState();
      const candidate=transactions.createTransaction(checked.identity.owner,key,receiver,nonce,actions,new Uint8Array(block));
      if(!Buffer.from(transactions.encodeTransaction(candidate)).equals(unsigned))throw fail();
      prepared=true;return candidate;
    },
    async assertWitnessedOriginal(originalHash) {
      if(!prepared || !signerUsed || originalHash!==txHash)throw fail();
      const head=await confirmOriginalAndState();
      return {status:'WITNESSED_ORIGINAL_MATCH',owner:checked.identity.owner,original_hash:txHash,witness_head:head};
    },
  });
}
