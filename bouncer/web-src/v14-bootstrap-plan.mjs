/**
 * Construct the testnet-only, temporary-key V14 bootstrap that avoids sending
 * the full WASM through a mobile wallet. This module creates no keys, opens no
 * wallet, signs nothing and sends nothing. It may build a local preparation
 * review, but no live wallet transaction is wired to it.
 *
 * An owner first creates/funds a NEW child vault and adds a temporary FullAccess
 * key there. That key signs deployment + initialization + its own deletion as
 * one receipt. Until that deletion is FINAL the key can control the new vault;
 * an interruption can leave it active or lock funds. The caller must obtain
 * explicit owner approval and independently retain and recover originals and
 * the encrypted key before any wallet prompt. Matching artifact hashes are
 * not an audit, a receipt, a backup or permission to transact.
 */
import {actionCreators,createTransaction,encodeTransaction,SignedTransaction,Signature} from '@near-js/transactions';
import {decodeNativeHash32,encodeBase58} from './native-oracle-transaction.mjs';
import {PublicKey} from '@near-js/crypto';
import {inflateSync} from 'fflate';
import {isV14CheckpointAccountPair} from './v14-checkpoint-enrollment.mjs';
import {V14_TESTNET_ARTIFACT} from '../shared/v14-testnet-artifact.mjs';
import {V14_PHONE_RESEARCH_ARTIFACTS,V14_PHONE_RESEARCH_SIZES} from '../shared/v14-phone-research-artifacts.mjs';

const T=10n**12n, N=10n**24n, MAX_FUNDING=10n*N;
const ENCODER=new TextEncoder(), MAGIC=[0,97,115,109,1,0,0,0];
const DUMMY=PublicKey.from('ed25519:11111111111111111111111111111111');
const DOMAIN=ENCODER.encode('bouncer-v14-temporary-vault-bootstrap-v1\0');
const fail=()=>new Error('Invalid or altered V14 bootstrap plan; no wallet action is authorized');
const hex=bytes=>[...bytes].map(n=>n.toString(16).padStart(2,'0')).join('');
async function sha(crypto,bytes){return new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))}
const concat=(a,b)=>{const bytes=new Uint8Array(a.length+b.length);bytes.set(a);bytes.set(b,a.length);return bytes};
function key(value) {
  try {
    if(typeof value!=='string'||!value.startsWith('ed25519:'))throw Error();
    const k=PublicKey.from(value);
    if(String(k)!==value||k.keyType!==0||k.ed25519Key?.data?.length!==32||String(k)===String(DUMMY))throw Error();
    return k;
  }catch{throw fail()}
}
function funding(value) {
  if(typeof value!=='string'||!/^[1-9][0-9]{0,38}$/.test(value))throw fail();
  const amount=BigInt(value);if(amount>MAX_FUNDING)throw fail();return amount;
}
async function commitment(crypto,signer,receiver,actions) {
  const transaction=createTransaction(signer,DUMMY,receiver,1n,actions,new Uint8Array(32));
  return hex(await sha(crypto,concat(DOMAIN,encodeTransaction(transaction))));
}

