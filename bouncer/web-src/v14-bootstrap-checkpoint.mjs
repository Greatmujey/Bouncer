/** Research-only browser owner-signature helpers for an encrypted temporary
 * vault checkpoint. These never install a key, send or authorize a transaction. */
import {buildV14TemporaryBootstrapPlan} from './v14-bootstrap-plan.mjs';
import {openV14BootstrapRecoveryKit} from './v14-bootstrap-recovery-kit.mjs';
import {verifyCliLogin} from './cli-login.mjs';
import {V14_BOOTSTRAP_ORIGINS,V14_BOOTSTRAP_LIFETIME,validateBootstrapEnrollmentTerms,
  bootstrapEnrollmentMessage,verifyBootstrapEnrollmentContents,validateBootstrapRecoveryTerms,
  bootstrapRecoveryMessage,bootstrapSha256} from '../shared/v14-bootstrap-protocol.mjs';
export * from '../shared/v14-bootstrap-protocol.mjs';
const HEX=/^[a-f0-9]{64}$/,SCOPE=/^[a-f0-9]{32}$/;
const fail=()=>new Error('V14 bootstrap checkpoint unavailable; preserve originals and do not repeat a wallet prompt');
const b64=bytes=>btoa(String.fromCharCode(...bytes));

/** Rebuild the exact pinned review and open the encrypted kit before an
 * owner signature. The caller must also retain an independent recovery copy. */
export async function prepareBootstrapEnrollment({review:inputReview,kit:inputKit,passphrase,compressedV14,site,crypto=globalThis.crypto,now=Date.now}={}) {
  if(!crypto?.subtle||typeof crypto.getRandomValues!=='function'||typeof now!=='function'||!V14_BOOTSTRAP_ORIGINS.includes(site)||
    !inputReview||typeof inputReview!=='object'||!inputKit||typeof inputKit!=='object'||Array.isArray(inputKit))throw fail();
  const review=structuredClone(inputReview),kit=structuredClone(inputKit);
  const plan=await buildV14TemporaryBootstrapPlan({owner:review?.owner,ownerPublicKey:review?.owner_public_key,vault:review?.vault,
    temporaryPublicKey:review?.temporary_vault_public_key,vaultFundingYocto:review?.vault_funding_yocto,compressedV14,crypto});
  if(JSON.stringify(review)!==JSON.stringify(plan.review)||kit.format!=='bouncer-v14-temporary-bootstrap-kit-v1'||
    kit.owner!==review.owner||kit.vault!==review.vault||kit.owner_public_key!==review.owner_public_key||
    kit.temporary_public_key!==review.temporary_vault_public_key||kit.review_sha256!==review.review_sha256||
    !SCOPE.test(kit.scope_id??'')||!HEX.test(kit.capability_sha256??''))throw fail();
  const recovered=await openV14BootstrapRecoveryKit({kit,passphrase,crypto,expected:{owner:review.owner,vault:review.vault,
    ownerPublicKey:review.owner_public_key,temporaryPublicKey:review.temporary_vault_public_key,
    reviewSha256:review.review_sha256,scopeId:kit.scope_id}});
  recovered.dispose();
  const kitText=JSON.stringify(kit),reviewText=JSON.stringify(review);
  const issued=now(),terms=validateBootstrapEnrollmentTerms({format:'bouncer-v14-bootstrap-enrollment-v1',network:'testnet',
    owner:review.owner,owner_public_key:review.owner_public_key,vault:review.vault,temporary_public_key:review.temporary_vault_public_key,
    review_sha256:review.review_sha256,scope_id:kit.scope_id,capability_sha256:kit.capability_sha256,
    kit_sha256:await bootstrapSha256(crypto,kitText),site,issued_ms:issued,expires_ms:issued+V14_BOOTSTRAP_LIFETIME},{now:issued});
  return {terms,review_text:reviewText,sealed_kit:kitText,nonce:crypto.getRandomValues(new Uint8Array(32)),
    recipient:new URL(site).host,message:bootstrapEnrollmentMessage(terms)};
}
/** Sign a non-spending checkpoint enrollment once. A lost result is not
 * permission to start a different scope or transaction. */
