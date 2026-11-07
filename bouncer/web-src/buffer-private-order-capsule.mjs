/** Experimental owner-unlockable private Buffer order capsule. No seller HTTP,
 * persistence, transaction or wallet-spending approval is performed here.
 * The off-chain NEP-413 unlock signature is key material: never transmit, log,
 * or reuse it as a login. A compromised site/wallet can steal plaintext. The
 * owner must retain the key record and a wallet able to reproduce this exact
 * Ed25519 signature; loss of either means permanent loss of access. */
import { isTestnetAccount } from './wallet-utils.mjs';
import { verifyCliLogin } from './cli-login.mjs';

const enc = new TextEncoder(), dec = new TextDecoder('utf-8', {fatal:true});
const fail = () => Error('PRIVATE_ORDER_CAPSULE_UNAVAILABLE');
const KEY_FORMAT = 'bouncer-buffer-private-key-v1', DATA_FORMAT = 'bouncer-buffer-private-order-v1';
const KEY_FIELDS = ['format','network','owner','owner_public_key','site','nonce','public_spki','public_key_sha256','salt','iv','wrapped_private'];
const DATA_FIELDS = ['format','network','owner','site','public_key_sha256','attempt_id','wrapped_key','iv','ciphertext'];
const plain = x => !!x && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
const exact = (x, keys) => plain(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x,k));
const hex = bytes => [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');
const b64 = bytes => btoa(Array.from(new Uint8Array(bytes), x=>String.fromCharCode(x)).join(''));
function unb64(value, min, max) {
  if (typeof value !== 'string' || value.length > Math.ceil(max/3)*4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw fail();
  let s; try { s=atob(value); } catch { throw fail(); }
  if (s.length<min || s.length>max || btoa(s)!==value) throw fail();
  return Uint8Array.from(s,c=>c.charCodeAt(0));
}
function siteFrom(location) {
  let u; try { u=new URL(location?.origin); } catch { throw fail(); }
  if (u.protocol!=='https:' || u.origin!==location.origin || u.host!==location.host || u.username || u.password) throw fail();
  return u.origin;
}
function identity(owner, publicKey, site) {
  if (!isTestnetAccount(owner) || typeof publicKey!=='string' || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(publicKey) ||
      typeof site!=='string') throw fail();
  const u=new URL(site);
  if (u.protocol!=='https:' || u.origin!==site || u.username || u.password) throw fail();
}
function meta(record) {
  return [KEY_FORMAT,record.network,record.owner,record.owner_public_key,record.site,record.nonce,
    record.public_key_sha256,record.salt];
}
function dataMeta(data) {
  return [DATA_FORMAT,data.network,data.owner,data.site,data.public_key_sha256,data.attempt_id];
}
function message(owner, publicKey, site) {
  return `Bouncer private Buffer order unlock\nAccount: ${owner}\nPublic key: ${publicKey}\nSite: ${site}\n`+
    'This off-chain signature unlocks private order data. Keep it private. It is not a transaction or spending approval.';
}
async function signUnlock({wallet,owner,ownerPublicKey,site,nonce,crypto,fetch}) {
  if (!wallet || typeof wallet.signMessage!=='function' || !crypto?.subtle || typeof fetch!=='function') throw fail();
  const recipient=new URL(site).host, text=message(owner,ownerPublicKey,site);
  const mobile=wallet.manifest?.id==='near-mobile' ? {accountId:owner} : {};
  const signed=await wallet.signMessage({network:'testnet',signerId:owner,...mobile,message:text,nonce:new Uint8Array(nonce),recipient});
  if (signed?.accountId!==owner || signed.publicKey!==ownerPublicKey) throw fail();
  await verifyCliLogin({account:{accountId:owner,publicKey:ownerPublicKey,signedMessage:signed},
    message:text,nonce,recipient,crypto,fetch});
  return unb64(signed.signature,64,64);
}
async function wrappingKey(signature, record, crypto) {
  const material=await crypto.subtle.importKey('raw',signature,'HKDF',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:unb64(record.salt,32,32),
    info:enc.encode(JSON.stringify(['bouncer-buffer-private-wrap-v1',...meta(record)]))},material,
    {name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
async function checkedPublic(record, crypto) {
  if (!exact(record,KEY_FIELDS) || record.format!==KEY_FORMAT || record.network!=='testnet' ||
      !/^[a-f0-9]{64}$/.test(record.public_key_sha256 ?? '')) throw fail();
  identity(record.owner,record.owner_public_key,record.site);
  unb64(record.nonce,32,32); unb64(record.salt,32,32); unb64(record.iv,12,12); unb64(record.wrapped_private,1000,3000);
  const spki=unb64(record.public_spki,250,400);
  if (hex(await crypto.subtle.digest('SHA-256',spki))!==record.public_key_sha256) throw fail();
  const key=await crypto.subtle.importKey('spki',spki,{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt','wrapKey']);
  if (key.algorithm.modulusLength!==2048 || b64(key.algorithm.publicExponent)!=='AQAB') throw fail();
  return key;
}
function checkedData(value) {
  if (!exact(value,['brief','sku','orderId','onchainOrderId','accessToken']) || typeof value.brief!=='string' ||
      !value.brief.isWellFormed() || value.brief!==value.brief.trim() || value.brief.length<10 || value.brief.length>4000 ||
      enc.encode(value.brief).length>16000 || !['weekly-market-brief','crosschain-brief'].includes(value.sku) ||
      typeof value.orderId!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.orderId) ||
      typeof value.onchainOrderId!=='string' || !/^o-[0-9a-f]{12}$/.test(value.onchainOrderId) ||
      typeof value.accessToken!=='string' || !/^[0-9a-f]{48}$/.test(value.accessToken)) throw fail();
  return value;
}

/** Enroll a public encryption key, wrapping its private half with a wallet's
 * repeatable off-chain Ed25519 signature. This module does not return or
 * transmit that signature; wallet/browser compromise can still expose it.
 * The returned record contains no plaintext private key or unlock signature. */
export async function createPrivateOrderKey({wallet,owner,ownerPublicKey,location,crypto=globalThis.crypto,fetch=globalThis.fetch}={}) {
  try {
    const site=siteFrom(location); identity(owner,ownerPublicKey,site);
    const nonce=crypto.getRandomValues(new Uint8Array(32)), salt=crypto.getRandomValues(new Uint8Array(32)),
      iv=crypto.getRandomValues(new Uint8Array(12));
    const signature=await signUnlock({wallet,owner,ownerPublicKey,site,nonce,crypto,fetch});
    try {
      // Refuse a wallet that cannot reproduce its own unlock signature.
      const again=await signUnlock({wallet,owner,ownerPublicKey,site,nonce,crypto,fetch});
      try { if (again.some((x,i)=>x!==signature[i])) throw fail(); } finally { again.fill(0); }
      const pair=await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:2048,
        publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['encrypt','decrypt','wrapKey','unwrapKey']);
      const spki=await crypto.subtle.exportKey('spki',pair.publicKey), pkcs8=new Uint8Array(await crypto.subtle.exportKey('pkcs8',pair.privateKey));
      const record={format:KEY_FORMAT,network:'testnet',owner,owner_public_key:ownerPublicKey,site,nonce:b64(nonce),
        public_spki:b64(spki),public_key_sha256:hex(await crypto.subtle.digest('SHA-256',spki)),salt:b64(salt),iv:b64(iv),wrapped_private:''};
      try {
        const key=await wrappingKey(signature,record,crypto);
        record.wrapped_private=b64(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:enc.encode(JSON.stringify(meta(record)))},key,pkcs8));
      } finally { pkcs8.fill(0); }
      await checkedPublic(record,crypto);
      return record;
    } finally { signature.fill(0); }
  } catch { throw fail(); }
}

/** Anyone possessing the public record may encrypt a single private fixed
 * order; only its matching wallet-derived key can decrypt the result. The
 * caller must validate seller terms and durably commit the ciphertext before
 * treating the order as retained; sealing alone does not do either. */
export async function sealPrivateOrder({keyRecord,attemptId,privateOrder,crypto=globalThis.crypto}={}) {
  try {
    const record=structuredClone(keyRecord), order=checkedData(structuredClone(privateOrder));
    if (!/^[a-f0-9]{32}$/.test(attemptId ?? '')) throw fail();
    const publicKey=await checkedPublic(record,crypto);
    const aes=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const capsule={format:DATA_FORMAT,network:'testnet',owner:record.owner,site:record.site,
      public_key_sha256:record.public_key_sha256,attempt_id:attemptId,wrapped_key:'',iv:b64(iv),ciphertext:''};
    capsule.wrapped_key=b64(await crypto.subtle.wrapKey('raw',aes,publicKey,{name:'RSA-OAEP'}));
    capsule.ciphertext=b64(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:enc.encode(JSON.stringify(dataMeta(capsule)))},
      aes,enc.encode(JSON.stringify(order))));
    return capsule;
  } catch { throw fail(); }
}

