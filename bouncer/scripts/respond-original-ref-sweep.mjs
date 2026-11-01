#!/usr/bin/env node
/**
 * Operator-side response to an ephemeral GitHub Actions testnet sweep request.
 * Reads only the separately scoped sweep key, encrypts it to the worker's
 * ephemeral RSA public key and pushes a run-specific ciphertext file to this
 * private branch. Never prints the secret or transfers an input/owner key.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import nearApi from 'near-api-js';
import { decodeSweepHandoffRequest, sealSweepHandoff } from '../agent/ref-sweep-handoff.mjs';

const REPO = 'abdullahimujeeb0505-stack/Bouncer', BRANCH = 'arena/88d70c7c-near-hub';
const REQUEST_TITLE = 'Scoped Ref sweep handoff request';
const ORIGINAL_HASH = 'DzWVHLp51KuoUoy8oaYNQTgLNAMgSRcegYT4mjuXCXrz';
const OUTPUT_RECEIPT = '7KEWv6Ux5EHX6R1F7ipdZmvFZKp7p6iQkpRsynXieSSX';
const OWNER = 'owner.bouncer-ref-44f619d9.testnet', VAULT = 'bouncer-ref-44f619d9.testnet', ROUTER = 'ref-router-44f619d9.testnet';
function gh(endpoint, args = []) {
  return JSON.parse(execFileSync('gh', ['api', endpoint, ...args], { encoding: 'utf8', maxBuffer: 2_000_000, stdio: ['ignore', 'pipe', 'pipe'] }));
}
function readOwnerOnly(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > 8192 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('sweep credential must be owner-only');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}
function main() {
  const jobId = process.argv[2], runId = process.argv[3], checkId = process.argv[4];
  if (![jobId, runId, checkId].every(value => /^[1-9][0-9]{0,19}$/.test(value || '')) || process.argv.length !== 5) {
    throw new Error('usage: node respond-original-ref-sweep.mjs JOB_ID RUN_ID HANDOFF_CHECK_ID');
  }
  const run = gh(`/repos/${REPO}/actions/runs/${runId}`);
  const job = gh(`/repos/${REPO}/actions/jobs/${jobId}`);
  const check = gh(`/repos/${REPO}/check-runs/${checkId}`);
  const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const localHead = git(['rev-parse', 'HEAD']);
  const root = git(['rev-parse', '--show-toplevel']);
  if (git(['branch', '--show-current']) !== BRANCH || git(['status', '--porcelain', '--untracked-files=all'])) {
    throw new Error('scoped handoff requires the clean fixed session branch');
  }
  if (run?.id?.toString() !== runId || run.event !== 'push' || run.run_attempt !== 1 ||
      run.status !== 'in_progress' || run.path !== '.github/workflows/ci.yml' || run.head_branch !== BRANCH ||
      run.head_sha !== localHead || run.repository?.private !== true || job?.id?.toString() !== jobId ||
      job.run_id?.toString() !== runId || job.run_attempt !== 1 || job.head_sha !== localHead ||
      job.name !== 'Resume original Ref output sweep (testnet)' || job.status !== 'in_progress' ||
      !job.steps?.some(step => step.name === 'Recover original receipts and perform one scoped sweep' && step.status === 'in_progress')) {
    throw new Error('expected private first-attempt original-sweep job is not running at the current HEAD');
  }
  if (check?.id?.toString() !== checkId || check.name !== `Scoped Ref sweep handoff ${runId}` || check.head_sha !== localHead ||
      check.status !== 'completed' || check.conclusion !== 'success' || check.app?.id !== 15368 || check.app?.slug !== 'github-actions' ||
      check.external_id !== `bouncer-ref-sweep-${runId}` || check.details_url !== `https://github.com/${REPO}/actions/runs/${runId}` ||
      check.output?.title !== REQUEST_TITLE || typeof check.started_at !== 'string' || typeof job.started_at !== 'string' ||
      !Number.isFinite(Date.parse(check.started_at)) || !Number.isFinite(Date.parse(job.started_at)) ||
      Date.parse(check.started_at) < Date.parse(job.started_at)) {
    throw new Error('handoff check is not bound to the expected current GitHub Actions job');
  }
  const request = decodeSweepHandoffRequest(check.output?.summary);
  if (request?.run_id !== runId) throw new Error('handoff run does not match its Actions job');
  const file = path.join(os.homedir(), '.near-credentials/testnet/bouncer-ref-v3-20261101/sweep.json');
  const credentials = readOwnerOnly(file);
  if (credentials.account_id !== OWNER || typeof credentials.private_key !== 'string') throw new Error('wrong testnet sweep credential');
  const sweepKey = nearApi.KeyPair.fromString(credentials.private_key).getPublicKey().toString();
  const expected = { owner_account_id: OWNER, contract_id: VAULT, router_id: ROUTER, original_hash: ORIGINAL_HASH,
    output_receipt_id: OUTPUT_RECEIPT, expected_output: '6926', sweep_public_key: sweepKey };
  const sealed = sealSweepHandoff({ request, expected, credentials });
  const relative = `bouncer/recovery/ref-sweep-${runId}.json`, destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.writeFileSync(destination, JSON.stringify(sealed, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  // Commit only ciphertext (never an owner key, input key or signed action).
  // A rejected/uncertain push is not retried: the worker may have received it.
  git(['add', '--', relative]);
  git(['commit', '--only', '-m', `Deliver encrypted scoped testnet sweep handoff for run ${runId}`, '--', relative]);
  git(['push', 'origin', BRANCH]);
  console.log(`Encrypted scoped testnet sweep credential delivered for run ${runId}. No owner key or input key was shared.`);
}
try { main(); } catch (error) { console.error(`[ref-sweep-handoff] ${error.message}`); process.exitCode = 1; }
