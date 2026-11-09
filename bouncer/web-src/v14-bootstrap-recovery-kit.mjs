/**
 * Encrypted recovery for a TEMPORARY new-vault FullAccess key, kept separate
 * from the existing restricted-agent kit. Nothing here opens a wallet, stores
 * a kit remotely, signs a transaction or authorizes deployment. The browser
 * may use it for local-only candidate preparation. Remote retention, freshness
 * and a real-phone restore are still required before setup can be enabled.
 *
 * The passphrase is local to the browser and must not be a wallet seed phrase.
 * A leaked kit permits offline passphrase guessing. A lost passphrase or kit
 * may strand the vault. JavaScript cannot guarantee erasure from memory; a
 * compromised browser/origin can steal the key while it is unlocked.
 */
import {KeyPair,PublicKey} from '@near-js/crypto';
import {baseDecode,baseEncode} from '@near-js/utils';
import {isV14CheckpointAccountPair} from './v14-checkpoint-enrollment.mjs';

const FORMAT='bouncer-v14-temporary-bootstrap-kit-v1',SECRET_FORMAT='bouncer-v14-temporary-bootstrap-secrets-v1';
const ITERATIONS=600_000,HEX=/^[a-f0-9]{64}$/,SCOPE=/^[a-f0-9]{32}$/,ENCODER=new TextEncoder();
const HEADER=['format','network','owner','owner_public_key','vault','temporary_public_key','review_sha256','scope_id',
  'capability_sha256','kdf','iterations','salt','iv'];
const SECRET=['format','temporary_private_key','checkpoint_capability'];
const exact=(value,fields)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===fields.length&&
  fields.every(field=>Object.hasOwn(value,field));
const fail=()=>new Error('V14 temporary-key recovery unavailable; do not repeat a transaction');
const hex=bytes=>[...bytes].map(n=>n.toString(16).padStart(2,'0')).join('');
const b64=bytes=>btoa(String.fromCharCode(...bytes));
function unb64(value,length) {
  if(typeof value!=='string'||value.length>8192||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw fail();
  let bytes;try{bytes=Uint8Array.from(atob(value),c=>c.charCodeAt(0))}catch{throw fail()}
  if((length!==undefined&&bytes.length!==length)||b64(bytes)!==value)throw fail();
  return bytes;
}
function publicKey(value) {
  try{const key=PublicKey.from(value);if(!value.startsWith('ed25519:')||String(key)!==value||key.keyType!==0||
    key.ed25519Key?.data?.length!==32||value==='ed25519:11111111111111111111111111111111')throw Error();return key}
  catch{throw fail()}
}
function privateKey(value) {
  try {
    if(typeof value!=='string'||!value.startsWith('ed25519:'))throw Error();
    const encoded=value.slice(8),bytes=baseDecode(encoded);
    if(bytes.length!==64||baseEncode(bytes)!==encoded)throw Error();
    const pair=KeyPair.fromString(value),pub=pair.getPublicKey().ed25519Key.data;
    if(!pub.every((item,i)=>item===bytes[32+i]))throw Error();
    return pair;
  }catch{throw fail()}
}
async function digest(crypto,value){return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',ENCODER.encode(value))))}
function validPassphrase(value){return typeof value==='string'&&value.length>=16&&value.length<=1024}
function validateHeader(h) {
  if(!exact(h,HEADER)||h.format!==FORMAT||h.network!=='testnet'||!isV14CheckpointAccountPair(h.vault,h.owner)||
    !HEX.test(h.review_sha256??'')||!SCOPE.test(h.scope_id??'')||!HEX.test(h.capability_sha256??'')||
    h.kdf!=='PBKDF2-SHA256'||h.iterations!==ITERATIONS)throw fail();
  if(String(publicKey(h.owner_public_key))===String(publicKey(h.temporary_public_key)))throw fail();
  unb64(h.salt,16);unb64(h.iv,12);return h;
}
function orderedHeader(kit){return Object.fromEntries(HEADER.map(field=>[field,kit[field]]))}
async function aes(crypto,passphrase,salt,usage) {
  const bytes=ENCODER.encode(passphrase);
  try {
    const material=await crypto.subtle.importKey('raw',bytes,'PBKDF2',false,['deriveKey']);
    return await crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations:ITERATIONS},material,
      {name:'AES-GCM',length:256},false,[usage]);
  }finally{bytes.fill(0)}
}

