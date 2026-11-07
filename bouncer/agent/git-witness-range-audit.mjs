/**
 * Audit every newly reachable Git parent edge after a trusted checkpoint.
 *
 * Comparing only the trees at two heads misses a witness deleted and later
 * restored between them. This range walk also inspects side-parent histories
 * introduced by merges. It is read-only and bounded; an incomplete, shallow,
 * grafted, unrelated-root or excessively long history is a stop.
 *
 * The checkpoint itself must already be a separately verified, independently
 * retained complete baseline. This does not discover deleted refs, other
 * repositories or a rollback/forgery of the independent checkpoint.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGitWitnessHistoryAudit } from './git-witness-history-audit.mjs';

const MAX_COMMITS = 10_000, MAX_EDGES = 20_000, MAX_PARENTS = 16;
const hash = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const fail = () => new Error('Git witness range is unavailable, incomplete or unsafe');

export function createGitWitnessRangeAudit({ repo } = {}) {
  if (typeof repo !== 'string' || !path.isAbsolute(repo)) throw fail();
  let root;
  try { root = fs.realpathSync(repo); } catch { throw fail(); }
  const git = (args, maxBuffer = 2_000_000) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer,
        stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0',
          GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' } }).trimEnd();
    } catch { throw fail(); }
  };
  const auditEdge = createGitWitnessHistoryAudit({ repo: root });
  return async function auditRange(fromHead, toHead) {
    if (!hash(fromHead) || !hash(toHead)) throw fail();
    if (git(['rev-parse', '--show-toplevel']) !== root || git(['rev-parse', '--is-shallow-repository']) !== 'false') throw fail();
    // Grafts can hide or replace ancestry even in a non-shallow checkout.
    const graft = git(['rev-parse', '--git-path', 'info/grafts']);
    try { if (fs.statSync(path.resolve(root, graft)).size) throw fail(); }
    catch (error) { if (error?.code !== 'ENOENT') throw fail(); }
    // This validates both commits and ancestry even for an empty range.
    await auditEdge(fromHead, toHead);
    const output = git(['rev-list', '--topo-order', '--reverse', `--max-count=${MAX_COMMITS + 1}`,
      '--parents', toHead, `^${fromHead}`]);
    const lines = output ? output.split('\n') : [];
    if (lines.length > MAX_COMMITS) throw fail();
    const seen = new Set(); let edgeCount = 0;
    for (const line of lines) {
      const [commit, ...parents] = line.split(' ');
      if (!hash(commit) || seen.has(commit) || !parents.length || parents.length > MAX_PARENTS ||
          parents.some(parent => !hash(parent)) || new Set(parents).size !== parents.length) throw fail();
      seen.add(commit);
      edgeCount += parents.length;
      if (edgeCount > MAX_EDGES) throw fail();
      // Include every merge parent, even one forked before the checkpoint.
      // A side branch's delete-and-restore is as unsafe as a mainline one.
      for (const parent of parents) await auditEdge(parent, commit);
    }
    return true;
  };
}
