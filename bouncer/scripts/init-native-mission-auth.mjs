#!/usr/bin/env node
/** Operator-only schema initialization in a dedicated testnet database. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { validateSellerDatabaseUrl } from '../services/shared-resource-provider.mjs';
import { initializePostgresWalletPromptAuth, inspectPostgresWalletPromptAuthSchema } from '../agent/postgres-wallet-prompt-auth.mjs';

const USAGE=`Usage: node scripts/init-native-mission-auth.mjs --confirm-dedicated-testnet-db

Explicitly initializes the one-use wallet-consent schema in the configured,
dedicated testnet PostgreSQL primary. The database must already exist. Requires
BOUNCER_NATIVE_MISSION_AUTH_DATABASE_URL; use verified TLS for remote databases.
Never put the URL in the repository or command arguments. Existing challenges
are not cleared. Database history rollback cannot be detected by this schema.
No wallet prompt, NEAR key, journal or transaction is created.
`;
async function main() {
  if(process.argv.length===3&&process.argv[2]==='--help'){console.log(USAGE);return}
  if(process.argv.length!==3||process.argv[2]!=='--confirm-dedicated-testnet-db'||process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0')throw new Error();
  const url=validateSellerDatabaseUrl(process.env.BOUNCER_NATIVE_MISSION_AUTH_DATABASE_URL);
  const pool=new pg.Pool({connectionString:url,max:1,connectionTimeoutMillis:5000,idleTimeoutMillis:30000});pool.on('error',()=>{});
  try {await initializePostgresWalletPromptAuth({pool});await inspectPostgresWalletPromptAuthSchema({pool});}
  finally {await pool.end()}
  console.log('Testnet wallet-consent schema checked. No wallet prompt or transaction was made.');
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  main().catch(()=>{console.error('Testnet wallet-consent schema was not confirmed; inspect the dedicated database before continuing.');process.exitCode=1});
}
