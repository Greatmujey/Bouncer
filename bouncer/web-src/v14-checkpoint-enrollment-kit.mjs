// Research-only enrollment of an independently retained checkpoint AND one
// encrypted key kit. One off-chain NEP-413 signature covers both. This does
// not deploy a vault, authorize payment or restore a journal. Not wired live.
import {validateV14EnrollmentTerms,V14_ENROLLMENT_SITE,V14_ENROLLMENT_RECIPIENT} from './v14-checkpoint-enrollment.mjs';
import {inspectV14SealedKit,openV14SecretKit} from './v14-secret-recovery-kit.mjs';
import {decodePublicKey,decodeSignature,nep413Payload,verifyCliLogin} from './cli-login.mjs';

const HEX=/^[a-f0-9]{64}$/;
const FIELDS=['format','network','owner','owner_public_key','vault','scope_id','review_sha256','capability_sha256','issued_ms','expires_ms','kit_sha256'];
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(key=>Object.hasOwn(x,key));
const fail=()=>new Error('V14 encrypted-kit enrollment unavailable; preserve existing originals and do not repeat a wallet prompt');
const b64=bytes=>btoa(String.fromCharCode(...bytes));
const hex=bytes=>[...bytes].map(byte=>byte.toString(16).padStart(2,'0')).join('');
export async function v14KitSha256(crypto,text) {
  if(!crypto?.subtle||typeof text!=='string'||new TextEncoder().encode(text).length>20000)throw fail();
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))));
}
export function validateV14KitEnrollmentTerms(input,{now}={}) {
  if(!exact(input,FIELDS)||input.format!=='bouncer-v14-checkpoint-kit-enrollment-v2'||!HEX.test(input.kit_sha256??''))throw fail();
  const base={...input,format:'bouncer-v14-checkpoint-enrollment-v1'};delete base.kit_sha256;
  validateV14EnrollmentTerms(base,{now});
  return Object.freeze({...input});
}
export function v14KitEnrollmentMessage(terms) {
  const t=validateV14KitEnrollmentTerms(terms);
  return `Bouncer TESTNET checkpoint and encrypted recovery-key kit enrollment\nAccount: ${t.owner}\nPublic key: ${t.owner_public_key}\n`+
    `Candidate vault: ${t.vault}\nReviewed setup SHA-256: ${t.review_sha256}\nCheckpoint scope: ${t.scope_id}\n`+
    `Checkpoint capability SHA-256: ${t.capability_sha256}\nEncrypted kit SHA-256: ${t.kit_sha256}\nSite: ${V14_ENROLLMENT_SITE}\n`+
    `Issued: ${new Date(t.issued_ms).toISOString()}\nExpires: ${new Date(t.expires_ms).toISOString()}\n`+
    'I approve retaining this checkpoint and encrypted key kit only. This does not deploy a vault, install a key, or authorize a payment.';
}
function inspectKitText(text,terms) {
  if(typeof text!=='string'||!text||new TextEncoder().encode(text).length>16000||/[\r\n]/.test(text))throw fail();
  let kit;try{kit=JSON.parse(text)}catch{throw fail()}
  if(JSON.stringify(kit)!==text)throw fail();
  inspectV14SealedKit({envelope:kit,owner:terms.owner,vault:terms.vault,scopeId:terms.scope_id,
    reviewSha256:terms.review_sha256,capabilitySha256:terms.capability_sha256});
  return kit;
}
export async function verifyV14KitText({text,terms,crypto=globalThis.crypto}={}) {
  const normalized=validateV14KitEnrollmentTerms(terms),kit=inspectKitText(text,normalized);
  if(await v14KitSha256(crypto,text)!==normalized.kit_sha256)throw fail();
  return kit;
}
/** Recheck the stored historical signature without asserting that its key is
 * still active. The caller must separately bind ownerPublicKey to the original
 * independently retained review and verify the current owner for read access. */
