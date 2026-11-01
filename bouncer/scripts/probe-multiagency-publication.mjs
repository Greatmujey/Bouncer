#!/usr/bin/env node
/** Recheck one historical public MultiAgency research handoff. GET only;
 * this is NOT a Bouncer purchase, a current quote or evidence of capacity. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { verifyMultiAgencyPublishedHandoff } from '../agent/multiagency-research.mjs';

const exec = promisify(execFile), base = 'repos/MultiAgency/kanban-sandbox/issues';
async function read(path) {
  let stdout;
  try {
    ({ stdout } = await exec('gh', ['api', '--hostname', 'github.com', '--method', 'GET', `${base}${path}`],
      { timeout: 20_000, maxBuffer: 1_000_000, windowsHide: true }));
  } catch { throw new Error('bounded GitHub public read failed'); }
  try { return JSON.parse(stdout); } catch { throw new Error('GitHub public read returned invalid JSON'); }
}
async function main() {
  const [epic, task, comments] = await Promise.all([read('/32'), read('/40'), read('/40/comments?per_page=100')]);
  const { text, ...proof } = verifyMultiAgencyPublishedHandoff({ epic, task, comments });
  console.log(`::notice title=Historical independent research handoff control::${JSON.stringify({ ...proof, bytes: Buffer.byteLength(text),
    buyer: 'agency.testnet', is_bouncer_purchase: false, scope: 'historical public handoff only; no current availability or Bouncer purchase' })}`);
}
main().catch(error => { console.error(`[multiagency-publication] ${error.message}`); process.exitCode = 1; });