/** Seal only the key that matches a self-consistent, freshly built review. */
export async function sealV14BootstrapRecoveryKit({review,temporaryKey,scopeId,checkpointCapability,passphrase,crypto=globalThis.crypto}={}) {
  if(!crypto?.subtle||typeof crypto.getRandomValues!=='function'||!validPassphrase(passphrase)||
    !SCOPE.test(scopeId??'')||!HEX.test(checkpointCapability??'')||!review||typeof review!=='object')throw fail();
  const {review_sha256:reviewHash,...reviewBody}=review;
  if(reviewBody.format!=='bouncer-v14-temporary-vault-bootstrap-v1'||reviewBody.network!=='testnet'||
    reviewBody.wallet_approval_obtained!==false||reviewBody.transaction_sent!==false||!HEX.test(reviewHash??'')||
    await digest(crypto,JSON.stringify(reviewBody))!==reviewHash)throw fail();
  let pair;try{pair=privateKey(String(temporaryKey))}catch{throw fail()}
  if(String(pair.getPublicKey())!==reviewBody.temporary_vault_public_key)throw fail();
  const h=validateHeader({format:FORMAT,network:'testnet',owner:reviewBody.owner,owner_public_key:reviewBody.owner_public_key,
    vault:reviewBody.vault,temporary_public_key:String(pair.getPublicKey()),review_sha256:reviewHash,scope_id:scopeId,
    capability_sha256:await digest(crypto,checkpointCapability),kdf:'PBKDF2-SHA256',iterations:ITERATIONS,
    salt:b64(crypto.getRandomValues(new Uint8Array(16))),iv:b64(crypto.getRandomValues(new Uint8Array(12)))});
  const plaintext=ENCODER.encode(JSON.stringify({format:SECRET_FORMAT,temporary_private_key:String(pair),checkpoint_capability:checkpointCapability}));
  try {
    const aesKey=await aes(crypto,passphrase,unb64(h.salt,16),'encrypt');
    const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv:unb64(h.iv,12),additionalData:ENCODER.encode(JSON.stringify(h))},aesKey,plaintext);
    return {...h,ciphertext:b64(new Uint8Array(encrypted))};
  }catch{throw fail()}finally{plaintext.fill(0)}
}

/** Restore against separately trusted identity and review values, not the kit's
 * own header. Secrets are only exposed to a callback and are never returned in
 * JSON. The caller must retain originals separately and reconcile chain state. */
export async function openV14BootstrapRecoveryKit({kit,expected,passphrase,crypto=globalThis.crypto}={}) {
  if(!crypto?.subtle||!validPassphrase(passphrase)||!exact(kit,[...HEADER,'ciphertext'])||
    !exact(expected,['owner','vault','ownerPublicKey','temporaryPublicKey','reviewSha256','scopeId']))throw fail();
  const h=validateHeader(orderedHeader(kit));
  if(h.owner!==expected.owner||h.vault!==expected.vault||h.owner_public_key!==expected.ownerPublicKey||
    h.temporary_public_key!==expected.temporaryPublicKey||h.review_sha256!==expected.reviewSha256||h.scope_id!==expected.scopeId)throw fail();
  const ciphertext=unb64(kit.ciphertext);if(ciphertext.length<16||ciphertext.length>4096)throw fail();
  let plain,secret,pair,capability;
  try {
    const aesKey=await aes(crypto,passphrase,unb64(h.salt,16),'decrypt');
    plain=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(h.iv,12),additionalData:ENCODER.encode(JSON.stringify(h))},aesKey,ciphertext));
    secret=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain));
    if(!exact(secret,SECRET)||secret.format!==SECRET_FORMAT||!HEX.test(secret.checkpoint_capability??''))throw fail();
    pair=privateKey(secret.temporary_private_key);capability=secret.checkpoint_capability;
    if(String(pair.getPublicKey())!==h.temporary_public_key||await digest(crypto,capability)!==h.capability_sha256)throw fail();
  }catch{throw fail()}finally{plain?.fill(0);secret=null}
  let disposed=false;
  return Object.freeze({owner:h.owner,vault:h.vault,temporaryPublicKey:h.temporary_public_key,scopeId:h.scope_id,reviewSha256:h.review_sha256,
    async useSecrets(callback){if(disposed||typeof callback!=='function')throw fail();return callback({temporaryKey:pair,checkpointCapability:capability})},
    dispose(){disposed=true;pair=null;capability=null;},
  });
}
