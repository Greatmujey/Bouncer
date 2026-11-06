/**
 * EXPERIMENTAL server-side NEP-413 challenge authentication for named
 * testnet owner prompt contexts. This has no HTTP/session endpoint, wallet
 * call, transaction sender or payment authorization. It issues a durable
 * one-use challenge bound to the exact action and fixed server origin, checks
 * the signature, and reads the signing key as FullAccess at one fresh FINAL
 * block from the caller's trusted testnet RPC. It can be supplied as the
 * authenticator to postgres-wallet-prompt-fence.mjs.
 *
 * This is not a production login: operators still need rate limits, CSRF and
 * session controls, a dedicated origin, independent database checkpoints,
 * secure deployment, wallet/phone interoperability tests, prompt recovery,
 * reviewed terms and fresh stage preflights. The RPC and database are trusted,
 * not independently attested. EVM 0x wallets do not support this NEP-413 path.
 */
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { nep413Payload } from '../web-src/cli-login.mjs';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';

const SCHEMA = 'bouncer_wallet_auth_v1';
const MAX_LIFETIME_MS = 120_000, MAX_CLOCK_SKEW_MS = 30_000;
const GUARD_SOURCE = `
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wallet authentication challenges cannot be deleted';
  END IF;
  IF NEW.challenge_id IS DISTINCT FROM OLD.challenge_id OR
     NEW.action_sha256 IS DISTINCT FROM OLD.action_sha256 OR
     NEW.nonce IS DISTINCT FROM OLD.nonce OR
     NEW.recipient IS DISTINCT FROM OLD.recipient OR
     NEW.message IS DISTINCT FROM OLD.message OR
     NEW.issued_ms IS DISTINCT FROM OLD.issued_ms OR
     NEW.expires_ms IS DISTINCT FROM OLD.expires_ms OR
     OLD.consumed OR NOT NEW.consumed THEN
    RAISE EXCEPTION 'wallet authentication challenge is immutable and single use';
  END IF;
  RETURN NEW;
END;
`;
const HEX32 = /^[a-f0-9]{32}$/, HEX64 = /^[a-f0-9]{64}$/;
const STAGES = ['configure_buffer_locked_policy', 'install_buffer_vault_agent', 'install_buffer_forwarder_agent'];
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(x));
const exact = (value, names) => {
  if (!record(value)) return false;
  const fields = Object.getOwnPropertyDescriptors(value);
  return Object.keys(fields).length === names.length && names.every(name => Object.hasOwn(fields[name] ?? {}, 'value'));
};
const sha = x => crypto.createHash('sha256').update(x).digest('hex');

