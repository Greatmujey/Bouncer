// Research-only browser enrollment for a separately retained V14 checkpoint.
// This is an OFF-CHAIN NEP-413 message, not vault deployment or payment
// consent. It never asks for a wallet private key. No UI calls it yet.
import { isTestnetAccount } from './wallet-utils.mjs';
import { verifyCliLogin } from './cli-login.mjs';

export const V14_ENROLLMENT_SITE='https://bouncer-near.vercel.app';
export const V14_ENROLLMENT_RECIPIENT='bouncer-near.vercel.app';
export const V14_ENROLLMENT_LIFETIME_MS=180_000;
const HEX=/^[a-f0-9]{64}$/,SCOPE=/^[a-f0-9]{32}$/,KEY=/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const FIELDS=['format','network','owner','owner_public_key','vault','scope_id','review_sha256','capability_sha256','issued_ms','expires_ms'];
const exact=(x,keys)=>x && typeof x==='object' && !Array.isArray(x) && Object.keys(x).length===keys.length && keys.every(k=>Object.hasOwn(x,k));
const fail=()=>new Error('V14 checkpoint enrollment unavailable; no vault or payment has been authorized');
const hex=bytes=>[...bytes].map(n=>n.toString(16).padStart(2,'0')).join('');
const base64=bytes=>btoa(String.fromCharCode(...bytes));
export function isV14CheckpointAccountPair(vault,owner) {
  if (!isTestnetAccount(owner) || !owner.endsWith('.testnet') || owner==='bouncer-owner-12f343b795633e357ae5560d.testnet' ||
      !isTestnetAccount(vault) || !vault.endsWith(`.${owner}`)) return false;
  const prefix=vault.slice(0,-owner.length-1);
  return Boolean(prefix) && !prefix.includes('.');
}

export function validateV14EnrollmentTerms(input,{now}={}) {
  if (!exact(input,FIELDS) || input.format!=='bouncer-v14-checkpoint-enrollment-v1' || input.network!=='testnet' ||
      !isV14CheckpointAccountPair(input.vault,input.owner) || !KEY.test(input.owner_public_key ?? '') || !SCOPE.test(input.scope_id ?? '') ||
      !HEX.test(input.review_sha256 ?? '') || !HEX.test(input.capability_sha256 ?? '') ||
      !Number.isSafeInteger(input.issued_ms) || !Number.isSafeInteger(input.expires_ms) || input.issued_ms<1 ||
      input.expires_ms-input.issued_ms!==V14_ENROLLMENT_LIFETIME_MS || !Number.isFinite(new Date(input.expires_ms).getTime())) throw fail();
  if (now!==undefined && (!Number.isSafeInteger(now) || now<input.issued_ms-30_000 || now>=input.expires_ms)) throw fail();
  return Object.freeze({...input});
}

export function v14EnrollmentMessage(terms) {
  const t=validateV14EnrollmentTerms(terms);
  return `Bouncer TESTNET recovery checkpoint enrollment\nAccount: ${t.owner}\nPublic key: ${t.owner_public_key}\n`+
    `Candidate vault: ${t.vault}\nReviewed setup SHA-256: ${t.review_sha256}\nCheckpoint scope: ${t.scope_id}\n`+
    `Checkpoint capability SHA-256: ${t.capability_sha256}\nSite: ${V14_ENROLLMENT_SITE}\n`+
    `Issued: ${new Date(t.issued_ms).toISOString()}\nExpires: ${new Date(t.expires_ms).toISOString()}\n`+
    'I approve creating this recovery checkpoint only. This does not deploy a vault, install a key, or authorize a payment.';
}

/** Generate a random non-wallet capability and nonce in browser memory only.
 * The capability is a bearer secret: never show it, log it, put it in a URL,
 * or send it to the wallet. Losing it requires owner-controlled recovery;
 * it must not be used to silently initialize another checkpoint. */
export async function prepareV14Enrollment({owner,ownerPublicKey,vault,reviewSha256,crypto=globalThis.crypto,now=Date.now} = {}) {
  if (!crypto?.subtle || typeof crypto.getRandomValues!=='function' || typeof now!=='function') throw fail();
  const issued=now();
  const scope=hex(crypto.getRandomValues(new Uint8Array(16)));
  const capability=hex(crypto.getRandomValues(new Uint8Array(32)));
  const nonce=crypto.getRandomValues(new Uint8Array(32));
  const capHash=hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(capability))));
  const terms=validateV14EnrollmentTerms({format:'bouncer-v14-checkpoint-enrollment-v1',network:'testnet',owner,
    owner_public_key:ownerPublicKey,vault,scope_id:scope,review_sha256:reviewSha256,capability_sha256:capHash,
    issued_ms:issued,expires_ms:issued+V14_ENROLLMENT_LIFETIME_MS},{now:issued});
  return {terms,capability,nonce,recipient:V14_ENROLLMENT_RECIPIENT,message:v14EnrollmentMessage(terms)};
}

/** One off-chain owner message. This helper does not enroll the DB or call
 * signAndSendTransaction. A caller must never automatically re-open a wallet
 * after a lost response; inspect the checkpoint using the original scope. */
export async function signV14Enrollment({draft,wallet,location,crypto=globalThis.crypto,fetch:fetchImpl=globalThis.fetch,now=Date.now} = {}) {
  if (typeof now!=='function') throw fail();
  const terms=validateV14EnrollmentTerms(draft?.terms,{now:now()}),message=v14EnrollmentMessage(terms);
  if (!wallet || typeof wallet.signMessage!=='function' || location?.origin!==V14_ENROLLMENT_SITE ||
      location?.host!==V14_ENROLLMENT_RECIPIENT || draft.recipient!==V14_ENROLLMENT_RECIPIENT ||
      draft.message!==message || !HEX.test(draft.capability ?? '') ||
      !(draft.nonce instanceof Uint8Array) || draft.nonce.length!==32 || !crypto?.subtle || typeof fetchImpl!=='function') throw fail();
  // Snapshot the request before asynchronous crypto or the wallet can yield.
  const nonce=new Uint8Array(draft.nonce),capability=draft.capability;
  const capHash=hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(capability))));
  if (capHash!==terms.capability_sha256) throw fail();
  const mobile=wallet.manifest?.id==='near-mobile'?{accountId:terms.owner}:{};
  const signed=await wallet.signMessage({network:'testnet',signerId:terms.owner,...mobile,message,
    nonce:new Uint8Array(nonce),recipient:V14_ENROLLMENT_RECIPIENT});
  validateV14EnrollmentTerms(terms,{now:now()});
  if (signed?.accountId!==terms.owner || signed.publicKey!==terms.owner_public_key) throw fail();
  await verifyCliLogin({account:{accountId:terms.owner,publicKey:terms.owner_public_key,signedMessage:signed},
    message,nonce,recipient:V14_ENROLLMENT_RECIPIENT,crypto,fetch:fetchImpl});
  validateV14EnrollmentTerms(terms,{now:now()});
  return {terms:{...terms},nonce_base64:base64(nonce),signature_base64:signed.signature};
}
