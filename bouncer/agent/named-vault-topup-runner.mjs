/** One fixed testnet vault topup and read-only recovery of its original hash.
 * Signed bytes are public bearer data; a third party may relay them before a
 * preflight. A trusted RPC and a durable one-shot fence remain assumptions. */
import { inspectNamedVaultTopup, assertNamedVaultTopupBefore, verifySignedNamedVaultTopup,
  TOPUP_SOURCE, TOPUP_VAULT, TOPUP_ATOMS, TOPUP_SOURCE_BEFORE, TOPUP_VAULT_BEFORE } from './named-vault-topup.mjs';
import { validateNamedRecoveryPlan } from './named-testnet-recovery.mjs';
import { verifyCircleVaultReceiptGraph } from './keyless-vault-circle-runner.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { pinnedAccessKeyNonce } from '../shared/pinned-access-key-nonce.mjs';

const MAX_REFERENCE_BLOCK_AGE = 3600; // conservative additional bound, not NEAR's validity period

/** Verify the signature and exact action before reusing the shared receipt
 * graph checker. This establishes transfer/acceptance, never seller delivery. */
export function verifyNamedVaultTopupReceipt(result, envelope, rawPlan) {
  const plan = validateNamedRecoveryPlan(rawPlan), signed = verifySignedNamedVaultTopup(envelope, plan);
  return verifyCircleVaultReceiptGraph(result, { ...envelope, kind: 'fund' },
    { account_id: TOPUP_SOURCE, public_key: plan.public_key }, signed.transaction.actions[0]);
}

/** Verify the original hash's complete Circle/vault receipt graph and fresh
 * actual + tracked balances. A missing receipt is unknown, not a retry signal. */
export async function reconcileNamedVaultTopup({ plan: raw, envelope, provider, now = Date.now }) {
  const plan = validateNamedRecoveryPlan(raw); verifySignedNamedVaultTopup(envelope, plan);
  if (!provider || typeof provider.txStatusReceipts !== 'function') throw new Error('original-hash receipt lookup required');
  const receipt = verifyNamedVaultTopupReceipt(await provider.txStatusReceipts(envelope.tx_hash, TOPUP_SOURCE, 'FINAL'), envelope, plan);
  const state = await inspectNamedVaultTopup({ plan, provider, now });
  const nonce = pinnedAccessKeyNonce(state.source_key_nonce);
  if (nonce === null || nonce < BigInt(envelope.nonce) ||
      state.source_circle_atoms !== (BigInt(TOPUP_SOURCE_BEFORE) - BigInt(TOPUP_ATOMS)).toString() ||
      state.vault_actual_circle_atoms !== (BigInt(TOPUP_VAULT_BEFORE) + BigInt(TOPUP_ATOMS)).toString() ||
      state.vault_tracked_circle_atoms !== state.vault_actual_circle_atoms) {
    throw new Error('post-topup named account or tracked/actual vault balances differ; reconcile the original, never resend');
  }
  return { status: 'NAMED_TESTNET_TOPUP_FINAL_VERIFIED', network: 'testnet', source: TOPUP_SOURCE, vault: TOPUP_VAULT,
    amount_atoms: TOPUP_ATOMS, tx_hash: envelope.tx_hash, receipt, state, seller_contacted: false, do_not_resend: true,
    scope: 'original FINAL receipt graph and fresh trusted-RPC balances only; no seller payment or independent fulfillment' };
}

/** The caller must confirm an original-hash artifact fence before the single
 * broadcast; no later code path resubmits or prepares a replacement. */
export async function broadcastNamedVaultTopupOnce({ plan: raw, envelope, provider, persistAttempt, now = Date.now }) {
  const plan = validateNamedRecoveryPlan(raw), signed = verifySignedNamedVaultTopup(envelope, plan);
  if (!provider || provider.enforcesSetupBeforeSubmitGuard !== true ||
      ['viewNodeStatus', 'viewBlock', 'query', 'callFunctionRaw', 'experimental_protocolConfig', 'gasPrice',
        'sendTransactionOnce', 'txStatusReceipts'].some(k => typeof provider[k] !== 'function') || typeof persistAttempt !== 'function') {
    throw new Error('guarded one-shot testnet provider and original-hash fence required');
  }
  const before = await inspectNamedVaultTopup({ plan, provider, now });
  assertNamedVaultTopupBefore(before, plan, now());
  if (BigInt(before.source_key_nonce) !== BigInt(envelope.nonce) - 1n) {
    throw new Error('source key nonce differs; inspect the original, do not resend');
  }
  const [base, canonical] = await Promise.all([
    provider.viewBlock({ blockId: envelope.block_hash }), provider.viewBlock({ blockId: envelope.block_height }),
  ]);
  if (base?.header?.hash !== envelope.block_hash || base.header.height !== envelope.block_height ||
      canonical?.header?.hash !== envelope.block_hash || canonical.header.height !== envelope.block_height ||
      before.block_height < envelope.block_height || before.block_height - envelope.block_height >= MAX_REFERENCE_BLOCK_AGE ||
      before.block_height - envelope.block_height >= before.validity_period_blocks) {
    throw new Error('original reference block is not recent and canonical; inspect the original, do not resend');
  }
  if (await persistAttempt({ tx_hash: envelope.tx_hash, source: TOPUP_SOURCE, vault: TOPUP_VAULT,
      amount_atoms: TOPUP_ATOMS, preflight_block_hash: before.block_hash }) !== true) {
    throw new Error('original topup fence was not established; no broadcast');
  }
  try {
    const sent = await provider.sendTransactionOnce(signed, 'FINAL', { beforeSubmit: () => {
      verifySignedNamedVaultTopup(envelope, plan);
      assertFreshFinalBlock({ header: { hash: before.block_hash, timestamp_nanosec: before.block_timestamp_nanosec } }, now());
    } });
    if (sent?.transaction_outcome?.id !== envelope.tx_hash || sent.final_execution_status !== 'FINAL') {
      throw new Error('submission did not identify the original FINAL hash');
    }
    return await reconcileNamedVaultTopup({ plan, envelope, provider, now });
  } catch {
    throw new Error(`original topup ${envelope.tx_hash} is unconfirmed; retain the journal and reconcile, never resend`);
  }
}