function parseOwnerKey(value) {
  try {
    const key = nearApi.utils.PublicKey.from(value);
    if (typeof value !== 'string' || String(key) !== value || key.keyType !== 0 || key.ed25519Key?.data?.length !== 32) throw Error();
    return key;
  } catch { throw new Error('canonical ed25519 owner public key required'); }
}
function actionFields(action) {
  if (!record(action)) throw new Error('invalid owner authorization action');
  const purpose = Object.getOwnPropertyDescriptor(action, 'purpose');
  if (!purpose || !Object.hasOwn(purpose, 'value')) throw new Error('invalid owner authorization action');
  const common = ['format', 'network', 'purpose', 'owner', 'owner_public_key'];
  const extra = purpose.value === 'reserve' ? ['review_sha256', 'stage_id', 'action_commitment_sha256'] :
    purpose.value === 'record_original_hash' ? ['operation_id', 'original_hash'] : purpose.value === 'inspect' ? [] : null;
  if (!extra || !exact(action, [...common, ...extra]) || action.format !== 'bouncer-wallet-prompt-auth-v1' ||
      action.network !== 'testnet' || !isTestnetAccount(action.owner)) throw new Error('invalid owner authorization action');
  parseOwnerKey(action.owner_public_key);
  if (action.purpose === 'reserve' && (!HEX64.test(action.review_sha256 ?? '') || !STAGES.includes(action.stage_id) ||
      !HEX64.test(action.action_commitment_sha256 ?? ''))) throw new Error('invalid reservation authorization action');
  if (action.purpose === 'record_original_hash' && (!HEX32.test(action.operation_id ?? '') || !isTransactionHash(action.original_hash))) {
    throw new Error('invalid original-hash authorization action');
  }
  return Object.freeze(Object.fromEntries([...common, ...extra].map(name => [name, action[name]])));
}
function actionHash(action) {
  // Every value is a validated primitive string. The fixed field order makes
  // the signature insensitive to JSON object insertion order in the transport.
  return sha(Buffer.from(JSON.stringify(actionFields(action)), 'utf8'));
}
function fixedOrigin(value) {
  let url; try { url = new URL(value); } catch { throw new Error('fixed HTTPS origin required'); }
  if (typeof value !== 'string' || url.protocol !== 'https:' || url.origin !== value || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || value.length > 255 || !url.hostname.includes('.')) {
    throw new Error('fixed HTTPS origin required');
  }
  return value;
}
function challengeMessage(action, digest, origin, issued, expires) {
  const what = action.purpose === 'reserve' ? `Reserve setup prompt: ${action.stage_id}` :
    action.purpose === 'record_original_hash' ? 'Record the original transaction hash' : 'Inspect the retained prompt';
  return `Bouncer testnet owner authentication\n${what}\nAccount: ${action.owner}\n` +
    `Public key: ${action.owner_public_key}\nAction SHA-256: ${digest}\nSite: ${origin}\n` +
    `Issued: ${new Date(issued).toISOString()}\nExpires: ${new Date(expires).toISOString()}\n` +
    'This message is not a transaction and does not itself approve spending.';
}
function signatureBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(value)) throw new Error('invalid signature');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== value) throw new Error('invalid signature');
  return bytes;
}
async function transaction(pool, work) {
  let client, begun = false, destroy = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED'); begun = true;
    await client.query("SET LOCAL synchronous_commit = 'on'");
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '15s'");
    const { rows } = await client.query(`SELECT pg_catalog.pg_is_in_recovery() AS replica,
      pg_catalog.current_setting('fsync') AS fsync, pg_catalog.current_setting('transaction_read_only') AS read_only,
      pg_catalog.current_setting('synchronous_commit') AS synchronous_commit`);
    const s = rows[0];
    if (!s || s.replica !== false || s.fsync !== 'on' || s.read_only !== 'off' || s.synchronous_commit !== 'on') {
      throw new Error('unsafe database');
    }
    const result = await work(client);
    await client.query('COMMIT'); begun = false;
    return result;
  } catch {
    destroy = true;
    if (client && begun) { try { await client.query('ROLLBACK'); } catch { /* unknown commit */ } }
    throw new Error('wallet authentication database unavailable or uncertain; no prompt is authorized');
  } finally { client?.release(destroy); }
}
async function verifySchema(client) {
  const v = await client.query(`SELECT version FROM ${SCHEMA}.meta WHERE singleton=true`);
  if (v.rows.length !== 1 || v.rows[0].version !== 1) throw new Error('unsafe schema');
  const indexes = await client.query(`SELECT t.relname AS table_name, array_agg(a.attname::text ORDER BY k.ordinality) AS columns
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class t ON t.oid=i.indrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
    JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum,ordinality) ON k.ordinality<=i.indnkeyatts
    JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum
    WHERE n.nspname='bouncer_wallet_auth_v1' AND t.relkind='r' AND i.indisunique AND i.indisvalid AND i.indisready
      AND i.indpred IS NULL AND i.indexprs IS NULL GROUP BY i.indexrelid,t.relname`);
  const found = new Set(indexes.rows.map(row => `${row.table_name}:${row.columns.join(',')}`));
  if (!['meta:singleton', 'challenges:challenge_id', 'challenges:nonce'].every(x => found.has(x))) throw new Error('unsafe schema');
  const visible = await client.query(`SELECT t.relrowsecurity,t.relforcerowsecurity FROM pg_catalog.pg_class t
    JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='bouncer_wallet_auth_v1' AND t.relname='challenges' AND t.relkind='r'`);
  if (visible.rows.length !== 1 || visible.rows[0].relrowsecurity || visible.rows[0].relforcerowsecurity) throw new Error('unsafe schema');
  const guard = await client.query(`SELECT g.tgenabled,g.tgtype::integer AS kind,g.tgisinternal,
      p.prosrc,p.pronargs,p.prosecdef,p.provolatile,p.proconfig,l.lanname
    FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_class t ON t.oid=g.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
    JOIN pg_catalog.pg_proc p ON p.oid=g.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid=p.prolang
    WHERE n.nspname='bouncer_wallet_auth_v1' AND t.relname='challenges' AND g.tgname='challenge_immutable'
      AND pn.nspname='bouncer_wallet_auth_v1' AND p.proname='guard_challenge'`);
  const g = guard.rows[0];
  if (guard.rows.length !== 1 || !['O','A'].includes(g.tgenabled) || g.kind !== 27 || g.tgisinternal ||
      g.prosrc !== GUARD_SOURCE || g.pronargs !== 0 || g.prosecdef || g.provolatile !== 'v' || g.lanname !== 'plpgsql' ||
      !Array.isArray(g.proconfig) || g.proconfig.length !== 1 || g.proconfig[0] !== 'search_path=pg_catalog') throw new Error('unsafe schema');
}

