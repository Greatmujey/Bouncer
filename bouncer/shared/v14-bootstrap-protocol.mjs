// Public, dependency-light protocol shared by the browser and Edge. It
// validates owner-signed metadata and encrypted-envelope shape, but cannot
// decrypt keys, sign, broadcast, establish freshness or authorize spending.
import {isV14CheckpointAccountPair} from '../web-src/v14-checkpoint-enrollment.mjs';
import {decodePublicKey,decodeSignature,nep413Payload} from '../web-src/cli-login.mjs';

export const V14_BOOTSTRAP_ORIGINS=Object.freeze(['https://bouncer-near.vercel.app','https://bouncer-production-6df1.up.railway.app']);
export const V14_BOOTSTRAP_LIFETIME=180_000;
const HEX=/^[a-f0-9]{64}$/,SCOPE=/^[a-f0-9]{32}$/,KEY=/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const FIELDS=['format','network','owner','owner_public_key','vault','temporary_public_key','review_sha256','scope_id',
  'capability_sha256','kit_sha256','site','issued_ms','expires_ms'];
const RECOVERY_FIELDS=['format','network','owner','owner_public_key','vault','site','issued_ms','expires_ms'];
const KIT_FIELDS=['format','network','owner','owner_public_key','vault','temporary_public_key','review_sha256','scope_id',
  'capability_sha256','kdf','iterations','salt','iv','ciphertext'];
const exact=(value,fields)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===fields.length&&
  fields.every(field=>Object.hasOwn(value,field));
const fail=()=>new Error('V14 bootstrap checkpoint unavailable; preserve originals and do not repeat a wallet prompt');
const hex=bytes=>[...bytes].map(n=>n.toString(16).padStart(2,'0')).join('');
function key(value) {
  try{const bytes=decodePublicKey(value);return bytes.some(byte=>byte!==0)}catch{return false}
}
function base64(value,minimum,maximum) {
  if(typeof value!=='string'||value.length>8192||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw fail();
  let text;try{text=atob(value)}catch{throw fail()}
  if(text.length<minimum||text.length>maximum||btoa(text)!==value)throw fail();
  return text;
}
export async function bootstrapSha256(crypto,text) {
  if(!crypto?.subtle||typeof text!=='string'||new TextEncoder().encode(text).length>32_000)throw fail();
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))));
}
export function validateBootstrapEnrollmentTerms(t,{now}={}) {
  if(!exact(t,FIELDS)||t.format!=='bouncer-v14-bootstrap-enrollment-v1'||t.network!=='testnet'||
    !isV14CheckpointAccountPair(t.vault,t.owner)||!KEY.test(t.owner_public_key??'')||!KEY.test(t.temporary_public_key??'')||
    !key(t.owner_public_key)||!key(t.temporary_public_key)||t.owner_public_key===t.temporary_public_key||
    !HEX.test(t.review_sha256??'')||!SCOPE.test(t.scope_id??'')||!HEX.test(t.capability_sha256??'')||!HEX.test(t.kit_sha256??'')||
    !V14_BOOTSTRAP_ORIGINS.includes(t.site)||!Number.isSafeInteger(t.issued_ms)||t.issued_ms<1||!Number.isSafeInteger(t.expires_ms)||
    t.expires_ms-t.issued_ms!==V14_BOOTSTRAP_LIFETIME||!Number.isFinite(new Date(t.expires_ms).getTime()))throw fail();
  if(now!==undefined&&(!Number.isSafeInteger(now)||now<t.issued_ms-30_000||now>=t.expires_ms))throw fail();
  return Object.freeze({...t});
}
function publicKit(kit) {
  if(!exact(kit,KIT_FIELDS)||kit.format!=='bouncer-v14-temporary-bootstrap-kit-v1'||kit.network!=='testnet'||
    !isV14CheckpointAccountPair(kit.vault,kit.owner)||!key(kit.owner_public_key)||!key(kit.temporary_public_key)||
    kit.owner_public_key===kit.temporary_public_key||!HEX.test(kit.review_sha256??'')||!SCOPE.test(kit.scope_id??'')||
    !HEX.test(kit.capability_sha256??'')||kit.kdf!=='PBKDF2-SHA256'||kit.iterations!==600_000)throw fail();
  base64(kit.salt,16,16);base64(kit.iv,12,12);base64(kit.ciphertext,16,4096);return kit;
}
/** Check ciphertext and public review bindings; not evidence of successful
 * decryption, owner control, server durability, or transaction authorization. */
