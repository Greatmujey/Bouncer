/** Observe the age of a signed transaction's canonical reference block.
 * This function is read-only: even an old reference does not establish what
 * happened historically and MUST NOT authorize resending the original. The
 * RPC and protocol configuration are trusted observations, not consensus proof.
 */
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

const height = x => Number.isSafeInteger(x) && x >= 0;
export async function observeOriginalReference({ provider, referenceHash, nowMs = Date.now() }) {
  if (!provider || ['viewNodeStatus', 'viewBlock', 'experimental_protocolConfig'].some(k => typeof provider[k] !== 'function') ||
      !isTransactionHash(referenceHash)) throw new Error('read-only original reference required');
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('testnet required');
  const [head, ref] = await Promise.all([
    provider.viewBlock({ finality: 'final' }), provider.viewBlock({ blockId: referenceHash }),
  ]);
  assertFreshFinalBlock(head, nowMs);
  const h = head?.header?.height, r = ref?.header?.height;
  if (!height(h) || !height(r) || h < r || ref?.header?.hash !== referenceHash) throw new Error('reference heights unavailable');
  const [canonical, protocol] = await Promise.all([
    provider.viewBlock({ blockId: r }), provider.experimental_protocolConfig({ blockId: head.header.hash }),
  ]);
  const validity = protocol?.transaction_validity_period;
  if (canonical?.header?.height !== r || canonical.header.hash !== referenceHash || protocol?.chain_id !== 'testnet' ||
      !height(validity) || validity === 0) throw new Error('canonical reference or validity unavailable');
  const age = h - r;
  return { current_final_block: head.header.hash, current_height: h, reference_block: referenceHash,
    reference_height: r, age_blocks: age, observed_validity_period_blocks: validity,
    // Extra headroom avoids asserting expiration at an ambiguous boundary.
    outside_observed_window_with_100_block_margin: age > validity + 100,
    historical_execution_known: false, do_not_resend_original: true,
    scope: 'trusted FINAL RPC and current protocol observation; not a receipt or a consensus proof' };
}
