#!/usr/bin/env node
/** LOCAL ONLY. Private files stay outside the repository. The original signed
 * envelope is journaled before its public bearer bytes are exported. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateOwnerBootstrapPlan } from '../agent/testnet-owner-bootstrap.mjs';
import { signAndJournalCircleRegistration } from '../agent/circle-owner-offline-journal.mjs';
const mode = process.argv.slice(2);
if (mode.length > 1 || (mode.length === 1 && mode[0] !== '--restore-original')) throw new Error('only --restore-original is supported');
const plan = validateOwnerBootstrapPlan(JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-bootstrap-plan.json', import.meta.url), 'utf8')));
const privateDir = '/home/user/bouncer-private';
const evidenceDir = fileURLToPath(new URL('../evidence/testnet-circle-owner-registration/', import.meta.url));
const paths = { primary: `/home/user/.near-credentials/testnet/${plan.account_id}.json`,
  backup: `${privateDir}/Bouncer-testnet-owner-recovery.json`, snapshot: `${privateDir}/circle-owner-snapshot.json`,
  journal: `${privateDir}/circle-owner-registration-journal.json`, lock: `${privateDir}/circle-owner-registration.lock`,
  evidence: path.join(evidenceDir, 'original-signed-registration.json') };
try {
  const result = await signAndJournalCircleRegistration({ plan, paths, restore: mode[0] === '--restore-original' });
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(`Local registration signing stopped: ${error?.message ?? 'unknown error'}`); process.exitCode = 1; }
