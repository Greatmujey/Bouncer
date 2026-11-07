import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import nearApi from 'near-api-js';
import { buildNativeOracleWalletPlan, NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE, NATIVE_ORACLE_V9_CODE_HASH } from '../agent/native-oracle-wallet-plan.mjs';
import { buildNativeOracleRevocationPlan, prepareNativeOracleRevocationAttempt } from '../agent/native-oracle-wallet-recovery.mjs';
import { inspectNativeOracleRevocationStage } from '../agent/native-oracle-recovery-preflight.mjs';
import { NO_LOCAL_CONTRACT_HASH } from '../shared/plain-owner-profile.mjs';

const wasm = fs.readFileSync(new URL('../../bouncer.wasm', import.meta.url));
const key = () => String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const ownerKey = key(), agentKey = key(), hash = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n));
const owner = 'buyer.testnet', vault = 'native.buyer.testnet', NOW = 1_800_000_000_000, BLOCK = hash(70);
const setupReview = buildNativeOracleWalletPlan({ wasmBytes: wasm, terms: { owner, vault, policy_id: 'price', agent_public_key: agentKey,
  per_tx_cap_yocto: '100000000000000000000000', daily_cap_yocto: '100000000000000000000000',
  vault_deposit_yocto: '100000000000000000000000', agent_gas_allowance_yocto: NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } }).review;
const base = { setupReview, wasmBytes: wasm, trustedSetupReviewHash: setupReview.review_sha256, trustedOwnerPublicKey: ownerKey };
function fixture(stage = 'remove', opts = {}) {
  const plan = buildNativeOracleRevocationPlan({ ...base, expectedAccessKeyPresent: stage !== 'alreadyAbsent' });
  const recoveryReview = plan.review, trustedRecoveryReviewHash = recoveryReview.review_sha256;
  const stageId = stage === 'remove' ? 'remove_native_oracle_access_key' : 'revoke_native_oracle_vault_grant';
  const prior = [];
  if (stage === 'revoke') {
    const batch = plan.batches[0], trustedOriginalHash = hash(8), root = hash(9);
    const attempt = prepareNativeOracleRevocationAttempt({ ...base, recoveryReview, trustedRecoveryReviewHash,
      stageId: batch.id, trustedOriginalHash });
    const result = { final_execution_status: 'FINAL', status: { SuccessValue: '' },
      transaction: { hash: trustedOriginalHash, signer_id: owner, public_key: ownerKey, receiver_id: owner,
        actions: [{ DeleteKey: { public_key: agentKey } }] },
      transaction_outcome: { id: trustedOriginalHash, outcome: { executor_id: owner, receipt_ids: [root], status: { SuccessReceiptId: root } } },
      receipts: [], receipts_outcome: [{ id: root, outcome: { executor_id: owner, status: { SuccessValue: '' }, receipt_ids: [], logs: [] } }] };
    prior.push({ attempt, trustedOriginalHash, result });
  }
  const calls = [];
  const provider = {
    async viewNodeStatus() { calls.push('status'); return { chain_id: opts.mainnet ? 'mainnet' : 'testnet' }; },
    async viewBlock() { calls.push('block'); return { header: { hash: BLOCK, height: 321,
      timestamp_nanosec: String(BigInt(NOW - (opts.stale ? 121_000 : 0)) * 1_000_000n) } }; },
    async query(q) {
      calls.push('query'); assert.equal(q.block_id, BLOCK);
      if (q.request_type === 'view_account' && q.account_id === owner) return { block_hash: opts.mixed ? hash(71) : BLOCK,
        code_hash: opts.ownerCode ? hash(72) : NO_LOCAL_CONTRACT_HASH };
      if (q.request_type === 'view_account' && q.account_id === vault) return { block_hash: BLOCK,
        code_hash: opts.badVaultCode ? hash(72) : NATIVE_ORACLE_V9_CODE_HASH };
      if (q.request_type === 'view_access_key_list' && q.account_id === owner) return { block_hash: BLOCK, keys: [
        { public_key: ownerKey, access_key: { permission: opts.ownerRestricted ? { FunctionCall: {} } : 'FullAccess', nonce: 100 } },
        ...((stage === 'remove' ? !opts.missingAgent : opts.agentStillPresent) ? [{ public_key: agentKey, access_key: { permission: 'FullAccess', nonce: 0 } }] : []),
      ] };
      if (q.request_type === 'view_access_key_list' && q.account_id === vault) return { block_hash: BLOCK, keys: opts.vaultHasKey ? [{ public_key: agentKey }] : [] };
      throw Error('unexpected query');
    },
    async callFunctionRaw(id, method, value, ref) {
      calls.push('view'); assert.equal(id, vault); assert.deepEqual(ref, { blockId: BLOCK }); let result;
      if (method === 'contract_version') result = 'bouncer-agent-v9';
      else if (method === 'get_owner') result = opts.wrongOwner ? 'other.testnet' : owner;
      else if (method === 'is_agent_key_allowed') { assert.deepEqual(value, { policy_id: 'price', public_key: agentKey }); result = !opts.grantAlreadyAbsent; }
      else throw Error('unexpected view');
      return { block_hash: opts.mixedView ? hash(71) : BLOCK, result: [...Buffer.from(JSON.stringify(result))] };
    },
  };
  return { ...base, recoveryReview, trustedRecoveryReviewHash, stageId, prior, provider, now: () => NOW, calls };
}

