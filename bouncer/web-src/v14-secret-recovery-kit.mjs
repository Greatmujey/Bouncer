/**
 * Experimental, local-only encrypted recovery kit for V14 checkpoint secrets.
 *
 * A kit may contain the checkpoint capability, the two journal encryption
 * keys and ONLY the three reviewed restricted agent keys. Never supply any
 * owner wallet key or seed. Matching the reviewed public keys and rejecting
 * the reviewed owner signing key does NOT prove another key is not FullAccess;
 * a fresh on-chain key preflight is separately required. It does not contain the journals, prove that
 * a copy is current, restore a journal, authorize a wallet prompt or send a
 * transaction. The caller must independently retain the journals and their
 * latest checkpoint heads, and reconcile any uncertainty before recovery.
 *
 * This module performs no network or storage I/O and is not wired into the
 * live wallet UI. WebCrypto and the page receiving these secrets are trusted;
 * a compromised origin/browser/backend can steal them. JavaScript cannot
 * guarantee erasure of secret strings from memory.
 */
import { ed25519 } from '@noble/curves/ed25519';
import { isV14CheckpointAccountPair } from './v14-checkpoint-enrollment.mjs';

export const V14_KIT_ITERATIONS=600_000;
const FORMAT='bouncer-v14-secret-kit-v1', SECRETS='bouncer-v14-restricted-secrets-v1';
const HEX=/^[a-f0-9]{64}$/,SCOPE=/^[a-f0-9]{32}$/,ID=/^[A-Za-z0-9_-]{1,64}$/;
const ALPHABET='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const HEADER_FIELDS=['format','kdf','iterations','cipher','owner','vault','scope_id','review_sha256','capability_sha256','salt_base64','iv_base64'];
const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const fail=()=>new Error('V14 recovery kit is invalid or could not be unlocked; preserve existing originals and stop');
const hex=bytes=>[...bytes].map(byte=>byte.toString(16).padStart(2,'0')).join('');
const b64=bytes=>btoa(String.fromCharCode(...bytes));
const same=(a,b)=>a.length===b.length&&a.every((byte,index)=>byte===b[index]);
const utf8=text=>new TextEncoder().encode(text);

function unb64(value,length) {
  if(typeof value!=='string'||value.length>20_000||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw fail();
  let decoded;try{decoded=atob(value)}catch{throw fail()}
  const bytes=Uint8Array.from(decoded,char=>char.charCodeAt(0));
  if(b64(bytes)!==value||(length!==undefined&&bytes.length!==length))throw fail();
  return bytes;
}
function decodeKey(value,expectedLength) {
  if(typeof value!=='string'||!value.startsWith('ed25519:'))throw fail();
  const text=value.slice(8);
  if(!text||text.length>90||[...text].some(char=>!ALPHABET.includes(char)))throw fail();
  let number=0n;
  for(const char of text)number=number*58n+BigInt(ALPHABET.indexOf(char));
  const bytes=[];
  while(number>0n){bytes.push(Number(number&255n));number>>=8n}
  bytes.reverse();let zeros=0;while(text[zeros]==='1')zeros++;
  const result=Uint8Array.from([...new Array(zeros).fill(0),...bytes]);
  if(result.length!==expectedLength)throw fail();
  return result;
}
function checkCrypto(crypto) {
  if(!crypto?.subtle||typeof crypto.getRandomValues!=='function')throw fail();
}
function passwordBytes(passphrase) {
  if(typeof passphrase!=='string')throw fail();
  const normalized=passphrase.normalize('NFKC');
  if([...normalized].length<14||[...normalized].length>128||!normalized.trim()||new Set([...normalized]).size<8)throw fail();
  const bytes=utf8(normalized);if(bytes.length>512)throw fail();return bytes;
}
async function digest(crypto,value) {return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',utf8(value))));}
async function reviewedIdentity(review,trustedReviewSha256,crypto) {
  if(!HEX.test(trustedReviewSha256??'')||review?.review_sha256!==trustedReviewSha256||
      !review||typeof review!=='object'||Array.isArray(review)||review.format!=='bouncer-research-v14-phone-plan-v1'||
      review.status!=='UNSIGNED_OFFLINE_PLAN_ONLY'||review.network!=='testnet'||review.signing_authorized!==false||
      review.transaction_sent!==false||!isV14CheckpointAccountPair(review.vault,review.owner)||!HEX.test(review.review_sha256??'')||
      !Array.isArray(review.mission?.goals)||review.mission.goals.length!==3||!review.agent_public_keys||
      typeof review.agent_public_keys!=='object'||Array.isArray(review.agent_public_keys))throw fail();
  const encoded=JSON.stringify(review);if(utf8(encoded).length>20_000)throw fail();
  const unsigned={...review};delete unsigned.review_sha256;
  if(await digest(crypto,JSON.stringify(unsigned))!==review.review_sha256)throw fail();
  const ids=review.mission.goals.map(item=>item?.goal?.id);
  if(ids.some(id=>!ID.test(id??''))||new Set(ids).size!==3||
      Object.keys(review.agent_public_keys).sort().join('\0')!==[...ids].sort().join('\0'))throw fail();
  const ownerKey=decodeKey(review.owner_public_key,32),publicKeys=new Set();
  for(const id of ids) {
    const value=review.agent_public_keys[id],bytes=decodeKey(value,32);
    if(same(bytes,ownerKey)||publicKeys.has(value))throw fail();
    publicKeys.add(value);
  }
  return {owner:review.owner,vault:review.vault,review_sha256:review.review_sha256,ids,agent_public_keys:{...review.agent_public_keys}};
}
function validateSecrets(secrets,identity) {
  if(!exact(secrets,['format','capability','witness_journal_key','mission_journal_key','restricted_agent_keys'])||secrets.format!==SECRETS||
      !HEX.test(secrets.capability??'')||!HEX.test(secrets.witness_journal_key??'')||!HEX.test(secrets.mission_journal_key??'')||
      new Set([secrets.capability,secrets.witness_journal_key,secrets.mission_journal_key]).size!==3||
      !exact(secrets.restricted_agent_keys,identity.ids))throw fail();
  for(const id of identity.ids) {
    const raw=decodeKey(secrets.restricted_agent_keys[id],64),expected=decodeKey(identity.agent_public_keys[id],32);
    try {
      const derived=ed25519.getPublicKey(raw.subarray(0,32));
      if(!same(derived,expected)||!same(raw.subarray(32),expected))throw fail();
    } finally {raw.fill(0)}
  }
}
function headerFor(envelope) {
  return Object.fromEntries(HEADER_FIELDS.map(key=>[key,envelope[key]]));
}
async function deriveKey(crypto,passphrase,salt,usage) {
  const password=passwordBytes(passphrase);
  try {
    const material=await crypto.subtle.importKey('raw',password,'PBKDF2',false,['deriveKey']);
    return await crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations:V14_KIT_ITERATIONS},material,
      {name:'AES-GCM',length:256},false,[usage]);
  } finally {password.fill(0)}
}
function checkedHeader(envelope,identity,scopeId,capabilitySha256) {
  if(!exact(envelope,[...HEADER_FIELDS,'ciphertext_base64'])||envelope.format!==FORMAT||envelope.kdf!=='PBKDF2-SHA256'||
      envelope.iterations!==V14_KIT_ITERATIONS||envelope.cipher!=='AES-256-GCM'||envelope.owner!==identity.owner||
      envelope.vault!==identity.vault||envelope.review_sha256!==identity.review_sha256||!SCOPE.test(scopeId??'')||
      envelope.scope_id!==scopeId||!HEX.test(capabilitySha256??'')||envelope.capability_sha256!==capabilitySha256)throw fail();
  const salt=unb64(envelope.salt_base64,16),iv=unb64(envelope.iv_base64,12),ciphertext=unb64(envelope.ciphertext_base64);
  if(ciphertext.length<17||ciphertext.length>12_000)throw fail();
  return {salt,iv,ciphertext,additionalData:utf8(JSON.stringify(headerFor(envelope)))};
}

