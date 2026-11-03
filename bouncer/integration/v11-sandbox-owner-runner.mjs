/**
 * TEST ONLY: exercise the actual experimental setup coordinator, RPC transport,
 * stage preflight and recovery on a SECOND disposable sandbox owner/vault.
 *
 * Only the chain identity is aliased by SandboxSetupRpc after it verifies the
 * local sandbox; all state, transactions and receipts come from nearcore. The
 * locally asserted approval flags are test inputs, not real user consent,
 * independent review, verified backups, or permission to use testnet.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import nearApi from 'near-api-js';
import { buildUnsignedSvalinTrialSetup } from '../agent/svalin-setup-plan.mjs';
import { inspectSvalinSetupStage } from '../agent/svalin-setup-stage-preflight.mjs';
import { runSvalinSetupStageOnce, recoverSvalinSetupStage } from '../agent/svalin-setup-runner.mjs';
import { FileJournal } from '../agent/procurement.mjs';
import { initializeSvalinSetupJournal, inspectSvalinSetupJournal } from '../agent/svalin-setup-journal.mjs';
import { SandboxSetupRpc, withSandboxOnlyFetch } from './v11-sandbox-setup-rpc.mjs';

export const RUNNER_OWNER = 'runner-owner.testnet';
export const RUNNER_VAULT = 'trial.runner-owner.testnet';
const NEAR = 10n ** 24n;
const pub = pair => String(pair.getPublicKey());
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest();
const originalHash = signed => nearApi.utils.serialize.base_encode(sha256(nearApi.transactions.encodeTransaction(signed.transaction)));

function locallySimulatedApproval(plan, stageId) {
  return { network: 'testnet', stage_id: stageId, review_sha256: plan.review.review_sha256,
    artifact_sha256: plan.review.artifact.sha256, one_broadcast_approved: true,
    unaudited_artifact_risk_accepted: true, journal_and_key_backups_attested: true,
    keyless_vault_storage_risk_accepted: true };
}
function expectProfile(profile, expected) {
  assert.equal(profile.status, expected,
    `${profile.stage_id}: pinned sandbox preflight ${profile.status}; blockers=${JSON.stringify(profile.blockers)}`);
  assert.equal(profile.blockers.length, 0);
  assert.equal(profile.current_state_is_not_authorization, true);
}

/** The caller has already created/funded RUNNER_OWNER with local mock tokens,
 * registered it and the local mock seller, and started the isolated node. */
export async function exerciseSandboxOwnerRunner(args) {
  return withSandboxOnlyFetch(args.rpcUrl, () => exerciseWithFencedFetch(args));
}

