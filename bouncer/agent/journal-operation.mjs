/**
 * In-process exclusion for participating single-host payment protocols sharing
 * one journal object. The FileJournal's filesystem lock covers other compliant
 * processes opening that same file. Neither layer detects a different journal,
 * rollback, bypassing callers, an untrusted filesystem or another owner.
 */
const active = new WeakMap();

/**
 * A coordinating operation may pass its private, short-lived scope to nested
 * journal helpers. Unscoped/concurrent callers still fail, and a forged,
 * expired or different-journal scope is rejected. Await all nested calls before
 * the owning operation returns, and never pass the scope to an untrusted
 * signer, provider, callback or external process.
 */
export async function withExclusiveJournalOperation(journal, operation, scope) {
  if (typeof operation !== 'function') throw new Error('invalid journal operation');
  if (journal === null || journal === undefined) {
    if (scope !== undefined) throw new Error('invalid journal operation scope');
    return operation();
  }
  if (typeof journal !== 'object') throw new Error('invalid payment journal');
  if (scope !== undefined) {
    if (!scope || active.get(journal) !== scope) throw new Error('invalid or expired journal operation scope');
    return operation(scope);
  }
  if (active.has(journal)) throw new Error('another payment operation is already running on this journal');
  const ownedScope = Object.freeze(Object.create(null));
  active.set(journal, ownedScope);
  try { return await operation(ownedScope); } finally { active.delete(journal); }
}
