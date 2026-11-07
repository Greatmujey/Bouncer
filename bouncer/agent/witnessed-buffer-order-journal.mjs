/** Coordinates an authenticated PostgreSQL write-ahead journal with a separate
 * public CAS witness. No seller POST, signer, wallet, policy or transaction is
 * implemented here. Both stores must be independently durable, monitored and
 * anchored. A claimed or uncertain attempt never grants a retry. */
import {isDeepStrictEqual} from 'node:util';
import {privateOrderCapsuleCommitment} from '../web-src/buffer-private-order-capsule.mjs';
import {validateBufferOrderIdentity} from './git-buffer-order-witness.mjs';
export class WitnessedBufferOrderError extends Error {
  constructor(code='ORDER_RECOVERY_REQUIRED') {
    super('Buffer order state is uncertain or inconsistent; retain the evidence and never repeat an uncertain order'); this.code=code;
  }
}
const fail=()=>new WitnessedBufferOrderError();
export function createWitnessedBufferOrderJournal({fence,witness}={}) {
  if(!fence || ['reserve','claim','record','retainClaimedResult','inspect'].some(k=>typeof fence[k]!=='function') ||
      !witness || ['reserve','claim','seal','inspect'].some(k=>typeof witness[k]!=='function')) throw fail();
  const checked=raw=>{try{return validateBufferOrderIdentity(structuredClone(raw))}catch{throw fail()}};
  const matching=(state,id)=>state && isDeepStrictEqual(state.identity,id);
  const localClaims=new WeakMap();
  return Object.freeze({
    async reserve({identity:raw,keyRecord,draftCapsule,evidence}={}) {
      const id=checked(raw), remote=await witness.inspect(id.owner);
      if(remote.state) throw fail();
      try {
        await fence.reserve({identity:id,keyRecord,draftCapsule,evidence});
        await witness.reserve(id);
        return {identity:id,status:'RESERVED',independently_witnessed:true,seller_post_authorized:false};
      } catch { throw fail(); }
    },
    /** Repair a missing reservation witness only for the exact authenticated,
     * still-unclaimed database row. This never repairs or repeats a claim. */
    async reconcileReservation({identity:raw,evidence}={}) {
      const id=checked(raw), remote=await witness.inspect(id.owner);
      if(remote.state) throw fail();
      try {
        const row=await fence.inspect({identity:id,evidence});
        if(row.state!=='reserved') throw fail();
        await witness.reserve(id);
        return {identity:id,status:'RESERVED',independently_witnessed:true,seller_post_authorized:false};
      } catch { throw fail(); }
    },
    async claim({identity:raw,evidence}={}) {
      const id=checked(raw), remote=await witness.inspect(id.owner);
      if(!matching(remote.state,id) || remote.state.phase!=='reserved') throw fail();
      try {
        const receipt=await fence.claim({identity:id,evidence});
        await witness.claim(id);
        const claim=Object.freeze({identity:Object.freeze(id),status:'CLAIMED_NO_RESULT',independently_witnessed:true,do_not_retry:true,seller_post_authorized:false});
        localClaims.set(claim,receipt); return claim;
      } catch { throw fail(); }
    },
    /** Only a same-process claim can retain a checked response immediately.
     * This capability cannot be reconstructed from a JSON response and does
     * not let the caller perform or repeat any seller request. */
    async retainClaimedResult({claim,keyRecord,capsule}={}) {
      const receipt=claim && typeof claim==='object' ? localClaims.get(claim) : null;
      if(!receipt) throw fail();
      localClaims.delete(claim);
      const id=checked(claim.identity),remote=await witness.inspect(id.owner);
      if(!matching(remote.state,id) || remote.state.phase!=='claimed') throw fail();
      try {
        const row=await fence.retainClaimedResult({claim:receipt,keyRecord,capsule});
        await witness.seal(id,row.capsule_sha256);
        return {identity:id,status:'SEALED',capsule_sha256:row.capsule_sha256,independently_witnessed:true,
          do_not_retry:true,seller_post_authorized:false,delivered:false};
      } catch { throw fail(); }
    },
    async record({identity:raw,keyRecord,capsule,evidence}={}) {
      const id=checked(raw), remote=await witness.inspect(id.owner);
      if(!matching(remote.state,id) || !['claimed','sealed'].includes(remote.state.phase)) throw fail();
      try {
        if(remote.state.phase==='sealed' && await privateOrderCapsuleCommitment({capsule})!==remote.state.records.at(-1).capsule_sha256) throw fail();
        const row=await fence.record({identity:id,keyRecord,capsule,evidence});
        if(remote.state.phase==='sealed' && remote.state.records.at(-1).capsule_sha256!==row.capsule_sha256) throw fail();
        await witness.seal(id,row.capsule_sha256);
        return {identity:id,status:'SEALED',capsule_sha256:row.capsule_sha256,independently_witnessed:true,
          do_not_retry:true,seller_post_authorized:false,delivered:false};
      } catch { throw fail(); }
    },
    async inspect({identity:raw,evidence}={}) {
      const id=checked(raw), remote=await witness.inspect(id.owner);
      let row; try { row=await fence.inspect({identity:id,evidence}); }
      catch(e) { if(e?.code!=='NOT_FOUND') throw fail(); }
      if(!row && !remote.state) return {status:'NO_LOCAL_RECORD',seller_post_authorized:false,
        scope:'Absence here does not prove no order was submitted elsewhere.'};
      if(!row || !matching(remote.state,id) || row.state!==remote.state.phase ||
          (row.state==='sealed' && row.capsule_sha256!==remote.state.records.at(-1).capsule_sha256)) {
        return {status:'RECOVERY_REQUIRED',do_not_retry:true,seller_post_authorized:false};
      }
      return {status:row.state.toUpperCase(),key_record:row.key_record,draft_capsule:row.draft_capsule,
        ...(row.capsule ? {capsule:row.capsule,capsule_sha256:row.capsule_sha256} : {}),
        do_not_retry:row.state!=='reserved',independently_witnessed:true,seller_post_authorized:false,delivered:false};
    },
  });
}