export async function verifyBootstrapEnrollmentContents({terms,reviewText,kitText,crypto=globalThis.crypto}={}) {
  const t=validateBootstrapEnrollmentTerms(terms);
  if(typeof reviewText!=='string'||typeof kitText!=='string'||/[\r\n]/.test(reviewText+kitText)||
    new TextEncoder().encode(reviewText).length>24_000||new TextEncoder().encode(kitText).length>16_000)throw fail();
  let review,kit;try{review=JSON.parse(reviewText);kit=JSON.parse(kitText)}catch{throw fail()}
  if(JSON.stringify(review)!==reviewText||JSON.stringify(kit)!==kitText||!review||typeof review!=='object'||Array.isArray(review))throw fail();
  const {review_sha256:reviewHash,...body}=review,header=publicKit(kit);
  if(reviewHash!==t.review_sha256||await bootstrapSha256(crypto,JSON.stringify(body))!==reviewHash||
    body.format!=='bouncer-v14-temporary-vault-bootstrap-v1'||body.network!=='testnet'||body.owner!==t.owner||
    body.owner_public_key!==t.owner_public_key||body.vault!==t.vault||body.temporary_vault_public_key!==t.temporary_public_key||
    body.wallet_approval_obtained!==false||body.transaction_sent!==false||header.owner!==t.owner||header.vault!==t.vault||
    header.owner_public_key!==t.owner_public_key||header.temporary_public_key!==t.temporary_public_key||
    header.scope_id!==t.scope_id||header.review_sha256!==t.review_sha256||header.capability_sha256!==t.capability_sha256||
    await bootstrapSha256(crypto,kitText)!==t.kit_sha256)throw fail();
  return {review,kit};
}
export function bootstrapEnrollmentMessage(input) {
  const t=validateBootstrapEnrollmentTerms(input);
  return `Bouncer TESTNET temporary-vault recovery checkpoint\nOwner: ${t.owner}\nOwner public key: ${t.owner_public_key}\n`+
    `Candidate new vault: ${t.vault}\nTemporary vault public key: ${t.temporary_public_key}\n`+
    `Reviewed setup SHA-256: ${t.review_sha256}\nCheckpoint scope: ${t.scope_id}\n`+
    `Capability SHA-256: ${t.capability_sha256}\nEncrypted recovery kit SHA-256: ${t.kit_sha256}\n`+
    `Site: ${t.site}\nIssued: ${new Date(t.issued_ms).toISOString()}\nExpires: ${new Date(t.expires_ms).toISOString()}\n`+
    'I request only the retention of this encrypted recovery kit and original transaction hashes. This does not create a vault, install a key, or authorize a payment. If later installed, the temporary key would have FullAccess to the new vault until deleted.';
}
export function validateBootstrapRecoveryTerms(t,{now}={}) {
  if(!exact(t,RECOVERY_FIELDS)||t.format!=='bouncer-v14-bootstrap-recovery-v1'||t.network!=='testnet'||
    !isV14CheckpointAccountPair(t.vault,t.owner)||!KEY.test(t.owner_public_key??'')||!key(t.owner_public_key)||!V14_BOOTSTRAP_ORIGINS.includes(t.site)||
    !Number.isSafeInteger(t.issued_ms)||t.issued_ms<1||!Number.isSafeInteger(t.expires_ms)||
    t.expires_ms-t.issued_ms!==V14_BOOTSTRAP_LIFETIME||!Number.isFinite(new Date(t.expires_ms).getTime()))throw fail();
  if(now!==undefined&&(!Number.isSafeInteger(now)||now<t.issued_ms-30_000||now>=t.expires_ms))throw fail();
  return Object.freeze({...t});
}
export function bootstrapRecoveryMessage(input) {
  const t=validateBootstrapRecoveryTerms(input);
  return `Bouncer TESTNET temporary-vault recovery read\nOwner: ${t.owner}\nCurrent owner public key: ${t.owner_public_key}\n`+
    `Vault: ${t.vault}\nSite: ${t.site}\nIssued: ${new Date(t.issued_ms).toISOString()}\nExpires: ${new Date(t.expires_ms).toISOString()}\n`+
    'I request only the existing encrypted recovery kit and original hashes. This does not decrypt a key, restore authorization, or permit another transaction.';
}
/** Historical signature verification; a fresh owner signature is separately
 * required for read and neither signature grants transaction permission. */
export async function verifyBootstrapAttestation({text,terms:expected,crypto=globalThis.crypto}={}) {
  if(typeof text!=='string'||new TextEncoder().encode(text).length>8192||/[\r\n]/.test(text)||!crypto?.subtle)throw fail();
  let att;try{att=JSON.parse(text)}catch{throw fail()}
  if(JSON.stringify(att)!==text||!exact(att,['terms','nonce_base64','signature_base64']))throw fail();
  const terms=validateBootstrapEnrollmentTerms(att.terms);
  if(expected&&JSON.stringify(terms)!==JSON.stringify(validateBootstrapEnrollmentTerms(expected)))throw fail();
  if(!/^[A-Za-z0-9+/]{43}=$/.test(att.nonce_base64??''))throw fail();
  let nonceText,signature;try{nonceText=atob(att.nonce_base64);signature=decodeSignature(att.signature_base64)}catch{throw fail()}
  if(nonceText.length!==32||btoa(nonceText)!==att.nonce_base64)throw fail();
  const nonce=Uint8Array.from(nonceText,c=>c.charCodeAt(0)),pub=await crypto.subtle.importKey('raw',decodePublicKey(terms.owner_public_key),{name:'Ed25519'},false,['verify']);
  const payload=nep413Payload({message:bootstrapEnrollmentMessage(terms),nonce,recipient:new URL(terms.site).host});
  const digest=await crypto.subtle.digest('SHA-256',payload);
  if(!await crypto.subtle.verify({name:'Ed25519'},pub,signature,digest))throw fail();
  return {terms,nonce_base64:att.nonce_base64,signature_base64:att.signature_base64};
}
