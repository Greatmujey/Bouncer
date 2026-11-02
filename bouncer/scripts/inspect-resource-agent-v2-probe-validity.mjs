#!/usr/bin/env node
/** READ ONLY: original block validity and same-final-block owner nonce. */
import { publicResourceAgentInputs } from './resource-agent-v2-common.mjs';
import { inspectOriginalProbeValidity } from '../agent/testnet-resource-agent-expiry.mjs';
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';
try {
  const { owner, agent, anchor, envelope } = publicResourceAgentInputs('guard-probe');
  const result = await inspectOriginalProbeValidity({ ownerPlan: owner, agentPlan: agent, envelope,
    expectedCircleCodeHash: anchor.circle_code_hash, provider: new ReadOnlyNearRpcProvider('https://rpc.testnet.near.org') });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`Original probe validity is unknown; never resend: ${error?.message ?? 'unknown error'}`);
  process.exitCode = 1;
}
