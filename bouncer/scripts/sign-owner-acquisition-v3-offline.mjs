#!/usr/bin/env node
/** LOCAL ONLY: fixed testnet wrap/swap for the distinct backed-up owner.
 * The exact original is journaled before publishing any bearer transaction. */
import fs from 'node:fs';
import { validateOwnerBootstrapPlan } from '../agent/testnet-owner-bootstrap.mjs';
import { signAndJournalOwnerAcquisition } from '../agent/circle-owner-acquisition-journal.mjs';
import { exportTemporaryTestnetOwner } from '../agent/testnet-owner-local-keyring.mjs';
const [kind, option, ...rest] = process.argv.slice(2);
if (!['wrap', 'swap'].includes(kind) || (option && option !== '--restore-original') || rest.length) {
  throw new Error('usage: sign-owner-acquisition-v3-offline.mjs wrap|swap [--restore-original]');
}
const plan = validateOwnerBootstrapPlan(JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v3-plan.json', import.meta.url), 'utf8')));
const keyring = '/home/user/near_hub/.bouncer-private/owner-v3', temp = '/home/user/bouncer-private-v3';
const paths = { primary: `${temp}/recovery.json`, backup: `${temp}/recovery-copy.json`,
  snapshot: `${keyring}/acquisition-${kind}-snapshot.json`, circleJournal: `${keyring}/circle-owner-registration-journal.json`,
  wrapJournal: `${keyring}/acquisition-wrap-journal.json`, journal: `${keyring}/acquisition-${kind}-journal.json`,
  lock: `${keyring}/acquisition-${kind}.lock`, evidence: `/home/user/near_hub/bouncer/evidence/testnet-owner-v3/${kind}-original.json` };
try {
  if (option !== '--restore-original') exportTemporaryTestnetOwner({ dir: keyring, plan, primary: paths.primary, backup: paths.backup });
  const result = await signAndJournalOwnerAcquisition({ plan, paths, kind, restore: option === '--restore-original' });
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(`Backed-up ${kind} signing stopped: ${error?.message ?? 'unknown error'}`); process.exitCode = 1; }
