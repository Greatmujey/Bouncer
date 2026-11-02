/** Read-only diagnostics for the original zero-yocto resource-agent probe.
 * This does NOT authorize a replacement, sign, submit, or prove a receipt is
 * absent. It reports the chain's configured block-validity window and the
 * owner's same-FINAL-block access-key nonce. A trusted RPC can be dishonest;
 * an unavailable hash remains an unknown receipt, never a guard success. */
import { verifySignedTestnetResourceAgentSetup, inspectTestnetResourceAgentSetup } from './testnet-resource-agent-setup.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { pinnedAccessKeyNonce } from '../shared/pinned-access-key-nonce.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

const height = v => Number.isSafeInteger(v) && v >= 0;

export function classifyProbeValidity({ envelope, state, baseBlock, canonicalBlock, finalBlock, protocol, nowMs = Date.now() } = {}) {
  const base = baseBlock?.header, canonical = canonicalBlock?.header, final = finalBlock?.header;
  const nonce = pinnedAccessKeyNonce(state?.owner_key_nonce), signedNonce = pinnedAccessKeyNonce(envelope?.nonce);
  const validity = protocol?.transaction_validity_period;
  if (envelope?.stage !== 'guard-probe' || !isTransactionHash(envelope.tx_hash) || !isTransactionHash(envelope.block_hash) ||
      !height(base?.height) || base.hash !== envelope.block_hash || canonical?.hash !== base.hash || canonical?.height !== base.height ||
      !height(final?.height) || !isTransactionHash(final?.hash) || final.hash !== state?.block_hash || final.height < base.height ||
      protocol?.chain_id !== 'testnet' || !height(validity) || validity === 0 ||
      state?.network !== 'testnet' || state.owner !== envelope.owner || state.public_key !== envelope.owner_public_key ||
      nonce === null || signedNonce === null || signedNonce === 0n || !Number.isSafeInteger(nowMs)) {
    throw new Error('invalid original probe expiry inputs');
  }
  assertFreshFinalBlock({ header: final }, nowMs);
  // nearcore checks prev_block_height > base_height + validity_period; use a
  // strict inequality, and retain margin if the RPC reports skipped heights.
  const elapsed = final.height - base.height;
  const expired = elapsed > validity;
  return {
    version: 1, network: 'testnet', original_hash: envelope.tx_hash,
    original_block_hash: envelope.block_hash, original_block_height: base.height,
    canonical_at_original_height: true, final_block_hash: final.hash, final_block_height: final.height,
    final_block_timestamp_nanosec: String(final.timestamp_nanosec), validity_period_blocks: validity,
    elapsed_blocks: elapsed, validity_window_passed_at_final: expired,
    owner_nonce_at_final: nonce.toString(), original_nonce: signedNonce.toString(),
    owner_nonce_unchanged_since_signing: nonce === signedNonce - 1n,
    policy: state.policy, agent_granted: state.agent_granted,
    vault_actual_circle_atoms: state.vault_actual_circle_atoms, vault_tracked_circle_atoms: state.vault_tracked_circle_atoms,
    receipt_status: 'UNKNOWN_UNLESS_SEPARATELY_VERIFIED', guard_failure_verified: false,
    signed: false, sent: false, seller_contacted: false, do_not_resend_original: true,
    scope: 'trusted-RPC FINAL diagnostics only; not receipt proof, not a retry authorization or independent guard verification',
  };
}

export async function inspectOriginalProbeValidity({ ownerPlan, agentPlan, envelope, expectedCircleCodeHash, provider, now = Date.now } = {}) {
  verifySignedTestnetResourceAgentSetup(envelope, ownerPlan, agentPlan);
  if (envelope.stage !== 'guard-probe' || !provider || typeof provider.viewBlock !== 'function' ||
      typeof provider.experimental_protocolConfig !== 'function') throw new Error('read-only original probe required');
  const state = await inspectTestnetResourceAgentSetup({ ownerPlan, agentPlan, provider, now });
  if (state.circle_code_hash !== expectedCircleCodeHash) throw new Error('Circle funding anchor differs');
  const [baseBlock, finalBlock, protocol] = await Promise.all([
    provider.viewBlock({ blockId: envelope.block_hash }), provider.viewBlock({ blockId: state.block_hash }),
    provider.experimental_protocolConfig({ blockId: state.block_hash }),
  ]);
  if (!height(baseBlock?.header?.height)) throw new Error('original block height unavailable');
  const canonicalBlock = await provider.viewBlock({ blockId: baseBlock.header.height });
  return classifyProbeValidity({ envelope, state, baseBlock, canonicalBlock, finalBlock, protocol, nowMs: now() });
}
