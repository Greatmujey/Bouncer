#!/usr/bin/env node
/** Publish ONLY the RSA-encrypted bootstrap envelope to this session branch.
 * The two jobs serialize their commits. No plaintext credential, wallet key,
 * signature, transaction, database write, or wallet prompt is published.
 * An uncertain push is an error and is never repeated by this script. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const role = process.env.BOUNCER_INFRA_ROLE, runId = process.env.GITHUB_RUN_ID;
const branch = process.env.GITHUB_REF_NAME, temporary = process.env.RUNNER_TEMP;
if (!['coordinator','checkpoint'].includes(role) || !/^[1-9][0-9]{0,19}$/.test(runId ?? '') ||
    branch !== 'arena/0e4386ea-near-hub' || !path.isAbsolute(temporary ?? '')) throw new Error('unexpected session');
const git = args => execFileSync('git', args, { encoding:'utf8', stdio:['ignore','pipe','pipe'], timeout:30_000,
  env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'} }).trim();
const file = r => `bouncer/infrastructure/session-${runId}-${r}.json`;
if (git(['branch','--show-current']) !== branch || git(['status','--porcelain','--untracked-files=normal'])) throw new Error('unsafe checkout');
if (role === 'checkpoint') {
  let ready = false;
  for (let i=0;i<60;i++) {
    try { git(['fetch','--quiet','--no-tags','origin',branch]);
      const content = JSON.parse(git(['show',`refs/remotes/origin/${branch}:${file('coordinator')}`]));
      if (content.version === 1 && content.run_id === runId && content.role === 'coordinator') { ready = true; break; }
    } catch { /* wait only for the other public envelope */ }
    await delay(3_000);
  }
  if (!ready) throw new Error('coordinator envelope unavailable');
}
git(['fetch','--quiet','--no-tags','origin',branch]);
git(['pull','--ff-only','--quiet','origin',branch]);
if (git(['status','--porcelain','--untracked-files=normal'])) throw new Error('unsafe checkout');
const output = file(role), encrypted = fs.readFileSync(path.join(temporary,`bouncer-testnet-infra-${role}`,'bootstrap.enc'),'utf8');
if (!/^[A-Za-z0-9+/]{683}=$/.test(encrypted) || fs.existsSync(output)) throw new Error('unsafe envelope');
fs.writeFileSync(output,`${JSON.stringify({version:1,run_id:runId,role,ciphertext_base64:encrypted})}\n`,{mode:0o644,flag:'wx'});
git(['add','--',output]);
if (git(['diff','--cached','--name-only']) !== output) throw new Error('unexpected staged content');
git(['-c','user.name=Bouncer testnet infrastructure','-c','user.email=41898282+github-actions[bot]@users.noreply.github.com',
  'commit','-m',`Publish encrypted ${role} testnet session envelope`,'--',output]);
// Deliberately one attempt. Any conflict or lost acknowledgement is a stop.
git(['push','origin',branch]);
console.log(`Published the encrypted ${role} envelope on the current session branch. No wallet action was authorized.`);
