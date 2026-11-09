/** One non-spending, read-only inspection at standby startup. The public
 * result is deliberately coarse and never includes files, paths, keys,
 * headers, response bodies or errors. These checks do NOT prove persistence,
 * backup, wallet control, owner consent, a quote or provider execution. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ReadOnlyNearRpcProvider } from './read-only-near-rpc.mjs';
import { assertOracleProjectRegistry } from './oracle-testnet-registry.mjs';
import { MARKET_SUMMARY_PROGRAM } from '../shared/market-summary-constants.mjs';
import { readBoundedBytes } from '../shared/bounded-json.mjs';

const RPC = 'https://test.rpc.fastnear.com';
const scope = 'One startup inspection only: public RPC/registry views and a backend-side artifact fetch are not provider execution. A mounted path is not proof of persistence or backup. No mission or transaction is enabled.';

/** Railway-injected path plus Linux mountinfo and access checks. It cannot
 * distinguish a real persistent volume from a forged environment/mount. No
 * directory or probe file is written. */
export function inspectStandbyMount({ env = process.env, filesystem = fs, mountInfo = '/proc/self/mountinfo' } = {}) {
  try {
    const raw = env.RAILWAY_VOLUME_MOUNT_PATH;
    if (typeof raw !== 'string' || raw.length > 4096 || !path.isAbsolute(raw) || raw.includes('\0') ||
        raw === '/' || path.normalize(raw) !== raw) return 'NOT_CONFIRMED';
    const stat = filesystem.lstatSync(raw);
    if (!stat.isDirectory() || stat.isSymbolicLink() || filesystem.realpathSync(raw) !== raw) return 'NOT_CONFIRMED';
    const text = filesystem.readFileSync(mountInfo, 'utf8');
    if (typeof text !== 'string' || text.length > 2_000_000) return 'NOT_CONFIRMED';
    const decode = value => value.replace(/\\([0-7]{3})/g, (_all, octal) => String.fromCharCode(parseInt(octal, 8)));
    const present = text.split('\n').some(line => {
      const fields = line.split(' ');
      return fields.length >= 10 && fields.includes('-') && decode(fields[4]) === raw;
    });
    if (!present) return 'NOT_CONFIRMED';
    try { filesystem.accessSync(raw, fs.constants.R_OK | fs.constants.W_OK); }
    catch { return 'MOUNT_PRESENT_ACCESS_UNCONFIRMED'; }
    return 'DECLARED_MOUNT_PRESENT';
  } catch { return 'NOT_CONFIRMED'; }
}

/** Fixed public destinations, no user-supplied URL, no signing, no retry and
 * no request-triggered network work. `fetchImpl` is injected for tests only. */
export function createStandbyReadiness({ env = process.env, filesystem = fs, fetchImpl = globalThis.fetch, recoveryVolumeProbe, recoveryAnchorEnabled, recoveryAnchorWritesEnabled } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('read-only standby fetch unavailable');
  if ((recoveryAnchorEnabled !== undefined && typeof recoveryAnchorEnabled !== 'boolean') ||
      (recoveryAnchorWritesEnabled !== undefined && typeof recoveryAnchorWritesEnabled !== 'boolean') ||
      (recoveryAnchorWritesEnabled === true && recoveryAnchorEnabled !== true)) throw new Error('invalid recovery route diagnostic');
  let probe;
  if (recoveryVolumeProbe !== undefined) {
    const p=recoveryVolumeProbe,keys=['phase','status','fingerprint','transaction_authorized'];
    if (!p || typeof p!=='object' || Array.isArray(p) || Object.keys(p).length!==keys.length || !keys.every(k=>Object.hasOwn(p,k)) ||
        !['initial','after-redeploy'].includes(p.phase) || !['CREATED','OBSERVED','MISSING','LOCKED','UNAVAILABLE','MOUNT_NOT_CONFIRMED'].includes(p.status) ||
        p.transaction_authorized!==false || (['CREATED','OBSERVED'].includes(p.status) ? !/^[a-f0-9]{64}$/.test(p.fingerprint??'') : p.fingerprint!==null))
      throw new Error('invalid public volume diagnostic');
    probe=Object.freeze({...p});
  }
  const checks = { volume: inspectStandbyMount({ env, filesystem }), testnet_rpc: 'PENDING',
    pinned_oracle_registry: 'PENDING', market_wasm: 'PENDING' };
  let started, checkedAt = null;
  const snapshot = () => ({ service: 'bouncer-testnet-native-backend', status: 'STANDBY',
    mission_enabled: false, transactions_enabled: false, checks: { ...checks }, checked_at: checkedAt,
    ...(recoveryAnchorEnabled !== undefined ? {recovery_anchor_enabled:recoveryAnchorEnabled} : {}),
    ...(recoveryAnchorWritesEnabled !== undefined ? {recovery_anchor_writes_enabled:recoveryAnchorWritesEnabled} : {}),
    ...(probe ? {recovery_volume_probe:{...probe}} : {}),
    scope:probe ? `${scope} The isolated volume diagnostic contains only a non-secret test marker; it does not read or alter recovery records.` : scope });
  async function rpc() {
    if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
      checks.testnet_rpc = 'UNAVAILABLE'; checks.pinned_oracle_registry = 'SKIPPED'; return;
    }
    const provider = new ReadOnlyNearRpcProvider(RPC, { fetchImpl, timeoutMs: 10_000 });
    try {
      const status = await provider.viewNodeStatus();
      if (status?.chain_id !== 'testnet') { checks.testnet_rpc = 'WRONG_NETWORK'; checks.pinned_oracle_registry = 'SKIPPED'; return; }
      checks.testnet_rpc = 'TESTNET_VIEW_OK';
    } catch { checks.testnet_rpc = 'UNAVAILABLE'; checks.pinned_oracle_registry = 'SKIPPED'; return; }
    try { await assertOracleProjectRegistry(provider); checks.pinned_oracle_registry = 'REGISTRY_MATCH'; }
    catch { checks.pinned_oracle_registry = 'UNAVAILABLE_OR_MISMATCH'; }
  }
  async function program() {
    if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') { checks.market_wasm = 'UNAVAILABLE'; return; }
    let response;
    try {
      response = await fetchImpl(MARKET_SUMMARY_PROGRAM.url, { method: 'GET', redirect: 'error', cache: 'no-store',
        signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error();
      const bytes = await readBoundedBytes(response, { maxBytes: 16_384, label: 'public program' });
      checks.market_wasm = createHash('sha256').update(bytes).digest('hex') === MARKET_SUMMARY_PROGRAM.sha256 ? 'SHA256_MATCH' : 'MISMATCH';
    } catch { checks.market_wasm = 'UNAVAILABLE'; }
    finally { await response?.body?.cancel().catch(() => {}); }
  }
  return Object.freeze({
    snapshot,
    start() {
      if (!started) started = Promise.all([rpc(), program()]).then(() => { checkedAt = new Date().toISOString(); return snapshot(); });
      return started;
    },
  });
}
