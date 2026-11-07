import test from 'node:test';
import assert from 'node:assert/strict';
import { withExclusiveJournalOperation } from '../agent/journal-operation.mjs';

test('private journal scope permits only the owning operation to call nested helpers', async () => {
  const journal = {}, other = {}; let saved, nestedCalls = 0;
  await withExclusiveJournalOperation(journal, async scope => {
    saved = scope;
    assert.equal(Object.isFrozen(scope), true);
    await assert.rejects(withExclusiveJournalOperation(journal, () => {}, {}), /invalid or expired/);
    await assert.rejects(withExclusiveJournalOperation(other, () => {}, scope), /invalid or expired/);
    await assert.rejects(withExclusiveJournalOperation(journal, () => {}), /another payment operation/);
    await withExclusiveJournalOperation(other, () => { nestedCalls++; });
    await withExclusiveJournalOperation(journal, () => { nestedCalls++; }, scope);
    assert.equal(nestedCalls, 2);
  });
  await assert.rejects(withExclusiveJournalOperation(journal, () => {}, saved), /invalid or expired/);
  await withExclusiveJournalOperation(journal, () => { nestedCalls++; });
  assert.equal(nestedCalls, 3);
});

test('scope is released on failure; unscoped callers cannot reuse it after a new operation begins', async () => {
  const journal = {}; let expired;
  await assert.rejects(withExclusiveJournalOperation(journal, scope => { expired = scope; throw Error('synthetic failure'); }), /synthetic failure/);
  await withExclusiveJournalOperation(journal, async current => {
    assert.notEqual(current, expired);
    await assert.rejects(withExclusiveJournalOperation(journal, () => {}, expired), /invalid or expired/);
    await withExclusiveJournalOperation(journal, () => {}, current);
  });
  await assert.rejects(withExclusiveJournalOperation(null, () => {}, {}), /invalid journal operation scope/);
});

test('shared-buyer local contention preserves OWNER_BUSY without claiming a database lock', async () => {
  const journal = { sharedDirectV3: true };
  await withExclusiveJournalOperation(journal, async () => {
    await assert.rejects(withExclusiveJournalOperation(journal, () => {}), error =>
      error.code === 'OWNER_BUSY' && /another payment operation/.test(error.message));
  });
});