/** A public-key capsule can be forged by anyone with the public key. Its
 * exact commitment MUST be independently retained by the authenticated order
 * coordinator/witness; a digest supplied by the same untrusted store is not
 * an authentication or integrity anchor. No bearer or brief is revealed. */
export async function privateOrderCapsuleCommitment({capsule:input,crypto=globalThis.crypto}={}) {
  try {
    const capsule=structuredClone(input);
    if (!exact(capsule,DATA_FIELDS) || capsule.format!==DATA_FORMAT || capsule.network!=='testnet' ||
        !isTestnetAccount(capsule.owner) || typeof capsule.site!=='string' ||
        !/^[a-f0-9]{64}$/.test(capsule.public_key_sha256 ?? '') || !/^[a-f0-9]{32}$/.test(capsule.attempt_id ?? '')) throw fail();
    unb64(capsule.wrapped_key,256,256); unb64(capsule.iv,12,12); unb64(capsule.ciphertext,17,20000);
    return hex(await crypto.subtle.digest('SHA-256',enc.encode(JSON.stringify(['bouncer-buffer-capsule-commitment-v1',
      ...DATA_FIELDS.map(k=>capsule[k])]))));
  } catch { throw fail(); }
}

/** Owner-only local decryption. The independently witnessed commitment is
 * required to prevent substitution; the server should also authenticate a
 * fresh separate challenge before returning the retained ciphertext. */