/** Privileged, explicit setup in a dedicated testnet database. */
export async function initializePostgresWalletPromptAuth({ pool } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('PostgreSQL pool required');
  await transaction(pool, async c => {
    await c.query('SELECT pg_catalog.pg_advisory_xact_lock(1702243041, 903136)');
    await c.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await c.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.meta (singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), version integer NOT NULL)`);
    await c.query(`INSERT INTO ${SCHEMA}.meta (singleton,version) VALUES (true,1) ON CONFLICT DO NOTHING`);
    await c.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.challenges (
      challenge_id text PRIMARY KEY, action_sha256 text NOT NULL, nonce bytea NOT NULL UNIQUE,
      recipient text NOT NULL, message text NOT NULL, issued_ms bigint NOT NULL, expires_ms bigint NOT NULL,
      consumed boolean NOT NULL DEFAULT false
    )`);
    const funcs = await c.query(`SELECT p.oid FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='bouncer_wallet_auth_v1' AND p.proname='guard_challenge' AND p.pronargs=0`);
    if (funcs.rows.length === 0) await c.query(`CREATE FUNCTION ${SCHEMA}.guard_challenge() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog AS $guard$${GUARD_SOURCE}$guard$`);
    const triggers = await c.query(`SELECT g.oid FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_class t ON t.oid=g.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='bouncer_wallet_auth_v1' AND t.relname='challenges' AND g.tgname='challenge_immutable'`);
    if (triggers.rows.length === 0) await c.query(`CREATE TRIGGER challenge_immutable BEFORE UPDATE OR DELETE ON ${SCHEMA}.challenges
      FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.guard_challenge()`);
    await verifySchema(c);
  });
}

/** Fixed origin and trusted testnet read-only provider are server configuration,
 * not accepted from a browser. The issued nonce is public; signatures are never
 * persisted. No method in this object signs, sends or opens a wallet. */
