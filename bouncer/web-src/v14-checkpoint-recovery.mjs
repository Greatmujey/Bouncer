// Research-only, read-only owner recovery. A current FullAccess NEP-413
// signature can ask the independent checkpoint for its existing public review
// and original hashes, even if the random checkpoint capability is lost. This
// does not rotate a capability, recreate a journal, prompt a transaction, or
// authorize a replacement. The optional wallet UI remains hidden until the
// separately hosted read-only endpoint is explicitly enabled.
import {verifyCliLogin} from './cli-login.mjs';
import {isV14CheckpointAccountPair,V14_ENROLLMENT_SITE,V14_ENROLLMENT_RECIPIENT,V14_ENROLLMENT_LIFETIME_MS} from './v14-checkpoint-enrollment.mjs';

const KEY=/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const FIELDS=['format','network','owner','owner_public_key','vault','issued_ms','expires_ms'];
const exact=(x,keys)=>x && typeof x==='object' && !Array.isArray(x) && Object.keys(x).length===keys.length && keys.every(k=>Object.hasOwn(x,k));
const fail=()=>new Error('V14 checkpoint recovery unavailable; do not invent or resend an original');
const base64=bytes=>btoa(String.fromCharCode(...bytes));
export function validateV14RecoveryTerms(input,{now}={}) {
  if(!exact(input,FIELDS) || input.format!=='bouncer-v14-checkpoint-recovery-v1' || input.network!=='testnet' ||
      !isV14CheckpointAccountPair(input.vault,input.owner) || !KEY.test(input.owner_public_key ?? '') ||
      !Number.isSafeInteger(input.issued_ms) || !Number.isSafeInteger(input.expires_ms) || input.issued_ms<1 ||
      input.expires_ms-input.issued_ms!==V14_ENROLLMENT_LIFETIME_MS || !Number.isFinite(new Date(input.expires_ms).getTime()))throw fail();
  if(now!==undefined && (!Number.isSafeInteger(now) || now<input.issued_ms-30_000 || now>=input.expires_ms))throw fail();
  return Object.freeze({...input});
}
export function v14RecoveryMessage(terms) {
  const t=validateV14RecoveryTerms(terms);
  return `Bouncer TESTNET recovery checkpoint read\nAccount: ${t.owner}\nCurrent public key: ${t.owner_public_key}\n`+
    `Candidate vault: ${t.vault}\nSite: ${V14_ENROLLMENT_SITE}\n`+
    `Issued: ${new Date(t.issued_ms).toISOString()}\nExpires: ${new Date(t.expires_ms).toISOString()}\n`+
    'I request the existing public review and original hashes only. This cannot reset a checkpoint or authorize a payment.';
}
export function prepareV14Recovery({owner,ownerPublicKey,vault,crypto=globalThis.crypto,now=Date.now}={}) {
  if(typeof crypto?.getRandomValues!=='function' || typeof now!=='function')throw fail();
  const issued=now(),nonce=crypto.getRandomValues(new Uint8Array(32));
  const terms=validateV14RecoveryTerms({format:'bouncer-v14-checkpoint-recovery-v1',network:'testnet',owner,owner_public_key:ownerPublicKey,
    vault,issued_ms:issued,expires_ms:issued+V14_ENROLLMENT_LIFETIME_MS},{now:issued});
  return {terms,nonce,recipient:V14_ENROLLMENT_RECIPIENT,message:v14RecoveryMessage(terms)};
}
export async function signV14Recovery({draft,wallet,location,crypto=globalThis.crypto,fetch:fetchImpl=globalThis.fetch,now=Date.now}={}) {
  if(typeof now!=='function')throw fail();
  const terms=validateV14RecoveryTerms(draft?.terms,{now:now()}),message=v14RecoveryMessage(terms);
  if(!wallet || typeof wallet.signMessage!=='function' || location?.origin!==V14_ENROLLMENT_SITE || location?.host!==V14_ENROLLMENT_RECIPIENT ||
      draft.recipient!==V14_ENROLLMENT_RECIPIENT || draft.message!==message || !(draft.nonce instanceof Uint8Array) || draft.nonce.length!==32 ||
      !crypto?.subtle || typeof fetchImpl!=='function')throw fail();
  const nonce=new Uint8Array(draft.nonce),mobile=wallet.manifest?.id==='near-mobile'?{accountId:terms.owner}:{};
  const signed=await wallet.signMessage({network:'testnet',signerId:terms.owner,...mobile,message,nonce:new Uint8Array(nonce),
    recipient:V14_ENROLLMENT_RECIPIENT});
  validateV14RecoveryTerms(terms,{now:now()});
  if(signed?.accountId!==terms.owner || signed.publicKey!==terms.owner_public_key)throw fail();
  await verifyCliLogin({account:{accountId:terms.owner,publicKey:terms.owner_public_key,signedMessage:signed},
    message,nonce,recipient:V14_ENROLLMENT_RECIPIENT,crypto,fetch:fetchImpl});
  validateV14RecoveryTerms(terms,{now:now()});
  return {terms:{...terms},nonce_base64:base64(nonce),signature_base64:signed.signature};
}
