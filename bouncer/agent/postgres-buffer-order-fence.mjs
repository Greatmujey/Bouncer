/** EXPERIMENTAL one-attempt Buffer private-order write-ahead journal. It has
 * NO seller HTTP, wallet, transaction or payment code. Authentication is an
 * injected, REQUIRED trust boundary: it must verify the current owner, exact
 * identity/action and a fresh single-use challenge. PostgreSQL alone cannot
 * resist privileged deletion, stale restores, split primaries, owner bypass or
 * simultaneous witness rollback. A claimed order with no sealed capsule is
 * UNKNOWN and must never be automatically retried. One owner has at most one
 * trial attempt in this schema; no reset/delete API is provided. */
import { isDeepStrictEqual } from 'node:util';
import { validateBufferOrderIdentity } from './git-buffer-order-witness.mjs';
import { privateOrderCapsuleCommitment, inspectPrivateOrderKeyRecord } from '../web-src/buffer-private-order-capsule.mjs';
const SCHEMA='bouncer_buffer_order_v1';
const GUARD=`
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Buffer order records cannot be deleted'; END IF;
  IF NEW.owner IS DISTINCT FROM OLD.owner OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id OR
     NEW.identity IS DISTINCT FROM OLD.identity OR NEW.key_record IS DISTINCT FROM OLD.key_record OR
     NEW.draft_capsule IS DISTINCT FROM OLD.draft_capsule OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Buffer order identity and draft are immutable';
  END IF;
  IF OLD.state = 'reserved' AND NEW.state = 'claimed' AND OLD.capsule IS NULL AND NEW.capsule IS NULL AND
     OLD.capsule_sha256 IS NULL AND NEW.capsule_sha256 IS NULL THEN RETURN NEW; END IF;
  IF OLD.state = 'claimed' AND NEW.state = 'sealed' AND OLD.capsule IS NULL AND NEW.capsule IS NOT NULL AND
     OLD.capsule_sha256 IS NULL AND NEW.capsule_sha256 IS NOT NULL THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Buffer order transitions are immutable and single use';
END;
`;
export class BufferOrderFenceError extends Error {
  constructor(code) { super('Buffer order journal unavailable or uncertain; do not repeat an unknown order'); this.code=code; }
}
const fail=code=>new BufferOrderFenceError(code);
async function transaction(pool,run) {
  let client,begun=false,destroy=false;
  try {
    client=await pool.connect(); await client.query('BEGIN ISOLATION LEVEL READ COMMITTED'); begun=true;
    await client.query("SET LOCAL synchronous_commit = 'on'"); await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL lock_timeout = '5s'"); await client.query("SET LOCAL idle_in_transaction_session_timeout = '15s'");
    const r=await client.query(`SELECT pg_catalog.pg_is_in_recovery() AS replica, pg_catalog.current_setting('fsync') AS fsync,
      pg_catalog.current_setting('transaction_read_only') AS read_only, pg_catalog.current_setting('synchronous_commit') AS synchronous_commit`);
    const h=r.rows[0];
    if (!h || h.replica!==false || h.fsync!=='on' || h.read_only!=='off' || h.synchronous_commit!=='on') throw fail('UNSAFE_DATABASE');
    const result=await run(client); await client.query('COMMIT'); begun=false; return result;
  } catch(e) {
    destroy=true; if(client && begun) { try { await client.query('ROLLBACK'); } catch {} }
    if(e instanceof BufferOrderFenceError) throw e;
    throw fail('DATABASE_UNKNOWN');
  } finally { client?.release(destroy); }
}
async function verifySchema(client) {
  const meta=await client.query(`SELECT version FROM ${SCHEMA}.meta WHERE singleton=true`);
  if(meta.rows.length!==1 || meta.rows[0].version!==1) throw fail('UNSAFE_SCHEMA');
  const relation=await client.query(`SELECT t.relpersistence,t.relrowsecurity,t.relforcerowsecurity
    FROM pg_catalog.pg_class t JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname=$1 AND t.relname='orders' AND t.relkind='r'`,[SCHEMA]);
  const table=relation.rows[0];
  if(relation.rows.length!==1 || table.relpersistence!=='p' || table.relrowsecurity || table.relforcerowsecurity) throw fail('UNSAFE_SCHEMA');
  const columns=await client.query(`SELECT a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class t ON t.oid=a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND t.relname='orders'
      AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,[SCHEMA]);
  const expected=['owner:text','attempt_id:text','identity:jsonb','key_record:jsonb','draft_capsule:jsonb',
    'state:text','capsule:jsonb','capsule_sha256:text','created_at:timestamp with time zone'];
  if(!isDeepStrictEqual(columns.rows.map(x=>`${x.attname}:${x.type}`),expected)) throw fail('UNSAFE_SCHEMA');
  const indexes=await client.query(`SELECT array_agg(a.attname::text ORDER BY k.ordinality) AS columns
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class t ON t.oid=i.indrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
    JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum,ordinality) ON k.ordinality<=i.indnkeyatts
    JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum
    WHERE n.nspname=$1 AND t.relname='orders' AND i.indisunique AND i.indisvalid AND i.indisready
      AND i.indpred IS NULL AND i.indexprs IS NULL GROUP BY i.indexrelid`,[SCHEMA]);
  const keys=new Set(indexes.rows.map(x=>x.columns.join(',')));
  if(!keys.has('owner') || !keys.has('attempt_id')) throw fail('UNSAFE_SCHEMA');
  const triggers=await client.query(`SELECT tr.tgname,tr.tgenabled,p.prosrc,p.prosecdef,nf.nspname AS function_schema,
      l.lanname,pg_catalog.pg_get_triggerdef(tr.oid) AS definition
    FROM pg_catalog.pg_trigger tr JOIN pg_catalog.pg_class t ON t.oid=tr.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace JOIN pg_catalog.pg_proc p ON p.oid=tr.tgfoid
    JOIN pg_catalog.pg_namespace nf ON nf.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang
    WHERE n.nspname=$1 AND t.relname='orders' AND NOT tr.tgisinternal`,[SCHEMA]);
  const g=triggers.rows[0];
  if(triggers.rows.length!==1 || g.tgname!=='orders_guard' || g.tgenabled!=='O' || g.prosrc!==GUARD || g.prosecdef ||
      g.function_schema!==SCHEMA || g.lanname!=='plpgsql' || !/^CREATE TRIGGER orders_guard BEFORE DELETE OR UPDATE ON /.test(g.definition)) {
    throw fail('UNSAFE_SCHEMA');
  }
}
export async function initializePostgresBufferOrderFence({pool}={}) {
  if(!pool || typeof pool.connect!=='function') throw fail('UNSAFE_DATABASE');
  return transaction(pool,async client=>{
    await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('bouncer-buffer-order-v1'))");
    const found=await client.query('SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname=$1',[SCHEMA]);
    if(found.rows.length===0) {
      await client.query(`CREATE SCHEMA ${SCHEMA};
        CREATE TABLE ${SCHEMA}.meta (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),version integer NOT NULL);
        INSERT INTO ${SCHEMA}.meta(singleton,version) VALUES(true,1);
        CREATE TABLE ${SCHEMA}.orders (
          owner text PRIMARY KEY, attempt_id text NOT NULL UNIQUE, identity jsonb NOT NULL, key_record jsonb NOT NULL,
          draft_capsule jsonb NOT NULL, state text NOT NULL CHECK(state IN ('reserved','claimed','sealed')),
          capsule jsonb, capsule_sha256 text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
          CHECK(octet_length(identity::text)<=4096 AND octet_length(key_record::text)<=8192 AND octet_length(draft_capsule::text)<=32768),
          CHECK(capsule IS NULL OR octet_length(capsule::text)<=32768),
          CHECK((state IN ('reserved','claimed') AND capsule IS NULL AND capsule_sha256 IS NULL) OR
            (state='sealed' AND capsule IS NOT NULL AND capsule_sha256 ~ '^[a-f0-9]{64}$'))
        );
        CREATE FUNCTION ${SCHEMA}.guard() RETURNS trigger LANGUAGE plpgsql AS $guard$${GUARD}$guard$;
        CREATE TRIGGER orders_guard BEFORE UPDATE OR DELETE ON ${SCHEMA}.orders FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.guard();`);
    }
    await verifySchema(client); return {initialized:true};
  });
}
async function validatedCapsule(identity,keyRecord,capsule,kind,crypto) {
  const key=structuredClone(keyRecord), data=structuredClone(capsule);
  if(!key || key.format!=='bouncer-buffer-private-key-v1' || key.network!=='testnet' ||
      key.owner!==identity.owner || key.owner_public_key!==identity.owner_public_key || key.site!==identity.site ||
      key.public_key_sha256!==identity.key_sha256 || !data || data.format!==kind || data.owner!==identity.owner ||
      data.site!==identity.site || data.public_key_sha256!==identity.key_sha256 || data.attempt_id!==identity.attempt_id ||
      JSON.stringify(key).length>8192 || JSON.stringify(data).length>32768) throw fail('INVALID_ATTEMPT');
  const keyInfo=await inspectPrivateOrderKeyRecord({keyRecord:key,crypto});
  if(keyInfo.key_record_sha256!==identity.key_record_sha256) throw fail('INVALID_ATTEMPT');
  const digest=await privateOrderCapsuleCommitment({capsule:data,crypto});
  return {key,data,digest};
}
export function createPostgresBufferOrderFence({pool,authenticate,crypto=globalThis.crypto}={}) {
  if(!pool || typeof pool.connect!=='function' || typeof authenticate!=='function' || !crypto?.subtle) throw fail('UNSAFE_CONFIGURATION');
  async function identityAndAuth(raw,purpose,evidence,extra={}) {
    let id; try { id=validateBufferOrderIdentity(structuredClone(raw)); } catch { throw fail('INVALID_ATTEMPT'); }
    try { if(await authenticate({purpose,identity:structuredClone(id),...extra,evidence})!==true) throw Error(); }
    catch { throw fail('UNAUTHENTICATED'); }
    return id;
  }
  // Non-serializable in-process capabilities are created only after a
  // successful authenticated DB claim. They do not survive a restart and
  // are consumed before a result write; they never authorize another POST.
  const localClaims=new WeakMap();
  async function persistResult(id,sealed) {
    return transaction(pool,async client=>{ await verifySchema(client);
      const found=await client.query(`SELECT identity,key_record,state,capsule_sha256,capsule FROM ${SCHEMA}.orders
        WHERE owner=$1 AND attempt_id=$2 FOR UPDATE`,[id.owner,id.attempt_id]);
      const row=found.rows[0];
      if(!row || !isDeepStrictEqual(row.identity,id) || !isDeepStrictEqual(row.key_record,sealed.key)) throw fail('NOT_CLAIMABLE');
      if(row.state==='sealed' && row.capsule_sha256===sealed.digest && isDeepStrictEqual(row.capsule,sealed.data)) {
        return {identity:id,state:'sealed',capsule_sha256:sealed.digest,do_not_retry:true,seller_post_authorized:false};
      }
      if(row.state!=='claimed') throw fail('NOT_CLAIMABLE');
      const result=await client.query(`UPDATE ${SCHEMA}.orders SET state='sealed',capsule=$3::jsonb,capsule_sha256=$4
        WHERE owner=$1 AND attempt_id=$2 AND state='claimed' RETURNING state`,[id.owner,id.attempt_id,JSON.stringify(sealed.data),sealed.digest]);
      if(result.rowCount!==1) throw fail('NOT_CLAIMABLE');
      return {identity:id,state:'sealed',capsule_sha256:sealed.digest,do_not_retry:true,seller_post_authorized:false};
    });
  }
  return Object.freeze({
    async reserve({identity:raw,keyRecord,draftCapsule,evidence}={}) {
      const id=await identityAndAuth(raw,'reserve',evidence), sealed=await validatedCapsule(id,keyRecord,draftCapsule,'bouncer-buffer-private-draft-v1',crypto);
      if(sealed.digest!==id.draft_sha256) throw fail('INVALID_ATTEMPT');
      return transaction(pool,async client=>{ await verifySchema(client);
        const result=await client.query(`INSERT INTO ${SCHEMA}.orders(owner,attempt_id,identity,key_record,draft_capsule,state)
          VALUES($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,'reserved') ON CONFLICT DO NOTHING RETURNING state`,
        [id.owner,id.attempt_id,JSON.stringify(id),JSON.stringify(sealed.key),JSON.stringify(sealed.data)]);
        if(result.rowCount!==1) throw fail('ALREADY_RESERVED');
        return {identity:id,state:'reserved',seller_post_authorized:false};
      });
    },
    async claim({identity:raw,evidence}={}) {
      const id=await identityAndAuth(raw,'claim',evidence);
      const claim=await transaction(pool,async client=>{ await verifySchema(client);
        const r=await client.query(`UPDATE ${SCHEMA}.orders SET state='claimed'
          WHERE owner=$1 AND attempt_id=$2 AND identity=$3::jsonb AND state='reserved' RETURNING state`,
          [id.owner,id.attempt_id,JSON.stringify(id)]);
        if(r.rowCount!==1) throw fail('NOT_CLAIMABLE');
        return Object.freeze({identity:Object.freeze(id),state:'claimed',do_not_retry:true,seller_post_authorized:false});
      });
      localClaims.set(claim,id); return claim;
    },
    async record({identity:raw,keyRecord,capsule,evidence}={}) {
      let id; try { id=validateBufferOrderIdentity(structuredClone(raw)); } catch { throw fail('INVALID_ATTEMPT'); }
      const sealed=await validatedCapsule(id,keyRecord,capsule,'bouncer-buffer-private-order-v1',crypto);
      await identityAndAuth(id,'record',evidence,{capsule_sha256:sealed.digest});
      return persistResult(id,sealed);
    },
    /** Internal result retention only: the handle is the exact object from a
     * successful claim, never a JSON value or browser credential. */
    async retainClaimedResult({claim,keyRecord,capsule}={}) {
      const id=claim && typeof claim==='object' ? localClaims.get(claim) : null;
      if(!id) throw fail('NOT_CLAIMABLE');
      localClaims.delete(claim);
      const sealed=await validatedCapsule(id,keyRecord,capsule,'bouncer-buffer-private-order-v1',crypto);
      return persistResult(id,sealed);
    },
    async inspect({identity:raw,evidence}={}) {
      const id=await identityAndAuth(raw,'inspect',evidence);
      return transaction(pool,async client=>{ await verifySchema(client);
        const r=await client.query(`SELECT identity,key_record,draft_capsule,state,capsule,capsule_sha256 FROM ${SCHEMA}.orders
          WHERE owner=$1 AND attempt_id=$2`,[id.owner,id.attempt_id]);
        const row=r.rows[0]; if(!row || !isDeepStrictEqual(row.identity,id)) throw fail('NOT_FOUND');
        const draft=await validatedCapsule(id,row.key_record,row.draft_capsule,'bouncer-buffer-private-draft-v1',crypto);
        if(draft.digest!==id.draft_sha256) throw fail('UNSAFE_RECORD');
        if(row.state==='sealed') {
          const sealed=await validatedCapsule(id,row.key_record,row.capsule,'bouncer-buffer-private-order-v1',crypto);
          if(sealed.digest!==row.capsule_sha256) throw fail('UNSAFE_RECORD');
        } else if(!['reserved','claimed'].includes(row.state) || row.capsule!==null || row.capsule_sha256!==null) throw fail('UNSAFE_RECORD');
        return {...row,do_not_retry:row.state!=='reserved',seller_post_authorized:false};
      });
    },
  });
}
