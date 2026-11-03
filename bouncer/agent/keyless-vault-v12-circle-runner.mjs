/** V12 Circle testnet vault setup: verify the exact signed original, require
 * a fresh pinned state and durable fence, send at most once, and reconcile by
 * original hash. Circle token and V12 code hashes are pinned; code can still
 * change after a view and a published signed transaction remains a bearer. */
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { inspectVaultCircleFunding } from './keyless-vault-v12-circle-readiness.mjs';
import { verifySignedVaultCircle } from './keyless-vault-v12-circle.mjs';
import { verifyCircleVaultReceiptGraph } from './keyless-vault-circle-runner.mjs';
import { assertV12OriginalReference } from './keyless-vault-v12-runner.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';

export function verifyVaultCircleReceipt(result, envelope, rawPlan) {
  const plan = validateOwnerBootstrapPlan(rawPlan), signed = verifySignedVaultCircle(envelope, plan);
  return verifyCircleVaultReceiptGraph(result, envelope, plan, signed.transaction.actions[0]);
}

/** A single original receipt plus fresh actual and tracked balances, fetched
 * read-only. A trusted RPC is required; this is not provider delivery. */
export async function reconcileVaultCircle({ plan: raw, envelope, provider, now = Date.now } = {}) {
  const plan = validateOwnerBootstrapPlan(raw); verifySignedVaultCircle(envelope, plan);
  if (!provider || typeof provider.txStatusReceipts !== 'function') throw new Error('read-only original-hash receipt lookup required');
  const receipt = verifyVaultCircleReceipt(await provider.txStatusReceipts(envelope.tx_hash, plan.account_id, 'FINAL'), envelope, plan);
  const state = await inspectVaultCircleFunding({ plan, provider, now });
  if (BigInt(state.owner_key_nonce) < BigInt(envelope.nonce) || state.circle_code_hash !== envelope.expected_circle_code_hash ||
      state.vault_code_hash !== envelope.expected_vault_code_hash || state.vault_circle_registration !== 'REGISTERED_AT_VIEW') {
    throw new Error('post-action Circle/keyless V12 state differs');
  }
  if (envelope.kind === 'register') {
    if (state.owner_circle_atoms !== envelope.expected_owner_atoms || state.vault_actual_circle_atoms !== '0' || state.vault_tracked_circle_atoms !== '0') {
      throw new Error('post-registration owner or vault balances differ');
    }
  } else if (state.owner_circle_atoms !== (BigInt(envelope.expected_owner_atoms) - BigInt(envelope.amount_atoms)).toString() ||
      state.vault_actual_circle_atoms !== envelope.amount_atoms || state.vault_tracked_circle_atoms !== envelope.amount_atoms) {
    throw new Error('post-funding owner, actual vault and tracked vault balances differ');
  }
  return { status: envelope.kind === 'register' ? 'VAULT_CIRCLE_REGISTERED_AT_FINAL' : 'VAULT_FUNDED_CIRCLE_TEST_USDC_AT_FINAL',
    kind: envelope.kind, network: 'testnet', owner: plan.account_id, vault: envelope.vault, tx_hash: envelope.tx_hash,
    receipt, state, circle_funding_verified: envelope.kind === 'fund', seller_contacted: false, do_not_resend: true,
    scope: 'matching original FINAL receipt graph plus fresh trusted-RPC V12/Circle balances; not an audit or provider delivery' };
}

export async function broadcastVaultCircleOnce({ plan: raw, envelope, provider, persistAttempt, now = Date.now } = {}) {
  const plan = validateOwnerBootstrapPlan(raw), signed = verifySignedVaultCircle(envelope, plan);
  if (!provider || provider.enforcesSetupBeforeSubmitGuard !== true ||
      ['viewNodeStatus','viewBlock','query','callFunctionRaw','experimental_protocolConfig','sendTransactionOnce','txStatusReceipts']
        .some(k => typeof provider[k] !== 'function') || typeof persistAttempt !== 'function') throw new Error('guarded one-shot provider and fence required');
  const before = await inspectVaultCircleFunding({ plan, provider, now });
  if ((envelope.kind === 'register' ? !before.register_eligible : !before.fund_eligible) ||
      before.owner_key_nonce !== (BigInt(envelope.nonce) - 1n).toString() || before.circle_code_hash !== envelope.expected_circle_code_hash ||
      before.vault_code_hash !== envelope.expected_vault_code_hash || before.circle_storage_min_yocto !== envelope.storage_min_yocto ||
      before.owner_circle_atoms !== envelope.expected_owner_atoms || before.vault_actual_circle_atoms !== envelope.expected_vault_atoms ||
      before.vault_tracked_circle_atoms !== envelope.expected_tracked_atoms || before.vault_circle_registration !== envelope.expected_registration) {
    throw new Error(`original vault ${envelope.kind} ${envelope.tx_hash} no longer matches fresh preflight; inspect it, do not resend`);
  }
  await assertV12OriginalReference({ provider, currentBlockHash: before.block_hash, envelope });
  if (await persistAttempt({ kind: envelope.kind, tx_hash: envelope.tx_hash, owner: plan.account_id,
    vault: envelope.vault, preflight_block_hash: before.block_hash }) !== true) throw new Error('original Circle vault fence was not established');
  try {
    const sent = await provider.sendTransactionOnce(signed, 'FINAL', { beforeSubmit: () => {
      verifySignedVaultCircle(envelope, plan);
      assertFreshFinalBlock({ header: { hash: before.block_hash, timestamp_nanosec: before.block_timestamp_nanosec } }, now());
    } });
    if (sent?.transaction_outcome?.id !== envelope.tx_hash || sent.final_execution_status !== 'FINAL') throw new Error('submission response did not identify original FINAL hash');
    return await reconcileVaultCircle({ plan, envelope, provider, now });
  } catch (error) {
    throw new Error(`original vault ${envelope.kind} ${envelope.tx_hash} is not safely confirmed; retain the hash and reconcile, never resend: ${error?.message ?? 'unknown error'}`);
  }
}