test('each recovery stage requires fresh exact owner/key state; grant revocation requires the original removal', async () => {
  for (const stage of ['remove', 'revoke', 'alreadyAbsent']) {
    const f = fixture(stage), result = await inspectNativeOracleRevocationStage(f);
    assert.equal(result.status, 'STATE_CHECKS_PASSED_NOT_AUTHORIZED'); assert.deepEqual(result.blockers, []);
    assert.equal(result.stage_id, f.stageId); assert.equal(result.wallet_prompt_authorized, false);
    assert.equal(result.onchain_revocation_verified, false); assert.equal(result.transaction_sent, false);
    assert.deepEqual(result.prior_original_hashes, stage === 'revoke' ? [hash(8)] : []);
    if (stage !== 'remove') assert.equal(result.vault_state.agent_grant_active, true);
  }
});

test('missing, changed or failed original removal blocks later grant prompts before any RPC call', async () => {
  for (const mutate of [
    f => { f.prior = []; }, f => { f.prior[0].trustedOriginalHash = hash(10); },
    f => { f.prior[0].result.transaction.actions[0].DeleteKey.public_key = key(); },
    f => { f.prior[0].result.final_execution_status = 'EXECUTED'; },
    f => { f.prior[0].result.status = { Failure: { ActionError: {} } }; f.prior[0].result.receipts_outcome[0].outcome.status = { Failure: { ActionError: {} } }; },
  ]) { const f = fixture('revoke'); mutate(f); await assert.rejects(inspectNativeOracleRevocationStage(f)); assert.deepEqual(f.calls, []); }
});

test('changed owner key, access-key presence, vault or grant fail closed', async () => {
  for (const [stage, opts, blocker] of [
    ['remove', { missingAgent: true }, 'expected_agent_access_key_state'], ['remove', { ownerCode: true }, 'plain_owner'],
    ['remove', { ownerRestricted: true }, 'exact_owner_full_access_key'], ['revoke', { agentStillPresent: true }, 'expected_agent_access_key_state'],
    ['revoke', { badVaultCode: true }, 'exact_keyless_vault'], ['revoke', { vaultHasKey: true }, 'exact_keyless_vault'],
    ['revoke', { wrongOwner: true }, 'exact_keyless_vault'], ['revoke', { grantAlreadyAbsent: true }, 'agent_grant_still_active'],
  ]) {
    const result = await inspectNativeOracleRevocationStage(fixture(stage, opts));
    assert.equal(result.status, 'BLOCKED_OR_UNKNOWN'); assert.ok(result.blockers.includes(blocker), blocker);
  }
  for (const opts of [{ mainnet: true }, { stale: true }, { mixed: true }, { mixedView: true }]) {
    await assert.rejects(inspectNativeOracleRevocationStage(fixture('revoke', opts)));
  }
});
