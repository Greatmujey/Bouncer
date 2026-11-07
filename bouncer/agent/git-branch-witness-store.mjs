/**
 * Optional Git-backed, public CAS store for the experimental prompt witness.
 * It writes ONLY to the current explicitly configured session branch. No force
 * push, branch creation/switching, secret, NEAR transaction or wallet call.
 * A protected branch, remote outage, dirty worktree, non-fast-forward, failed
 * push, unknown acknowledgement, stale local branch or unsafe path blocks use.
 *
 * A remote repository is independent of PostgreSQL but not immutable: a
 * GitHub admin can force-push, delete, edit or restore its history. Operators
 * must independently retain/monitor the latest acknowledged Git head. This
 * does not protect a simultaneous rollback of the DB and remote witness.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { parseWalletWitness, WalletWitnessError } from './git-wallet-prompt-witness.mjs';
import { parseBufferOrderWitness } from './git-buffer-order-witness.mjs';
import { parseNativeOraclePromptWitness } from './git-native-oracle-prompt-witness.mjs';

const failed = () => new WalletWitnessError('GIT_WITNESS_UNAVAILABLE',
  'remote Git witness is dirty, changed, unavailable or uncertain; stop and reconcile, never repeat a wallet prompt');
const hash = owner => crypto.createHash('sha256').update(owner).digest('hex');

const objectId = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

/** `repo`, `branch`, `remote` and `initialHead` are operator configuration,
 * never browser input. `initialHead` is an independently recorded lower bound;
 * it is not proof that a later witness was not erased before startup. */
export function createGitBranchWitnessStore(options = {}) { return createStore(options, 'wallet'); }
/** Separate fixed namespace, but the same checkout lock and branch discipline. */
export function createGitBufferOrderWitnessStore(options = {}) { return createStore(options, 'buffer-order'); }
/** Separate native-oracle namespace; it cannot parse or overwrite FT setup evidence. */
export function createGitNativeOraclePromptWitnessStore(options = {}) { return createStore(options, 'native-oracle'); }
function createStore({ repo, branch, remote = 'origin', initialHead } = {}, kind) {
  const configs = {
    wallet: { parse: parseWalletWitness, folder: 'wallet-prompt-witness-v1', message: 'Record public testnet wallet prompt witness' },
    'buffer-order': { parse: parseBufferOrderWitness, folder: 'buffer-order-witness-v1', message: 'Record public testnet Buffer order witness' },
    'native-oracle': { parse: parseNativeOraclePromptWitness, folder: 'native-oracle-prompt-witness-v1', message: 'Record public testnet native oracle prompt witness' },
  };
  const config = configs[kind]; if (!config) throw failed();
  const { parse } = config;
  const pathFor = owner => `bouncer/evidence/${config.folder}/${hash(owner)}.jsonl`;
  if (typeof repo !== 'string' || !path.isAbsolute(repo) || typeof branch !== 'string' ||
      !/^arena\/[a-z0-9][a-z0-9-]{2,99}$/.test(branch) || remote !== 'origin' || !objectId(initialHead)) throw failed();
  const root = fs.realpathSync(repo);
  // Git replacement objects must not make the witness store read a different
  // history from the independently audited, original commit graph.
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' };
  function git(args) {
    try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 128_000,
      stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv }).trimEnd(); }
    catch { throw failed(); }
  }
  if (git(['rev-parse', '--show-toplevel']) !== root || git(['branch', '--show-current']) !== branch ||
      git(['rev-parse', '--git-dir']) !== '.git') throw failed();
  const lockPath = path.join(root, '.git', 'bouncer-wallet-prompt-witness.lock');
  // Detect a remote history rollback during this process lifetime. A restart
  // still needs the separately retained most recent acknowledged head.
  let lastSeenHead = initialHead;
  function exclusive() {
    let fd; try { fd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
    catch { throw failed(); }
    return () => { try { fs.closeSync(fd); fs.unlinkSync(lockPath); } catch { /* stale lock blocks later work */ } };
  }
  function sync() {
    if (git(['branch', '--show-current']) !== branch || git(['status', '--porcelain', '--untracked-files=normal']) !== '') throw failed();
    git(['fetch', '--no-tags', remote, branch]);
    const local = git(['rev-parse', 'HEAD']), head = git(['rev-parse', `refs/remotes/${remote}/${branch}`]);
    if (!objectId(head) || local !== head) throw failed();
    // Never accept a remote revision before the operator's baseline.
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', initialHead, head], { cwd: root, stdio: 'ignore', timeout: 10_000, env: gitEnv });
      execFileSync('git', ['merge-base', '--is-ancestor', lastSeenHead, head], { cwd: root, stdio: 'ignore', timeout: 10_000, env: gitEnv });
    } catch { throw failed(); }
    lastSeenHead = head;
    return head;
  }
  function remoteText(head, file) {
    const found = git(['ls-tree', '--name-only', head, '--', file]);
    if (!found) return '';
    if (found !== file) throw failed();
    const text = git(['show', `${head}:${file}`]);
    // git() strips trailing LF for command output; canonical JSONL always has one.
    return text ? `${text}\n` : '';
  }
  function ensurePath(file) {
    const parts = file.split('/'); let current = root;
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      try { fs.mkdirSync(current, { mode: 0o755 }); } catch (e) { if (e.code !== 'EEXIST') throw failed(); }
      const st = fs.lstatSync(current);
      if (!st.isDirectory() || st.isSymbolicLink()) throw failed();
    }
    const target = path.join(root, file);
    if (!target.startsWith(`${root}${path.sep}`)) throw failed();
    try { const st = fs.lstatSync(target); if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw failed(); }
    catch (e) { if (e.code !== 'ENOENT') throw failed(); }
    return target;
  }
  return Object.freeze({
    async read(owner) {
      if (!isTestnetAccount(owner)) throw failed();
      const release = exclusive();
      try {
        const head = sync(), text = remoteText(head, pathFor(owner));
        parse(text, owner);
        return { head, text };
      } finally { release(); }
    },
    async append({ owner, expectedHead, expectedText, text } = {}) {
      if (!isTestnetAccount(owner) || !objectId(expectedHead) || typeof expectedText !== 'string' ||
          typeof text !== 'string' || text.length > 32_768 || !text.startsWith(expectedText) || text === expectedText ||
          (text.slice(expectedText.length).match(/\n/g) ?? []).length !== 1) throw failed();
      parse(expectedText, owner); parse(text, owner);
      const release = exclusive();
      try {
        const file = pathFor(owner), head = sync();
        if (head !== expectedHead || remoteText(head, file) !== expectedText) throw failed();
        const target = ensurePath(file);
        let fd;
        try {
          fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o644);
          fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd);
        } finally { if (fd !== undefined) fs.closeSync(fd); }
        git(['add', '--', file]);
        if (git(['diff', '--cached', '--name-only']) !== file) throw failed();
        git(['commit', '-m', config.message, '--', file]);
        const committed = git(['rev-parse', 'HEAD']);
        // Push only the configured current arena branch. A failed/unknown push
        // is never retried here and is never returned as a usable claim.
        git(['push', remote, branch]);
        git(['fetch', '--no-tags', remote, branch]);
        const confirmed = git(['rev-parse', `refs/remotes/${remote}/${branch}`]);
        if (!objectId(committed) || !objectId(confirmed) || confirmed !== committed || remoteText(confirmed, file) !== text) throw failed();
        lastSeenHead = confirmed;
        return { confirmed: true, head: confirmed };
      } finally { release(); }
    },
  });
}