export async function verifyV14KitAttestation({text,owner,vault,ownerPublicKey,scopeId,reviewSha256,capabilitySha256,kitSha256,
    crypto=globalThis.crypto}={}) {
  try {
    if(typeof text!=='string'||new TextEncoder().encode(text).length>4096||/[\r\n]/.test(text)||!crypto?.subtle)throw fail();
    const attestation=JSON.parse(text);
    if(JSON.stringify(attestation)!==text||!exact(attestation,['terms','nonce_base64','signature_base64']))throw fail();
    const terms=validateV14KitEnrollmentTerms(attestation.terms);
    if(terms.owner!==owner||terms.vault!==vault||terms.owner_public_key!==ownerPublicKey||terms.scope_id!==scopeId||
        terms.review_sha256!==reviewSha256||terms.capability_sha256!==capabilitySha256||terms.kit_sha256!==kitSha256)throw fail();
    if(!/^[A-Za-z0-9+/]{43}=$/.test(attestation.nonce_base64??''))throw fail();
    const nonceText=atob(attestation.nonce_base64),signatureText=atob(attestation.signature_base64);
    if(nonceText.length!==32||btoa(nonceText)!==attestation.nonce_base64||btoa(signatureText)!==attestation.signature_base64)throw fail();
    const nonce=Uint8Array.from(nonceText,char=>char.charCodeAt(0)),signature=decodeSignature(attestation.signature_base64);
    const key=await crypto.subtle.importKey('raw',decodePublicKey(ownerPublicKey),{name:'Ed25519'},false,['verify']);
    const payload=nep413Payload({message:v14KitEnrollmentMessage(terms),nonce,recipient:V14_ENROLLMENT_RECIPIENT});
    const hash=await crypto.subtle.digest('SHA-256',payload);
    if(!await crypto.subtle.verify({name:'Ed25519'},key,signature,hash))throw fail();
    return {terms:{...terms},nonce_base64:attestation.nonce_base64,signature_base64:attestation.signature_base64};
  } catch {throw fail()}
}
/** Verify that the kit decrypts correctly on this device BEFORE requesting the
 * owner's single non-spending enrollment signature. The password is never sent
 * to the wallet or enrollment endpoint. Separate journal backups are still
 * mandatory; a key kit is not a journal or proof that no prompt occurred. */
export async function prepareV14KitEnrollment({draft,envelope,review,trustedReviewSha256,passphrase,
    crypto=globalThis.crypto,now=Date.now}={}) {
  if(typeof now!=='function'||!crypto?.subtle||!(draft?.nonce instanceof Uint8Array)||draft.nonce.length!==32||
      draft.recipient!==V14_ENROLLMENT_RECIPIENT||!HEX.test(draft.capability??''))throw fail();
  const base=validateV14EnrollmentTerms(draft.terms,{now:now()}),nonce=new Uint8Array(draft.nonce),capability=draft.capability;
  if(base.review_sha256!==trustedReviewSha256)throw fail();
  const kit=inspectV14SealedKit({envelope,owner:base.owner,vault:base.vault,scopeId:base.scope_id,
    reviewSha256:base.review_sha256,capabilitySha256:base.capability_sha256});
  const opened=await openV14SecretKit({envelope:kit,review,trustedReviewSha256,scopeId:base.scope_id,
    capabilitySha256:base.capability_sha256,passphrase,crypto});
  if(opened.capability!==capability)throw fail();
  const text=JSON.stringify(kit),kitSha256=await v14KitSha256(crypto,text);
  const terms=validateV14KitEnrollmentTerms({...base,format:'bouncer-v14-checkpoint-kit-enrollment-v2',kit_sha256:kitSha256},{now:now()});
  return {terms,nonce,recipient:V14_ENROLLMENT_RECIPIENT,message:v14KitEnrollmentMessage(terms),sealed_kit:text};
}
/** A single off-chain owner signature. Never automatically retry a lost result. */
export async function signV14KitEnrollment({draft,wallet,location,crypto=globalThis.crypto,fetch:fetchImpl=globalThis.fetch,now=Date.now}={}) {
  if(typeof now!=='function'||!wallet||typeof wallet.signMessage!=='function'||!crypto?.subtle||typeof fetchImpl!=='function'||
      location?.origin!==V14_ENROLLMENT_SITE||location?.host!==V14_ENROLLMENT_RECIPIENT||
      !(draft?.nonce instanceof Uint8Array)||draft.nonce.length!==32)throw fail();
  const terms=validateV14KitEnrollmentTerms(draft.terms,{now:now()}),message=v14KitEnrollmentMessage(terms),nonce=new Uint8Array(draft.nonce);
  const text=draft.sealed_kit;
  if(draft.recipient!==V14_ENROLLMENT_RECIPIENT||draft.message!==message)throw fail();
  await verifyV14KitText({text,terms,crypto});
  const mobile=wallet.manifest?.id==='near-mobile'?{accountId:terms.owner}:{};
  const signed=await wallet.signMessage({network:'testnet',signerId:terms.owner,...mobile,message,nonce:new Uint8Array(nonce),recipient:V14_ENROLLMENT_RECIPIENT});
  validateV14KitEnrollmentTerms(terms,{now:now()});
  if(signed?.accountId!==terms.owner||signed.publicKey!==terms.owner_public_key)throw fail();
  await verifyCliLogin({account:{accountId:terms.owner,publicKey:terms.owner_public_key,signedMessage:signed},
    message,nonce,recipient:V14_ENROLLMENT_RECIPIENT,crypto,fetch:fetchImpl});
  validateV14KitEnrollmentTerms(terms,{now:now()});
  return {terms:{...terms},nonce_base64:b64(nonce),signature_base64:signed.signature,sealed_kit:text};
}
