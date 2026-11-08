#!/usr/bin/env node
/**
 * Wait for an operator's public, run-specific provisioning instruction on the
 * SAME Arena branch. This is not a wallet-prompt or payment authorization.
 * If no instruction arrives, exit without touching a database or NEAR.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const branch = process.env.GITHUB_REF_NAME;
const runId = process.env.GITHUB_RUN_ID;
const role = process.env.BOUNCER_INFRA_ROLE;
if (branch !== 'arena/0e4386ea-near-hub' || !/^[1-9][0-9]{0,19}$/.test(runId ?? '') ||
    !['coordinator', 'checkpoint'].includes(role)) throw new Error('unexpected session');
const file = `bouncer/infrastructure/session-${runId}.json`;
const git = args => execFileSync('git', args, { encoding:'utf8', stdio:['ignore','pipe','pipe'], timeout:30_000,
  env:{ ...process.env, GIT_TERMINAL_PROMPT:'0', GIT_NO_REPLACE_OBJECTS:'1' } }).trim();
const deadline = Date.now() + 55 * 60_000;
let provisioningStarted = false;
while (Date.now() < deadline) {
  try {
    git(['fetch','--quiet','--no-tags','origin',branch]);
    const raw = git(['show', `refs/remotes/origin/${branch}:${file}`]);
    const config = JSON.parse(raw);
    if (config?.version === 1 && config.run_id === runId && ['provision-only','resume-only'].includes(config.mode)) {
      if (git(['branch','--show-current']) !== branch || git(['status','--porcelain','--untracked-files=normal'])) throw Error();
      git(['pull','--ff-only','--quiet','origin',branch]);
      console.log('Found the run-specific provisioning instruction. No wallet action is authorized.');
      provisioningStarted = true;
      const result = spawnSync(process.execPath, ['bouncer/scripts/run-testnet-infra-session.mjs', file],
        { env:process.env, stdio:'inherit', timeout:60 * 60_000 });
      if (result.error || result.signal || result.status !== 0) throw new Error('testnet provisioning did not complete');
      process.exit(0);
    }
  } catch {
    // Missing config or a temporary read problem means wait, not an approval.
    // If an instruction was consumed but execution failed, fail closed instead
    // of re-running any provisioning or subsequent operation.
    if (provisioningStarted) throw new Error('provisioning outcome uncertain');
  }
  await delay(5_000);
}
console.log('No run-specific provisioning instruction was received; nothing was provisioned or sent.');