export function createPostgresWalletPromptAuth({ pool, origin, provider } = {}) {
  const siteOrigin = fixedOrigin(origin);
  // NEP-413 examples and Bouncer's existing wallet adapters use the host as
  // recipient. The signed message separately binds the entire HTTPS origin.
  const recipient = new URL(siteOrigin).host;
  if (!pool || typeof pool.connect !== 'function' || !provider ||
      ['viewNodeStatus', 'viewBlock', 'viewAccessKey'].some(name => typeof provider[name] !== 'function')) {
    throw new Error('PostgreSQL pool and trusted read-only testnet provider required');
  }
  async function issue(inputAction) {
    const action = actionFields(inputAction), digest = actionHash(action);
    const id = crypto.randomBytes(16).toString('hex'), nonce = crypto.randomBytes(32);
    return transaction(pool, async c => {
      await verifySchema(c);
      const clock = await c.query(`SELECT pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000)::bigint AS now_ms`);
      const issued = Number(clock.rows[0]?.now_ms), local = Date.now(), expires = issued + MAX_LIFETIME_MS;
      if (!Number.isSafeInteger(issued) || Math.abs(issued-local) > MAX_CLOCK_SKEW_MS) throw new Error('clock mismatch');
      const message = challengeMessage(action, digest, siteOrigin, issued, expires);
      const saved = await c.query(`INSERT INTO ${SCHEMA}.challenges
        (challenge_id,action_sha256,nonce,recipient,message,issued_ms,expires_ms) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING challenge_id`,
      [id, digest, nonce, recipient, message, String(issued), String(expires)]);
      if (saved.rows.length !== 1 || saved.rows[0].challenge_id !== id) throw new Error('challenge was not stored');
      return { challenge_id: id, nonce_base64: nonce.toString('base64'), recipient, message, expires_at_ms: expires };
    });
  }
  async function authenticate({ action: inputAction, evidence } = {}) {
    try {
      const action = actionFields(inputAction), digest = actionHash(action);
      if (!exact(evidence, ['challenge_id','accountId','publicKey','signature']) || !HEX32.test(evidence.challenge_id ?? '') ||
          evidence.accountId !== action.owner || evidence.publicKey !== action.owner_public_key) return false;
      const key = parseOwnerKey(evidence.publicKey), signature = signatureBytes(evidence.signature);
      const selected = await transaction(pool, async c => {
        await verifySchema(c);
        const result = await c.query(`SELECT challenge_id,action_sha256,nonce,recipient,message,issued_ms,expires_ms,consumed
          FROM ${SCHEMA}.challenges WHERE challenge_id=$1`, [evidence.challenge_id]);
        return result.rows.length === 1 ? result.rows[0] : null;
      });
      if (!selected || selected.challenge_id !== evidence.challenge_id || selected.action_sha256 !== digest ||
          selected.recipient !== recipient || selected.consumed !== false || !Buffer.isBuffer(selected.nonce) || selected.nonce.length !== 32) return false;
      const issued = Number(selected.issued_ms), expires = Number(selected.expires_ms), local = Date.now();
      if (!Number.isSafeInteger(issued) || !Number.isSafeInteger(expires) || expires-issued !== MAX_LIFETIME_MS ||
          local < issued-MAX_CLOCK_SKEW_MS || local >= expires || selected.message !== challengeMessage(action, digest, siteOrigin, issued, expires)) return false;
      const payload = nep413Payload({ message: selected.message, nonce: new Uint8Array(selected.nonce), recipient });
      const signedHash = crypto.createHash('sha256').update(payload).digest();
      if (!key.verify(signedHash, signature)) return false;
      if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') return false;
      const block = await provider.viewBlock({ finality: 'final' });
      const { hash } = assertFreshFinalBlock(block, Date.now());
      const access = await provider.viewAccessKey(action.owner, action.owner_public_key, { blockId: hash });
      if (access?.block_hash !== hash || access.permission !== 'FullAccess') return false;
      // Compare every previously verified column in the atomic consume, so a
      // row changed between signature verification and update cannot be used.
      return await transaction(pool, async c => {
        await verifySchema(c);
        const result = await c.query(`UPDATE ${SCHEMA}.challenges SET consumed=true
          WHERE challenge_id=$1 AND action_sha256=$2 AND nonce=$3 AND recipient=$4 AND message=$5
            AND issued_ms=$6 AND expires_ms=$7 AND consumed=false
            AND issued_ms <= pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000)::bigint + $8::bigint
            AND expires_ms > pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000)::bigint
          RETURNING challenge_id`, [selected.challenge_id, digest, selected.nonce, recipient, selected.message,
          String(issued), String(expires), String(MAX_CLOCK_SKEW_MS)]);
        return result.rows.length === 1 && result.rows[0].challenge_id === selected.challenge_id;
      });
    } catch { return false; }
  }
  return Object.freeze({ issue, authenticate });
}