export async function openPrivateOrder({wallet,keyRecord,capsule:input,trustedCapsuleSha256,location,crypto=globalThis.crypto,fetch=globalThis.fetch}={}) {
  try {
    const record=structuredClone(keyRecord), capsule=structuredClone(input), site=siteFrom(location);
    await checkedPublic(record,crypto);
    if (!/^[a-f0-9]{64}$/.test(trustedCapsuleSha256 ?? '') ||
        await privateOrderCapsuleCommitment({capsule,crypto})!==trustedCapsuleSha256) throw fail();
    if (!exact(capsule,DATA_FIELDS) || capsule.format!==DATA_FORMAT || capsule.network!=='testnet' ||
        capsule.owner!==record.owner || capsule.site!==record.site || site!==record.site ||
        capsule.public_key_sha256!==record.public_key_sha256 || !/^[a-f0-9]{32}$/.test(capsule.attempt_id ?? '')) throw fail();
    const wrapped=unb64(capsule.wrapped_key,256,256), iv=unb64(capsule.iv,12,12), ciphertext=unb64(capsule.ciphertext,17,20000);
    const signature=await signUnlock({wallet,owner:record.owner,ownerPublicKey:record.owner_public_key,
      site,nonce:unb64(record.nonce,32,32),crypto,fetch});
    try {
      const key=await wrappingKey(signature,record,crypto);
      const privateBytes=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(record.iv,12,12),
        additionalData:enc.encode(JSON.stringify(meta(record)))},key,unb64(record.wrapped_private,1000,3000)));
      try {
        const privateKey=await crypto.subtle.importKey('pkcs8',privateBytes,{name:'RSA-OAEP',hash:'SHA-256'},false,['unwrapKey']);
        if (privateKey.algorithm.modulusLength!==2048 || b64(privateKey.algorithm.publicExponent)!=='AQAB') throw fail();
        const aes=await crypto.subtle.unwrapKey('raw',wrapped,privateKey,{name:'RSA-OAEP'},
          {name:'AES-GCM',length:256},false,['decrypt']);
        const bytes=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv,
          additionalData:enc.encode(JSON.stringify(dataMeta(capsule)))},aes,ciphertext));
        try { return checkedData(JSON.parse(dec.decode(bytes))); } finally { bytes.fill(0); }
      } finally { privateBytes.fill(0); }
    } finally { signature.fill(0); }
  } catch { throw fail(); }
}
