/**
 * Native OutLayer uses a local synchronous original-hash journal. A new signed
 * hash must be recorded and read back before the only submission. This is NOT
 * proof of fsync, distributed coordination, or protection from rollback;
 * production callers still require the original FileJournal and an
 * independently retained checkpoint. Asynchronous writers are not compatible.
 */
import { isDeepStrictEqual } from 'node:util';

const unavailable = () => new Error('native original journal is uncertain; stop and reconcile, never resend automatically');
function noPromise(value) {
  if (value && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function') {
    Promise.resolve(value).catch(() => {}); // prevent a late rejection from becoming unhandled
    throw unavailable();
  }
  return value;
}
function withoutId(value, id) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.hasOwn(value,'id') && value.id !== id)) throw unavailable();
  const result = { ...value }; delete result.id; return result;
}

/** Read synchronously and reject malformed/ambiguous or asynchronous entries.
 * Suppress late promise rejections while failing before a signature or send. */
export function readNativeJournal(journal, id) {
  if (!journal || typeof journal.get !== 'function' || typeof id !== 'string' || !id) throw unavailable();
  const entry = noPromise(journal.get(id));
  if (entry !== undefined) withoutId(entry, id);
  return entry;
}

/** `expected` is null only for a new reservation; otherwise it is the exact
 * previously read record. No asynchronous gap exists between the final check
 * and put, but callers must hold the participating journal operation lock. */
export function writeConfirmedNativeJournal(journal, id, entry, expected) {
  if (!journal || typeof journal.get !== 'function' || typeof journal.put !== 'function' || typeof id !== 'string' || !id) throw unavailable();
  const before = readNativeJournal(journal, id);
  if (expected === null) { if (before !== undefined) throw unavailable(); }
  else if (!isDeepStrictEqual(withoutId(before,id),withoutId(expected,id))) throw unavailable();
  noPromise(journal.put(id,entry));
  const after = readNativeJournal(journal, id);
  if (!isDeepStrictEqual(withoutId(after,id),withoutId(entry,id))) throw unavailable();
}
