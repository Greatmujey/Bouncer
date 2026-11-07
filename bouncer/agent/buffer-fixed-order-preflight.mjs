/** Read-only preflight for creating the FIRST unpaid fixed Buffer order. It
 * rechecks all three original setup receipt graphs and one fresh FINAL block
 * using the existing vault setup inspector. It does not verify future state,
 * a seller HTTP response, a forwarder, agent keys, payment or delivery. */
import {inspectBufferWalletSetupStage} from './buffer-wallet-setup-preflight.mjs';
import {verifyBufferSpendingReview} from './buffer-wallet-spending-evidence.mjs';
import {validateBufferOrderIdentity} from './git-buffer-order-witness.mjs';
import {CIRCLE_TESTNET_CODE_HASH} from './keyless-vault-v12-readiness.mjs';
import {BUFFER_TESTNET_CONTRACT} from '../experiments/buffer-forwarder/build.mjs';
import {isTransactionHash} from '../shared/direct-payment-settlement.mjs';
const fail=()=>Error('BUFFER_ORDER_PREFLIGHT_UNAVAILABLE');
/** The reviewed setup inputs and original hashes must be independently retained
 * by the operator; accepting them from the ordering browser would not be an
 * independent trust anchor. The injected provider is a trusted read-only RPC. */
export function createBufferFixedOrderPreflight({setupReview:rawReview,setupSnapshot:rawSnapshot,wasmBytes:rawWasm,
  trustedSetupReviewHash,trustedOwnerPublicKey,trustedSellerCodeHash,priorOriginals:rawOriginals,provider,now=Date.now}={}) {
  const setupReview=structuredClone(rawReview),setupSnapshot=structuredClone(rawSnapshot),
    wasmBytes=rawWasm instanceof Uint8Array?Buffer.from(rawWasm):null,priorOriginals=structuredClone(rawOriginals);
  if(!wasmBytes || !Array.isArray(priorOriginals) || priorOriginals.length!==3 ||
      !/^[a-f0-9]{64}$/.test(trustedSetupReviewHash ?? '') || !isTransactionHash(trustedSellerCodeHash) ||
      typeof trustedOwnerPublicKey!=='string' || !provider || typeof now!=='function') throw fail();
  return async ({identity:rawIdentity,review:rawSpendingReview,sku}={})=>{
    try {
      const identity=validateBufferOrderIdentity(structuredClone(rawIdentity)),review=structuredClone(rawSpendingReview);
      if(identity.owner_public_key!==trustedOwnerPublicKey || sku!=='weekly-market-brief') throw fail();
      const spending=verifyBufferSpendingReview({review,trustedReviewHash:identity.review_sha256,trustedOwnerPublicKey});
      if(spending.owner!==identity.owner || spending.vault!==setupReview?.vault || spending.owner!==setupReview?.owner ||
          review.per_tx_cap_atoms!=='20000000' || review.daily_cap_atoms!=='20000000') throw fail();
      const result=await inspectBufferWalletSetupStage({review:setupReview,snapshot:setupSnapshot,wasmBytes,
        trustedReviewHash:trustedSetupReviewHash,trustedOwnerPublicKey,trustedSellerCodeHash,
        stageId:'verify_funded_vault',priorOriginals,provider,now});
      const checkedAt=Date.parse(result.checked_at);
      if(result.status!=='READ_ONLY_SETUP_STAGE_PROFILE_MATCH' || result.network!=='testnet' || result.owner!==identity.owner ||
          result.vault!==spending.vault || result.seller!==BUFFER_TESTNET_CONTRACT || result.prior_receipt_graphs_matched!==3 ||
          result.seller_code_hash!==trustedSellerCodeHash || result.checks?.circle_and_seller_code_pins!=='PASS' ||
          result.checks?.seller_active_and_price_matches!=='PASS' || result.checks?.vault_token_funding_expected!=='PASS' ||
          result.checks?.final_block_fresh_at_completion!=='PASS' || !Number.isSafeInteger(checkedAt) ||
          !isTransactionHash(result.block_hash) || !Array.isArray(result.blockers) || result.blockers.length) throw fail();
      return {status:'READ_ONLY_BUFFER_ORDER_PROFILE_MATCH',network:'testnet',owner:identity.owner,adapter:spending.adapter,
        review_sha256:identity.review_sha256,sku,amount_atoms:'20000000',seller:BUFFER_TESTNET_CONTRACT,
        seller_code_hash:trustedSellerCodeHash,circle_code_hash:CIRCLE_TESTNET_CODE_HASH,block_hash:result.block_hash,checked_at_ms:checkedAt,
        scope:'Trusted RPC and independently retained setup receipts only; no seller order, agent authority, purchase or delivery.'};
    } catch {throw fail()}
  };
}
