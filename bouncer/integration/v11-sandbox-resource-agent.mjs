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
import { broadcastTestnetResourceAgentOnce, reconcileTestnetResourceAgent } from '../agent/testnet-resource-agent-runner.mjs';
import { inspectInstalledTestnetResourceAgent } from '../agent/testnet-resource-agent-state.mjs';

export async function exerciseSandboxResourceAgent({ rpc, ownerPlan, ownerKey, directory, checkpoint, expectedCircleCodeHash }) {
  const agent = createTestnetResourceAgentKeyring({ dir: path.join(directory,'sandbox-resource-agent'), ownerPlan }).plan;
  const receipts = {};
  for (const stage of ['guard-probe','configure','install']) {
    const snapshot = await inspectTestnetResourceAgentSetup({ ownerPlan, agentPlan: agent, provider: rpc });
    assert.equal(snapshot[stage === 'guard-probe' ? 'guard_probe_eligible' : stage === 'configure' ? 'configure_eligible' : 'install_eligible'], true);
    const envelope = await signTestnetResourceAgentSetup({ ownerPlan, agentPlan: agent, snapshot, stage, keyPair: ownerKey });
    verifySignedTestnetResourceAgentSetup(envelope, ownerPlan, agent);
    const fence = path.join(directory, `resource-agent-${stage}-original.json`);
    syncWrite(fence, JSON.stringify(envelope) + '\n', 'wx', 0o600);
    const args = { ownerPlan, agentPlan:agent, envelope, expectedCircleCodeHash, provider:rpc,
      persistAttempt: async attempt => {
        const original = JSON.parse(fs.readFileSync(fence, 'utf8'));
        verifySignedTestnetResourceAgentSetup(original, ownerPlan, agent);
        return attempt.tx_hash === original.tx_hash && attempt.stage === stage;
      }};
    let result;
    if (stage === 'configure') {
      const calls = rpc.transportCalls;
      rpc.loseNextAcknowledgementForTest();
      await assert.rejects(broadcastTestnetResourceAgentOnce(args), /never resend/);
      assert.equal(rpc.transportCalls, calls + 1);
      result = await reconcileTestnetResourceAgent(args);
      assert.equal(rpc.transportCalls, calls + 1, 'lost acknowledgement recovery must not send twice');
    } else {
      result = await broadcastTestnetResourceAgentOnce(args);
    }
    assert.equal(result.tx_hash, envelope.tx_hash);
    assert.equal(result.receipt.guard_failure_verified, stage === 'guard-probe');
    if (stage === 'guard-probe') {
      assert.equal(result.state.policy, null); assert.equal(result.state.agent_granted, false);
    }
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
  const state = await inspectInstalledTestnetResourceAgent({ ownerPlan, agentPlan:agent, expectedCircleCodeHash, provider:rpc });
  assert.equal(state.vault_key_count, 0); assert.equal(state.vault_actual_circle_atoms, '6907');
  assert.equal(state.vault_tracked_circle_atoms, '6907');
  checkpoint('sandbox resource-agent planner: zero-yocto escalation rejected, policy configured, restricted key installed');
  return { scope:'isolated local chain and mock FT only; no live policy, Circle funding, audit, payee or seller delivery',
    zero_yocto_policy_rejected_by_vault:true, policy_configured_after_guard:true, restricted_agent_key_installed:true,
    post_install_pinned_state_checked:true, lost_ack_reconciled_without_resend:true,
    allowed_methods:['execute','execute_ft_call'], payee_added:false, sandbox_original_hashes:receipts };
}
