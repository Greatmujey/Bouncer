/** Offline processing of a supplied fixed-brief Buffer order response. This
 * function never performs the POST, persists a record, authenticates the
 * owner or authorizes payment. The caller must hold a durable pre-POST claim,
 * authenticate and pin the encryption key beforehand, atomically retain the
 * ciphertext, and independently witness its commitment. An uncertain POST or
 * retention acknowledgement is never permission to retry. */
import { checkBufferOrderResponse } from '../experiments/buffer-forwarder/build.mjs';
import { sealPrivateOrder, privateOrderCapsuleCommitment } from '../web-src/buffer-private-order-capsule.mjs';

export async function sealCheckedFixedBufferOrder({terms,request,response,keyRecord,trustedPublicKeySha256,attemptId,
  nowMs=Date.now(),crypto=globalThis.crypto}={}) {
  try {
    if (typeof trustedPublicKeySha256!=='string' || !/^[a-f0-9]{64}$/.test(trustedPublicKeySha256) ||
        keyRecord?.public_key_sha256!==trustedPublicKeySha256 || keyRecord.owner!==terms?.owner) throw Error();
    const match=checkBufferOrderResponse(terms,request,response,{nowMs});
    const capsule=await sealPrivateOrder({keyRecord,attemptId,crypto,privateOrder:{brief:request.brief,sku:request.sku,
      orderId:response.orderId,onchainOrderId:response.onchainOrderId,accessToken:response.accessToken}});
    const capsuleSha256=await privateOrderCapsuleCommitment({capsule,crypto});
    return {capsule,capsule_sha256:capsuleSha256,checked_terms:match,
      retained:false,independently_witnessed:false,origin_verified:false,execution_authorized:false,delivered:false};
  } catch { throw Error('BUFFER_PRIVATE_ORDER_UNAVAILABLE'); }
}
