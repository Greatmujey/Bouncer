#!/usr/bin/env node
/** Operator-facing read-only audit. Does not provision or update a checkpoint. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { auditFullGitWitnessHistory } from '../agent/full-git-witness-history-audit.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('Read-only audit of all parent edges reachable from the current public Bouncer branch. Requires an unshallowed checkout and matching remote HEAD.');
  console.log('Does not discover deleted branches, provision a checkpoint, authorize a wallet, sign or send anything.');
} else {
  try {
    if (args.length) throw Error();
    const git = args => execFileSync('git',args,{cwd:repo,timeout:30_000,maxBuffer:32_768,stdio:['ignore','pipe','pipe'],
      env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'}}).toString('utf8').trimEnd();
    const branch=git(['branch','--show-current']), head=git(['rev-parse','HEAD']);
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/.test(branch) || branch.includes('..') || branch.endsWith('/') ||
        !/^[a-f0-9]{40}$/.test(head) || git(['config','--get','remote.origin.url']) !== 'https://github.com/Greatmujey/Bouncer.git') throw Error();
    const remote=()=>git(['ls-remote','--heads','origin',`refs/heads/${branch}`]);
    if (remote() !== `${head}\trefs/heads/${branch}`) throw Error();
    const report=await auditFullGitWitnessHistory({repo,head});
    if (remote() !== `${head}\trefs/heads/${branch}`) throw Error();
    console.log(JSON.stringify({status:'REACHABLE_HISTORY_CHECKED_NOT_A_TRUSTED_BASELINE',repository:'Greatmujey/Bouncer',branch,
      observed_at_utc:new Date().toISOString(),...report},null,2));
  } catch {
    console.error('Witness baseline audit unavailable or unsafe. No checkpoint was provisioned and no transaction was authorized.');
    process.exitCode=1;
  }
}