/** Seal on the trusted device. `capabilitySha256` must come from the exact
 * separately retained owner-signed enrollment; do not trust a server-supplied
 * replacement. Passwords should be long, unique and saved outside the app. */
export async function sealV14SecretKit({review,trustedReviewSha256,scopeId,capabilitySha256,capability,witnessJournalKey,missionJournalKey,
    restrictedAgentKeys,passphrase,crypto=globalThis.crypto}={}) {
  checkCrypto(crypto);
  const identity=await reviewedIdentity(structuredClone(review),trustedReviewSha256,crypto);
  const secrets={format:SECRETS,capability,witness_journal_key:witnessJournalKey,mission_journal_key:missionJournalKey,
    restricted_agent_keys:structuredClone(restrictedAgentKeys)};
  validateSecrets(secrets,identity);
  if(!SCOPE.test(scopeId??'')||!HEX.test(capabilitySha256??'')||await digest(crypto,capability)!==capabilitySha256)throw fail();
  const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
  const header={format:FORMAT,kdf:'PBKDF2-SHA256',iterations:V14_KIT_ITERATIONS,cipher:'AES-256-GCM',owner:identity.owner,
    vault:identity.vault,scope_id:scopeId,review_sha256:identity.review_sha256,capability_sha256:capabilitySha256,
    salt_base64:b64(salt),iv_base64:b64(iv)};
  const plain=utf8(JSON.stringify(secrets));
  try {
    const key=await deriveKey(crypto,passphrase,salt,'encrypt');
    const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:utf8(JSON.stringify(header)),tagLength:128},key,plain);
    return {...header,ciphertext_base64:b64(new Uint8Array(encrypted))};
  } catch {throw fail()} finally {plain.fill(0)}
}

/** Unlock only against the original public review, scope and capability hash.
 * A successful decryption is not permission to recreate a missing journal or
 * retry an unresolved transaction. Returned secrets stay in caller memory. */
export async function openV14SecretKit({envelope,review,trustedReviewSha256,scopeId,capabilitySha256,passphrase,crypto=globalThis.crypto}={}) {
  checkCrypto(crypto);
  const identity=await reviewedIdentity(structuredClone(review),trustedReviewSha256,crypto),copy=structuredClone(envelope);
  const {salt,iv,ciphertext,additionalData}=checkedHeader(copy,identity,scopeId,capabilitySha256);
  let plain;
  try {
    const key=await deriveKey(crypto,passphrase,salt,'decrypt');
    plain=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData,tagLength:128},key,ciphertext));
    const secrets=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain));
    validateSecrets(secrets,identity);
    if(await digest(crypto,secrets.capability)!==capabilitySha256)throw fail();
    return structuredClone(secrets);
  } catch {throw fail()} finally {plain?.fill(0)}
}
