/**
 * Experimental anti-rollback adapter for a public CAS witness store.
 *
 * A *separate* operator-controlled, durable CAS checkpoint must already retain
 * the latest trusted Git head and a unique revision. Its deployment, access
 * controls and own rollback protection are external requirements: this
 * adapter cannot make an untrusted database, process or operator independent.
 * `audit` must verify Git ancestry AND append-only continuity of *all*
 * protected witness files from the checkpoint to the candidate head. Merely
 * checking that a commit is a descendant is insufficient: a later commit
 * could otherwise delete a previously witnessed claim.
 *
 * No prompt should be returned until the underlying Git append, external
 * checkpoint CAS and both read-backs succeed. Any unknown result is a stop;
 * never repeat a claimed wallet operation. No wallet/RPC/payment calls occur.
 */
import { WalletWitnessError } from './git-wallet-prompt-witness.mjs';

const fail = () => new WalletWitnessError('WITNESS_ANCHOR_UNAVAILABLE',
  'independent witness checkpoint unavailable, stale, changed or uncertain; stop and reconcile, never repeat a prompt');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const fields = (value, names) => object(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const head = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const revision = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
function checkpoint(value) {
  if (!fields(value, ['head', 'revision']) || !head(value.head) || !revision(value.revision)) throw fail();
  return { head: value.head, revision: value.revision };
}
const equal = (a, b) => a.head === b.head && a.revision === b.revision;

/**
 * `store` is the existing public Git CAS witness store; `anchor` supplies
 * read() -> {head, revision} and compareAndSet({expected, nextHead}) ->
 * {confirmed: true, head, revision}; `audit(fromHead, toHead)` returns true
 * only if ALL protected witness histories are append-only and fromHead is an
 * ancestor of toHead. Provision the anchor out-of-band with a verified baseline
 * before allowing any prompt. This module never initializes an empty anchor.
 */
export function createAnchoredWitnessStore({ store, anchor, audit } = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.append !== 'function' ||
      !anchor || typeof anchor.read !== 'function' || typeof anchor.compareAndSet !== 'function' || typeof audit !== 'function') throw fail();
  async function readAnchor() { try { return checkpoint(await anchor.read()); } catch { throw fail(); } }
  async function check(from, to) { try { if (!head(to) || await audit(from, to) !== true) throw Error(); } catch { throw fail(); } }
  async function read(owner) {
    const prior = await readAnchor();
    let snapshot;
    try { snapshot = await store.read(owner); } catch { throw fail(); }
    if (!object(snapshot) || !head(snapshot.head) || typeof snapshot.text !== 'string') throw fail();
    await check(prior.head, snapshot.head);
    if (!equal(prior, await readAnchor())) throw fail();
    return snapshot;
  }
  return Object.freeze({
    read,
    async append(request = {}) {
      if (!fields(request, ['owner', 'expectedHead', 'expectedText', 'text']) || typeof request.owner !== 'string' ||
          !head(request.expectedHead) || typeof request.expectedText !== 'string' || typeof request.text !== 'string' ||
          request.text.length > 32_768 || !request.text.startsWith(request.expectedText) || request.text === request.expectedText ||
          (request.text.slice(request.expectedText.length).match(/\n/g) ?? []).length !== 1) throw fail();
      const prior = await readAnchor();
      let current;
      try { current = await store.read(request.owner); } catch { throw fail(); }
      if (!object(current) || current.head !== request.expectedHead || current.text !== request.expectedText) throw fail();
      await check(prior.head, current.head);
      if (!equal(prior, await readAnchor())) throw fail();
      let result;
      try { result = await store.append(request); } catch { throw fail(); }
      if (!object(result) || result.confirmed !== true || !head(result.head) || result.head === current.head) throw fail();
      await check(current.head, result.head);
      await check(prior.head, result.head);
      let reread;
      try { reread = await store.read(request.owner); } catch { throw fail(); }
      if (!object(reread) || reread.head !== result.head || reread.text !== request.text) throw fail();
      let saved;
      try { saved = await anchor.compareAndSet({ expected: prior, nextHead: result.head }); } catch { throw fail(); }
      if (!fields(saved, ['confirmed', 'head', 'revision']) || saved.confirmed !== true || saved.head !== result.head ||
          !revision(saved.revision) || saved.revision === prior.revision) throw fail();
      const after = await readAnchor();
      if (after.head !== saved.head || after.revision !== saved.revision) throw fail();
      try { reread = await store.read(request.owner); } catch { throw fail(); }
      if (!object(reread) || reread.head !== saved.head || reread.text !== request.text || !equal(after, await readAnchor())) throw fail();
      return { confirmed: true, head: saved.head };
    },
  });
}
