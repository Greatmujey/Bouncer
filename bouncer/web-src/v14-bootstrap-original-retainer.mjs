/**
 * Retain one temporary-bootstrap original in the already-provisioned two-copy
 * witness. This is not wired to the live wallet or mission. It never prompts,
 * signs, broadcasts or retries a transaction. In particular, a wallet that
 * sends before returning its hash can leave only a durable claim. Recovery is
 * then manual: locate its original hash in wallet history, verify that exact
 * FINAL transaction and vault key, and only then retain it in both copies.
 *
 * The caller must separately prove that its stores and encrypted key are
 * recoverable, the independent latest head is trustworthy, the preflight is
 * fresh, and the owner explicitly approved any transaction. A branded witness
 * or a successful append is not proof of any of those requirements.
 */
import {createTransaction,encodeTransaction,SignedTransaction} from '@near-js/transactions';
import {PublicKey} from '@near-js/crypto';
import {buildV14TemporaryBootstrapPlan} from './v14-bootstrap-plan.mjs';
import {isBootstrapTwoCopyWitness,bootstrapWitnessUsesCreateVerifier} from './v14-bootstrap-originals.mjs';
import {isV14BootstrapCreateVerifier} from './v14-bootstrap-create-verifier.mjs';
import {decodeNativeHash32,encodeBase58} from './native-oracle-transaction.mjs';

const MAX_BYTES=1_000_000;
const retainers=new WeakMap();
// In-realm identity only; it does not establish storage independence or freshness.
export const isBootstrapOriginalRetainer=(value,witness,reviewSha256)=>{
  const binding=retainers.get(value);
  return Boolean(binding&&binding.witness===witness&&binding.review_sha256===reviewSha256);
};
const fail=()=>new Error('Bootstrap original could not be safely retained; stop and reconcile without another wallet prompt or send');
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const hash=x=>{try{decodeNativeHash32(x);return true}catch{return false}};
const bytesEqual=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);

/** Rebuild the reviewed plan before accepting any original. The witness must
 * already be bound to the retained scope/review and configured with the real
 * create verifier; it must not be initialized as a substitute for lost state. */
