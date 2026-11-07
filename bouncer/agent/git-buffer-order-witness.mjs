/** Independent, public compare-and-swap witness for one named testnet owner's
 * fixed Buffer order attempt. Only randomized commitments and account/key IDs
 * belong here: never a brief, bearer, signature, ciphertext decryption key,
 * wallet transaction or proof of delivery. Git history is independently
 * retained but can be rewritten by an administrator; operators must retain a
 * current head out of band. This is not a seller HTTP client. */
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { isTestnetAccount } from '../shared/account-id.mjs';
const ZERO='0'.repeat(64), H=/^[a-f0-9]{64}$/, ID=/^[a-f0-9]{32}$/;
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const plain=x=>x && typeof x==='object' && !Array.isArray(x) && Object.getPrototypeOf(x)===Object.prototype;
const exact=(x,fields)=>plain(x) && Object.keys(x).length===fields.length && fields.every(k=>Object.hasOwn(x,k));
const fields=['owner','owner_public_key','attempt_id','site','key_sha256','review_sha256','request_commitment_sha256','draft_sha256'];
export class BufferOrderWitnessError extends Error {
  constructor(code='ORDER_WITNESS_UNAVAILABLE') { super('Buffer order witness unavailable, conflicting or uncertain; never repeat an uncertain order'); this.code=code; }
}
const fail=()=>new BufferOrderWitnessError();
export function validateBufferOrderIdentity(input) {
  if (!exact(input,fields) || !isTestnetAccount(input.owner) || !ID.test(input.attempt_id ?? '') ||
      !['key_sha256','review_sha256','request_commitment_sha256','draft_sha256'].every(k=>H.test(input[k] ?? ''))) throw fail();
  try {
    const key=nearApi.utils.PublicKey.from(input.owner_public_key), site=new URL(input.site);
    if (String(key)!==input.owner_public_key || key.keyType!==0 || key.ed25519Key?.data?.length!==32 ||
        site.protocol!=='https:' || site.origin!==input.site || site.username || site.password) throw fail();
  } catch { throw fail(); }
  return Object.fromEntries(fields.map(k=>[k,input[k]]));
}
const identityHash=identity=>sha(JSON.stringify(['bouncer-buffer-order-identity-v1',...fields.map(k=>identity[k])]));
function line(identity,seq,event,previous,capsuleSha256) {
  const payload={format:'bouncer-buffer-order-witness-v1',seq,event,owner:identity.owner,
    identity_sha256:identityHash(identity),previous_sha256:previous,
    ...(event==='reserved' ? {identity} : {}), ...(event==='sealed' ? {capsule_sha256:capsuleSha256} : {})};
  return {...payload,hash:sha(JSON.stringify(payload))};
}
export function parseBufferOrderWitness(text,owner) {
  if (typeof text!=='string' || text.length>16_384 || !isTestnetAccount(owner) || (text && !text.endsWith('\n'))) throw fail();
  if (!text) return null;
  const lines=text.slice(0,-1).split('\n'); if (lines.length<1 || lines.length>3) throw fail();
  let identity,previous=ZERO; const records=[];
  for(let i=0;i<lines.length;i++) {
    let value; try { value=JSON.parse(lines[i]); } catch { throw fail(); }
    const event=['reserved','claimed','sealed'][i];
    if (i===0) identity=validateBufferOrderIdentity(value?.identity);
    const expected=line(identity,i+1,event,previous,value?.capsule_sha256);
    if (event==='sealed' && !H.test(value?.capsule_sha256 ?? '')) throw fail();
    if (identity.owner!==owner || JSON.stringify(value)!==lines[i] || JSON.stringify(value)!==JSON.stringify(expected)) throw fail();
    records.push(value); previous=value.hash;
  }
  return {identity,phase:records.at(-1).event,records};
}
export function createBufferOrderWitness({store}={}) {
  if (!store || typeof store.read!=='function' || typeof store.append!=='function') throw fail();
  async function inspect(owner) {
    const snapshot=await store.read(owner);
    if (!snapshot || typeof snapshot.head!=='string' || typeof snapshot.text!=='string') throw fail();
    return {...snapshot,state:parseBufferOrderWitness(snapshot.text,owner)};
  }
  async function append(identity,event,capsuleSha256) {
    identity=validateBufferOrderIdentity(identity);
    if (event==='sealed' && !H.test(capsuleSha256 ?? '')) throw fail();
    const snapshot=await inspect(identity.owner), state=snapshot.state;
    if (event==='reserved' ? state!==null : !state || JSON.stringify(state.identity)!==JSON.stringify(identity)) throw fail();
    if (event==='sealed' && state.phase==='sealed' && state.records.at(-1).capsule_sha256===capsuleSha256) return {confirmed:true,head:snapshot.head};
    if (event==='claimed' && state.phase!=='reserved' || event==='sealed' && state.phase!=='claimed') throw fail();
    const previous=state?.records.at(-1).hash ?? ZERO, seq=(state?.records.length ?? 0)+1;
    const text=snapshot.text+JSON.stringify(line(identity,seq,event,previous,capsuleSha256))+'\n';
    const result=await store.append({owner:identity.owner,expectedHead:snapshot.head,expectedText:snapshot.text,text});
    if (!result?.confirmed || typeof result.head!=='string') throw fail();
    return result;
  }
  return Object.freeze({inspect,reserve:identity=>append(identity,'reserved'),claim:identity=>append(identity,'claimed'),
    seal:(identity,capsuleSha256)=>append(identity,'sealed',capsuleSha256)});
}
