/**
 * Independent, recovery-only filesystem checkpoint for ONE testnet
 * bootstrap. Intended for a separately operated Railway persistent volume;
 * not mounted or initialized by default. It never signs, prompts, broadcasts,
 * deletes or retries a NEAR transaction. A volume can still be rolled back,
 * lost or altered by its operator. Compare it with an independently retained
 * head and on-chain receipts; this service alone cannot establish freshness.
 *
 * Each event is exclusively created and fsynced. An interrupted initialization
 * or partial write makes the store unavailable; it is NEVER repaired, reset,
 * recreated or retried here. All secret bearer capabilities stay out of paths,
 * returned data and error messages. Do not use a shared/ephemeral filesystem.
 */
import fs from 'node:fs';
import path from 'node:path';
import cryptoNode from 'node:crypto';
import {bootstrapSha256,verifyBootstrapAttestation,verifyBootstrapEnrollmentContents,
  validateBootstrapRecoveryTerms,bootstrapRecoveryMessage} from '../shared/v14-bootstrap-protocol.mjs';
import {verifyFreshV14Owner} from '../infrastructure/v14-owner-nep413.mjs';
import {verifyBootstrapAnchorInitialization} from '../shared/v14-bootstrap-anchor-auth.mjs';
import {buildV14TemporaryBootstrapPlan} from '../web-src/v14-bootstrap-plan.mjs';
import {inspectBootstrapOriginals} from '../web-src/v14-bootstrap-originals.mjs';

const OWNER='great_mujey.testnet',VAULT=`native.${OWNER}`,FUNDING=String(6n*10n**24n);
const HEX=/^[a-f0-9]{64}$/,SCOPE=/^[a-f0-9]{32}$/,ZERO='0'.repeat(64),DIR='v14-bootstrap-anchor-v1';
const exact=(x,fields)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===fields.length&&fields.every(k=>Object.hasOwn(x,k));
const fail=()=>new Error('Independent bootstrap checkpoint unavailable or uncertain; preserve existing records and never repeat a claimed prompt');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const textEncoder=new TextEncoder();
function syncDirectory(dir){const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}
function writeNew(file,text){
  const fd=fs.openSync(file,'wx',0o600);
  try{fs.writeFileSync(fd,text,{encoding:'utf8'});fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
}
function readFile(file,limit){
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size<1||stat.size>limit)throw fail();
  const raw=fs.readFileSync(file);if(raw.length!==stat.size)throw fail();
  return new TextDecoder('utf-8',{fatal:true}).decode(raw);
}
function validRoot(root){
  if(typeof root!=='string'||!path.isAbsolute(root)||root==='/'||fs.realpathSync(root)!==root)throw fail();
  const stat=fs.lstatSync(root);if(!stat.isDirectory()||stat.isSymbolicLink())throw fail();return root;
}

/** A caller must explicitly request initialization ONCE for an existing,
 * owner-signed candidate. Absence or a genesis snapshot never proves that no
 * prior initialization or transaction existed. No automatic initialization is
 * performed on read, restart, failure, restore or append. */
