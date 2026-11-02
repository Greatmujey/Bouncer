#!/usr/bin/env node
/** Explicit operator CLI for the experimental Circle-testnet Svalin adapter.
 * No live work is authorized by this program's existence or --help. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { PaymentRpcProvider, MonotonicAccount } from './near-account.mjs';
import { openConfiguredFileJournal } from './procurement.mjs';
import { validateSvalinProGoal, prepareSvalinProSession, reserveSvalinProOnce, recoverSvalinProReservationOnce,
  prepareSvalinProExactFt } from './svalin-pro-session.mjs';
import { paySvalinProExactFtOnce, recoverSvalinProPayment, activateSvalinProOnce,
  inspectSvalinProActivation, requestSvalinProRiskOnce } from './svalin-pro-runner.mjs';

const USAGE = `Experimental Svalin Pro adapter: Circle testnet USDC ONLY; not a proven independent purchase.
Usage: node agent/svalin-pro.mjs --goal PUBLIC-GOAL.json --state ORIGINAL-ENCRYPTED-JOURNAL ACTION [options]
Actions (choose one; back up the journal AND its separate key before any seller contact):
  --init --new-journal --ack-key-backup              Create a local encrypted session; no network
  --reserve --execute --ack-key-backup               One reservation POST, existing journal only
  --recover-reservation --execute --ack-key-backup --ack-seller-mutation
                                                      One mutating lookup after a lost reservation
  --prepare-exact --public-key ED25519_KEY            Return unsigned owner/agent calldata; no network
  --pay-exact --execute --ack-key-backup --key RESTRICTED-AGENT.json
                                                      One payment against an ALREADY PINNED V11 intent
  --recover-payment                                   Reconcile original hash; no signing or seller call
  --activate --execute --ack-key-backup --ack-seller-mutation
                                                      One separately authorized activation POST
  --inspect-activation --execute --ack-key-backup --ack-bearer-disclosure
                                                      Status GET after an ambiguous activation
  --risk --target PUBLIC-NEAR-ACCOUNT --execute --ack-key-backup --ack-bearer-disclosure --ack-quota-use
                                                      One separately authorized paid API GET
Options: --rpc TESTNET_RPC (payment/recovery/activation/status/risk), --help
BOUNCER_FILE_JOURNAL_KEY_FILE must identify the ORIGINAL owner-only encryption key.
Owner approval, V11 deployment, token funding and backups are separate tasks; this CLI does none of them.
Acknowledgments are operator assertions, not evidence. Seller terms are unsigned and its exact-amount
matcher accepts ANY payer. Activation does not identify the credited tx, so attribution remains unproven.
Do not repeat ambiguous operations, recreate a missing journal or use a stale backup. Testnet USDC has no value.`;
const expand = value => path.resolve(value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value);
const ACTIONS = ['init', 'reserve', 'recover-reservation', 'prepare-exact', 'pay-exact', 'recover-payment', 'activate', 'inspect-activation', 'risk'];
function parse(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (!word.startsWith('--')) throw new Error('unknown argument; use --help');
    const key = word.slice(2);
    if (Object.hasOwn(out, key)) throw new Error(`duplicate --${key}`);
    if (['help', 'execute', 'new-journal', 'ack-key-backup', 'ack-seller-mutation', 'ack-bearer-disclosure', 'ack-quota-use', ...ACTIONS].includes(key)) out[key] = true;
    else if (['goal', 'state', 'key', 'public-key', 'target', 'rpc'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) out[key] = args[++i];
    else throw new Error('unknown or incomplete argument; use --help');
  }
  if (out.help) return out;
  if (ACTIONS.filter(k => out[k]).length !== 1 || !out.goal || !out.state) throw new Error('one action and the original goal/journal are required');
  const external = Boolean(out.reserve || out['recover-reservation'] || out['pay-exact'] || out.activate || out['inspect-activation'] || out.risk);
  const mutation = Boolean(out['recover-reservation'] || out.activate);
  const disclosure = Boolean(out['inspect-activation'] || out.risk);
  const needsRpc = Boolean(out['pay-exact'] || out['recover-payment'] || out.activate || out['inspect-activation'] || out.risk);
  if (external !== Boolean(out.execute)) throw new Error('seller contact and payment require --execute; offline/recovery actions must not use it');
  if (Boolean(out.init) !== Boolean(out['new-journal'])) throw new Error('--new-journal is required only for the first --init');
  if (Boolean(out.init || external) !== Boolean(out['ack-key-backup'])) throw new Error('--ack-key-backup is required only for initialization and external operations');
  if (mutation !== Boolean(out['ack-seller-mutation'])) throw new Error('--ack-seller-mutation is required only for activation POSTs');
  if (disclosure !== Boolean(out['ack-bearer-disclosure'])) throw new Error('--ack-bearer-disclosure is required only for status or paid risk');
  if (Boolean(out.risk) !== Boolean(out['ack-quota-use'])) throw new Error('--ack-quota-use is required only for the paid risk call');
  if (Boolean(out.key) !== Boolean(out['pay-exact'])) throw new Error('--key is required only for payment');
  if (Boolean(out['public-key']) !== Boolean(out['prepare-exact'])) throw new Error('--public-key is required only for exact intent preparation');
  if (Boolean(out.target) !== Boolean(out.risk)) throw new Error('--target is required only for the paid risk call');
  if (out.rpc && !needsRpc) throw new Error('--rpc is not used for this action');
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
  const goal = validateSvalinProGoal(readJson(opts.goal)), state = expand(opts.state);
  if (state === expand(opts.goal) || state === expand(process.env.BOUNCER_FILE_JOURNAL_KEY_FILE) || (opts.key && state === expand(opts.key))) {
    throw new Error('journal must be separate from the goal and all key files');
  }
  if (opts.init) {
    try { fs.lstatSync(state); throw new Error('journal already exists; never replace it'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const journal = openConfiguredFileJournal(state, goal.vault, goal.owner, { requireExisting: !opts.init });
  try {
    if (!journal.encryptionEnabled) throw new Error('encrypted journal is required');
    if (opts.init && (fs.existsSync(state) || journal.list().length)) throw new Error('journal already exists; never replace it');
    const common = { goal, journal };
    let result;
    if (opts.init) result = await prepareSvalinProSession(common);
    else if (opts.reserve) result = await reserveSvalinProOnce({ ...common, execute: true, acknowledgeBackup: true });
    else if (opts['recover-reservation']) result = await recoverSvalinProReservationOnce({ ...common, execute: true, acknowledgeBackup: true, acknowledgeMutation: true });
    else if (opts['prepare-exact']) result = await prepareSvalinProExactFt({ ...common, agentPublicKey: opts['public-key'] });
    else {
      const provider = new PaymentRpcProvider(opts.rpc || process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com');
      if (opts['pay-exact']) result = await paySvalinProExactFtOnce({ ...common, provider, ...makeAccount(goal, provider, opts.key), execute: true, acknowledgeBackup: true });
      else if (opts['recover-payment']) result = await recoverSvalinProPayment({ ...common, provider });
      else if (opts.activate) result = await activateSvalinProOnce({ ...common, provider, execute: true, acknowledgeBackup: true, acknowledgeMutation: true });
      else if (opts['inspect-activation']) result = await inspectSvalinProActivation({ ...common, provider, execute: true, acknowledgeBackup: true, acknowledgeDisclosure: true });
      else result = await requestSvalinProRiskOnce({ ...common, provider, target: opts.target, execute: true, acknowledgeDisclosure: true, acknowledgeUsage: true });
    }
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'BLOCKED') process.exitCode = 2;
  } finally { journal.close(); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`[svalin-pro] ${error.message}`); process.exitCode = 1; });
}
