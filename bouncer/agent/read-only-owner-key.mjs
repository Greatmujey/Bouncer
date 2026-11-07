/** Check only the current public testnet access-key permission at one fresh
 * FINAL block. This proves neither possession of the key nor transaction
 * authorization; the caller must separately verify the wallet signature. */
import nearApi from 'near-api-js';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';

export async function inspectReadOnlyOwnerKey({ owner, publicKey, provider, now = Date.now } = {}) {
  if (!isTestnetAccount(owner) || typeof publicKey !== 'string' || !provider || typeof now !== 'function' ||
      ['viewNodeStatus','viewBlock','viewAccessKey'].some(k => typeof provider[k] !== 'function')) throw Error('owner key check unavailable');
  try {
    const key = nearApi.utils.PublicKey.from(publicKey);
    if (!publicKey.startsWith('ed25519:') || String(key) !== publicKey || key.ed25519Key?.data?.length !== 32) throw Error();
    if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw Error();
    const block = await provider.viewBlock({finality:'final'}), pinned = assertFreshFinalBlock(block,now());
    const view = await provider.viewAccessKey(owner,publicKey,{blockId:pinned.hash});
    if (!view || view.block_hash !== pinned.hash) throw Error();
    return { full_access:view.permission === 'FullAccess', block_hash:pinned.hash,
      scope:'Public testnet key view from a trusted RPC, not a signature or spending approval.' };
  } catch { throw Error('owner key check unavailable'); }
}
