/** A distinct, zero-yocto owner-guard control for the original uncertain fake
 * token registration. Its nonce is exactly original + 1. When FINAL it fences
 * any later acceptance of the original; it does not prove whether the original
 * ran earlier. No token transfer, registration, seller order or mainnet action. */
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import {validateOwnerBootstrapPlan} from './testnet-owner-bootstrap.mjs';
import {validateOutlayerBurnPlan} from './outlayer-v12-burn-plan.mjs';
import {verifySignedOutlayerBurnStage} from './outlayer-v12-burn-signed.mjs';
import {inspectOutlayerBurnStage} from './outlayer-v12-burn-preflight.mjs';
import {readPinnedJsonView} from './read-only-near-rpc.mjs';
import {assertFreshFinalBlock} from '../shared/fresh-final-block.mjs';
import {pinnedAccessKeyNonce} from '../shared/pinned-access-key-nonce.mjs';
import {isTransactionHash} from '../shared/direct-payment-settlement.mjs';
import {CIRCLE_TESTNET_USDC} from '../scripts/circle-testnet-setup.mjs';
const POLICY='ol-register-nonce-control',GAS=30n*10n**12n;
const sha=b=>crypto.createHash('sha256').update(b).digest();
const fields=['version','purpose','network','owner','vault','public_key','policy_id','nonce','block_hash','original_tx_hash','original_nonce',
 'tx_hash','signed_tx_base64','do_not_blindly_resend','scope'];
const actions=()=>[nearApi.transactions.functionCall('set_policy',{policy_id:POLICY,token:CIRCLE_TESTNET_USDC,per_tx_cap:'1',daily_cap:'1'},GAS,0n)];
function originalTerms(original,plan,owner){
 verifySignedOutlayerBurnStage(original,plan,owner);
 const n=pinnedAccessKeyNonce(original.nonce);
 if(original.stage!=='register-fake'||n===null||n===0n||n>=BigInt(Number.MAX_SAFE_INTEGER)-1n)throw new Error('original registration is invalid');
 return n;
}
/** One pinned view for the untouched registration state and the dedicated
 * empty control-policy slot. Neither view is proof the original never ran. */
