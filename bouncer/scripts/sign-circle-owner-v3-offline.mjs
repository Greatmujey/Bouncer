#!/usr/bin/env node
/** LOCAL ONLY: sign a Circle self-registration for the backed-up testnet
 * owner after a fresh public snapshot. Journal original bytes before export. */
import fs from 'node:fs';
import { validateOwnerBootstrapPlan } from '../agent/testnet-owner-bootstrap.mjs';
import { signAndJournalCircleRegistration } from '../agent/circle-owner-offline-journal.mjs';
import { exportTemporaryTestnetOwner } from '../agent/testnet-owner-local-keyring.mjs';
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--restore-original')) throw new Error('only --restore-original is supported');
const plan = validateOwnerBootstrapPlan(JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v3-plan.json', import.meta.url), 'utf8')));
const keyring = '/home/user/near_hub/.bouncer-private/owner-v3', temp = '/home/user/bouncer-private-v3';
const paths = { primary: `${temp}/recovery.json`, backup: `${temp}/recovery-copy.json`,
  snapshot: `${keyring}/circle-owner-snapshot.json`, journal: `${keyring}/circle-owner-registration-journal.json`,
  lock: `${keyring}/circle-owner-registration.lock`,
  evidence: '/home/user/near_hub/bouncer/evidence/testnet-owner-v3/circle-registration-original.json' };
try {
  if (args[0] !== '--restore-original') exportTemporaryTestnetOwner({ dir: keyring, plan, primary: paths.primary, backup: paths.backup });
  const result = await signAndJournalCircleRegistration({ plan, paths, restore: args[0] === '--restore-original' });
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(`New owner registration signing stopped: ${error?.message ?? 'unknown error'}`); process.exitCode = 1; }
