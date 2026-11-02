/** All keys, receipts, RPC responses and contract state below are synthetic. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { inspectSvalinSetupStage } from '../agent/svalin-setup-stage-preflight.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { fixture, resultFor, STAGES, OWNER, VAULT, hash } from './fixtures/svalin-setup-fixture.mjs';
import { readExactArtifact, SyntheticNearHost } from './fixtures/v11-synthetic-host.mjs';

import { BLOCK, OTHER, NOW, REG, COST, MAX, ALLOWANCE, UNFUNDED, stageName, snapshot, providerFor, completeThrough }
  from './fixtures/svalin-setup-rpc-fixture.mjs';

function inspect(f, index, s, extra = {}) {
  return inspectSvalinSetupStage({ ...f.base(), stageId: stageName(index), provider: providerFor(f, s), now: () => NOW, ...extra });
}

// Exercises the real local journal, signature verification and receipt
// reconciliation against invented transaction/receipt graphs; no network.
test('all five synthetic stages and post-funding state require original receipts and one pinned read-only snapshot', async () => {
  const f = fixture();
  try {
    await f.init();
    for (let i = 0; i <= 5; i++) {
      const s = snapshot(f, i), before = fs.readFileSync(f.file);
      const result = await inspect(f, i, s);
      assert.equal(result.status, i === 5 ? 'READ_ONLY_FUNDED_VAULT_PROFILE_MATCH' : 'READ_ONLY_STAGE_PROFILE_MATCH', stageName(i));
      assert.equal(result.stage_id, stageName(i)); assert.deepEqual(result.blockers, []);
      assert.equal(Object.values(result.checks).every(value => value === 'PASS'), true);
      assert.equal(result.block_hash, BLOCK); assert.equal(result.observed_protocol_version, 88);
      assert.equal(result.current_state_is_not_authorization, true);
      for (const field of ['execution_authorized', 'owner_approval_verified', 'backup_verified', 'transaction_sent',
        'transaction_signed', 'seller_contacted', 'all_payees_and_agents_enumerated', 'runtime_linking_and_all_host_imports_verified',
        'receipt_consensus_verified', 'setup_or_funding_independently_verified', 'seller_fulfillment_verified']) {
        assert.equal(result[field], false, field);
      }
      assert.deepEqual(fs.readFileSync(f.file), before, 'inspection does not write the encrypted journal');
      for (const [name, ...args] of s.calls) {
        if (['status', 'block'].includes(name)) continue;
        if (name === 'presence') assert.equal(args.at(-1), BLOCK);
        else assert.deepEqual(args.at(-1), { blockId: BLOCK }, name);
      }
      assert.equal(s.calls.some(call => String(call[1]).includes('workers.dev')), false);
      if (i === 5) break;
      const tx = await f.signed(i, BigInt(i + 1));
      await f.record(i, tx.signed);
      const pending = snapshot(f, i);
      await assert.rejects(inspect(f, i, pending), /reconcile original hashes/);
      assert.deepEqual(pending.calls, [], 'an already-recorded stage never reaches RPC');
      await f.reconcile(i, resultFor(f, i, tx.txHash));
    }
  } finally { f.close(); }
});

test('actual V11 bytes drive every staged snapshot in an intentionally synthetic chain',
  { skip: process.env.BOUNCER_V11_WASM_PATH ? false : 'set BOUNCER_V11_WASM_PATH to the recovered V11 artifact' }, async () => {
    const bytes = readExactArtifact(process.env.BOUNCER_V11_WASM_PATH);
    const host = new SyntheticNearHost(bytes), f = fixture({ wasmBytes: bytes });
    try {
      await f.init();
      for (let i = 0; i <= 5; i++) {
        const s = snapshot(f, i), provider = providerFor(f, s), fakeTokenView = provider.callFunctionRaw;
        // The real bytecode supplies vault method results; account/key/FT state,
        // receipts, timestamps and the host implementation remain synthetic.
        s.vault.storage_usage = bytes.length + 10_000;
        provider.callFunctionRaw = async (contract, method, args, ref) => {
          if (contract !== VAULT) return fakeTokenView(contract, method, args, ref);
          s.calls.push(['actualWasm:' + method, contract, method, args, ref]);
          const result = host.call(method, args).value;
          return { block_hash: BLOCK, result: [...Buffer.from(JSON.stringify(result))] };
        };
        const checked = await inspect(f, i, s, { provider });
        assert.equal(checked.status, i === 5 ? 'READ_ONLY_FUNDED_VAULT_PROFILE_MATCH' : 'READ_ONLY_STAGE_PROFILE_MATCH');
        assert.deepEqual(checked.blockers, []);
        if (i === 5) break;
        const tx = await f.signed(i, BigInt(i + 1));
        await f.record(i, tx.signed); await f.reconcile(i, resultFor(f, i, tx.txHash));
        if (i === 0) {
          const action = f.plan.batches[0].actions[3].functionCall;
          host.call(action.methodName, JSON.parse(Buffer.from(action.args).toString()), { predecessor: OWNER, deposit: action.deposit });
        } else if (i === 1) {
          for (const entry of f.plan.batches[1].actions) {
            const action = entry.functionCall;
            host.call(action.methodName, JSON.parse(Buffer.from(action.args).toString()), { predecessor: OWNER, deposit: action.deposit });
          }
        } else if (i === 4) {
          host.call('ft_on_transfer', { sender_id: OWNER, amount: MAX, msg: '' }, { predecessor: TOKEN });
        }
      }
      assert.equal(host.call('vault_balance', { token: TOKEN }).value, MAX);
      assert.equal(host.call('daily_spent', { policy_id: 'svalin' }).value, '0');
    } finally { f.close(); }
  });

test('state drift, unsafe keys, changed token prerequisites and non-pristine balances block the next stage', async () => {
  const groups = {
    1: [
      ['vault_code_matches_review', s => { s.vault.code_hash = OTHER; }],
      ['vault_code_matches_review', s => { s.vault.block_hash = OTHER; }],
      ['vault_has_no_access_keys', s => { s.vaultKeys.keys.push({ public_key: 'unexpected' }); }],
      ['owner_and_version', s => { s.contractOwner = 'intruder.testnet'; }],
      ['owner_and_version', s => { s.version = 'bouncer-agent-v9'; }],
      ['policy_not_yet_configured', s => { s.policy = {}; }],
      ['policy_not_yet_configured', s => { s.policyLocked = true; }],
      ['policy_not_yet_configured', s => { s.agentGranted = true; }],
      ['agent_key_state', (s, f) => { s.ownerKeys.keys.push({ public_key: f.inputs.agentPublicKey, access_key: { permission: 'FullAccess' } }); }],
      ['token_payee_not_consumed_or_locked', s => { s.pairLocked = true; }],
      ['daily_budget_unused', s => { s.daily = '1'; }],
      ['vault_token_and_tracked_balances', s => { s.tracked = '1'; }],
      ['vault_token_and_tracked_balances', s => { s.vaultUsdc = '1'; }],
      ['vault_registration_state', s => { s.vaultRegistration = { total: REG, available: '0' }; }],
      ['testnet_protocol_and_storage_cost', s => { s.protocol.protocol_version = 87; }],
      ['testnet_protocol_and_storage_cost', s => { s.protocol.protocol_version = '88'; }],
      ['testnet_protocol_and_storage_cost', s => { delete s.protocol.protocol_version; }],
      ['testnet_protocol_and_storage_cost', s => { s.protocol.chain_id = 'mainnet'; }],
      ['testnet_protocol_and_storage_cost', s => { s.protocol.runtime_config.storage_amount_per_byte = '0'; }],
      ['owner_full_access_key', s => { s.ownerKey.permission = { FunctionCall: {} }; }],
      ['owner_nonce_safely_represented', s => { s.ownerKey.nonce = BigInt(Number.MAX_SAFE_INTEGER); }],
      ['owner_nonce_safely_represented', s => { s.ownerKey.nonce = -1n; }],
      ['owner_nonce_safely_represented', s => { s.ownerKey.block_hash = OTHER; }],
      ['owner_native_estimate', s => { s.owner.amount = 0n; }],
      ['vault_native_estimate', s => { s.vault.amount = 0n; }],
    ],
    2: [
      ['strict_trial_policy', s => { s.policy.per_tx_cap = '5010000'; }],
      ['strict_trial_policy', s => { s.policy.daily_cap = '0'; }],
      ['policy_locked_and_agent_granted', s => { s.policyLocked = false; }],
      ['policy_locked_and_agent_granted', s => { s.agentGranted = false; }],
      ['expected_payee_check', s => { s.verdict = [false, 'BLOCKED: payee not in allowlist']; }],
      ['expected_payee_check', s => { s.verdict = [true, 'anything']; }],
      ['agent_key_state', s => { s.ownerKeys.keys.push(s.ownerKeys.keys[0]); }],
      ['circle_bounds_match_review', s => { s.bounds.min = '1'; }],
      ['circle_bounds_match_review', s => { delete s.bounds.max; }],
      ['owner_and_seller_registered', s => { s.sellerRegistration = null; }],
      ['owner_and_seller_registered', s => { s.ownerRegistration.available = '99999999999999999999999'; }],
      ['owner_token_balance', s => { s.ownerUsdc = '5009998'; }],
    ],
    3: [
      ['agent_key_state', s => { s.ownerKeys.keys[1].access_key.permission = 'FullAccess'; }],
      ['agent_key_state', s => { s.ownerKeys.keys[1].access_key.permission.FunctionCall.receiver_id = 'other.testnet'; }],
      ['agent_key_state', s => { s.ownerKeys.keys[1].access_key.permission.FunctionCall.method_names.push('set_policy'); }],
      ['agent_key_state', s => { s.ownerKeys.keys[1].access_key.permission.FunctionCall.allowance = null; }],
      ['agent_key_state', s => { s.ownerKeys.keys[1].access_key.permission.FunctionCall.allowance = '999'; }],
      ['agent_key_state', s => { s.ownerKeys.block_hash = OTHER; }],
      ['vault_registration_state', s => { s.vaultRegistration = { total: REG, available: '0' }; }],
    ],
    4: [
      ['vault_registration_state', s => { s.vaultRegistration = null; }],
      ['vault_registration_state', s => { s.vaultRegistration.total = '1'; }],
      ['vault_registration_state', s => { s.vaultRegistration.available = '9999999999999999999999'; }],
      ['owner_token_balance', s => { s.ownerUsdc = MAX - 1; }],
    ],
    5: [
      ['vault_token_and_tracked_balances', s => { s.tracked = '5009998'; }],
      ['vault_token_and_tracked_balances', s => { s.vaultUsdc = '5010000'; }],
      ['expected_payee_check', s => { s.verdict = [false, UNFUNDED]; }],
      ['daily_budget_unused', s => { s.daily = '1'; }],
    ],
  };
  for (const [text, cases] of Object.entries(groups)) {
    const index = Number(text), f = fixture();
    try {
      await completeThrough(f, index);
      for (const [check, mutate] of cases) {
        const s = snapshot(f, index); mutate(s, f);
        const result = await inspect(f, index, s);
        assert.equal(result.status, 'BLOCKED_OR_UNKNOWN', `${stageName(index)} ${check}`);
        assert.equal(result.checks[check], 'BLOCKED', `${stageName(index)} ${check}`);
        assert.ok(result.blockers.some(entry => entry.check === check && entry.status === 'BLOCKED'), check);
      }
    } finally { f.close(); }
  }
});

test('every setup stage and final snapshot reject an owner with local or global contract code', async () => {
  for (let index = 0; index <= 5; index++) {
    const f = fixture();
    try {
      await completeThrough(f, index);
      for (const mutate of [
        s => { s.owner.code_hash = OTHER; },
        s => { delete s.owner.code_hash; },
        s => { s.owner.global_contract_hash = OTHER; },
        s => { s.owner.global_contract_account_id = 'shared.testnet'; },
        s => { s.owner.state = 'uninitialized'; },
        s => { s.owner.block_hash = OTHER; },
      ]) {
        const s = snapshot(f, index); mutate(s);
        const result = await inspect(f, index, s);
        assert.equal(result.status, 'BLOCKED_OR_UNKNOWN', stageName(index));
        assert.equal(result.checks.owner_has_no_contract_code, 'BLOCKED', stageName(index));
        assert.equal(result.transaction_signed, false); assert.equal(result.transaction_sent, false);
      }
    } finally { f.close(); }
  }
});

test('every setup stage and final snapshot reject missing or disabled reported WASM feature gates', async () => {
  for (let index = 0; index <= 5; index++) {
    const f = fixture();
    try {
      await completeThrough(f, index);
      for (const feature of ['global_contract_host_fns', 'reftypes_bulk_memory', 'gas_key_host_fns', 'universal_accounts']) {
        for (const value of [false, null, 'true']) {
          const s = snapshot(f, index); s.protocol.runtime_config.wasm_config[feature] = value;
          const result = await inspect(f, index, s);
          assert.equal(result.status, 'BLOCKED_OR_UNKNOWN', `${stageName(index)} ${feature}`);
          assert.equal(result.checks.v11_selected_wasm_features_enabled, 'BLOCKED', `${stageName(index)} ${feature}`);
          assert.equal(result.observed_v11_selected_wasm_features[feature], value === false ? false : null);
          assert.equal(result.transaction_signed, false); assert.equal(result.transaction_sent, false);
        }
      }
    } finally { f.close(); }
  }
});

test('unavailable and wrong-block views remain UNKNOWN, sanitized and unable to authorize', async () => {
  const f = fixture();
  try {
    await completeThrough(f, 4);
    for (const [failure, check] of [['protocol', 'testnet_protocol_and_storage_cost'], ['ownerKeys', 'agent_key_state'],
      ['owner', 'owner_has_no_contract_code'], ['vault', 'vault_code_matches_review'],
      ['vaultKeys', 'vault_has_no_access_keys'], ['policy', 'strict_trial_policy'],
      ['verdict', 'expected_payee_check'], ['tracked', 'vault_token_and_tracked_balances'],
      ['vaultRegistration', 'vault_registration_state']]) {
      const s = snapshot(f, 4); s.failures.add(failure);
      const result = await inspect(f, 4, s);
      assert.equal(result.checks[check], 'UNKNOWN', check);
      assert.equal(result.status, 'BLOCKED_OR_UNKNOWN');
      assert.equal(JSON.stringify(result).includes('untrusted-rpc-secret'), false);
    }
    for (const malformed of [{ block_hash: OTHER, result: [...Buffer.from('true')] },
      { block_hash: BLOCK, result: [] }, { block_hash: BLOCK, result: [256] },
      { block_hash: BLOCK, result: [255] }, { block_hash: BLOCK, result: [...Buffer.from('not-json')] }]) {
      const s = snapshot(f, 4); s.raw.policyLocked = malformed;
      const result = await inspect(f, 4, s);
      assert.equal(result.checks.policy_locked_and_agent_granted, 'UNKNOWN');
      assert.equal(result.execution_authorized, false);
    }
  } finally { f.close(); }
});

test('journal sequencing and unknown original attempts block before any RPC', async () => {
  const f = fixture();
  try {
    const s = snapshot(f, 0);
    await assert.rejects(inspect(f, 0, s), /manifest is missing/);
    assert.deepEqual(s.calls, []);
    await f.init();
    const skipped = snapshot(f, 1);
    await assert.rejects(inspect(f, 1, skipped), /journal is not ready/);
    assert.deepEqual(skipped.calls, []);
    const tx = await f.signed(0); await f.record(0, tx.signed);
    for (const index of [0, 1, 5]) {
      const state = snapshot(f, index);
      await assert.rejects(inspect(f, index, state), /journal is not ready/);
      assert.deepEqual(state.calls, []);
    }
    const wrong = snapshot(f, 0);
    await assert.rejects(inspect(f, 0, wrong, { pendingOriginalHash: hash(91) }), /journal is not ready/);
    assert.deepEqual(wrong.calls, []);
    const pendingView = await inspect(f, 0, snapshot(f, 0), { pendingOriginalHash: tx.txHash });
    assert.equal(pendingView.status, 'READ_ONLY_STAGE_PROFILE_MATCH');
    assert.equal(pendingView.pending_original_hash, tx.txHash);
    assert.equal(pendingView.execution_authorized, false);
    assert.equal((await f.status()).stages[0].tx_hash, tx.txHash);
    assert.equal((await f.status()).stages[0].do_not_resend, true);
  } finally { f.close(); }
});

test('a journal change during RPC invalidates the snapshot and retains its original pending hash', async () => {
  for (const index of [0, 4]) {
    const f = fixture();
    try {
      await completeThrough(f, index);
      const tx = await f.signed(index, BigInt(index + 1)), s = snapshot(f, index);
      s.hook = async () => { await f.record(index, tx.signed); };
      const result = await inspect(f, index, s);
      assert.equal(result.status, 'BLOCKED_OR_UNKNOWN');
      assert.equal(result.checks.journal_unchanged, 'BLOCKED');
      assert.equal(result.execution_authorized, false);
      const state = await f.status();
      assert.equal(state.stages[index].state, 'ORIGINAL_HASH_PENDING');
      assert.equal(state.stages[index].tx_hash, tx.txHash);
      await assert.rejects(f.record(index, tx.signed), /already recorded/);
    } finally { f.close(); }
  }
});

test('wrong network, invalid or expired FINAL blocks and modified reviews fail closed', async () => {
  const f = fixture();
  try {
    await completeThrough(f, 3);
    for (const change of [s => { s.network = 'mainnet'; }, s => { s.block.header.hash = 'not-a-hash'; },
      s => { s.block.header.timestamp_nanosec = '1'; },
      s => { s.block.header.timestamp_nanosec = String(BigInt(NOW + 30_001) * 1_000_000n); },
      s => { s.failures.add('status'); }, s => { s.failures.add('block'); }]) {
      const s = snapshot(f, 3); change(s);
      await assert.rejects(inspect(f, 3, s));
      assert.equal(s.calls.some(call => call[0] === 'vault'), false);
    }
    const s = snapshot(f, 3); let clockReads = 0;
    const expired = await inspect(f, 3, s, { now: () => ++clockReads < 3 ? NOW : NOW + 120_001 });
    assert.equal(expired.checks.final_block_fresh_at_completion, 'BLOCKED');
    assert.equal(expired.status, 'BLOCKED_OR_UNKNOWN');
    const changed = snapshot(f, 3);
    changed.hook = async () => { f.plan.batches[1].actions[0].functionCall.deposit = 0n; };
    await assert.rejects(inspect(f, 3, changed), /setup plan differs/);
  } finally { f.close(); }
});