async function exerciseWithFencedFetch({ rpcUrl, wasm, tokenStorageMin, directory, ownerKey, agentKey, checkpoint }) {
  const codeHash = nearApi.utils.serialize.base_encode(sha256(wasm));
  const plan = buildUnsignedSvalinTrialSetup({
    goal: { version: 1, id: 'sandbox-runner-only', owner: RUNNER_OWNER, vault: RUNNER_VAULT,
      vault_code_hash: codeHash, policy_id: 'svalin', accept_unsigned_seller_risk: true, accept_exact_amount_matching_risk: true },
    wasmBytes: wasm, agentPublicKey: pub(agentKey), initialVaultFundingYocto: (7n * NEAR).toString(),
    agentGasAllowanceYocto: NEAR.toString(), vaultTokenStorageDepositYocto: tokenStorageMin,
  });
  const trustedReviewHash = plan.review.review_sha256, ownerPublicKey = pub(ownerKey);
  const signer = new nearApi.KeyPairSigner(ownerKey), rpc = new SandboxSetupRpc(rpcUrl);
  const journalKey = crypto.randomBytes(32), journalPath = path.join(directory, 'sandbox-runner-journal.json');
  let journal, activeStage, journalChecks = 0;
  try {
    journal = new FileJournal(journalPath, RUNNER_VAULT, RUNNER_OWNER, { encryptionKey: journalKey });
    const base = () => ({ plan, trustedReviewHash, ownerPublicKey, journal });
    const state = () => inspectSvalinSetupJournal(base());
    await initializeSvalinSetupJournal({ ...base(), confirmNew: true });

    // Observe the original encrypted journal directly inside the test-only
    // wrapper at the production runner's transport boundary. Do not bypass
    // the production transport or its synchronous beforeSubmit guard.
    const realOneShot = rpc.sendTransactionOnce.bind(rpc);
    rpc.sendTransactionOnce = async (signed, finality, options) => {
      const hash = originalHash(signed);
      const entry = journal.list().find(item => item.id === `svalin-setup-v1-${activeStage}`);
      assert.equal(entry?.status, 'pending', 'original hash must be journaled before entering the transport');
      assert.equal(entry.tx_hash, hash, 'journal must contain the exact signed original');
      assert.equal(fs.readFileSync(journalPath, 'utf8').includes(hash), false, 'on-disk journal must be encrypted');
      journalChecks++;
      return realOneShot(signed, finality, options);
    };

    const observations = [];
    for (let i = 0; i < plan.batches.length; i++) {
      const stageId = plan.batches[i].id;
      activeStage = stageId;
      const stageBase = () => ({ ...base(), stageId, provider: rpc });
      const profile = await inspectSvalinSetupStage(stageBase());
      expectProfile(profile, 'READ_ONLY_STAGE_PROFILE_MATCH');
      if (i >= 3) assert.equal(profile.checks.agent_key_state, 'PASS', 'the fresh installed key must match the exact allowance');
      const sendsBefore = rpc.transportCalls;
      const options = { ...stageBase(), signer, approval: locallySimulatedApproval(plan, stageId) };
      // Exercise an ambiguous response on the local registration stage: nearcore
      // has actually processed the one send, but the adapter drops its reply.
      if (i === 3) rpc.loseNextAcknowledgementForTest();
      const result = await runSvalinSetupStageOnce(options);
      assert.equal(result.stage_id, stageId);
      assert.equal(result.broadcast_attempts, 1);
      assert.equal(result.do_not_resend, true);
      assert.equal(rpc.transportCalls, sendsBefore + 1);
      const expected = i === 4 ? 'FINAL_FUNDING_RECEIPTS_MATCH' :
        i === 2 ? 'FINAL_LOCAL_ADD_KEY_OUTCOME_MATCH' : 'FINAL_SETUP_RECEIPT_MATCH';
      let settled = result;
      if (i === 3) {
        assert.equal(result.status, 'ORIGINAL_HASH_NEEDS_RECONCILIATION');
        assert.equal((await state()).stages[i].state, 'ORIGINAL_HASH_PENDING');
        // A restart must reopen this same encrypted journal; the original is
        // never replaced or sent again even though the acknowledgement was lost.
        journal.close();
        journal = new FileJournal(journalPath, RUNNER_VAULT, RUNNER_OWNER, { encryptionKey: journalKey, requireExisting: true });
        const dry = await recoverSvalinSetupStage({ ...stageBase(), update: false });
        assert.equal(dry.status, expected);
        assert.equal(dry.tx_hash, result.tx_hash);
        assert.equal(dry.journal_updated, false);
        assert.equal((await state()).stages[i].state, 'ORIGINAL_HASH_PENDING');
        await assert.rejects(runSvalinSetupStageOnce({ ...stageBase(), signer, approval: options.approval }), /journal is not ready/);
        assert.equal(rpc.transportCalls, sendsBefore + 1, 'a pending original must not be broadcast again');
        settled = await recoverSvalinSetupStage({ ...stageBase(), update: true });
        assert.equal(settled.journal_updated, true);
        assert.equal(settled.tx_hash, result.tx_hash);
        assert.equal(rpc.transportCalls, sendsBefore + 1, 'read-only recovery must not broadcast');
      }
      assert.equal(settled.status, expected, `${stageId}: real local outcome failed to reconcile`);
      const current = await state();
      assert.equal(current.stages[i].state, i === 2 ? 'FINAL_LOCAL_ADD_KEY_OUTCOME_MATCH' : 'FINAL_RECEIPTS_MATCH');
      assert.equal(current.stages[i].tx_hash, result.tx_hash);
      observations.push({ stage: stageId, pinned_preflight: profile.status, sandbox_transaction_hash: result.tx_hash,
        evidence_status: settled.status, transport_calls: 1, lost_ack_and_original_hash_recovery: i === 3 });
      if (i === 2) {
        journal.close();
        journal = new FileJournal(journalPath, RUNNER_VAULT, RUNNER_OWNER, { encryptionKey: journalKey, requireExisting: true });
        assert.equal((await state()).stages[i].state, 'FINAL_LOCAL_ADD_KEY_OUTCOME_MATCH');
      }
      checkpoint(`actual setup runner stage ${i + 1}/5 reconciled against local sandbox${i === 3 ? ' after original-hash recovery' : ''}`);
    }
    const final = await inspectSvalinSetupStage({ ...base(), stageId: 'verify_funded_vault', provider: rpc });
    expectProfile(final, 'READ_ONLY_FUNDED_VAULT_PROFILE_MATCH');
    for (const check of ['agent_key_state', 'vault_code_matches_review', 'vault_has_no_access_keys', 'strict_trial_policy',
      'policy_locked_and_agent_granted', 'expected_payee_check', 'vault_token_and_tracked_balances', 'vault_registration_state',
      'daily_budget_unused', 'final_block_fresh_at_completion']) assert.equal(final.checks[check], 'PASS', check);
    assert.equal(rpc.transportCalls, 5, 'exactly one coordinator transport call per stage');
    assert.equal(journalChecks, 5, 'every original was journaled before its transport call');
    assert.equal((await state()).stages.length, 5);
    checkpoint('actual stage preflight matched the funded local vault, exact agent-key allowance and mock FT state');
    return { scope: 'ONLY disposable local nearcore; chain identity and acknowledgments deliberately simulated',
      production_testnet_chain_check_not_exercised: true, actual_node_chain_id_is_aliased_to_testnet_only_in_this_harness: true,
      simulated_approvals_are_not_user_consent_or_review: true, pinned_final_stage_snapshots: observations,
      post_funding_snapshot: final.status, exact_agent_key_allowance_checked: true,
      encrypted_original_journal_checks_before_transport: journalChecks, coordinator_transport_calls: rpc.transportCalls,
      simulated_lost_ack_recovered_original_without_resend: true };
  } finally {
    journal?.close();
    journalKey.fill(0);
  }
}
