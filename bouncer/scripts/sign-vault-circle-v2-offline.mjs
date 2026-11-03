#!/usr/bin/env node
/** LOCAL ONLY: exactly one Circle registration or funding action for the
 * replacement keyless testnet vault. No RPC and no private key to CI. */
import fs from 'node:fs';
import { validateOwnerBootstrapPlan } from '../agent/testnet-owner-bootstrap.mjs';
import { signAndJournalVaultCircle } from '../agent/keyless-vault-circle-journal.mjs';
import { exportTemporaryTestnetOwner } from '../agent/testnet-owner-local-keyring.mjs';
const [kind, option, ...rest] = process.argv.slice(2);
if (!['register','fund'].includes(kind) || (option && option !== '--restore-original') || rest.length) {
  throw new Error('usage: sign-vault-circle-v2-offline.mjs register|fund [--restore-original]');
}
const plan = validateOwnerBootstrapPlan(JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v2-plan.json', import.meta.url), 'utf8')));
const keyring = '/home/user/near_hub/.bouncer-private/replacement-owner', temp = '/home/user/bouncer-private-v2';
const paths = { primary: `${temp}/owner-v2-primary.json`, backup: `${temp}/Bouncer-v2-testnet-owner-recovery.json`,
  snapshot: `${keyring}/vault-circle-${kind}-snapshot.json`, bootstrapJournal: `${keyring}/vault-bootstrap-journal.json`,
  swapJournal: `${keyring}/acquisition-swap-journal.json`, registrationJournal: `${keyring}/vault-circle-register-journal.json`,
  journal: `${keyring}/vault-circle-${kind}-journal.json`, lock: `${keyring}/vault-circle-${kind}.lock`,
  evidence: `/home/user/near_hub/bouncer/evidence/testnet-owner-v2/vault-circle-${kind}-original.json` };
try {
  if (option !== '--restore-original') exportTemporaryTestnetOwner({ dir: keyring, plan, primary: paths.primary, backup: paths.backup });
  const result = await signAndJournalVaultCircle({ plan, paths, kind, restore: option === '--restore-original' });
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(`Vault Circle ${kind} signing stopped: ${error?.message ?? 'unknown error'}`); process.exitCode = 1; }
