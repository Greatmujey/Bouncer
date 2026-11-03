#!/usr/bin/env node
/** LOCAL ONLY: one fixed keyless V11 vault for the distinct replacement owner.
 * Never publish a replacement for an unresolved original. No RPC or CI keys. */
import fs from 'node:fs';
import { validateOwnerBootstrapPlan } from '../agent/testnet-owner-bootstrap.mjs';
import { signAndJournalVaultBootstrap } from '../agent/keyless-vault-bootstrap-journal.mjs';
import { exportTemporaryTestnetOwner } from '../agent/testnet-owner-local-keyring.mjs';
const args = process.argv.slice(2);
if (args.length > 1 || (args.length && args[0] !== '--restore-original')) throw new Error('usage: sign-keyless-vault-v2-offline.mjs [--restore-original]');
const plan = validateOwnerBootstrapPlan(JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v2-plan.json', import.meta.url), 'utf8')));
const keyring = '/home/user/near_hub/.bouncer-private/replacement-owner', temp = '/home/user/bouncer-private-v2';
const paths = { primary: `${temp}/owner-v2-primary.json`, backup: `${temp}/Bouncer-v2-testnet-owner-recovery.json`,
  snapshot: `${keyring}/vault-bootstrap-snapshot.json`, swapJournal: `${keyring}/acquisition-swap-journal.json`,
  wasm: '/home/user/bouncer-tools/v11-review/bouncer-v11.wasm', journal: `${keyring}/vault-bootstrap-journal.json`,
  lock: `${keyring}/vault-bootstrap.lock`, evidence: '/home/user/near_hub/bouncer/evidence/testnet-owner-v2/vault-bootstrap-original.json' };
try {
  if (!args.length) exportTemporaryTestnetOwner({ dir: keyring, plan, primary: paths.primary, backup: paths.backup });
  const result = await signAndJournalVaultBootstrap({ plan, paths, restore: args.length === 1 });
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(`Replacement vault signing stopped: ${error?.message ?? 'unknown error'}`); process.exitCode = 1; }
