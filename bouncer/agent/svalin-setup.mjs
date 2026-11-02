#!/usr/bin/env node
/**
 * Experimental, separately gated owner CLI for the V11 Svalin TESTNET setup.
 * Each invocation can submit at most one reviewed stage. This is not an audit,
 * consent mechanism, backup verifier, seller purchase or production deployer.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { buildUnsignedSvalinTrialSetup } from './svalin-setup-plan.mjs';
import { verifySvalinSetupPlan } from './svalin-setup-evidence.mjs';
import { openConfiguredFileJournal } from './procurement.mjs';
import { initializeSvalinSetupJournal, inspectSvalinSetupJournal } from './svalin-setup-journal.mjs';
import { inspectSvalinSetupStage } from './svalin-setup-stage-preflight.mjs';
import { runSvalinSetupStageOnce, recoverSvalinSetupStage } from './svalin-setup-runner.mjs';
import { ReadOnlyNearRpcProvider } from './read-only-near-rpc.mjs';
import { ExperimentalSvalinSetupRpc } from './svalin-setup-rpc.mjs';

const TX_STAGES = ['create_keyless_vault', 'configure_locked_policy', 'install_restricted_agent_key',
  'register_vault_for_test_usdc', 'fund_vault_with_test_usdc'];
const INSPECTION_STAGES = [...TX_STAGES, 'verify_funded_vault'];
const VALUE_OPTIONS = ['review', 'wasm', 'review-sha256', 'owner-public-key', 'state', 'rpc', 'owner-key',
  'check-stage', 'execute-stage', 'recover-stage'];
const FLAGS = ['init-journal', 'journal-status', 'confirm-new-journal', 'ack-key-backup',
  'execute', 'ack-backups', 'ack-reviewed-artifact', 'accept-keyless-lock', 'record-evidence'];
const USAGE = `EXPERIMENTAL V11 TESTNET owner setup; synthetic-tested only. No live setup is implied.
A keyless V11 vault currently cannot be upgraded/deleted or unregister its Circle storage;
native storage stake and the token-registration deposit may remain locked.

Common options for every action:
  --review ORIGINAL-PLAN.json --review-sha256 RETAINED-64-HEX-DIGEST
  --wasm REVIEWED-V11.wasm --owner-public-key ed25519:... --state ORIGINAL-JOURNAL
  Set BOUNCER_FILE_JOURNAL_KEY_FILE to the separate original, owner-only 32-byte key file.
  The review JSON must be unchanged output of svalin-setup-plan.mjs, including its newline.
  Use node directly or npm run --silent when saving planner JSON (npm banners corrupt it).

Choose exactly one action:
  --init-journal --confirm-new-journal --ack-key-backup
      Create a NEW encrypted local journal only if no prior setup or journal ever existed.
  --journal-status
      Inspect the original local journal; no RPC, signing or transaction.
  --check-stage STAGE --rpc TRUSTED-TESTNET-RPC
      Read-only pinned-state and journal check. Use verify_funded_vault after all five receipts.
  --execute-stage STAGE --rpc TRUSTED-TESTNET-RPC --owner-key OWNER-KEY.json
      --execute --ack-backups --ack-reviewed-artifact --accept-keyless-lock
      Separately approve at most ONE signed transaction. Never automatically retry it.
  --recover-stage STAGE --rpc TRUSTED-TESTNET-RPC [--record-evidence --ack-backups]
      Look up ONLY the original recorded hash; --record-evidence updates the local journal.

Stages: ${TX_STAGES.join(', ')}.
An owner-key JSON has account_id and private_key and must be an owner-only regular file, not a symlink.
Acknowledgments assert, but cannot prove, consent, review or backups. Independently review the exact
binary and current deployed token, back up keys and EACH updated journal, and verify fresh state and
all FINAL receipts before proceeding. A lost/rolled-back journal or dishonest RPC defeats these guards.
Unknown results must be reconciled by the original hash, never resent or replaced. No seller is contacted;
FT settlement is not seller delivery. Testnet USDC has no real-world value.`;
const expand = file => path.resolve(file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file);

function parse(argv) {
  if (argv.length === 1 && argv[0] === '--help') return null;
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i];
    if (typeof word !== 'string' || !word.startsWith('--')) throw new Error('invalid argument; use --help');
    const name = word.slice(2);
    if (Object.hasOwn(out, name)) throw new Error(`duplicate --${name}`);
    if (FLAGS.includes(name)) out[name] = true;
    else if (VALUE_OPTIONS.includes(name) && argv[i + 1] && !argv[i + 1].startsWith('--')) out[name] = argv[++i];
    else throw new Error('unknown or incomplete option; use --help');
  }
  const required = ['review', 'wasm', 'review-sha256', 'owner-public-key', 'state'];
  const actions = ['init-journal', 'journal-status', 'check-stage', 'execute-stage', 'recover-stage'];
  if (required.some(name => !out[name]) || actions.filter(name => out[name]).length !== 1 ||
      !/^[0-9a-f]{64}$/.test(out['review-sha256'])) {
    throw new Error('one action and all retained public review and journal options are required; use --help');
  }
  const init = Boolean(out['init-journal']), check = Boolean(out['check-stage']);
  const execution = Boolean(out['execute-stage']), recovery = Boolean(out['recover-stage']);
  const record = Boolean(out['record-evidence']);
  if (init !== Boolean(out['confirm-new-journal']) || init !== Boolean(out['ack-key-backup'])) {
    throw new Error('initialization alone requires --confirm-new-journal and --ack-key-backup');
  }
  if (execution !== Boolean(out.execute) || execution !== Boolean(out['owner-key']) ||
      execution !== Boolean(out['ack-reviewed-artifact']) || execution !== Boolean(out['accept-keyless-lock'])) {
    throw new Error('one-stage execution alone requires --execute, --owner-key and both artifact/keyless acknowledgments');
  }
  if ((execution || record) !== Boolean(out['ack-backups']) || (record && !recovery)) {
    throw new Error('--ack-backups is required only for execution or explicitly recorded recovery');
  }
  if ((check || execution || recovery) !== Boolean(out.rpc)) throw new Error('--rpc is required only for checks, execution or recovery');
  if ((check && !INSPECTION_STAGES.includes(out['check-stage'])) ||
      (execution && !TX_STAGES.includes(out['execute-stage'])) ||
      (recovery && !TX_STAGES.includes(out['recover-stage']))) throw new Error('invalid setup stage');
  return out;
}

// A fixed-size descriptor read avoids following the final path component or
// allocating a file that grows after stat. Parent directories, process and
// filesystem still must be trusted. Never print private bytes or JSON errors.
function readBytes(file, max, { secret = false } = {}) {
  let fd, bytes;
  try {
    fd = fs.openSync(expand(file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.size < 1 || s.size > max || (secret &&
        (s.nlink !== 1 || (s.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && s.uid !== process.getuid())))) throw new Error();
    bytes = Buffer.alloc(s.size);
    let pos = 0;
    while (pos < bytes.length) {
      const n = fs.readSync(fd, bytes, pos, bytes.length - pos, null);
      if (!n) throw new Error();
      pos += n;
    }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0 || fs.fstatSync(fd).size !== s.size) throw new Error();
    return bytes;
  } catch {
    if (secret) bytes?.fill(0);
    throw new Error(secret ? 'owner key must be a bounded owner-only regular file, not a symlink or hard link' :
      'cannot read a bounded regular public input file');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function retainedPlan(opts) {
  let review;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(readBytes(opts.review, 64 * 1024));
    review = JSON.parse(text);
    // The planner emits exactly this representation. Reject ambiguous duplicate
    // keys and alternate textual displays rather than silently signing a
    // different interpretation of the file the operator reviewed.
    if (`${JSON.stringify(review, null, 2)}\n` !== text) throw new Error();
  } catch { throw new Error('retained review must be unchanged canonical planner JSON'); }
  let plan;
  try {
    plan = buildUnsignedSvalinTrialSetup({ goal: review.goal, agentPublicKey: review.agent_public_key,
      wasmBytes: readBytes(opts.wasm, 4 * 1024 * 1024),
      initialVaultFundingYocto: review.stages[0].actions[1].deposit_yocto,
      agentGasAllowanceYocto: review.stages[2].actions[0].allowance_yocto,
      vaultTokenStorageDepositYocto: review.stages[3].actions[0].deposit_yocto });
    if (!isDeepStrictEqual(review, plan.review)) throw new Error();
    verifySvalinSetupPlan({ plan, trustedReviewHash: opts['review-sha256'], ownerPublicKey: opts['owner-public-key'] });
  } catch { throw new Error('artifact, public key or retained review differs from the independently retained digest'); }
  return plan;
}

function ownerSigner(filename, ownerId, ownerPublicKey) {
  const bytes = readBytes(filename, 4096, { secret: true });
  let credentials, pair;
  try {
    credentials = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!credentials || credentials.account_id !== ownerId || typeof credentials.private_key !== 'string') throw new Error();
    pair = nearApi.KeyPair.fromString(credentials.private_key);
    if (String(pair.getPublicKey()) !== ownerPublicKey) throw new Error();
    return new nearApi.KeyPairSigner(pair);
  } catch { throw new Error('owner signing key does not match the retained owner account and public key'); }
  finally { bytes.fill(0); if (credentials && typeof credentials === 'object') credentials.private_key = undefined; }
}

function ensureDistinctFiles(opts, journalKey) {
  const state = expand(opts.state);
  if ([opts.review, opts.wasm, journalKey, opts['owner-key']].filter(Boolean).some(file => expand(file) === state)) {
    throw new Error('the journal must be a separate file from the review, artifact and keys');
  }
}
function ensureNewFile(filename) {
  try { fs.lstatSync(filename); }
  catch (error) { if (error.code === 'ENOENT') return; throw new Error('cannot inspect journal path'); }
  throw new Error('journal already exists; never replace the original');
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parse(argv);
  if (opts === null) { console.log(USAGE); return; }
  const journalKey = process.env.BOUNCER_FILE_JOURNAL_KEY_FILE;
  if (!journalKey) throw new Error('the original BOUNCER_FILE_JOURNAL_KEY_FILE is required');
  ensureDistinctFiles(opts, journalKey);
  const plan = retainedPlan(opts), state = expand(opts.state);
  const common = { plan, trustedReviewHash: opts['review-sha256'], ownerPublicKey: opts['owner-public-key'] };
  if (opts['init-journal']) ensureNewFile(state);
  const journal = openConfiguredFileJournal(state, plan.review.goal.vault, plan.review.goal.owner,
    { requireExisting: !opts['init-journal'] });
  try {
    if (!journal.encryptionEnabled) throw new Error('the original encrypted journal is required');
    const args = { ...common, journal };
    let result;
    if (opts['init-journal']) {
      // Recheck while the FileJournal's exclusive lock is held. A pre-existing
      // file, even an empty file, is never silently reused or replaced.
      ensureNewFile(state);
      result = await initializeSvalinSetupJournal({ ...args, confirmNew: true });
    } else if (opts['journal-status']) result = await inspectSvalinSetupJournal(args);
    else if (opts['check-stage']) result = await inspectSvalinSetupStage({ ...args, stageId: opts['check-stage'],
      provider: new ReadOnlyNearRpcProvider(opts.rpc) });
    else if (opts['recover-stage']) result = await recoverSvalinSetupStage({ ...args, stageId: opts['recover-stage'],
      provider: new ExperimentalSvalinSetupRpc(opts.rpc), update: Boolean(opts['record-evidence']) });
    else {
      const stageId = opts['execute-stage'], provider = new ExperimentalSvalinSetupRpc(opts.rpc);
      // Do not even open the private key if an initial current-state check is
      // blocked. The coordinator independently repeats the check after this.
      const checked = await inspectSvalinSetupStage({ ...args, stageId, provider });
      if (checked.status !== 'READ_ONLY_STAGE_PROFILE_MATCH') {
        result = { status: 'BLOCKED_BEFORE_SIGNING', stage_id: stageId, blockers: checked.blockers,
          transaction_signed: false, broadcast_attempts: 0, seller_contacted: false };
      } else {
        const signer = ownerSigner(opts['owner-key'], plan.review.goal.owner, opts['owner-public-key']);
        result = await runSvalinSetupStageOnce({ ...args, stageId, provider, signer,
          approval: { network: 'testnet', stage_id: stageId, review_sha256: opts['review-sha256'],
            artifact_sha256: plan.review.artifact.sha256, one_broadcast_approved: true,
            independent_artifact_review_attested: true, journal_and_key_backups_attested: true,
            keyless_vault_storage_risk_accepted: true } });
      }
    }
    console.log(JSON.stringify(result, null, 2));
    if (['BLOCKED_BEFORE_SIGNING', 'BLOCKED_OR_UNKNOWN', 'ORIGINAL_HASH_NEEDS_RECONCILIATION',
      'FINAL_FAILURE_NEEDS_RECONCILIATION'].includes(result.status)) process.exitCode = 2;
  } finally { journal.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(); }
  catch (error) { console.error(`Setup blocked: ${error.message}`); process.exitCode = 1; }
}
