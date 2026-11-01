#!/usr/bin/env node
// READ ONLY: independently reverify the retained original input and sweep.
// No keys, signatures, journal mutations, or new transactions are permitted.
import fs from 'node:fs';
import path from 'node:path';
import { PaymentRpcProvider } from '../agent/near-account.mjs';
import { openConfiguredFileJournal } from '../agent/procurement.mjs';
import { validateRefSwapGoal } from '../agent/ref-swap-evidence.mjs';
import { inspectCompletedRefSwap } from '../agent/ref-swap-reinspection.mjs';

const dir = process.argv[2];
if (!dir || process.argv.length !== 3) throw new Error('usage: node inspect-completed-ref-swap.mjs COMPLETED_ARTIFACT_DIRECTORY');
function find(name) {
  const found = [];
  function visit(root, level) {
    if (level > 3) return;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) visit(file, level + 1);
      else if (entry.isFile() && entry.name === name) found.push(file);
    }
  }
  visit(dir, 0);
  if (found.length !== 1) throw new Error(`expected exactly one retained ${name}`);
  return found[0];
}
async function main() {
  const goal = validateRefSwapGoal(JSON.parse(fs.readFileSync(find('goal.json'), 'utf8')));
  if (goal.contract_id !== 'bouncer-ref-44f619d9.testnet' || goal.owner_account_id !== 'owner.bouncer-ref-44f619d9.testnet' ||
      goal.router_id !== 'ref-router-44f619d9.testnet') throw new Error('unexpected retained swap identity');
  const journal = openConfiguredFileJournal(find('journal.json'), goal.contract_id, goal.owner_account_id, { requireExisting: true });
  try {
    const provider = new PaymentRpcProvider(process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com');
    const result = await inspectCompletedRefSwap({ goal, provider, journal,
      expectedInput: 'DzWVHLp51KuoUoy8oaYNQTgLNAMgSRcegYT4mjuXCXrz',
      expectedSweep: 'iprMyDVgVhFZDDBp152KDGUwpZBRehQEdvJDU29QEkP',
      expectedReceipt: '7KEWv6Ux5EHX6R1F7ipdZmvFZKp7p6iQkpRsynXieSSX', expectedAmount: '6926' });
    console.log(`::notice title=Read-only completed Ref swap reinspection::${JSON.stringify(result)}`);
  } finally { journal.close(); }
}
main().catch(error => {
  const text = String(error.message).slice(0, 2000).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.error(`[completed-ref-reinspection] ${error.message}`);
  console.log(`::error title=Completed Ref swap reinspection failed::${text}`); process.exitCode = 1;
});
