#!/usr/bin/env node
/** Testnet-only, single-host service. Never create secrets, journals, schema or
 * transactions on startup. Put a dedicated HTTPS proxy in front of loopback. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { configureNativeMissionSite } from '../agent/configured-native-mission-site.mjs';

const USAGE=`Usage: node scripts/start-native-mission-site.mjs

Serves the reviewed Bouncer site and fixed native testnet mission behind a
same-origin HTTPS proxy. Listens only on 127.0.0.1. Defaults OFF: this never
sets up a vault, creates a journal, signs a wallet prompt, or sends on startup.

Required environment: BOUNCER_NATIVE_MISSION_ENABLED=1,
BOUNCER_NATIVE_MISSION_MODE=execute|recover, BOUNCER_WALLET_ORIGIN,
BOUNCER_TESTNET_RPC_URL, BOUNCER_NATIVE_MISSION_FILE,
BOUNCER_NATIVE_MISSION_JOURNAL_FILE, BOUNCER_FILE_JOURNAL_KEY_FILE.
Execute mode also requires BOUNCER_NATIVE_MISSION_AGENT_KEYS_FILE and
BOUNCER_NATIVE_MISSION_AUTH_DATABASE_URL. The database and encrypted journal
must already exist. Optional: BOUNCER_NATIVE_MISSION_PORT (default 8789),
BOUNCER_WALLETCONNECT_PROJECT_ID and BOUNCER_GOOGLE_CLIENT_ID.

Keep keys outside the checkout. Use persistent storage, a verified TLS database,
a trusted RPC, backups and rollback monitoring. See docs/NATIVE_MISSIONS.md.
This is unaudited testnet software; never use real funds.
`;
async function main() {
  if(process.argv.length===3&&process.argv[2]==='--help'){console.log(USAGE);return}
  if(process.argv.length!==2)throw new Error('invalid arguments');
  const port=Number(process.env.BOUNCER_NATIVE_MISSION_PORT||'8789');
  if(!Number.isSafeInteger(port)||port<1||port>65535)throw new Error('invalid port');
  const runtime=await configureNativeMissionSite();
  try {await new Promise((resolve,reject)=>{runtime.server.once('error',reject);runtime.server.listen(port,'127.0.0.1',resolve)});}
  catch(error){await runtime.close();throw error}
  console.log(`Bouncer testnet mission site listening on loopback port ${port} in ${runtime.mode} mode. Dedicated HTTPS proxy required.`);
  let stopping=false;
  const shutdown=()=>{
    if(stopping)return;stopping=true;
    void runtime.close().then(()=>{process.exitCode=0},()=>{console.error('Shutdown is uncertain; preserve the original journal and reconcile before restart.');process.exitCode=1});
  };
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  main().catch(()=>{console.error('Bouncer testnet mission site did not start. Check the private configuration and preserve any original journal; no startup transaction was sent.');process.exitCode=1});
}
