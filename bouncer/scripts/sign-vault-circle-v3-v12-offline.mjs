#!/usr/bin/env node
/** LOCAL ONLY: one fixed Circle registration or deposit for the V3/V12
 * vault. A durable journal precedes public export. No private key goes to CI. */
import fs from 'node:fs';
import { validateOwnerBootstrapPlan } from '../agent/testnet-owner-bootstrap.mjs';
import { signAndJournalVaultCircle } from '../agent/keyless-vault-v12-circle-journal.mjs';
import { exportTemporaryTestnetOwner } from '../agent/testnet-owner-local-keyring.mjs';
const [kind, option, ...rest] = process.argv.slice(2);
if (!['register','fund'].includes(kind) || (option && option !== '--restore-original') || rest.length) {
  throw new Error('usage: sign-vault-circle-v3-v12-offline.mjs register|fund [--restore-original]');
}
const plan = validateOwnerBootstrapPlan(JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v3-plan.json', import.meta.url), 'utf8')));
const keyring = '/home/user/near_hub/.bouncer-private/owner-v3', temp = '/home/user/bouncer-private-v3';
const paths = { primary: `${temp}/recovery.json`, backup: `${temp}/recovery-copy.json`,
  snapshot: `${keyring}/vault-v12-circle-${kind}-snapshot.json`, bootstrapJournal: `${keyring}/vault-v12-bootstrap-journal.json`,
  swapJournal: `${keyring}/acquisition-swap-journal.json`, registrationJournal: `${keyring}/vault-v12-circle-register-journal.json`,
  journal: `${keyring}/vault-v12-circle-${kind}-journal.json`, lock: `${keyring}/vault-v12-circle-${kind}.lock`,
  evidence: `/home/user/near_hub/bouncer/evidence/testnet-owner-v3/vault-v12-circle-${kind}-original.json` };
try {
  if (option !== '--restore-original') exportTemporaryTestnetOwner({ dir: keyring, plan, primary: paths.primary, backup: paths.backup });
  const result = await signAndJournalVaultCircle({ plan, paths, kind, restore: option === '--restore-original' });
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(`V12 Circle vault ${kind} signing stopped: ${error?.message ?? 'unknown error'}`); process.exitCode = 1; }
