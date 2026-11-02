/** Read-only, point-in-time owner profile for the narrow Svalin trial. */
import { isTestnetAccount } from '../shared/account-id.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { hasPlainOwnerProfileAt } from '../shared/plain-owner-profile.mjs';

export async function readSvalinPlainOwnerAtFinal({ provider, owner, now = Date.now }) {
  if (!isTestnetAccount(owner) || typeof now !== 'function' || !provider ||
      ['viewNodeStatus', 'viewBlock', 'viewAccount'].some(k => typeof provider[k] !== 'function')) {
    throw new Error('testnet owner account view is required');
  }
  try {
    if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('wrong network');
    const block = await provider.viewBlock({ finality: 'final' });
    assertFreshFinalBlock(block, now());
    const account = await provider.viewAccount(owner, { blockId: block.header.hash });
    if (!hasPlainOwnerProfileAt(account, block.header.hash)) throw new Error('owner profile differs');
    const snapshot = { header: { hash: block.header.hash, timestamp_nanosec: block.header.timestamp_nanosec } };
    assertFreshFinalBlock(snapshot, now());
    return snapshot;
  } catch {
    // RPC exceptions can contain untrusted data. A passing view still relies on
    // that RPC and cannot exclude later code changes or already queued calls.
    throw new Error('fresh pinned testnet owner without local or global contract code is required');
  }
}