export async function createBootstrapOriginalRetainer({review:inputReview,compressedV14:inputCompressed,witness,verifyCreateFinal,
  crypto=globalThis.crypto}={}) {
  if(!inputReview||!(inputCompressed instanceof Uint8Array)||!isBootstrapTwoCopyWitness(witness)||
    !isV14BootstrapCreateVerifier(verifyCreateFinal)||!bootstrapWitnessUsesCreateVerifier(witness,verifyCreateFinal)||!crypto?.subtle)throw fail();
  const review=structuredClone(inputReview),compressedV14=new Uint8Array(inputCompressed),binding=witness.binding();
  const plan=await buildV14TemporaryBootstrapPlan({owner:review.owner,ownerPublicKey:review.owner_public_key,vault:review.vault,
    temporaryPublicKey:review.temporary_vault_public_key,vaultFundingYocto:review.vault_funding_yocto,compressedV14,crypto});
  if(JSON.stringify(review)!==JSON.stringify(plan.review)||binding.review_sha256!==review.review_sha256||
    !isV14BootstrapCreateVerifier(verifyCreateFinal,review.review_sha256))throw fail();
  let busy=false,walletResultConsumed=false;
  async function run(fn){if(busy)throw fail();busy=true;try{return await fn()}finally{busy=false}}
  const result=(status,originalHash)=>Object.freeze({status,original_hash:originalHash,do_not_retry:true,
    final_execution_verified:false,independent_recovery_verified:false,transaction_authorized:false,transaction_sent_by_this_operation:false});
  const retainer=Object.freeze({
    /** Call once after a pre-claimed wallet prompt returns. A malformed, lost,
     * cancelled or conflicting response is UNKNOWN, not evidence of failure.
     * Even when the wallet/session changed, try to preserve a returned hash. */
    async retainWalletResult(outcome){return run(async()=>{
      if(walletResultConsumed)throw fail();walletResultConsumed=true;
      const candidates=[outcome?.transaction?.hash,outcome?.transaction_outcome?.id].filter(x=>x!==undefined);
      const originalHash=candidates.length&&candidates.every(hash)&&new Set(candidates).size===1?candidates[0]:null;
      try {
        const before=await witness.inspect();
        if(before.next_event!=='create_original'||before.create_original!==null)throw fail();
        if(originalHash===null)return result('WALLET_RESULT_UNKNOWN',null);
        const after=await witness.retainCreateOriginal(originalHash);
        if(after.create_original!==originalHash||after.next_event!=='deploy_claim')throw fail();
        return result('CREATE_ORIGINAL_RETAINED',originalHash);
      }catch{
        // One copy may have committed. Return the hash to the caller to save,
        // but never retry an uncertain append or a wallet prompt automatically.
        return result('ORIGINAL_RETENTION_UNCERTAIN',originalHash);
      }
    })},
    /** A human-supplied wallet-history hash is NOT treated like a returned hash:
     * the configured verifier must first check the exact FINAL create receipt
     * and fresh vault/key state. If unavailable, both copies remain at claim. */
    async recoverCreateFromWalletHistory(originalHash){return run(async()=>{
      if(!hash(originalHash))throw fail();walletResultConsumed=true;
      const after=await witness.retainRecoveredCreateOriginal(originalHash);
      if(after.create_original!==originalHash||after.next_event!=='deploy_claim')throw fail();
      return Object.freeze({...result('RECOVERED_CREATE_ORIGINAL_RETAINED',originalHash),final_execution_verified:true});
    })},
    /** Validate the exact signed deployment and persist its hash in BOTH
     * copies before any caller can consider sending it. Signed bytes are a
     * bearer artifact: this function does not return or persist them. A later
     * unresolved hash is not permission to resend, including the same bytes. */
    async retainSignedDeployment(input){return run(async()=>{
      if(!exact(input,['status','transaction_hash','nonce','block_hash','signed_bytes','transaction_sent'])||
        input.status!=='SIGNED_NOT_BROADCAST'||input.transaction_sent!==false||!hash(input.transaction_hash)||
        typeof input.nonce!=='string'||!/^[1-9][0-9]{0,19}$/.test(input.nonce)||BigInt(input.nonce)>=(1n<<64n)||
        !hash(input.block_hash)||!(input.signed_bytes instanceof Uint8Array)||input.signed_bytes.length<100||
        input.signed_bytes.length>MAX_BYTES)throw fail();
      // Do not allow caller mutation while hashing or waiting for a store.
      const originalHash=input.transaction_hash,nonce=input.nonce,blockHash=input.block_hash,bytes=new Uint8Array(input.signed_bytes);
      let signed;
      try {
        try{signed=SignedTransaction.decode(bytes)}catch{throw fail()}
        const tx=signed?.transaction,block=decodeNativeHash32(blockHash),key=PublicKey.from(review.temporary_vault_public_key);
        if(!tx||typeof tx.nonce!=='bigint'||tx.nonce!==BigInt(nonce)||
          !Array.isArray(tx.blockHash)||!bytesEqual(Uint8Array.from(tx.blockHash),block)||
          !exact(signed.signature,['ed25519Signature'])||!Array.isArray(signed.signature.ed25519Signature?.data)||
          signed.signature.ed25519Signature.data.length!==64||!bytesEqual(encodeTransaction(signed),bytes))throw fail();
        const expected=createTransaction(review.vault,key,review.vault,tx.nonce,plan.deploymentActions,block);
        const unsigned=encodeTransaction(tx);
        if(!bytesEqual(unsigned,encodeTransaction(expected)))throw fail();
        const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',unsigned));
        if(encodeBase58(digest)!==originalHash||!key.verify(digest,Uint8Array.from(signed.signature.ed25519Signature.data)))throw fail();
        const before=await witness.inspect();
        if(before.next_event!=='deploy_original'||!before.create_original||before.deploy_original!==null)throw fail();
        try {
          const after=await witness.retainDeploymentOriginal(originalHash,before.head_sha256);
          if(after.deploy_original!==originalHash||after.next_event!==null)throw fail();
          return result('DEPLOYMENT_ORIGINAL_RETAINED',originalHash);
        }catch{return result('ORIGINAL_RETENTION_UNCERTAIN',originalHash)}
      } finally {
        // Best effort only: JavaScript cannot promise memory erasure and the
        // caller still owns its original bearer bytes until it disposes them.
        bytes.fill(0);signed?.signature?.ed25519Signature?.data?.fill?.(0);
      }
    })},
  });
  retainers.set(retainer,{witness,review_sha256:review.review_sha256});
  return retainer;
}