export async function inspectOutlayerRegistrationControl({plan:rawPlan,ownerPlan:rawOwner,provider,now=Date.now}={}){
 const owner=validateOwnerBootstrapPlan(rawOwner),plan=validateOutlayerBurnPlan(rawPlan,owner);
 const base=await inspectOutlayerBurnStage({plan,ownerPlan:owner,stage:'register-fake',provider,now});
 const control=await readPinnedJsonView(provider,base.block_hash,plan.vault,'get_policy',{policy_id:POLICY});
 assertFreshFinalBlock({header:{hash:base.block_hash,timestamp_nanosec:base.block_timestamp_nanosec}},now());
 return {...base,control_policy:control,control_eligible:base.eligible===true&&control===null,
  scope:'pinned read-only state and unused zero-yocto control slot; original transaction history remains separate'};
}
export async function signOutlayerRegistrationControl({plan:rawPlan,ownerPlan:rawOwner,original,snapshot,keyPair,nowMs=Date.now()}={}){
 const owner=validateOwnerBootstrapPlan(rawOwner),plan=validateOutlayerBurnPlan(rawPlan,owner),prior=originalTerms(original,plan,owner);
 const n=pinnedAccessKeyNonce(snapshot?.signer_key_nonce);
 if(!snapshot||snapshot.version!==1||snapshot.stage!=='register-fake'||snapshot.network!=='testnet'||snapshot.owner!==owner.account_id||
  snapshot.vault!==plan.vault||snapshot.signer_public_key!==owner.public_key||snapshot.eligible!==true||snapshot.control_eligible!==true||
  snapshot.control_policy!==null||!Array.isArray(snapshot.blockers)||snapshot.blockers.length!==0||n===null||n+1n!==prior||
  snapshot.signed!==false||snapshot.sent!==false||snapshot.seller_contacted!==false||snapshot.independent_fulfillment_verified!==false){
  throw new Error('fresh control snapshot does not match the unresolved original nonce');
 }
 assertFreshFinalBlock({header:{hash:snapshot.block_hash,timestamp_nanosec:snapshot.block_timestamp_nanosec}},nowMs);
 if(!keyPair||String(keyPair.getPublicKey())!==owner.public_key)throw new Error('control key differs from testnet owner');
 const nonce=prior+1n,tx=nearApi.transactions.createTransaction(owner.account_id,keyPair.getPublicKey(),plan.vault,nonce,actions(),
  nearApi.utils.serialize.base_decode(snapshot.block_hash));
 const unsigned=Buffer.from(nearApi.transactions.encodeTransaction(tx)),digest=sha(unsigned);
 const [returned,signed]=await new nearApi.KeyPairSigner(keyPair).signTransaction(tx);
 if(!Buffer.from(returned??[]).equals(digest)||!Buffer.from(nearApi.transactions.encodeTransaction(signed.transaction)).equals(unsigned)||
   signed.signature?.enum!=='ed25519Signature'||!keyPair.getPublicKey().verify(digest,signed.signature.data))throw new Error('control signature differs');
 const e={version:1,purpose:'outlayer-registration-nonce-control',network:'testnet',owner:owner.account_id,vault:plan.vault,
  public_key:owner.public_key,policy_id:POLICY,nonce:nonce.toString(),block_hash:snapshot.block_hash,original_tx_hash:original.tx_hash,
  original_nonce:prior.toString(),tx_hash:nearApi.utils.serialize.base_encode(digest),
  signed_tx_base64:Buffer.from(nearApi.transactions.encodeTransaction(signed)).toString('base64'),do_not_blindly_resend:true,
  scope:'PUBLIC BEARER; zero-yocto guard control, not a token registration; never blindly resend'};
 verifySignedOutlayerRegistrationControl(e,original,plan,owner);return e;
}
export function verifySignedOutlayerRegistrationControl(e,original,rawPlan,rawOwner){
 const owner=validateOwnerBootstrapPlan(rawOwner),plan=validateOutlayerBurnPlan(rawPlan,owner),prior=originalTerms(original,plan,owner);
 if(!e||typeof e!=='object'||Array.isArray(e)||Object.keys(e).sort().join(',')!==[...fields].sort().join(',')||
  e.version!==1||e.purpose!=='outlayer-registration-nonce-control'||e.network!=='testnet'||e.owner!==owner.account_id||e.vault!==plan.vault||
  e.public_key!==owner.public_key||e.policy_id!==POLICY||e.original_tx_hash!==original.tx_hash||e.original_nonce!==prior.toString()||
  e.nonce!==(prior+1n).toString()||!isTransactionHash(e.block_hash)||!isTransactionHash(e.tx_hash)||e.do_not_blindly_resend!==true||
  e.scope!=='PUBLIC BEARER; zero-yocto guard control, not a token registration; never blindly resend'||typeof e.signed_tx_base64!=='string'||
  e.signed_tx_base64.length>8192||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(e.signed_tx_base64)){
  throw new Error('invalid registration nonce-control bearer');
 }
 const bytes=Buffer.from(e.signed_tx_base64,'base64');if(bytes.length<1||bytes.length>4096||bytes.toString('base64')!==e.signed_tx_base64)throw new Error('invalid control bytes');
 let signed;try{signed=nearApi.transactions.SignedTransaction.decode(bytes)}catch{throw new Error('invalid control bytes')}
 const key=nearApi.utils.PublicKey.from(owner.public_key),expected=nearApi.transactions.createTransaction(owner.account_id,key,plan.vault,prior+1n,
  actions(),nearApi.utils.serialize.base_decode(e.block_hash));
 const actual=Buffer.from(nearApi.transactions.encodeTransaction(signed.transaction)),digest=sha(actual),sig=signed.signature?.ed25519Signature?.data;
 if(!Buffer.from(nearApi.transactions.encodeTransaction(signed)).equals(bytes)||!actual.equals(Buffer.from(nearApi.transactions.encodeTransaction(expected)))||
  !Array.isArray(sig)||sig.length!==64||!key.verify(digest,Uint8Array.from(sig))||nearApi.utils.serialize.base_encode(digest)!==e.tx_hash){
  throw new Error('registration control signature or fixed action differs');
 }
 return signed;
}