export async function signBootstrapEnrollment({draft,wallet,location,crypto=globalThis.crypto,fetch:fetchImpl=globalThis.fetch,now=Date.now}={}) {
  if(!wallet||typeof wallet.signMessage!=='function'||!crypto?.subtle||typeof fetchImpl!=='function'||typeof now!=='function'||
    !(draft?.nonce instanceof Uint8Array)||draft.nonce.length!==32)throw fail();
  const t=validateBootstrapEnrollmentTerms(draft.terms,{now:now()}),nonce=new Uint8Array(draft.nonce),site=new URL(t.site);
  const message=bootstrapEnrollmentMessage(t),reviewText=draft.review_text,kitText=draft.sealed_kit;
  if(location?.origin!==t.site||location?.host!==site.host||draft.recipient!==site.host||draft.message!==message)throw fail();
  await verifyBootstrapEnrollmentContents({terms:t,reviewText,kitText,crypto});
  const mobile=wallet.manifest?.id==='near-mobile'?{accountId:t.owner}:{};
  const signed=await wallet.signMessage({network:'testnet',signerId:t.owner,...mobile,message,
    nonce:new Uint8Array(nonce),recipient:site.host});
  validateBootstrapEnrollmentTerms(t,{now:now()});
  if(signed?.accountId!==t.owner||signed.publicKey!==t.owner_public_key)throw fail();
  await verifyCliLogin({account:{accountId:t.owner,publicKey:t.owner_public_key,signedMessage:signed},message,
    nonce,recipient:site.host,crypto,fetch:fetchImpl});
  validateBootstrapEnrollmentTerms(t,{now:now()});
  return {terms:{...t},nonce_base64:b64(nonce),signature_base64:signed.signature,
    sealed_kit:kitText,review_text:reviewText};
}

/** Prepare and sign a recovery-only read; no key or transaction is restored. */
export function prepareBootstrapRecovery({owner,ownerPublicKey,vault,site,crypto=globalThis.crypto,now=Date.now}={}) {
  if(typeof crypto?.getRandomValues!=='function'||typeof now!=='function')throw fail();
  const issued=now(),terms=validateBootstrapRecoveryTerms({format:'bouncer-v14-bootstrap-recovery-v1',network:'testnet',owner,
    owner_public_key:ownerPublicKey,vault,site,issued_ms:issued,expires_ms:issued+V14_BOOTSTRAP_LIFETIME},{now:issued});
  return {terms,nonce:crypto.getRandomValues(new Uint8Array(32)),recipient:new URL(site).host,message:bootstrapRecoveryMessage(terms)};
}
export async function signBootstrapRecovery({draft,wallet,location,crypto=globalThis.crypto,fetch:fetchImpl=globalThis.fetch,now=Date.now}={}) {
  if(!wallet||typeof wallet.signMessage!=='function'||!crypto?.subtle||typeof fetchImpl!=='function'||typeof now!=='function'||
    !(draft?.nonce instanceof Uint8Array)||draft.nonce.length!==32)throw fail();
  const t=validateBootstrapRecoveryTerms(draft.terms,{now:now()}),site=new URL(t.site),nonce=new Uint8Array(draft.nonce);
  const message=bootstrapRecoveryMessage(t);
  if(location?.origin!==t.site||location?.host!==site.host||draft.recipient!==site.host||draft.message!==message)throw fail();
  const mobile=wallet.manifest?.id==='near-mobile'?{accountId:t.owner}:{};
  const signed=await wallet.signMessage({network:'testnet',signerId:t.owner,...mobile,message,
    nonce:new Uint8Array(nonce),recipient:site.host});
  validateBootstrapRecoveryTerms(t,{now:now()});
  if(signed?.accountId!==t.owner||signed.publicKey!==t.owner_public_key)throw fail();
  await verifyCliLogin({account:{accountId:t.owner,publicKey:t.owner_public_key,signedMessage:signed},message,
    nonce,recipient:site.host,crypto,fetch:fetchImpl});
  validateBootstrapRecoveryTerms(t,{now:now()});
  return {terms:{...t},nonce_base64:b64(nonce),signature_base64:signed.signature};
}
