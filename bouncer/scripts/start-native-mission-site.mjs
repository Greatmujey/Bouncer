#!/usr/bin/env node
/** Testnet-only, single-host service. Never create secrets, journals, schema or
 * transactions on startup. The default is loopback behind a dedicated HTTPS
 * proxy; Railway binding requires explicit API-only secret-gated ingress. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { configureNativeMissionSite } from '../agent/configured-native-mission-site.mjs';

const USAGE=`Usage: node scripts/start-native-mission-site.mjs

Serves a fixed native testnet mission behind HTTPS. Defaults to the reviewed
same-origin site on 127.0.0.1 and remains OFF unless explicitly configured.
Railway may instead use a secret-gated API-only ingress on 0.0.0.0. Startup
never sets up a vault, creates a journal, prompts a wallet, or sends.

Required environment: BOUNCER_NATIVE_MISSION_ENABLED=1,
BOUNCER_NATIVE_MISSION_MODE=execute|recover, BOUNCER_WALLET_ORIGIN,
BOUNCER_TESTNET_RPC_URL, BOUNCER_NATIVE_MISSION_FILE,
BOUNCER_NATIVE_MISSION_JOURNAL_FILE, BOUNCER_FILE_JOURNAL_KEY_FILE.
Execute mode also requires BOUNCER_NATIVE_MISSION_AGENT_KEYS_FILE and
BOUNCER_NATIVE_MISSION_AUTH_DATABASE_URL. The database and encrypted journal
must already exist. Optional: BOUNCER_NATIVE_MISSION_PORT (default 8789),
BOUNCER_WALLETCONNECT_PROJECT_ID and BOUNCER_GOOGLE_CLIENT_ID.

For Railway, set BOUNCER_NATIVE_MISSION_INGRESS=railway-proxy,
BOUNCER_NATIVE_MISSION_BIND=0.0.0.0, BOUNCER_NATIVE_MISSION_BACKEND_ORIGIN
and BOUNCER_NATIVE_MISSION_PROXY_SECRET. PORT and RAILWAY_VOLUME_MOUNT_PATH
are supplied by Railway; every original/key/mission file must be on that
volume. Start in recover mode; execute requires separate reviewed setup.

Keep keys outside the checkout. Use persistent storage, a verified TLS database,
a trusted RPC, backups and rollback monitoring. See docs/NATIVE_MISSIONS.md.
This is unaudited testnet software; never use real funds.
`;
export function resolveNativeMissionListener(env = process.env) {
  const host = env.BOUNCER_NATIVE_MISSION_BIND || '127.0.0.1';
  if (!['127.0.0.1','0.0.0.0'].includes(host) ||
      (host === '0.0.0.0' && env.BOUNCER_NATIVE_MISSION_INGRESS !== 'railway-proxy')) {
    throw new Error('public binding requires explicit Railway proxy ingress');
  }
  if (host === '0.0.0.0' && env.PORT && env.BOUNCER_NATIVE_MISSION_PORT && env.PORT !== env.BOUNCER_NATIVE_MISSION_PORT) {
    throw new Error('configured mission port must match the Railway port');
  }
  const raw = env.BOUNCER_NATIVE_MISSION_PORT || (host === '0.0.0.0' ? env.PORT : '') || '8789';
  if (typeof raw !== 'string' || !/^[0-9]{1,5}$/.test(raw)) throw new Error('invalid port');
  const port=Number(raw);
  if(!Number.isSafeInteger(port)||port<1||port>65535)throw new Error('invalid port');
  return {host,port};
}

// Fixed labels only: underlying errors may contain a private path, RPC URL,
// database details or other operator data and must not reach service logs.
export function classifyNativeMissionStartupError(error) {
  const message=typeof error?.message==='string' ? error.message : '';
  if(message.includes('unclean shutdown'))return 'RECOVERY_REQUIRED';
  if(message.includes('start in recovery-only mode'))return 'INITIAL_RECOVERY_REQUIRED';
  if(message.includes('unknown journal lock') || message.includes('unsafe journal fence'))return 'MANUAL_LOCK_REVIEW';
  if(message.includes('persistent-volume fence') || message.includes('exclusive journal fence'))return 'VOLUME_FENCE_UNAVAILABLE';
  if(message.includes('declared Railway volume') || message.includes('a Railway persistent volume'))return 'VOLUME_CONFIGURATION';
  if(message.includes('original journal not found') || message.includes('dedicated original mission journal'))return 'ORIGINAL_JOURNAL_UNAVAILABLE';
  return 'CONFIGURATION_OR_RUNTIME';
}

export async function startNativeMissionSite({env=process.env}={}) {
  const {host,port}=resolveNativeMissionListener(env);
  const runtime=await configureNativeMissionSite({env});
  try {await new Promise((resolve,reject)=>{runtime.server.once('error',reject);runtime.server.listen(port,host,resolve)});}
  catch(error){await runtime.close();throw error}
  console.log(`Bouncer testnet mission service listening on ${host}:${port} in ${runtime.mode} mode (${runtime.ingress}). HTTPS proxy required.`);
  let stopping=false;
  const shutdown=()=>{
    if(stopping)return;stopping=true;
    void runtime.close().then(()=>{process.exitCode=0},()=>{console.error('Shutdown is uncertain; preserve the original journal and reconcile before restart.');process.exitCode=1});
  };
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  return runtime;
}
async function main() {
  if(process.argv.length===3&&process.argv[2]==='--help'){console.log(USAGE);return}
  if(process.argv.length!==2)throw new Error('invalid arguments');
  await startNativeMissionSite();
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  main().catch(error=>{console.error(`Bouncer testnet mission site did not start (${classifyNativeMissionStartupError(error)}). Preserve the original journal; no startup transaction was sent.`);process.exitCode=1});
}
