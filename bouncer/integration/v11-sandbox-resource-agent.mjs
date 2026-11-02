/** TEST-ONLY: exercise the bounded resource-agent planner on the existing
 * disposable loopback chain after the mock-FT vault was funded. The token's
 * Circle metadata is synthetic. No production runner or live send is implied. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { syncWrite } from '../agent/circle-owner-offline-journal.mjs';
import { createTestnetResourceAgentKeyring } from '../agent/testnet-resource-agent-keyring.mjs';
import { inspectTestnetResourceAgentSetup, signTestnetResourceAgentSetup,
  verifySignedTestnetResourceAgentSetup } from '../agent/testnet-resource-agent-setup.mjs';
import { verifyTestnetResourceAgentReceipt } from '../agent/testnet-resource-agent-evidence.mjs';
import { requireFinalSuccess } from './v11-sandbox-support.mjs';

export async function exerciseSandboxResourceAgent({ rpc, ownerPlan, ownerKey, directory, checkpoint }) {
  const agent = createTestnetResourceAgentKeyring({ dir: path.join(directory,'sandbox-resource-agent'), ownerPlan }).plan;
  const receipts = {};
  for (const stage of ['guard-probe','configure','install']) {
    const snapshot = await inspectTestnetResourceAgentSetup({ ownerPlan, agentPlan: agent, provider: rpc });
    assert.equal(snapshot[stage === 'guard-probe' ? 'guard_probe_eligible' : stage === 'configure' ? 'configure_eligible' : 'install_eligible'], true);
    const envelope = await signTestnetResourceAgentSetup({ ownerPlan, agentPlan: agent, snapshot, stage, keyPair: ownerKey });
    const signed = verifySignedTestnetResourceAgentSetup(envelope, ownerPlan, agent);
    const fence = path.join(directory, `resource-agent-${stage}-original.json`);
    syncWrite(fence, JSON.stringify(envelope) + '\n', 'wx', 0o600);
    await rpc.sendTransactionOnce(signed, 'FINAL', { beforeSubmit: () => {
      const original = JSON.parse(fs.readFileSync(fence, 'utf8'));
      assert.equal(original.tx_hash, envelope.tx_hash);
      verifySignedTestnetResourceAgentSetup(original, ownerPlan, agent);
    }});
    const result = await rpc.txStatusReceipts(envelope.tx_hash, ownerPlan.account_id, 'FINAL');
    const proof = verifyTestnetResourceAgentReceipt({ ownerPlan, agentPlan: agent, envelope, result });
    assert.equal(proof.tx_hash, envelope.tx_hash);
    assert.equal(proof.guard_failure_verified, stage === 'guard-probe');
    if (stage === 'guard-probe') {
      assert.equal(result.final_execution_status, 'FINAL');
      assert.match(JSON.stringify(result.status?.Failure), /owner-only method requires exactly 1 yoctoNEAR/);
      const root = result.transaction_outcome?.outcome?.status?.SuccessReceiptId;
      const failed = result.receipts_outcome?.filter(x => x.id === root && x.outcome?.executor_id === agent.vault &&
        JSON.stringify(x.outcome.status?.Failure) === JSON.stringify(result.status.Failure));
      assert.equal(failed?.length, 1, 'the linked vault receipt must show the expected failure');
      const after = await inspectTestnetResourceAgentSetup({ ownerPlan, agentPlan: agent, provider: rpc });
      assert.equal(after.policy, null); assert.equal(after.agent_granted, false);
    } else requireFinalSuccess(result, stage);
    receipts[stage] = envelope.tx_hash;
  }
  // Same-account AddKey is locally executed; its receipt body may be omitted.
  // Confirm the actual FINAL access-key permissions rather than inventing it.
  let access;
  for (let i=0; i<30; i++) {
    const block = await rpc.viewBlock({ finality: 'final' });
    const keys = await rpc.query({ request_type:'view_access_key_list', account_id:ownerPlan.account_id, block_id:block.header.hash });
    assert.equal(keys.block_hash, block.header.hash);
    access = keys.keys.find(x => x.public_key === agent.public_key)?.access_key;
    if (access) {
      assert.equal(keys.keys.length, 2);
      break;
    }
    await delay(300);
  }
  assert.ok(access, 'restricted key was not visible at FINAL');
  assert.equal(access.permission?.FunctionCall?.receiver_id, agent.vault);
  assert.deepEqual(access.permission?.FunctionCall?.method_names, ['execute','execute_ft_call']);
  assert.equal(String(access.permission?.FunctionCall?.allowance), agent.gas_allowance_yocto);
  checkpoint('sandbox resource-agent planner: zero-yocto escalation rejected, policy configured, restricted key installed');
  return { scope:'isolated local chain and mock FT only; no live policy, Circle funding, audit, payee or seller delivery',
    zero_yocto_policy_rejected_by_vault:true, policy_configured_after_guard:true, restricted_agent_key_installed:true,
    allowed_methods:['execute','execute_ft_call'], payee_added:false, sandbox_original_hashes:receipts };
}
