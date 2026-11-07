/**
 * Operator-only, read-only baseline inspection. Unlike a net diff, this
 * walks every parent edge in the reachable history and rejects a delete or
 * rewrite even if the final tree later restores the old bytes. It neither
 * discovers abandoned/forked repositories nor proves a Git/DB administrator
 * has not rolled back an independent checkpoint. It authorizes no prompt.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGitWitnessHistoryAudit } from './git-witness-history-audit.mjs';

const MAX_COMMITS = 10_000;
const folders = ['wallet-prompt-witness-v1','native-oracle-prompt-witness-v1','buffer-order-witness-v1']
  .map(name => `bouncer/evidence/${name}`);
const hash = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const fail = () => new Error('complete reachable Git witness history unavailable or unsafe');

/** A local, unshallowed checkout and explicit commit are operator inputs.
 * Results do not establish the remote head or histories outside this commit. */
export async function auditFullGitWitnessHistory({ repo, head } = {}) {
  if (typeof repo !== 'string' || !path.isAbsolute(repo) || !hash(head)) throw fail();
  let root; try { root = fs.realpathSync(repo); } catch { throw fail(); }
  const git = (args, maxBuffer = 2_000_000) => {
    try { return execFileSync('git', args, { cwd: root, timeout: 30_000, maxBuffer,
      stdio: ['ignore','pipe','pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT:'0', GIT_NO_REPLACE_OBJECTS:'1' } }).toString('utf8'); }
    catch { throw fail(); }
  };
  if (git(['rev-parse','--show-toplevel']).trimEnd() !== root || git(['rev-parse','--is-shallow-repository']).trimEnd() !== 'false' ||
      git(['cat-file','-t',head]).trimEnd() !== 'commit') throw fail();
  // Git grafts can hide ancestry despite an otherwise unshallowed checkout.
  const graft = git(['rev-parse','--git-path','info/grafts']).trimEnd();
  try { if (fs.statSync(path.resolve(root,graft)).size) throw fail(); } catch (e) { if (e?.code !== 'ENOENT') throw fail(); }
  const lines = git(['rev-list','--topo-order','--reverse',`--max-count=${MAX_COMMITS + 1}`,'--parents',head]).trimEnd().split('\n');
  if (!lines.length || lines.length > MAX_COMMITS) throw fail();
  const visited = new Set(), roots = [], edges = [];
  for (const line of lines) {
    const [commit,...parents] = line.split(' ');
    if (!hash(commit) || parents.length > 16 || parents.some(p => !hash(p) || !visited.has(p)) || visited.has(commit)) throw fail();
    if (!parents.length) roots.push(commit);
    for (const parent of parents) edges.push([parent,commit]);
    visited.add(commit);
  }
  if (!roots.length || !visited.has(head)) throw fail();
  // A witness already present at a root cannot be proven append-only from
  // prior history. Require separate manual reconciliation instead of seeding.
  for (const commit of roots) if (git(['ls-tree','-r','-z',commit,'--',...folders]).length) throw fail();
  const audit = createGitWitnessHistoryAudit({ repo: root });
  for (const [parent,commit] of edges) await audit(parent,commit);
  return { head, roots, commits: visited.size, parent_edges: edges.length, reachable_history_only: true,
    branches_or_repositories_outside_head_checked: false, independently_retained_latest_head: false,
    wallet_or_transaction_authorized: false };
}
