/**
 * Prepare and check a local, encrypted V14 bootstrap candidate. This does not
 * enroll it, sign an owner attestation, retain transaction originals, talk to a
 * server, or authorize/sign/send a transaction. A checked file is not proof
 * of a separate backup, latest history, or any on-chain state.
 *
 * The file contains a passphrase-encrypted temporary FullAccess vault key and
 * checkpoint capability. If later installed, that key can control the vault
 * until its deletion is final. A compromised browser can steal unlocked secrets;
 * a lost passphrase or file can strand funds. Never use a wallet seed phrase.
 */
import {KeyPair} from '@near-js/crypto';
import {buildV14TemporaryBootstrapPlan} from './v14-bootstrap-plan.mjs';
import {sealV14BootstrapRecoveryKit,openV14BootstrapRecoveryKit} from './v14-bootstrap-recovery-kit.mjs';
import {bootstrapSha256} from '../shared/v14-bootstrap-protocol.mjs';

const FORMAT='bouncer-v14-local-bootstrap-candidate-v1';
const DOMAIN='bouncer-v14-local-bootstrap-candidate-file-v1\0';
const MAX_BYTES=30_000, HEX=/^[a-f0-9]{64}$/;
const encoder=new TextEncoder();
const exact=(value,fields)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===fields.length&&fields.every(field=>Object.hasOwn(value,field));
const fail=()=>new Error('Encrypted setup file could not be prepared or verified; no transaction is authorized');
const hex=bytes=>[...bytes].map(value=>value.toString(16).padStart(2,'0')).join('');
const passphraseValid=value=>typeof value==='string'&&value.length>=16&&value.length<=1024&&/\S/.test(value);
async function fileFingerprint(crypto,text){return bootstrapSha256(crypto,DOMAIN+text)}
function publicResult(review,fingerprint) {
  return Object.freeze({fingerprint,owner:review.owner,vault:review.vault,owner_public_key:review.owner_public_key,
    temporary_public_key:review.temporary_vault_public_key,review_sha256:review.review_sha256,
    vault_funding_yocto:review.vault_funding_yocto,vault_wasm_sha256:review.vault_wasm_sha256,
    transaction_authorized_by_this_operation:false,transaction_sent_by_this_operation:false,
    owner_enrolled_by_this_operation:false,independent_backup_verified:false,
    latest_head_independently_verified:false,on_chain_state_checked:false});
}

/** Only encrypted JSON and public review values leave this function. */
export async function createV14BootstrapCandidate({owner,ownerPublicKey,vault,vaultFundingYocto,
  compressedV14,passphrase,crypto=globalThis.crypto}={}) {
  if(!crypto?.subtle||typeof crypto.getRandomValues!=='function'||!passphraseValid(passphrase))throw fail();
  try {
    const temporaryKey=KeyPair.fromRandom('ed25519');
    const scopeId=hex(crypto.getRandomValues(new Uint8Array(16)));
    const checkpointCapability=hex(crypto.getRandomValues(new Uint8Array(32)));
    const {review}=await buildV14TemporaryBootstrapPlan({owner,ownerPublicKey,vault,
      temporaryPublicKey:String(temporaryKey.getPublicKey()),vaultFundingYocto,compressedV14,crypto});
    const kit=await sealV14BootstrapRecoveryKit({review,temporaryKey,scopeId,checkpointCapability,passphrase,crypto});
    const text=JSON.stringify({format:FORMAT,network:'testnet',review,sealed_kit:kit});
    if(encoder.encode(text).byteLength>MAX_BYTES)throw fail();
    return Object.freeze({...publicResult(review,await fileFingerprint(crypto,text)),text});
  }catch{throw fail()}
}

/**
 * Compare the exact file to a separately recorded fingerprint, rebuild the
 * pinned plan, and decrypt/check its kit. This file contains no transaction
 * history. The observed current owner key is reported, not required to match:
 * an owner may legitimately rotate keys, but a mismatch must stop setup review.
 */
export async function verifyV14BootstrapCandidate({text,expectedFingerprint,owner,vault,vaultFundingYocto,currentOwnerPublicKey,
  compressedV14,passphrase,crypto=globalThis.crypto}={}) {
  if(!crypto?.subtle||typeof text!=='string'||encoder.encode(text).byteLength>MAX_BYTES||
    !HEX.test(expectedFingerprint??'')||!passphraseValid(passphrase)||typeof currentOwnerPublicKey!=='string')throw fail();
  let opened;
  try {
    if(await fileFingerprint(crypto,text)!==expectedFingerprint)throw fail();
    const file=JSON.parse(text);
    if(!exact(file,['format','network','review','sealed_kit'])||JSON.stringify(file)!==text||
      file.format!==FORMAT||file.network!=='testnet'||file.review?.owner!==owner||file.review?.vault!==vault||
      file.review?.vault_funding_yocto!==vaultFundingYocto)throw fail();
    const review=file.review,kit=file.sealed_kit;
    const plan=await buildV14TemporaryBootstrapPlan({owner,ownerPublicKey:review.owner_public_key,vault:review.vault,
      temporaryPublicKey:review.temporary_vault_public_key,vaultFundingYocto:review.vault_funding_yocto,compressedV14,crypto});
    if(JSON.stringify(plan.review)!==JSON.stringify(review))throw fail();
    opened=await openV14BootstrapRecoveryKit({kit,expected:{owner,vault:review.vault,ownerPublicKey:review.owner_public_key,
      temporaryPublicKey:review.temporary_vault_public_key,reviewSha256:review.review_sha256,scopeId:kit?.scope_id},passphrase,crypto});
    return Object.freeze({...publicResult(review,expectedFingerprint),owner_key_matches_current:review.owner_public_key===currentOwnerPublicKey});
  }catch{throw fail()}finally{opened?.dispose()}
}
