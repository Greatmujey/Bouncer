/**
 * File journals write synchronously. The shared direct-buyer journal exposes
 * explicit asynchronous operations; its ordinary put() deliberately throws so
 * unsupported payment runners cannot accidentally ignore an unawaited write.
 * A reservation is different from an update: it must fail if the ID exists.
 */
export function reserveJournal(journal, id, entry) {
  if (typeof journal?.reservePending === 'function') return journal.reservePending(id, entry);
  return journal.put(id, entry);
}

export function writeJournal(journal, id, entry) {
  if (typeof journal?.writeDurable === 'function') return journal.writeDurable(id, entry);
  return journal.put(id, entry);
}

export function assertJournalScope(journal, contractId, ownerAccountId) {
  if (typeof journal?.assertScope !== 'function') return;
  const result = journal.assertScope(contractId, ownerAccountId);
  if (result && typeof result.then === 'function') {
    Promise.resolve(result).catch(() => {});
    throw new Error('journal scope check must be synchronous; stop and reconcile');
  }
}
