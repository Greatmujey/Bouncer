/** TEST-ONLY: exercise the bounded resource-agent planner on the existing
 * disposable loopback chain after the mock-FT vault was funded. The token's
 * Circle metadata is synthetic. No production runner or live send is implied. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nearApi from 'near-api-js';
import { setTimeout as delay } from 'node:timers/promises';
import { syncWrite } from '../agent/circle-owner-offline-journal.mjs';
import { createTestnetResourceAgentKeyring } from '../agent/testnet-resource-agent-keyring.mjs';
import { inspectTestnetResourceAgentSetup, inspectTestnetResourceAgentGuardControl, signTestnetResourceAgentSetup,
  verifySignedTestnetResourceAgentSetup, verifyGuardControlParent } from '../agent/testnet-resource-agent-setup.mjs';
import { broadcastTestnetResourceAgentOnce, reconcileTestnetResourceAgent } from '../agent/testnet-resource-agent-runner.mjs';
import { inspectInstalledTestnetResourceAgent } from '../agent/testnet-resource-agent-state.mjs';

export async function exerciseSandboxResourceAgent({ rpc, ownerPlan, ownerKey, directory, checkpoint, expectedCircleCodeHash }) {
  const agent = createTestnetResourceAgentKeyring({ dir: path.join(directory,'sandbox-resource-agent'), ownerPlan }).plan;
  const receipts = {};
  // Model the live safety problem without contacting testnet: the first
  // zero-deposit probe is signed and retained but deliberately never sent.
  const initial=await inspectTestnetResourceAgentSetup({ownerPlan,agentPlan:agent,provider:rpc});
  const original=await signTestnetResourceAgentSetup({ownerPlan,agentPlan:agent,snapshot:initial,stage:'guard-probe',keyPair:ownerKey});
  syncWrite(path.join(directory,'sandbox-unsubmitted-guard-original.json'),JSON.stringify(original)+'\n','wx',0o600);
  const controlSnapshot=await inspectTestnetResourceAgentGuardControl({ownerPlan,agentPlan:agent,provider:rpc});
  const control=await signTestnetResourceAgentSetup({ownerPlan,agentPlan:agent,snapshot:controlSnapshot,stage:'guard-control',
    keyPair:ownerKey,originalProbe:original});
  assert.equal(BigInt(control.nonce),BigInt(original.nonce)+1n);verifyGuardControlParent(control,original,ownerPlan,agent);
  const controlFile=path.join(directory,'sandbox-guard-control-original.json');
  syncWrite(controlFile,JSON.stringify(control)+'\n','wx',0o600);
  const controlResult=await broadcastTestnetResourceAgentOnce({ownerPlan,agentPlan:agent,envelope:control,originalProbe:original,
    expectedCircleCodeHash,provider:rpc,persistAttempt:async attempt=>attempt.tx_hash===control.tx_hash&&
      JSON.parse(fs.readFileSync(controlFile,'utf8')).tx_hash===control.tx_hash});
  assert.equal(controlResult.status,'GUARD_CONTROL_REJECTED_AND_ORIGINAL_NONCE_SUPERSEDED_AT_FINAL');
  assert.equal(controlResult.receipt.guard_failure_verified,true);assert.equal(controlResult.state.owner_key_nonce,control.nonce);
  assert.equal(controlResult.state.policy,null);assert.equal(controlResult.state.guard_control_policy,null);
  // Isolated-chain adversarial replay: prove nearcore rejects the earlier
  // nonce once the higher control nonce is FINAL. Never do this to live hashes.
  const oldSigned=verifySignedTestnetResourceAgentSetup(original,ownerPlan,agent);
  const replay=await fetch(rpc.connection.url,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:'sandbox-old-nonce',method:'send_tx',params:{
      signed_tx_base64:Buffer.from(nearApi.transactions.encodeTransaction(oldSigned)).toString('base64'),wait_until:'FINAL'}})});
  const replayBody=await replay.json();
  assert.ok(replayBody.error,'the earlier nonce must not be accepted after the control');
  assert.match(JSON.stringify(replayBody.error),/InvalidNonce|INVALID_NONCE|nonce.*too (low|small)|nonce.*must be larger/i);
  receipts['guard-control']=control.tx_hash;
  for (const stage of ['configure','install']) {
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
    assert.equal(result.receipt.guard_failure_verified, false);
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
  checkpoint('sandbox: distinct zero-yocto guard rejected, higher nonce invalidated older probe, policy configured, restricted key installed');
  return { scope:'isolated local chain and mock FT only; no live policy, Circle funding, audit, payee or seller delivery',
    zero_yocto_policy_rejected_by_vault:true, higher_nonce_invalidated_older_probe:true,
    policy_configured_after_guard:true, restricted_agent_key_installed:true,
    post_install_pinned_state_checked:true, lost_ack_reconciled_without_resend:true,
    allowed_methods:['execute','execute_ft_call'], payee_added:false, sandbox_original_hashes:receipts };
}