/** Verify compressed public bytes and construct the two exact unsigned stages. */
export async function buildV14TemporaryBootstrapPlan({owner,ownerPublicKey,vault,temporaryPublicKey,
  vaultFundingYocto,compressedV14,crypto=globalThis.crypto}={}) {
  if(!crypto?.subtle||!isV14CheckpointAccountPair(vault,owner)||!(compressedV14 instanceof Uint8Array))throw fail();
  const ownerKey=key(ownerPublicKey),temporaryKey=key(temporaryPublicKey),value=funding(vaultFundingYocto);
  if(String(ownerKey)===String(temporaryKey)||compressedV14.length!==V14_PHONE_RESEARCH_SIZES.compressed)throw fail();
  // Snapshot all inputs before awaiting crypto; caller mutation cannot change
  // the bytes later used to reconstruct the reviewed actions.
  const packed=new Uint8Array(compressedV14);
  if(hex(await sha(crypto,packed))!==V14_PHONE_RESEARCH_ARTIFACTS.compressed_sha256)throw fail();
  let wasm;
  try{wasm=inflateSync(packed)}catch{throw fail()}
  if(wasm.length!==V14_TESTNET_ARTIFACT.bytes||!MAGIC.every((v,i)=>wasm[i]===v)||
      hex(await sha(crypto,wasm))!==V14_TESTNET_ARTIFACT.sha256)throw fail();
  const create=[actionCreators.createAccount(),actionCreators.transfer(value),
    actionCreators.addKey(temporaryKey,actionCreators.fullAccessKey())];
  const deploy=[actionCreators.deployContract(wasm),
    actionCreators.functionCall('new',ENCODER.encode(JSON.stringify({owner})),30n*T,0n),
    actionCreators.deleteKey(temporaryKey)];
  const createHash=await commitment(crypto,owner,vault,create),deployHash=await commitment(crypto,vault,vault,deploy);
  const review={format:'bouncer-v14-temporary-vault-bootstrap-v1',network:'testnet',owner,owner_public_key:String(ownerKey),
    vault,temporary_vault_public_key:String(temporaryKey),vault_funding_yocto:String(value),
    vault_wasm_sha256:V14_TESTNET_ARTIFACT.sha256,vault_code_hash:V14_TESTNET_ARTIFACT.near_code_hash,
    stages:[{id:'create_vault_with_temporary_key',signer_id:owner,receiver_id:vault,action_commitment_sha256:createHash,
      actions:[{type:'create_account'},{type:'transfer',deposit_yocto:String(value)},
        {type:'add_key',public_key:String(temporaryKey),permission:'FullAccess'}]},
      {id:'deploy_v14_and_delete_temporary_key',signer_id:vault,receiver_id:vault,action_commitment_sha256:deployHash,
        actions:[{type:'deploy_contract',sha256:V14_TESTNET_ARTIFACT.sha256,bytes:wasm.length},
          {type:'function_call',method:'new',args:{owner},gas:String(30n*T),deposit_yocto:'0'},
          {type:'delete_key',public_key:String(temporaryKey)}]}],
    limitations:[
      'The temporary FullAccess key controls only the new vault, not the existing owner account; it can move the new vault funds until deleted.',
      'Interrupted setup can leave the key active or funds stuck. Independently recover the key and originals; never repeat an uncertain transaction.',
      'Funding is locked storage collateral, not an OutLayer payment. Network gas is additional.',
      'A signed deployment and deletion must be FINAL and key absence verified before configuring any mission.',
    ],wallet_approval_obtained:false,transaction_sent:false};
  const reviewSha256=hex(await sha(crypto,ENCODER.encode(JSON.stringify(review))));
  const walletRequest={network:'testnet',signerId:owner,receiverId:vault,actions:[
    {type:'CreateAccount'},{type:'Transfer',params:{deposit:String(value)}},
    {type:'AddKey',params:{publicKey:String(temporaryKey),accessKey:{nonce:0,permission:'FullAccess'}}},
  ]};
  return {review:{...review,review_sha256:reviewSha256},
    walletRequest,createActions:create,deploymentActions:deploy};
}

/** Produce ONE signed original for the independently reviewed deployment. This
 * does not broadcast or retain it. The caller must first reserve a one-shot
 * claim, retain the returned hash in independently recoverable stores BEFORE
 * its only send, and reconcile by that hash if anything is uncertain. Signed
 * bytes are a bearer artifact and must not be logged or put in a URL. */
export async function signV14TemporaryBootstrapDeployment({review,expectedReviewSha256,compressedV14,temporaryKey,
  nonce,blockHash,crypto=globalThis.crypto}={}) {
  if(!review||typeof expectedReviewSha256!=='string'||review.review_sha256!==expectedReviewSha256||
      typeof nonce!=='string'||!/^[1-9][0-9]{0,19}$/.test(nonce)||BigInt(nonce)>=(1n<<64n)||
      !temporaryKey||typeof temporaryKey.sign!=='function'||typeof temporaryKey.getPublicKey!=='function')throw fail();
  const plan=await buildV14TemporaryBootstrapPlan({owner:review.owner,ownerPublicKey:review.owner_public_key,
    vault:review.vault,temporaryPublicKey:review.temporary_vault_public_key,vaultFundingYocto:review.vault_funding_yocto,
    compressedV14,crypto});
  if(plan.review.review_sha256!==expectedReviewSha256||JSON.stringify(review)!==JSON.stringify(plan.review)||
      String(temporaryKey.getPublicKey())!==plan.review.temporary_vault_public_key)throw fail();
  const block=decodeNativeHash32(blockHash),pub=key(plan.review.temporary_vault_public_key);
  const transaction=createTransaction(plan.review.vault,pub,plan.review.vault,BigInt(nonce),plan.deploymentActions,block);
  const unsigned=encodeTransaction(transaction),hash=await sha(crypto,unsigned);
  const signed=await temporaryKey.sign(new Uint8Array(hash));
  if(!(signed?.signature instanceof Uint8Array)||signed.signature.length!==64||String(signed.publicKey)!==String(pub)||
      !pub.verify(hash,signed.signature))throw fail();
  const result=new SignedTransaction({transaction,signature:new Signature({keyType:0,data:new Uint8Array(signed.signature)})});
  return {status:'SIGNED_NOT_BROADCAST',transaction_hash:encodeBase58(hash),nonce,block_hash:blockHash,
    signed_bytes:encodeTransaction(result),transaction_sent:false};
}
