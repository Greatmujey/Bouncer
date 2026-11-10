#!/usr/bin/env node
/**
 * Dry-run mission simulator — zero wallet, zero transaction, zero network.
 * Reads a mission plan and simulates each goal step by step, showing exactly
 * what would happen on testnet without sending anything.
 *
 * Usage: node scripts/dry-run-mission.mjs [mission-file.json]
 * Defaults to bouncer/examples/native-market-mission.example.json
 */

import fs from 'node:fs';
import { validateNativeMission } from '../agent/native-mission.mjs';
import { planNativeObjective } from '../agent/native-mission-planner.mjs';

const fail = (msg) => { console.error(`[DRY-RUN] ERROR: ${msg}`); process.exitCode = 1; };

const loadMission = (path) => {
  const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
  return validateNativeMission(raw);
};

const formatYocto = (y) => {
  const n = BigInt(y);
  const near = Number(n) / 1e24;
  return `${near.toFixed(6)} NEAR (${y} yocto)`;
};

const simulateGoal = (goal, index) => {
  const g = goal.goal;
  console.log(`\n  Goal ${index + 1}: ${goal.kind.toUpperCase()}`);
  console.log(`    ID: ${g.id}`);
  console.log(`    Policy: ${g.policy_id}`);
  console.log(`    Cap: ${formatYocto(g.amount)}`);
  console.log(`    Contract: ${g.contract_id}`);

  if (goal.kind === 'oracle') {
    console.log(`    Action: Fetch NEAR/USD price from Coinbase via OutLayer`);
    console.log(`    Route: zavodil2.testnet/price-oracle`);
    console.log(`    Max age: ${g.max_age_seconds}s`);
    console.log(`    Simulated result: NEAR/USD price returned, receipt generated`);
  } else if (goal.kind === 'market') {
    console.log(`    Action: Run market summary WASM (compute)`);
    console.log(`    Input: from_goal_id=${g.input.from_goal_id}, quantity=${g.input.quantity}`);
    console.log(`    Program SHA-256: ${g.program.sha256}`);
    console.log(`    Max instructions: ${g.program.max_instructions}`);
    console.log(`    Simulated result: WASM executes, market summary produced`);
  } else if (goal.kind === 'random') {
    console.log(`    Action: Run random integer WASM (compute)`);
    console.log(`    Input: min=${g.input.min}, max=${g.input.max}`);
    console.log(`    Program SHA-256: ${g.program.sha256}`);
    console.log(`    Simulated result: random integer produced`);
  } else if (goal.kind === 'storage') {
    console.log(`    Action: Write results to public NEAR storage`);
    console.log(`    Object ID: ${g.object_id}`);
    console.log(`    References: ${g.value.from_goal_ids.join(', ')}`);
    console.log(`    Prefix: ${g.route.prefix}`);
    console.log(`    Max value bytes: ${g.route.max_value_bytes}`);
    console.log(`    Simulated result: result object stored publicly`);
  }

  console.log(`    Status: SIMULATED (no transaction sent)`);
};

const simulateMission = (mission) => {
  console.log('═'.repeat(60));
  console.log('  BOUNCER V14 GUARDED MISSION — DRY RUN');
  console.log('═'.repeat(60));
  console.log(`\nMission ID: ${mission.id}`);
  console.log(`Owner: ${mission.owner_account_id}`);
  console.log(`Vault: ${mission.contract_id}`);
  console.log(`Network: testnet`);
  console.log(`Mission cap: ${formatYocto(mission.max_native_amount)}`);
  console.log(`Resources: ${mission.required_resources.join(', ')}`);
  console.log(`Goals: ${mission.goals.length}`);

  let totalCap = 0n;
  for (const goal of mission.goals) {
    totalCap += BigInt(goal.goal.amount);
  }
  console.log(`Total goal caps: ${formatYocto(totalCap)}`);
  console.log(`Within mission cap: ${totalCap <= BigInt(mission.max_native_amount) ? 'YES' : 'NO'}`);

  console.log('\n--- Step-by-step simulation ---');
  for (let i = 0; i < mission.goals.length; i++) {
    simulateGoal(mission.goals[i], i);
  }

  console.log('\n--- Expected execution order ---');
  console.log('  1. Owner signs 1-yocto approval for Goal 1 (oracle)');
  console.log('  2. Backend executes oracle call, receipt returned');
  console.log('  3. Owner signs 1-yocto approval for Goal 2 (compute)');
  console.log('  4. Backend executes WASM compute, receipt returned');
  console.log('  5. Owner signs 1-yocto approval for Goal 3 (storage)');
  console.log('  6. Backend writes to public storage, receipt returned');
  console.log('  7. Mission checkpoint — all delivery hashes verified');

  console.log('\n--- Safety checks that would apply ---');
  console.log('  ✓ 1-yocto owner guard on every goal');
  console.log('  ✓ Per-goal cap enforced (1 NEAR each)');
  console.log('  ✓ Mission cap enforced (3 NEAR total)');
  console.log('  ✓ Receipt verified before next goal');
  console.log('  ✓ No resend if hash unknown');
  console.log('  ✓ Temporary key deleted after mission');
  console.log('  ✓ No secrets in public storage');

  console.log('\n═'.repeat(60));
  console.log('  DRY RUN COMPLETE — zero transactions sent');
  console.log('═'.repeat(60));
};

const main = async () => {
  const missionPath = process.argv[2] || 'bouncer/examples/native-market-mission.example.json';
  let mission;
  try {
    mission = loadMission(missionPath);
  } catch (err) {
    fail(`Failed to load/validate mission from ${missionPath}: ${err.message}`);
    return;
  }

  simulateMission(mission);
};

main().catch((err) => { fail(err.message); });
