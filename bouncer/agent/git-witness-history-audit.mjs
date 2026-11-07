/**
 * Read-only Git history audit for the externally anchored witness adapter.
 * Every changed public witness file must remain canonical and retain the exact
 * previously checkpointed bytes as a prefix. This checks every owner and all
 * three known witness namespaces, not just the owner making the current call.
 * A Git descendant that deletes or rewrites a prior claim is therefore unsafe.
 *
 * The trusted starting commit must already include all known prior witness
 * records and be stored by a genuinely independent, non-rollbackable monitor;
 * this code cannot establish that the initial checkpoint is complete/latest.
 * Git and the independent checkpoint operator are still trust assumptions.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseWalletWitness } from './git-wallet-prompt-witness.mjs';
import { parseNativeOraclePromptWitness } from './git-native-oracle-prompt-witness.mjs';
import { parseBufferOrderWitness } from './git-buffer-order-witness.mjs';

const rootPath = 'bouncer/evidence';
const kinds = Object.freeze({
  'wallet-prompt-witness-v1': parseWalletWitness,
  'native-oracle-prompt-witness-v1': parseNativeOraclePromptWitness,
  'buffer-order-witness-v1': parseBufferOrderWitness,
});
const folders = Object.keys(kinds).map(name => `${rootPath}/${name}`);
const objectId = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const error = () => new Error('Git witness history is unavailable, rewritten, malformed or not append-only');
const hexOwner = owner => crypto.createHash('sha256').update(owner).digest('hex');

/** `repo` is an operator-selected local Git checkout, not browser input. Git
 * objects must already be fetched; this function never changes or pushes them. */
export function createGitWitnessHistoryAudit({ repo } = {}) {
  if (typeof repo !== 'string' || !path.isAbsolute(repo)) throw error();
  let root;
  try { root = fs.realpathSync(repo); } catch { throw error(); }
  function git(args, maxBuffer = 1_048_576) {
    try { return execFileSync('git', args, { cwd: root, timeout: 30_000, maxBuffer,
      stdio: ['ignore','pipe','pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' } }); }
    catch { throw error(); }
  }
  try { if (git(['rev-parse','--show-toplevel']).toString('utf8').trimEnd() !== root) throw Error(); }
  catch { throw error(); }
  function blob(commit, file) {
    const tree = git(['ls-tree','-z',commit,'--',file], 4096);
    if (!tree.length) return '';
    const output = tree.toString('utf8'), match = /^100644 blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(output);
    if (!match || match[2] !== file) throw error();
    const size = git(['cat-file','-s',match[1]], 64).toString('ascii').trim();
    if (!/^(0|[1-9][0-9]*)$/.test(size) || Number(size) > 32_768) throw error();
    const bytes = git(['cat-file','blob',match[1]], 32_769);
    if (bytes.length !== Number(size)) throw error();
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw error(); }
  }
  function validate(file, text) {
    if (!text) throw error();
    const m = /^bouncer\/evidence\/(wallet-prompt-witness-v1|native-oracle-prompt-witness-v1|buffer-order-witness-v1)\/([a-f0-9]{64})\.jsonl$/.exec(file);
    if (!m) throw error();
    let first, state;
    try {
      first = JSON.parse(text.slice(0, text.indexOf('\n')));
      const owner = m[1] === 'buffer-order-witness-v1' ? first?.identity?.owner : first?.owner;
      if (typeof owner !== 'string' || hexOwner(owner) !== m[2]) throw Error();
      state = kinds[m[1]](text, owner);
      if (!state || state.identity?.owner !== owner) throw Error();
    } catch { throw error(); }
  }
  return async function audit(fromHead, toHead) {
    if (!objectId(fromHead) || !objectId(toHead)) throw error();
    try { execFileSync('git', ['merge-base','--is-ancestor',fromHead,toHead], { cwd: root, timeout: 10_000,
      stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' } }); }
    catch { throw error(); }
    const bytes = git(['diff','--no-ext-diff','--no-textconv','--no-renames','--name-only','-z',fromHead,toHead,'--',...folders]);
    const parts = bytes.length ? bytes.toString('utf8').split('\0') : [];
    if (parts.length && parts.pop() !== '') throw error();
    if (parts.length > 512 || new Set(parts).size !== parts.length) throw error();
    for (const file of parts) {
      const before = blob(fromHead, file), after = blob(toHead, file);
      if (before) validate(file, before);
      validate(file, after);
      if (!after.startsWith(before)) throw error();
    }
    return true;
  };
}