export function createV14BootstrapRailwayAnchor({volumePath,compressedV14:inputCompressed,crypto=globalThis.crypto}={}) {
  let root;try{root=validRoot(volumePath)}catch{throw fail()}
  if(!(inputCompressed instanceof Uint8Array)||!crypto?.subtle)throw fail();
  const compressedV14=new Uint8Array(inputCompressed),dir=path.join(root,DIR),metaFile=path.join(dir,'metadata.json'),lockFile=path.join(dir,'write.lock');
  function directory(){
    const stat=fs.lstatSync(dir);if(!stat.isDirectory()||stat.isSymbolicLink()||fs.realpathSync(dir)!==dir)throw fail();
  }
  function requireUnlocked(){
    try{fs.lstatSync(lockFile);throw fail()}catch(error){if(error?.code!=='ENOENT')throw fail()}
  }
  // An exclusive, fsynced marker also fences overlapping service processes.
  // If a process crashes, the marker remains; nobody silently removes it.
  function acquire(){writeNew(lockFile,'locked');syncDirectory(dir)}
  function release(){fs.unlinkSync(lockFile);syncDirectory(dir)}
  async function verifiedMeta() {
    directory();const raw=readFile(metaFile,64_000);let meta;try{meta=JSON.parse(raw)}catch{throw fail()}
    if(!exact(meta,['format','scope_id','review_sha256','capability_sha256','initialization_signature','review_text','sealed_kit','owner_attestation'])||
      JSON.stringify(meta)!==raw||meta.format!=='bouncer-v14-railway-anchor-v1'||!SCOPE.test(meta.scope_id??'')||
      !HEX.test(meta.review_sha256??'')||!HEX.test(meta.capability_sha256??''))throw fail();
    const att=await verifyBootstrapAttestation({text:meta.owner_attestation,crypto});
    const {review}=await verifyBootstrapEnrollmentContents({terms:att.terms,reviewText:meta.review_text,kitText:meta.sealed_kit,crypto});
    if(att.terms.owner!==OWNER||att.terms.vault!==VAULT||att.terms.scope_id!==meta.scope_id||
      att.terms.review_sha256!==meta.review_sha256||review.vault_funding_yocto!==FUNDING)throw fail();
    const plan=await buildV14TemporaryBootstrapPlan({owner:review.owner,ownerPublicKey:review.owner_public_key,vault:review.vault,
      temporaryPublicKey:review.temporary_vault_public_key,vaultFundingYocto:review.vault_funding_yocto,compressedV14,crypto});
    if(!same(plan.review,review))throw fail();
    await verifyBootstrapAnchorInitialization({scopeId:meta.scope_id,reviewSha256:meta.review_sha256,
      capabilitySha256:meta.capability_sha256,temporaryPublicKey:review.temporary_vault_public_key,
      signature:meta.initialization_signature,crypto});
    return {meta,review};
  }
  async function authenticate(capability,meta){
    if(!HEX.test(capability??''))throw fail();
    const actual=Buffer.from(await bootstrapSha256(crypto,capability),'hex'),expected=Buffer.from(meta.capability_sha256,'hex');
    if(actual.length!==expected.length||!cryptoNode.timingSafeEqual(actual,expected))throw fail();
  }
  async function snapshot(meta,{insideLock=false}={}) {
    directory();const names=fs.readdirSync(dir);
    if(!names.includes('metadata.json')||names.length>(insideLock?6:5)||
      names.some(n=>n!=='metadata.json'&&!(insideLock&&n==='write.lock')&&!/^[1-4]\.event$/.test(n)))throw fail();
    const events=[];
    for(let i=1;i<=4;i++){
      const name=`${i}.event`;
      if(!names.includes(name)){if(names.some(n=>/^[1-4]\.event$/.test(n)&&Number(n[0])>i))throw fail();break;}
      events.push(readFile(path.join(dir,name),4096));
    }
    const last=events.at(-1),head=last?await bootstrapSha256(crypto,last):ZERO;
    const result={revision:events.length,head_sha256:head,events};
    await inspectBootstrapOriginals({snapshot:result,scopeId:meta.scope_id,reviewSha256:meta.review_sha256,crypto});
    return result;
  }
  async function current(capability,{insideLock=false}={}) {
    if(!insideLock)requireUnlocked();
    const {meta,review}=await verifiedMeta();await authenticate(capability,meta);
    const history=await snapshot(meta,{insideLock});
    if(!insideLock)requireUnlocked();
    return {meta,review,snapshot:history};
  }
  function recovery(meta,history){
    return {scope_id:meta.scope_id,review_sha256:meta.review_sha256,review_text:meta.review_text,sealed_kit:meta.sealed_kit,
      owner_attestation:meta.owner_attestation,...history,latest_head_independently_verified:false,transaction_authorized:false};
  }
  return Object.freeze({
    /** Does not accept wallet secrets, passphrases or the Supabase capability.
     * A valid historical owner attestation and a domain-separated temporary
     * key possession proof are both required. No existing record is replaced. */
    async initialize(value){
      try {
        // Caller-owned objects must not change while signatures are checked.
        const input=structuredClone(value);
        if(!exact(input,['scope_id','review_sha256','capability','initialization_signature','review_text','sealed_kit','owner_attestation'])||
          !SCOPE.test(input.scope_id??'')||!HEX.test(input.review_sha256??'')||!HEX.test(input.capability??''))throw fail();
        const att=await verifyBootstrapAttestation({text:input.owner_attestation,crypto});
        const {review}=await verifyBootstrapEnrollmentContents({terms:att.terms,reviewText:input.review_text,kitText:input.sealed_kit,crypto});
        if(att.terms.owner!==OWNER||att.terms.vault!==VAULT||att.terms.scope_id!==input.scope_id||
          att.terms.review_sha256!==input.review_sha256||review.vault_funding_yocto!==FUNDING)throw fail();
        const plan=await buildV14TemporaryBootstrapPlan({owner:review.owner,ownerPublicKey:review.owner_public_key,vault:review.vault,
          temporaryPublicKey:review.temporary_vault_public_key,vaultFundingYocto:review.vault_funding_yocto,compressedV14,crypto});
        if(!same(plan.review,review))throw fail();
        const capabilitySha256=await bootstrapSha256(crypto,input.capability);
        await verifyBootstrapAnchorInitialization({scopeId:input.scope_id,reviewSha256:input.review_sha256,capabilitySha256,
          temporaryPublicKey:review.temporary_vault_public_key,signature:input.initialization_signature,crypto});
        const meta={format:'bouncer-v14-railway-anchor-v1',scope_id:input.scope_id,review_sha256:input.review_sha256,
          capability_sha256:capabilitySha256,initialization_signature:input.initialization_signature,
          review_text:input.review_text,sealed_kit:input.sealed_kit,owner_attestation:input.owner_attestation};
        // mkdir is the first irreversible action. If anything after it is
        // uncertain, this directory stays and no re-initialization is allowed.
        fs.mkdirSync(dir,{mode:0o700});syncDirectory(root);acquire();
        writeNew(metaFile,JSON.stringify(meta));syncDirectory(dir);release();
        const checked=await current(input.capability);
        if(!same(checked.snapshot,{revision:0,head_sha256:ZERO,events:[]}))throw fail();
        return checked.snapshot;
      }catch{throw fail()}
    },
    async read({capability,scope_id}={}) {try{
      const item=await current(capability);if(scope_id!==undefined&&scope_id!==item.meta.scope_id)throw fail();return item.snapshot;
    }catch{throw fail()}},
    async recover({capability}={}) {try{
      const {meta,snapshot}=await current(capability);return recovery(meta,snapshot);
    }catch{throw fail()}},
    /** Recover ciphertext without already possessing the temporary key. The
     * message must be freshly signed by a current owner FullAccess key and
     * checked against trusted FINAL RPC state; this is a read, not approval. */
    async recoverByOwner({signed:input,origin,fetch:fetchImpl=globalThis.fetch,now=Date.now}={}) {try{
      const signed=structuredClone(input);
      if(!exact(signed,['terms','nonce_base64','signature_base64'])||typeof fetchImpl!=='function'||typeof now!=='function')throw fail();
      const terms=validateBootstrapRecoveryTerms(signed.terms,{now:now()});
      if(terms.owner!==OWNER||terms.vault!==VAULT||terms.site!==origin)throw fail();
      await verifyFreshV14Owner({owner:OWNER,ownerPublicKey:terms.owner_public_key,message:bootstrapRecoveryMessage(terms),
        recipient:new URL(origin).host,nonceBase64:signed.nonce_base64,signatureBase64:signed.signature_base64,
        fetch:fetchImpl,crypto,now});
      validateBootstrapRecoveryTerms(terms,{now:now()});
      requireUnlocked();const {meta}=await verifiedMeta();const history=await snapshot(meta);requireUnlocked();
      validateBootstrapRecoveryTerms(terms,{now:now()});return recovery(meta,history);
    }catch{throw fail()}},
    async append({capability,scope_id,expected_revision,expected_head_sha256,record}={}) {try{
      if(!Number.isSafeInteger(expected_revision)||expected_revision<0||expected_revision>3||!HEX.test(expected_head_sha256??'')||
        typeof record!=='string'||textEncoder.encode(record).length>4096||/[\r\n]/.test(record))throw fail();
      const {meta,snapshot:before}=await current(capability);
      if((scope_id!==undefined&&scope_id!==meta.scope_id)||before.revision!==expected_revision||before.head_sha256!==expected_head_sha256)throw fail();
      const candidate={revision:before.revision+1,head_sha256:await bootstrapSha256(crypto,record),events:[...before.events,record]};
      await inspectBootstrapOriginals({snapshot:candidate,scopeId:meta.scope_id,reviewSha256:meta.review_sha256,crypto});
      // Fence readers and competing service processes BEFORE creating the
      // event. A reader must not treat bytes visible before fsync as durable.
      // On any uncertain write the lock survives for manual reconciliation.
      let locked=false,dirty=false;
      try {
        acquire();locked=true;
        const again=await current(capability,{insideLock:true});
        if(!same(again.snapshot,before))throw fail();
        dirty=true;writeNew(path.join(dir,`${candidate.revision}.event`),record);syncDirectory(dir);
        const after=(await current(capability,{insideLock:true})).snapshot;if(!same(after,candidate))throw fail();
        release();locked=false;return after;
      } finally {
        if(locked&&!dirty){try{release()}catch{/* leave a stale lock; never repair automatically */}}
      }
    }catch{throw fail()}},
  });
}
