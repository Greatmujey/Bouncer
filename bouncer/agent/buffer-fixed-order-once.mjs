/** EXPERIMENTAL fixed-price Buffer order transport. The unpaid POST is issued
 * AT MOST ONCE per successful, authenticated PostgreSQL+independent-witness
 * claim. No wallet transaction, agent key, payment or delivery occurs here.
 * Disabled unless a caller explicitly constructs and invokes it; there is no
 * HTTP/UI wiring. A lost seller response or retention acknowledgement is UNKNOWN
 * and never a reason to retry. The backend and Buffer both see the brief/bearer.
 *
 * `preflight` is a REQUIRED trusted boundary: it must independently verify the
 * owner/funding, reviewed fixed product, current Circle/seller code and price
 * against one fresh FINAL testnet block, plus operational readiness. Its
 * response must meet the bounded shape below; a fabricated callback is not a
 * chain check. Independent durable journal/witness, authentication, TLS,
 * seller source, RPC, clock, and backend integrity are assumptions. */
import crypto from 'node:crypto';
import {verifyBufferSpendingReview} from './buffer-wallet-spending-evidence.mjs';
import {validateBufferOrderIdentity} from './git-buffer-order-witness.mjs';
import {sealCheckedFixedBufferOrder} from './buffer-private-order-seal.mjs';
import {privateBufferRequestCommitment,inspectPrivateOrderKeyRecord} from '../web-src/buffer-private-order-capsule.mjs';
import {readBoundedJson} from '../shared/bounded-json.mjs';
import {isTransactionHash} from '../shared/direct-payment-settlement.mjs';
import {CIRCLE_TESTNET_CODE_HASH} from './keyless-vault-v12-readiness.mjs';
import {BUFFER_TESTNET_CONTRACT} from '../experiments/buffer-forwarder/build.mjs';

