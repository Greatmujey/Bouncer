/**
 * Experimental independently operated PostgreSQL checkpoint for the shared
 * native/FT Git witness head. This is a CAS/retention building block, NOT a
 * deployment or proof of independence. Run it in a distinct database under a
 * separate operator, access policy and backup/monitoring regime from the setup
 * journal. The caller must audit Git ancestry AND every protected witness file
 * before CAS; a compromised privileged checkpoint writer can bypass that audit.
 * A privileged DB operator can disable guards, forge history or restore an old
 * snapshot. Defending against checkpoint rollback needs another independently
 * retained latest revision; this module cannot provide that by itself.
 *
 * Explicit provisioning pins a verified, complete initial baseline. Normal
 * reads/CAS NEVER initialize or repair missing/corrupt state. A lost COMMIT
 * acknowledgement is unknown and must be reconciled, not retried as a prompt.
 */
import { isDeepStrictEqual } from 'node:util';

const SCHEMA='bouncer_setup_head_anchor_v1',MAX_ENTRIES=10_000;
const GUARD=`\nBEGIN\n  RAISE EXCEPTION 'setup head checkpoint history is immutable';\nEND;\n`;
const head=x=>typeof x==='string' && /^[a-f0-9]{40}$/.test(x);
const revision=x=>typeof x==='string' && /^(0|[1-9][0-9]{0,15})$/.test(x) && BigInt(x)<BigInt(MAX_ENTRIES);
const plain=x=>x!==null && typeof x==='object' && !Array.isArray(x) && Object.getPrototypeOf(x)===Object.prototype;
const exact=(x,fields)=>plain(x) && Object.keys(x).length===fields.length && fields.every(k=>Object.hasOwn(x,k));
export class SetupHeadAnchorError extends Error {
  constructor(code){super('setup checkpoint is unavailable, changed or uncertain; stop and reconcile, never repeat a prompt');
    this.name='SetupHeadAnchorError';this.code=code}
}
const fail=code=>new SetupHeadAnchorError(code);
function config({pool,repository,branch,initialHead}={}) {
  if(!pool || typeof pool.connect!=='function' || typeof repository!=='string' ||
     !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) ||
     typeof branch!=='string' || !/^[A-Za-z0-9_./-]{1,180}$/.test(branch) || branch.includes('..') || branch.endsWith('/') ||
     !head(initialHead))throw fail('ANCHOR_INVALID');
  return {pool,repository,branch,initialHead};
}
async function verifySchema(client){
  for(const [table,columns] of [
    ['meta',['singleton:boolean:true','version:integer:true','repository:text:true','branch:text:true','initial_head:text:true']],
    ['entries',['revision:bigint:true','previous_head:text:false','head:text:true','created_at:timestamp with time zone:true']],
  ]){
    const rel=await client.query(`SELECT c.relpersistence,c.relrowsecurity,c.relforcerowsecurity
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind='r'`,[SCHEMA,table]);
    if(rel.rows.length!==1 || rel.rows[0].relpersistence!=='p' || rel.rows[0].relrowsecurity || rel.rows[0].relforcerowsecurity)throw fail('ANCHOR_UNSAFE');
    const found=await client.query(`SELECT a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull
      FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,[SCHEMA,table]);
    if(!isDeepStrictEqual(found.rows.map(c=>`${c.attname}:${c.type}:${c.attnotnull}`),columns))throw fail('ANCHOR_UNSAFE');
    const triggers=await client.query(`SELECT g.tgname,g.tgenabled,g.tgtype::integer AS kind,p.prosrc,p.pronargs,p.prosecdef,
      p.provolatile,p.proconfig,l.lanname,pn.nspname AS function_schema FROM pg_catalog.pg_trigger g
      JOIN pg_catalog.pg_class c ON c.oid=g.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_proc p ON p.oid=g.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
      JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      WHERE n.nspname=$1 AND c.relname=$2 AND NOT g.tgisinternal ORDER BY g.tgname`,[SCHEMA,table]);
    if(triggers.rows.length!==2)throw fail('ANCHOR_UNSAFE');
    for(const [i,name,kind] of [[0,'no_truncate',34],[1,'no_update_delete',27]]){
      const g=triggers.rows[i];if(g.tgname!==name || g.kind!==kind || !['O','A'].includes(g.tgenabled) || g.prosrc!==GUARD ||
        g.pronargs!==0 || g.prosecdef || g.provolatile!=='v' || g.lanname!=='plpgsql' || g.function_schema!==SCHEMA ||
        !isDeepStrictEqual(g.proconfig,['search_path=pg_catalog']))throw fail('ANCHOR_UNSAFE');
    }
  }
  const indexes=await client.query(`SELECT c.relname AS table_name,pg_catalog.array_agg(a.attname::text ORDER BY k.ordinality) AS columns
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN LATERAL pg_catalog.unnest(i.indkey) WITH ORDINALITY AS k(attnum,ordinality) ON k.ordinality<=i.indnkeyatts
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum
    WHERE n.nspname=$1 AND i.indisunique AND i.indisvalid AND i.indisready AND i.indpred IS NULL AND i.indexprs IS NULL
    GROUP BY i.indexrelid,c.relname`,[SCHEMA]);
  const keys=new Set(indexes.rows.map(r=>`${r.table_name}:${r.columns.join(',')}`));
  if(!['meta:singleton','entries:revision','entries:head'].every(k=>keys.has(k)))throw fail('ANCHOR_UNSAFE');
}
async function current(client,cfg){
  await verifySchema(client);
  const meta=await client.query(`SELECT singleton,version,repository,branch,initial_head FROM ${SCHEMA}.meta`);
  if(meta.rows.length!==1 || meta.rows[0].singleton!==true || meta.rows[0].version!==1 || meta.rows[0].repository!==cfg.repository ||
     meta.rows[0].branch!==cfg.branch || meta.rows[0].initial_head!==cfg.initialHead)throw fail('ANCHOR_UNSAFE');
  const result=await client.query(`SELECT revision::text,previous_head,head FROM ${SCHEMA}.entries ORDER BY revision ASC LIMIT ${MAX_ENTRIES+1}`);
  if(!result.rows.length || result.rows.length>MAX_ENTRIES)throw fail('ANCHOR_UNSAFE');
  let prior=null;const seen=new Set();
  for(let i=0;i<result.rows.length;i++){
    const row=result.rows[i];if(row.revision!==String(i) || !head(row.head) || seen.has(row.head) ||
      row.previous_head!==(prior?.head??null) || (i===0 && row.head!==cfg.initialHead))throw fail('ANCHOR_UNSAFE');
    seen.add(row.head);prior=row;
  }
  return {head:prior.head,revision:prior.revision};
}
async function transaction(pool,work){
  let client;try{client=await pool.connect()}catch{throw fail('ANCHOR_UNAVAILABLE')}
  let begun=false,committing=false;
  try{
    await client.query('BEGIN');begun=true;
    await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('bouncer-setup-head-anchor-v1'))");
    const result=await work(client);committing=true;await client.query('COMMIT');begun=false;return result;
  }catch(error){
    if(begun)try{await client.query('ROLLBACK')}catch{/* connection/result remains unknown */}
    if(committing)throw fail('ANCHOR_COMMIT_UNKNOWN');
    if(error instanceof SetupHeadAnchorError)throw error;throw fail('ANCHOR_UNAVAILABLE');
  }finally{client.release()}
}

/** One-time operator provisioning only. The caller must independently verify
 * the full baseline; empty/restored databases must not be auto-reprovisioned. */
export async function provisionPostgresSetupHeadAnchor(options={}){
  const cfg=config(options);if(options.operatorVerifiedCompleteBaseline!==true)throw fail('ANCHOR_INVALID');
  return transaction(cfg.pool,async client=>{
    const exists=await client.query('SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname=$1',[SCHEMA]);
    if(exists.rows.length!==0)throw fail('ANCHOR_ALREADY_PROVISIONED');
    await client.query(`CREATE SCHEMA ${SCHEMA};
      CREATE TABLE ${SCHEMA}.meta(singleton boolean PRIMARY KEY CHECK(singleton),version integer NOT NULL,
        repository text NOT NULL,branch text NOT NULL,initial_head text NOT NULL);
      CREATE TABLE ${SCHEMA}.entries(revision bigint PRIMARY KEY CHECK(revision>=0 AND revision<10000),
        previous_head text CHECK(previous_head IS NULL OR previous_head ~ '^[a-f0-9]{40}$'),
        head text NOT NULL UNIQUE CHECK(head ~ '^[a-f0-9]{40}$'),created_at timestamptz NOT NULL DEFAULT pg_catalog.now());
      CREATE FUNCTION ${SCHEMA}.immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $guard$${GUARD}$guard$;
      CREATE TRIGGER no_update_delete BEFORE UPDATE OR DELETE ON ${SCHEMA}.meta FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.immutable();
      CREATE TRIGGER no_truncate BEFORE TRUNCATE ON ${SCHEMA}.meta FOR EACH STATEMENT EXECUTE FUNCTION ${SCHEMA}.immutable();
      CREATE TRIGGER no_update_delete BEFORE UPDATE OR DELETE ON ${SCHEMA}.entries FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.immutable();
      CREATE TRIGGER no_truncate BEFORE TRUNCATE ON ${SCHEMA}.entries FOR EACH STATEMENT EXECUTE FUNCTION ${SCHEMA}.immutable();`);
    await client.query(`INSERT INTO ${SCHEMA}.meta(singleton,version,repository,branch,initial_head) VALUES(true,1,$1,$2,$3)`,
      [cfg.repository,cfg.branch,cfg.initialHead]);
    await client.query(`INSERT INTO ${SCHEMA}.entries(revision,previous_head,head) VALUES(0,NULL,$1)`,[cfg.initialHead]);
    return current(client,cfg);
  });
}

export function createPostgresSetupHeadAnchor(options={}){
  const cfg=config(options);
  return Object.freeze({
    async read(){return transaction(cfg.pool,client=>current(client,cfg))},
    async compareAndSet({expected,nextHead}={}){
      if(!exact(expected,['head','revision']) || !head(expected.head) || !revision(expected.revision) || !head(nextHead) || nextHead===expected.head)
        throw fail('ANCHOR_INVALID');
      return transaction(cfg.pool,async client=>{
        const before=await current(client,cfg);
        if(before.head!==expected.head || before.revision!==expected.revision)throw fail('ANCHOR_CONFLICT');
        if(BigInt(before.revision)+1n>=BigInt(MAX_ENTRIES))throw fail('ANCHOR_CAPACITY');
        await client.query(`INSERT INTO ${SCHEMA}.entries(revision,previous_head,head) VALUES($1::bigint,$2,$3)`,
          [(BigInt(before.revision)+1n).toString(),before.head,nextHead]);
        const after=await current(client,cfg);
        return {confirmed:true,...after};
      });
    },
  });
}
