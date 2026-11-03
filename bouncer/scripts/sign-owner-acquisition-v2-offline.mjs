#!/usr/bin/env node
/** LOCAL ONLY: fixed testnet wrap/swap for the distinct replacement owner.
 * The exact original is journaled before publishing any bearer transaction. */
import fs from 'node:fs';
import { validateOwnerBootstrapPlan } from '../agent/testnet-owner-bootstrap.mjs';
import { signAndJournalOwnerAcquisition } from '../agent/circle-owner-acquisition-journal.mjs';
import { exportTemporaryTestnetOwner } from '../agent/testnet-owner-local-keyring.mjs';
const [kind, option, ...rest] = process.argv.slice(2);
if (!['wrap', 'swap'].includes(kind) || (option && option !== '--restore-original') || rest.length) {
  throw new Error('usage: sign-owner-acquisition-v2-offline.mjs wrap|swap [--restore-original]');
}
const plan = validateOwnerBootstrapPlan(JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v2-plan.json', import.meta.url), 'utf8')));
const keyring = '/home/user/near_hub/.bouncer-private/replacement-owner', temp = '/home/user/bouncer-private-v2';
const paths = { primary: `${temp}/owner-v2-primary.json`, backup: `${temp}/Bouncer-v2-testnet-owner-recovery.json`,
  snapshot: `${keyring}/acquisition-${kind}-snapshot.json`, circleJournal: `${keyring}/circle-owner-registration-journal.json`,
  wrapJournal: `${keyring}/acquisition-wrap-journal.json`, journal: `${keyring}/acquisition-${kind}-journal.json`,
  lock: `${keyring}/acquisition-${kind}.lock`, evidence: `/home/user/near_hub/bouncer/evidence/testnet-owner-v2/${kind}-original.json` };
try {
  if (option !== '--restore-original') exportTemporaryTestnetOwner({ dir: keyring, plan, primary: paths.primary, backup: paths.backup });
  const result = await signAndJournalOwnerAcquisition({ plan, paths, kind, restore: option === '--restore-original' });
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(`Replacement ${kind} signing stopped: ${error?.message ?? 'unknown error'}`); process.exitCode = 1; }
