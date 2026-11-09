// Research-only request for the existing ENCRYPTED key kit. A current owner
// FullAccess NEP-413 signature asks only to read ciphertext. Decryption uses a
// separate local passphrase, never sent to the endpoint. No journal is restored.
import {verifyCliLogin} from './cli-login.mjs';
import {validateV14RecoveryTerms} from './v14-checkpoint-recovery.mjs';
import {V14_ENROLLMENT_SITE,V14_ENROLLMENT_RECIPIENT,V14_ENROLLMENT_LIFETIME_MS} from './v14-checkpoint-enrollment.mjs';

const FIELDS=['format','network','owner','owner_public_key','vault','issued_ms','expires_ms'];
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(key=>Object.hasOwn(x,key));
const fail=()=>new Error('V14 encrypted-kit recovery unavailable; preserve the original and never resend an uncertain transaction');
const b64=bytes=>btoa(String.fromCharCode(...bytes));
export function validateV14KitRecoveryTerms(input,{now}={}) {
  if(!exact(input,FIELDS)||input.format!=='bouncer-v14-encrypted-kit-recovery-v2')throw fail();
  validateV14RecoveryTerms({...input,format:'bouncer-v14-checkpoint-recovery-v1'},{now});
  return Object.freeze({...input});
}
export function v14KitRecoveryMessage(terms) {
  const t=validateV14KitRecoveryTerms(terms);
  return `Bouncer TESTNET encrypted recovery-key kit read\nAccount: ${t.owner}\nCurrent public key: ${t.owner_public_key}\n`+
    `Candidate vault: ${t.vault}\nSite: ${V14_ENROLLMENT_SITE}\n`+
    `Issued: ${new Date(t.issued_ms).toISOString()}\nExpires: ${new Date(t.expires_ms).toISOString()}\n`+
    'I request the existing encrypted key kit only. This does not unlock it, restore a journal, deploy a vault, or authorize a payment.';
}
export function prepareV14KitRecovery({owner,ownerPublicKey,vault,crypto=globalThis.crypto,now=Date.now}={}) {
  if(typeof crypto?.getRandomValues!=='function'||typeof now!=='function')throw fail();
  const issued=now(),nonce=crypto.getRandomValues(new Uint8Array(32));
  const terms=validateV14KitRecoveryTerms({format:'bouncer-v14-encrypted-kit-recovery-v2',network:'testnet',owner,owner_public_key:ownerPublicKey,
    vault,issued_ms:issued,expires_ms:issued+V14_ENROLLMENT_LIFETIME_MS},{now:issued});
  return {terms,nonce,recipient:V14_ENROLLMENT_RECIPIENT,message:v14KitRecoveryMessage(terms)};
}
export async function signV14KitRecovery({draft,wallet,location,crypto=globalThis.crypto,fetch:fetchImpl=globalThis.fetch,now=Date.now}={}) {
  if(typeof now!=='function'||!wallet||typeof wallet.signMessage!=='function'||!crypto?.subtle||typeof fetchImpl!=='function'||
      location?.origin!==V14_ENROLLMENT_SITE||location?.host!==V14_ENROLLMENT_RECIPIENT||
      !(draft?.nonce instanceof Uint8Array)||draft.nonce.length!==32)throw fail();
  const terms=validateV14KitRecoveryTerms(draft.terms,{now:now()}),message=v14KitRecoveryMessage(terms),nonce=new Uint8Array(draft.nonce);
  if(draft.recipient!==V14_ENROLLMENT_RECIPIENT||draft.message!==message)throw fail();
  const mobile=wallet.manifest?.id==='near-mobile'?{accountId:terms.owner}:{};
  const signed=await wallet.signMessage({network:'testnet',signerId:terms.owner,...mobile,message,nonce:new Uint8Array(nonce),recipient:V14_ENROLLMENT_RECIPIENT});
  validateV14KitRecoveryTerms(terms,{now:now()});
  if(signed?.accountId!==terms.owner||signed.publicKey!==terms.owner_public_key)throw fail();
  await verifyCliLogin({account:{accountId:terms.owner,publicKey:terms.owner_public_key,signedMessage:signed},
    message,nonce,recipient:V14_ENROLLMENT_RECIPIENT,crypto,fetch:fetchImpl});
  validateV14KitRecoveryTerms(terms,{now:now()});
  return {terms:{...terms},nonce_base64:b64(nonce),signature_base64:signed.signature};
}