const SELLER_URL='https://buffer-zeta.vercel.app/api/orders', PRICE='20000000', NEAR=10n**24n;
const exact=(x,keys)=>x && typeof x==='object' && !Array.isArray(x) && Object.keys(x).length===keys.length && keys.every(k=>Object.hasOwn(x,k));
const fail=()=>new BufferOrderAttemptError();
export class BufferOrderAttemptError extends Error {
  constructor() {super('Buffer order result is unknown or blocked; never repeat an uncertain order');this.code='BUFFER_ORDER_UNKNOWN';}
}
export function createFixedBufferOrderOnce({journal,preflight,fetch:fetchImpl=globalThis.fetch,crypto:wc=globalThis.crypto,now=Date.now,
  trustedSellerCodeHash}={}) {
  if(!journal || typeof journal.claim!=='function' || typeof journal.retainClaimedResult!=='function' ||
      typeof preflight!=='function' || typeof fetchImpl!=='function' || !wc?.subtle || typeof now!=='function' ||
      !isTransactionHash(trustedSellerCodeHash)) throw fail();
  async function checkedPreflight(id,review,sku) {
    const profile=await preflight({identity:structuredClone(id),review:structuredClone(review),sku});
    const clock=now();
    if (!Number.isSafeInteger(clock) || !profile || profile.status!=='READ_ONLY_BUFFER_ORDER_PROFILE_MATCH' ||
        profile.network!=='testnet' || profile.owner!==id.owner || profile.adapter!==review.adapter ||
        profile.review_sha256!==id.review_sha256 || profile.sku!==sku || profile.amount_atoms!==PRICE ||
        profile.seller!==BUFFER_TESTNET_CONTRACT || profile.seller_code_hash!==trustedSellerCodeHash ||
        profile.circle_code_hash!==CIRCLE_TESTNET_CODE_HASH || !isTransactionHash(profile.block_hash) ||
        !Number.isSafeInteger(profile.checked_at_ms) || profile.checked_at_ms>clock || clock-profile.checked_at_ms>5000) throw fail();
  }
  return Object.freeze({
    async submit({identity:raw,keyRecord:rawKey,draft:rawDraft,review:rawReview,config:rawConfig,claimEvidence}={}) {
      let claim, capsuleResult, claimAttempted=false, postStarted=false;
      try {
        const id=validateBufferOrderIdentity(structuredClone(raw)),keyRecord=structuredClone(rawKey),draft=structuredClone(rawDraft),
          review=structuredClone(rawReview),config=structuredClone(rawConfig), clock=now();
        if(!Number.isSafeInteger(clock) || !exact(config,['intent_id','expires_at_ms','native_return_cap','native_reserve']) ||
            typeof config.intent_id!=='string' || !/^[A-Za-z0-9_-]{1,64}$/.test(config.intent_id) ||
            !Number.isSafeInteger(config.expires_at_ms) || config.expires_at_ms<clock+15*60_000 || config.expires_at_ms>clock+24*60*60_000 ||
            typeof config.native_return_cap!=='string' || !/^(0|[1-9][0-9]{0,38})$/.test(config.native_return_cap) ||
            BigInt(config.native_return_cap)>2n*NEAR || typeof config.native_reserve!=='string' ||
            !/^[1-9][0-9]{0,38}$/.test(config.native_reserve) || BigInt(config.native_reserve)<NEAR || BigInt(config.native_reserve)>2n*NEAR) throw fail();
        const info=await inspectPrivateOrderKeyRecord({keyRecord,crypto:wc});
        if(info.owner!==id.owner || info.owner_public_key!==id.owner_public_key || info.site!==id.site ||
            info.public_key_sha256!==id.key_sha256 || info.key_record_sha256!==id.key_record_sha256) throw fail();
        const reviewed=verifyBufferSpendingReview({review,trustedReviewHash:id.review_sha256,trustedOwnerPublicKey:id.owner_public_key});
        if(reviewed.owner!==id.owner || BigInt(review.per_tx_cap_atoms)<BigInt(PRICE) || BigInt(review.daily_cap_atoms)<BigInt(PRICE) ||
            draft.customerAccount!==reviewed.adapter || await privateBufferRequestCommitment({keyRecord,attemptId:id.attempt_id,draft,crypto:wc})!==id.request_commitment_sha256) throw fail();
        await checkedPreflight(id,review,draft.sku);
        claimAttempted=true;
        claim=await journal.claim({identity:id,evidence:claimEvidence});
        if(claim?.status!=='CLAIMED_NO_RESULT' || claim.independently_witnessed!==true || claim.do_not_retry!==true) throw fail();
        // The first preflight may have aged during owner authentication / Git.
        // A failed second one consumes the claim but never contacts the seller.
        await checkedPreflight(id,review,draft.sku);
        const request={brief:draft.brief,sku:draft.sku,customerAccount:draft.customerAccount};
        postStarted=true;
        const response=await fetchImpl(SELLER_URL,{method:'POST',redirect:'error',credentials:'omit',cache:'no-store',
          headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(15_000)});
        let body;
        try {
          if(!response?.ok) throw fail();
          body=await readBoundedJson(response,{maxBytes:32_768,label:'Buffer order response'});
        } finally {await response?.body?.cancel().catch(()=>{});}
        const terms={owner:id.owner,vault:reviewed.vault,adapter:reviewed.adapter,
          forwarder_agent_public_key:reviewed.forwarder_agent_public_key,vault_agent_public_key:reviewed.vault_agent_public_key,
          policy_id:review.policy_id,intent_id:config.intent_id,amount:PRICE,expires_at_ms:config.expires_at_ms,
          native_return_cap:config.native_return_cap,native_reserve:config.native_reserve,api_order_id:body?.orderId,
          onchain_order_id:body?.onchainOrderId,sku:draft.sku,brief_sha256:crypto.createHash('sha256').update(draft.brief,'utf8').digest('hex')};
        capsuleResult=await sealCheckedFixedBufferOrder({terms,request,response:body,keyRecord,trustedPublicKeySha256:id.key_sha256,
          attemptId:id.attempt_id,nowMs:now(),crypto:wc});
        try {
          const retained=await journal.retainClaimedResult({claim,keyRecord,capsule:capsuleResult.capsule});
          if(retained?.status!=='SEALED' || retained.capsule_sha256!==capsuleResult.capsule_sha256) throw fail();
          return {status:'ORDER_RESPONSE_SEALED',terms,capsule_sha256:retained.capsule_sha256,
            independently_witnessed:true,do_not_retry:true,payment_sent:false,delivery_verified:false,
            scope:'Unpaid seller response checked and encrypted; HTTP origin, seller service, future chain state and delivery remain assumptions.'};
        } catch {
          // The owner may recover this encrypted response with a separate
          // authenticated record operation; never reissue the seller POST.
          return {status:'ORDER_RETENTION_UNKNOWN',recovery_capsule:capsuleResult.capsule,
            capsule_sha256:capsuleResult.capsule_sha256,do_not_retry:true,payment_sent:false,delivery_verified:false};
        }
      } catch {
        // A request may have reached the seller even if fetch throws or the
        // response is malformed. Do not leak response bodies or credentials.
        const error=fail(); error.claim_may_be_consumed=claimAttempted; error.seller_post_may_have_occurred=postStarted; throw error;
      }
    },
  });
}
