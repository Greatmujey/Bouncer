/**
 * In-process exclusion for participating single-host payment protocols sharing
 * one journal object. The FileJournal's filesystem lock covers other compliant
 * processes opening that same file. Neither layer detects a different journal,
 * rollback, bypassing callers, an untrusted filesystem or another owner.
 */
const active = new WeakSet();

export async function withExclusiveJournalOperation(journal, operation) {
  if (typeof operation !== 'function') throw new Error('invalid journal operation');
  if (journal === null || journal === undefined) return operation();
  if (typeof journal !== 'object') throw new Error('invalid payment journal');
  if (active.has(journal)) throw new Error('another payment operation is already running on this journal');
  active.add(journal);
  try { return await operation(); } finally { active.delete(journal); }
}
