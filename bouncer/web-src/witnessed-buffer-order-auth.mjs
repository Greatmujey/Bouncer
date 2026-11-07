/** Off-chain owner authentication for an encrypted Buffer order journal.
 * The challenge is distinct from the sensitive order-unlock signature. It
 * does not sign a transaction, approve spending or contact Buffer. */
import {isTestnetAccount} from './wallet-utils.mjs';
import {verifyCliLogin} from './cli-login.mjs';
const fail=()=>Error('BUFFER_ORDER_AUTH_UNAVAILABLE');
const ID=/^[a-f0-9]{32}$/, HASH=/^[a-f0-9]{64}$/;
const keys=['owner','owner_public_key','attempt_id','site','key_sha256','key_record_sha256','review_sha256','request_commitment_sha256','draft_sha256'];
const labels={reserve:'Reserve an encrypted Buffer order',claim:'Claim one Buffer order attempt',record:'Record the encrypted Buffer order',inspect:'Inspect the encrypted Buffer order'};
const purposes={reserve:'reserve_buffer_order',claim:'claim_buffer_order',record:'record_buffer_order',inspect:'inspect_buffer_order'};
const hex=x=>[...new Uint8Array(x)].map(n=>n.toString(16).padStart(2,'0')).join('');
export function bufferOrderAuthAction({purpose,identity,capsuleSha256}={}) {
  if (!Object.hasOwn(purposes,purpose) || !identity || typeof identity!=='object' || Array.isArray(identity) ||
      Object.keys(identity).length!==keys.length || !keys.every(k=>Object.hasOwn(identity,k)) ||
      !isTestnetAccount(identity.owner) || typeof identity.owner_public_key!=='string' ||
      !/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(identity.owner_public_key) || !ID.test(identity.attempt_id ?? '') ||
      !['key_sha256','key_record_sha256','review_sha256','request_commitment_sha256','draft_sha256'].every(k=>HASH.test(identity[k] ?? ''))) throw fail();
  let site;try {site=new URL(identity.site)} catch {throw fail()}
  if(site.protocol!=='https:' || site.origin!==identity.site || site.username || site.password) throw fail();
  if(purpose==='record' ? !HASH.test(capsuleSha256 ?? '') : capsuleSha256!==undefined) throw fail();
  return {format:'bouncer-wallet-prompt-auth-v1',network:'testnet',purpose:purposes[purpose],owner:identity.owner,
    owner_public_key:identity.owner_public_key,attempt_id:identity.attempt_id,site:identity.site,key_sha256:identity.key_sha256,
    key_record_sha256:identity.key_record_sha256,review_sha256:identity.review_sha256,
    request_commitment_sha256:identity.request_commitment_sha256,draft_sha256:identity.draft_sha256,
    ...(purpose==='record'?{capsule_sha256:capsuleSha256}:{})};
}
/** Check server challenge exactly before asking for a wallet message; verify
 * the returned signature and current FullAccess key separately afterward. */
export async function signReviewedBufferOrderChallenge({wallet,context,challenge,location,crypto,fetch,now=Date.now}={}) {
  const action=bufferOrderAuthAction(context);
  if(!wallet || typeof wallet.signMessage!=='function' || !crypto?.subtle || typeof fetch!=='function' || typeof now!=='function' ||
      !location || location.origin!==action.site || typeof location.host!=='string' || !challenge || !ID.test(challenge.challenge_id ?? '') ||
      typeof challenge.nonce_base64!=='string' || !/^[A-Za-z0-9+/]{43}=$/.test(challenge.nonce_base64) ||
      !Number.isSafeInteger(challenge.expires_at_ms) || typeof challenge.message!=='string') throw fail();
  const url=new URL(action.site);if(url.host!==location.host || challenge.recipient!==url.host) throw fail();
  let nonce;try {const b=atob(challenge.nonce_base64);if(b.length!==32 || btoa(b)!==challenge.nonce_base64)throw fail();nonce=Uint8Array.from(b,c=>c.charCodeAt(0))}catch{throw fail()}
  const digest=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(action))));
  const expires=challenge.expires_at_ms, issued=expires-120_000, clock=now();
  if(!Number.isSafeInteger(clock) || !Number.isSafeInteger(issued) || clock<issued-30_000 || clock>=expires) throw fail();
  const message=`Bouncer testnet owner authentication\n${labels[context.purpose]}\nAccount: ${action.owner}\n`+
    `Public key: ${action.owner_public_key}\nAction SHA-256: ${digest}\nSite: ${action.site}\n`+
    `Issued: ${new Date(issued).toISOString()}\nExpires: ${new Date(expires).toISOString()}\n`+
    'This message is not a transaction and does not itself approve spending.';
  if(challenge.message!==message) throw fail();
  const mobile=wallet.manifest?.id==='near-mobile'?{accountId:action.owner}:{};
  const signed=await wallet.signMessage({network:'testnet',signerId:action.owner,...mobile,message,nonce:new Uint8Array(nonce),recipient:url.host});
  if(now()>=expires || signed?.accountId!==action.owner || signed.publicKey!==action.owner_public_key) throw fail();
  await verifyCliLogin({account:{accountId:action.owner,publicKey:action.owner_public_key,signedMessage:signed},
    message,nonce,recipient:url.host,crypto,fetch});
  if(now()>=expires) throw fail();
  return {challenge_id:challenge.challenge_id,accountId:signed.accountId,publicKey:signed.publicKey,signature:signed.signature};
}
