/** Offline, fixed-action signing for the reviewed V12 OutLayer testnet burn plan.
 * A signed transaction is a PUBLIC BEARER: anyone who sees the bytes may relay
 * the exact action before a runner's preflight. This module never broadcasts;
 * durable originals, prior receipt checks and fresh live-state checks are
 * separately required before each one-shot send. */
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import {validateOwnerBootstrapPlan} from './testnet-owner-bootstrap.mjs';
import {validateOutlayerBurnPlan,buildOutlayerBurnStage} from './outlayer-v12-burn-plan.mjs';
import {assertFreshFinalBlock} from '../shared/fresh-final-block.mjs';
import {pinnedAccessKeyNonce} from '../shared/pinned-access-key-nonce.mjs';
import {isTransactionHash} from '../shared/direct-payment-settlement.mjs';

export const OUTLAYER_BURN_STAGES=Object.freeze(['register-fake','wrap','swap-fake','fund-vault','configure','install-keys','fund-provider','run-project']);
const sha=b=>crypto.createHash('sha256').update(b).digest();
const fields=['version','purpose','network','stage','owner','vault','signer_public_key','receiver','nonce','block_hash',
  'tx_hash','signed_tx_base64','do_not_blindly_resend','scope'];
function terms(plan,ownerPlan,stage){
 const owner=validateOwnerBootstrapPlan(ownerPlan),p=validateOutlayerBurnPlan(plan,owner);
 if(!OUTLAYER_BURN_STAGES.includes(stage))throw new Error('unsupported OutLayer diagnostic stage');
 const action=buildOutlayerBurnStage({plan:p,ownerPlan:owner,stage});
 return {owner,plan:p,action};
}
function checkedSnapshot(s,plan,ownerPlan,stage,nowMs){
 const t=terms(plan,ownerPlan,stage),n=pinnedAccessKeyNonce(s?.signer_key_nonce);
 if(!s||typeof s!=='object'||Array.isArray(s)||s.version!==1||s.stage!==stage||s.network!=='testnet'||
  s.owner!==t.owner.account_id||s.vault!==t.plan.vault||s.signer_public_key!==t.action.signer_public_key||n===null||
  n>=BigInt(Number.MAX_SAFE_INTEGER)-1n||s.eligible!==true||!Array.isArray(s.blockers)||s.blockers.length!==0||
  s.signed!==false||s.sent!==false||s.seller_contacted!==false||s.independent_fulfillment_verified!==false){
  throw new Error('fresh OutLayer diagnostic stage is not eligible for offline signing');
 }
 assertFreshFinalBlock({header:{hash:s.block_hash,timestamp_nanosec:s.block_timestamp_nanosec}},nowMs);
 return {...t,nonce:n+1n,block_hash:s.block_hash};
}
export async function signOutlayerBurnStage({plan,ownerPlan,snapshot,stage,keyPair,nowMs=Date.now()}={}){
 const t=checkedSnapshot(snapshot,plan,ownerPlan,stage,nowMs);
 if(!keyPair||String(keyPair.getPublicKey())!==t.action.signer_public_key)throw new Error('local OutLayer signing key differs');
 const tx=nearApi.transactions.createTransaction(t.owner.account_id,keyPair.getPublicKey(),t.action.receiver_id,t.nonce,t.action.actions,
  nearApi.utils.serialize.base_decode(t.block_hash));
 const encoded=Buffer.from(nearApi.transactions.encodeTransaction(tx)),digest=sha(encoded);
 const [returned,signed]=await new nearApi.KeyPairSigner(keyPair).signTransaction(tx);
 if(!Buffer.from(returned??[]).equals(digest)||!Buffer.from(nearApi.transactions.encodeTransaction(signed.transaction)).equals(encoded)||
   signed.signature?.enum!=='ed25519Signature'||!keyPair.getPublicKey().verify(digest,signed.signature.data))throw new Error('OutLayer stage signature differs');
 const envelope={version:1,purpose:'bounded-v12-outlayer-burn-stage',network:'testnet',stage,owner:t.owner.account_id,vault:t.plan.vault,
  signer_public_key:t.action.signer_public_key,receiver:t.action.receiver_id,nonce:t.nonce.toString(),block_hash:t.block_hash,
  tx_hash:nearApi.utils.serialize.base_encode(digest),signed_tx_base64:Buffer.from(nearApi.transactions.encodeTransaction(signed)).toString('base64'),
  do_not_blindly_resend:true,scope:'PUBLIC BEARER; exact testnet action only; never blindly resend'};
 verifySignedOutlayerBurnStage(envelope,t.plan,t.owner);return envelope;
}
export function verifySignedOutlayerBurnStage(e,plan,ownerPlan){
 const t=terms(plan,ownerPlan,e?.stage),n=pinnedAccessKeyNonce(e?.nonce);
 if(!e||typeof e!=='object'||Array.isArray(e)||Object.keys(e).sort().join(',')!==[...fields].sort().join(',')||
  e.version!==1||e.purpose!=='bounded-v12-outlayer-burn-stage'||e.network!=='testnet'||e.owner!==t.owner.account_id||e.vault!==t.plan.vault||
  e.signer_public_key!==t.action.signer_public_key||e.receiver!==t.action.receiver_id||n===null||n===0n||
  !isTransactionHash(e.block_hash)||!isTransactionHash(e.tx_hash)||e.do_not_blindly_resend!==true||
  e.scope!=='PUBLIC BEARER; exact testnet action only; never blindly resend'||typeof e.signed_tx_base64!=='string'||
  e.signed_tx_base64.length>16384||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(e.signed_tx_base64)){
  throw new Error('invalid fixed OutLayer stage bearer');
 }
 const bytes=Buffer.from(e.signed_tx_base64,'base64');
 if(bytes.length<1||bytes.length>12288||bytes.toString('base64')!==e.signed_tx_base64)throw new Error('invalid OutLayer stage bytes');
 let signed;try{signed=nearApi.transactions.SignedTransaction.decode(bytes)}catch{throw new Error('invalid OutLayer stage bytes')}
 const key=nearApi.utils.PublicKey.from(t.action.signer_public_key),expected=nearApi.transactions.createTransaction(t.owner.account_id,key,
  t.action.receiver_id,n,t.action.actions,nearApi.utils.serialize.base_decode(e.block_hash));
 const actual=Buffer.from(nearApi.transactions.encodeTransaction(signed.transaction)),digest=sha(actual),sig=signed.signature?.ed25519Signature?.data;
 if(!Buffer.from(nearApi.transactions.encodeTransaction(signed)).equals(bytes)||
  !actual.equals(Buffer.from(nearApi.transactions.encodeTransaction(expected)))||!Array.isArray(sig)||sig.length!==64||
  !key.verify(digest,Uint8Array.from(sig))||nearApi.utils.serialize.base_encode(digest)!==e.tx_hash)throw new Error('OutLayer stage signature or fixed actions differ');
 return signed;
}
