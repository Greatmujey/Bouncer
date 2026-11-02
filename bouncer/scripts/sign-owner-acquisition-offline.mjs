#!/usr/bin/env node
/** LOCAL ONLY: sign one narrow testnet owner funding stage and journal before
 * public bearer export. It never contacts a network or exposes the key. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateOwnerBootstrapPlan } from '../agent/testnet-owner-bootstrap.mjs';
import { signAndJournalOwnerAcquisition } from '../agent/circle-owner-acquisition-journal.mjs';
const [kind, option, ...rest] = process.argv.slice(2);
if (!['wrap', 'swap'].includes(kind) || (option && option !== '--restore-original') || rest.length) {
  throw new Error('usage: sign-owner-acquisition-offline.mjs wrap|swap [--restore-original]');
}
const plan = validateOwnerBootstrapPlan(JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-bootstrap-plan.json', import.meta.url), 'utf8')));
const dir = '/home/user/bouncer-private', evidenceDir = fileURLToPath(new URL('../evidence/testnet-circle-owner-acquisition/', import.meta.url));
const paths = { primary: `/home/user/.near-credentials/testnet/${plan.account_id}.json`, backup: `${dir}/Bouncer-testnet-owner-recovery.json`,
  snapshot: `${dir}/acquisition-${kind}-snapshot.json`, circleJournal: `${dir}/circle-owner-registration-journal.json`,
  wrapJournal: `${dir}/acquisition-wrap-journal.json`, journal: `${dir}/acquisition-${kind}-journal.json`,
  lock: `${dir}/acquisition-${kind}.lock`, evidence: path.join(evidenceDir, `${kind}-original.json`) };
try {
  const result = await signAndJournalOwnerAcquisition({ plan, paths, kind, restore: option === '--restore-original' });
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(`Local ${kind} signing stopped: ${error?.message ?? 'unknown error'}`); process.exitCode = 1; }
