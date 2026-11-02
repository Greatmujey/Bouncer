#!/usr/bin/env node
/** Explicit operator CLI for the experimental MultiAgency testnet adapter.
 * No network activity by default; quote/payment each require --execute. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { PaymentRpcProvider, MonotonicAccount } from './near-account.mjs';
import { openConfiguredFileJournal } from './procurement.mjs';
import { validateMultiAgencyGoal } from './multiagency-research.mjs';
import { inspectMultiAgencyResearchTask, payMultiAgencyQuoteOnce, recoverMultiAgencyPayment,
  prepareMultiAgencyExactIntent, payMultiAgencyExactFtOnce, recoverMultiAgencyExactFtPayment,
  inspectMultiAgencyExactResearchTask, requestMultiAgencyQuoteOnce } from './multiagency-runner.mjs';

const USAGE = `Experimental MultiAgency testnet research adapter (NOT a proven independent purchase).
Usage: node agent/multiagency.mjs --goal PUBLIC-GOAL.json --state ORIGINAL-ENCRYPTED-JOURNAL.json ACTION [options]
Actions (choose one):
  --quote --execute --ack-provider-availability [--new-journal --ack-key-backup]  One public quote POST
  --prepare-exact --public-key ED25519_KEY               Review V11 owner calldata; no signing or send
  --pay-exact --execute --ack-provider-availability --key RESTRICTED-AGENT.json   Pay an already pinned V11 intent
  --recover-exact                                        Inspect the original V11 hash; no signing or send
  --inspect-exact --task NUMBER                          Check one public task and its V11 paid-job linkage
Legacy V9 actions: --pay (same execution/key acknowledgments), --recover, --inspect --task NUMBER.
Options: --rpc TESTNET_RPC (payment/recovery/inspection), --help
BOUNCER_FILE_JOURNAL_KEY_FILE must point to the original owner-only encryption key.
V11 is experimental, fresh-state only and not deployed. Never upgrade V9/V10 in place.
The availability and key-backup flags are operator assertions, NOT proof of either.
Never replace an unresolved or lost journal. Testnet USDC has no financial value.
The seller quote is unsigned, the brief is public, and a stalled deposit may not be refunded.`;
const expand = value => path.resolve(value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value);
function parse(args) {
  const out = {}, actions = ['quote', 'pay', 'recover', 'inspect', 'prepare-exact', 'pay-exact', 'recover-exact', 'inspect-exact'];
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (!word.startsWith('--')) throw new Error('unknown argument; use --help');
    const key = word.slice(2);
    if (Object.hasOwn(out, key)) throw new Error(`duplicate --${key}`);
    if (['help', 'execute', 'new-journal', 'ack-key-backup', 'ack-provider-availability', ...actions].includes(key)) out[key] = true;
    else if (['goal', 'state', 'key', 'public-key', 'rpc', 'task'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) out[key] = args[++i];
    else throw new Error('unknown or incomplete argument; use --help');
  }
  if (out.help) return out;
  if (actions.filter(k => out[k]).length !== 1 || !out.goal || !out.state) throw new Error('one action and the original goal/journal are required');
  const changesState = Boolean(out.quote || out.pay || out['pay-exact']);
  if (changesState !== Boolean(out.execute)) throw new Error('quote and pay require --execute; read-only actions must not use it');
  if (changesState !== Boolean(out['ack-provider-availability'])) {
    throw new Error('quote/payment require a fresh operator assertion of provider availability; read-only actions must not use it');
  }
  if (Boolean(out.key) !== Boolean(out.pay || out['pay-exact'])) throw new Error('--key is required only for payment');
  if (Boolean(out['public-key']) !== Boolean(out['prepare-exact'])) throw new Error('--public-key is required only for exact intent preparation');
  if (Boolean(out.task) !== Boolean(out.inspect || out['inspect-exact']) || (out.task && !/^[1-9][0-9]{0,14}$/.test(out.task))) throw new Error('--inspect requires one positive task number');
  if (Boolean(out['new-journal']) !== Boolean(out['ack-key-backup']) || (out['new-journal'] && !out.quote)) {
    throw new Error('--new-journal and --ack-key-backup are paired and only allowed for the first quote');
  }
  if ((out.quote || out['prepare-exact']) && out.rpc) throw new Error('--rpc is not used for quote or exact intent preparation');
  return out;
}
function readJson(file, { secret = false, maxBytes = 16_384 } = {}) {
  let fd;
  try {
    fd = fs.openSync(expand(file), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (secret ? fs.constants.O_NOFOLLOW : 0));
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.size < 1 || s.size > maxBytes || (secret &&
        ((s.mode & 0o077) !== 0 || s.nlink !== 1 || (typeof process.getuid === 'function' && s.uid !== process.getuid())))) {
      throw new Error('input must be a bounded regular file; signing keys must be owner-only and not symlinks');
    }
    try { return JSON.parse(fs.readFileSync(fd, 'utf8')); }
    catch { throw new Error(secret ? 'invalid private signing-key JSON' : 'invalid public goal JSON'); }
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function makeAccount(goal, provider, filename) {
  const credentials = readJson(filename, { secret: true, maxBytes: 4096 });
  if (credentials?.account_id !== goal.owner || typeof credentials?.private_key !== 'string') throw new Error('restricted agent key file does not match the owner');
  let key;
  try { key = nearApi.KeyPair.fromString(credentials.private_key); }
  catch { throw new Error('invalid restricted agent signing key'); }
  return { account: new MonotonicAccount(goal.owner, provider, new nearApi.KeyPairSigner(key)), publicKey: key.getPublicKey() };
}
export async function main(argv = process.argv.slice(2)) {
  const opts = parse(argv);
  if (opts.help) { console.log(USAGE); return; }
  if (!process.env.BOUNCER_FILE_JOURNAL_KEY_FILE) throw new Error('original BOUNCER_FILE_JOURNAL_KEY_FILE is required');
  const goal = validateMultiAgencyGoal(readJson(opts.goal)), state = expand(opts.state);
  if (state === expand(opts.goal) || state === expand(process.env.BOUNCER_FILE_JOURNAL_KEY_FILE) || (opts.key && state === expand(opts.key))) {
    throw new Error('journal must be separate from the goal and all key files');
  }
  // No silent recreation of a lost journal. Only an explicit first-use quote
  // may create a new one, with a human assertion that the key is backed up.
  if (opts['new-journal']) {
    try { fs.lstatSync(state); throw new Error('journal already exists; never replace it'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const journal = openConfiguredFileJournal(state, goal.vault, goal.owner, { requireExisting: !opts['new-journal'] });
  try {
    if (!journal.encryptionEnabled) throw new Error('encrypted journal is required');
    if (opts['new-journal'] && (fs.existsSync(state) || journal.list().length)) throw new Error('journal already exists; never replace it');
    let result;
    if (opts.quote) result = await requestMultiAgencyQuoteOnce({ goal, journal, execute: true });
    else if (opts['prepare-exact']) result = await prepareMultiAgencyExactIntent({ goal, journal, agentPublicKey: opts['public-key'] });
    else {
      const provider = new PaymentRpcProvider(opts.rpc || process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com');
      if (opts.pay) result = await payMultiAgencyQuoteOnce({ goal, journal, provider, ...makeAccount(goal, provider, opts.key), execute: true, log: () => {} });
      else if (opts['pay-exact']) result = await payMultiAgencyExactFtOnce({ goal, journal, provider, ...makeAccount(goal, provider, opts.key), execute: true });
      else if (opts.recover) result = await recoverMultiAgencyPayment({ goal, journal, provider, log: () => {} });
      else if (opts['recover-exact']) result = await recoverMultiAgencyExactFtPayment({ goal, journal, provider });
      else {
        const inspect = opts['inspect-exact'] ? inspectMultiAgencyExactResearchTask : inspectMultiAgencyResearchTask;
        result = await inspect({ goal, journal, provider, task: Number(opts.task),
          githubToken: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || undefined });
      }
    }
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'BLOCKED') process.exitCode = 2;
  } finally { journal.close(); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`[multiagency] ${error.message}`); process.exitCode = 1; });
}
