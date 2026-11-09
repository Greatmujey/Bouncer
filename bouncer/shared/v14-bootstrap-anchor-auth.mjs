/** Domain-separated authentication for an independent encrypted bootstrap
 * checkpoint. The temporary private key stays in the caller's browser. The
 * deterministic service capability is derived from a DIFFERENT signature than
 * the initialization proof, so an enrollment signature does not reveal it.
 * Neither credential can sign a NEAR transaction. Do not log either value. */
import {PublicKey} from '@near-js/crypto';
import {bootstrapSha256} from './v14-bootstrap-protocol.mjs';

const HEX=/^[a-f0-9]{64}$/,SCOPE=/^[a-f0-9]{32}$/;
const fail=()=>new Error('Independent bootstrap checkpoint authentication unavailable');
const encoder=new TextEncoder();
const hex=bytes=>[...bytes].map(n=>n.toString(16).padStart(2,'0')).join('');
const b64=bytes=>btoa(String.fromCharCode(...bytes));
function unb64(value) {
  if(typeof value!=='string'||!/^[A-Za-z0-9+/]{86}==$/.test(value))throw fail();
  let raw;try{raw=atob(value)}catch{throw fail()}
  if(raw.length!==64||btoa(raw)!==value)throw fail();
  return Uint8Array.from(raw,c=>c.charCodeAt(0));
}
async function message(crypto,kind,scopeId,reviewSha256,capabilitySha256=''){
  if(!crypto?.subtle||!SCOPE.test(scopeId??'')||!HEX.test(reviewSha256??'')||
    !['capability','initialize'].includes(kind)||(kind==='initialize'&&!HEX.test(capabilitySha256)))throw fail();
  return new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(
    `bouncer-v14-railway-anchor-v1\0${kind}\0${scopeId}\0${reviewSha256}\0${capabilitySha256}`)));
}
async function sign(key,digest,publicKey){
  const value=await key.sign(new Uint8Array(digest));
  if(!(value?.signature instanceof Uint8Array)||value.signature.length!==64||String(value.publicKey)!==String(publicKey)||
    !publicKey.verify(digest,value.signature))throw fail();
  return new Uint8Array(value.signature);
}
/** Call only inside an opened recovery kit. Output is secret bearer material. */
export async function deriveBootstrapAnchorCredentials({temporaryKey,scopeId,reviewSha256,crypto=globalThis.crypto}={}) {
  if(!temporaryKey||typeof temporaryKey.getPublicKey!=='function'||typeof temporaryKey.sign!=='function')throw fail();
  let publicKey;try{publicKey=PublicKey.from(String(temporaryKey.getPublicKey()))}catch{throw fail()}
  if(publicKey.keyType!==0||publicKey.ed25519Key?.data?.length!==32)throw fail();
  let capSignature,initSignature;
  try {
    capSignature=await sign(temporaryKey,await message(crypto,'capability',scopeId,reviewSha256),publicKey);
    const capability=await bootstrapSha256(crypto,`bouncer-v14-railway-capability-v1\0${hex(capSignature)}`);
    const capabilitySha256=await bootstrapSha256(crypto,capability);
    initSignature=await sign(temporaryKey,await message(crypto,'initialize',scopeId,reviewSha256,capabilitySha256),publicKey);
    return Object.freeze({capability,capability_sha256:capabilitySha256,initialization_signature:b64(initSignature),
      temporary_public_key:String(publicKey)});
  }finally{capSignature?.fill(0);initSignature?.fill(0)}
}
/** Verify only proof of possession of the temporary key and the specific
 * service capability. It is not an owner approval or transaction signature. */
export async function verifyBootstrapAnchorInitialization({scopeId,reviewSha256,capabilitySha256,temporaryPublicKey,signature,
  crypto=globalThis.crypto}={}) {
  let publicKey;try{publicKey=PublicKey.from(temporaryPublicKey)}catch{throw fail()}
  if(typeof temporaryPublicKey!=='string'||!temporaryPublicKey.startsWith('ed25519:')||publicKey.keyType!==0||
    publicKey.ed25519Key?.data?.length!==32||String(publicKey)!==temporaryPublicKey||
    !publicKey.verify(await message(crypto,'initialize',scopeId,reviewSha256,capabilitySha256),unb64(signature)))throw fail();
  return true;
}
