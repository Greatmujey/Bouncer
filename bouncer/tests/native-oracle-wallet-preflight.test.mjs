import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import nearApi from 'near-api-js';
import { inspectNativeOracleWalletStage, inspectNativeOracleWalletCompletion } from '../agent/native-oracle-wallet-preflight.mjs';
import { buildNativeOracleWalletPlan, NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE, NATIVE_ORACLE_V9_CODE_HASH,
  NATIVE_ORACLE_VAULT_FUNDING } from '../agent/native-oracle-wallet-plan.mjs';
import { prepareNativeOracleWalletAttempt } from '../agent/native-oracle-wallet-evidence.mjs';
import { ORACLE_TESTNET_PROGRAM, ORACLE_PROJECT_ID, ORACLE_PROJECT_UUID } from '../agent/oracle-outlayer.mjs';
import { V11_SELECTED_WASM_FEATURES } from '../agent/svalin-setup-preflight.mjs';
import { NO_LOCAL_CONTRACT_HASH } from '../shared/plain-owner-profile.mjs';

const wasm = fs.readFileSync(new URL('../../bouncer.wasm', import.meta.url));
const ownerKey = String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey()), agentKey = String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const hash = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n));
const ONE = 10n ** 24n, NOW = 1_800_000_000_000, BLOCK = hash(70);
const owner = 'buyer.testnet', vault = 'native.buyer.testnet';
const STAGES = ['create_keyless_native_vault', 'configure_native_oracle_policy', 'fund_native_vault', 'install_native_oracle_agent'];
const plan = buildNativeOracleWalletPlan({ wasmBytes: wasm, terms: { owner, vault, policy_id: 'price', agent_public_key: agentKey,
  per_tx_cap_yocto: (ONE / 10n).toString(), daily_cap_yocto: (ONE / 10n).toString(), vault_deposit_yocto: (ONE / 10n).toString(),
  agent_gas_allowance_yocto: NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } });
function rpcAction(action) {
  if (action.enum === 'createAccount') return 'CreateAccount';
  if (action.enum === 'transfer') return { Transfer: { deposit: action.transfer.deposit.toString() } };
  if (action.enum === 'deployContract') return { DeployContract: { code: crypto.createHash('sha256').update(action.deployContract.code).digest('base64') } };
  if (action.enum === 'functionCall') return { FunctionCall: { method_name: action.functionCall.methodName,
    args: Buffer.from(action.functionCall.args).toString('base64'), gas: Number(action.functionCall.gas), deposit: action.functionCall.deposit.toString() } };
  if (action.enum === 'addKey') { const k = action.addKey, p = k.accessKey.permission.functionCall;
    return { AddKey: { public_key: String(k.publicKey), access_key: { nonce: Number(k.accessKey.nonce),
      permission: { FunctionCall: { allowance: p.allowance.toString(), receiver_id: p.receiverId, method_names: [...p.methodNames] } } } } }; }
  throw Error('unexpected stage action');
}
function original(index) {
  const review = structuredClone(plan.review), batch = plan.batches[index], trustedOriginalHash = hash(10 + index), root = hash(20 + index);
  const attempt = prepareNativeOracleWalletAttempt({ review, wasmBytes: wasm, trustedReviewHash: review.review_sha256,
    trustedOriginalHash, trustedOwnerPublicKey: ownerKey, stageId: batch.id });
  const actions = batch.actions.map(rpcAction);
  const result = { final_execution_status: 'FINAL', status: { SuccessValue: '' },
    transaction: { hash: trustedOriginalHash, signer_id: owner, public_key: ownerKey, receiver_id: batch.receiverId, actions: structuredClone(actions) },
    transaction_outcome: { id: trustedOriginalHash, outcome: { executor_id: owner, receipt_ids: [root], status: { SuccessReceiptId: root } } },
    receipts: index === 3 ? [] : [{ receipt_id: root, predecessor_id: owner, receiver_id: batch.receiverId, receipt: { Action: {
      signer_id: owner, signer_public_key: ownerKey, input_data_ids: [], output_data_receivers: [], actions: structuredClone(actions) } } }],
    receipts_outcome: [{ id: root, outcome: { executor_id: batch.receiverId, status: { SuccessValue: '' }, receipt_ids: [],
      logs: index === 2 ? ['BOUNCER native deposit received'] : [] } }] };
  return { attempt, trustedOriginalHash, result };
}
function fixture(index = 0, opts = {}) {
  const review = structuredClone(plan.review), calls = [], previous = Array.from({ length: index }, (_, i) => original(i));
  const project = { project_id: ORACLE_PROJECT_ID, uuid: ORACLE_PROJECT_UUID, owner: 'zavodil2.testnet' };
  const version = { wasm_hash: ORACLE_TESTNET_PROGRAM.sha256, source: { WasmUrl: { url: ORACLE_TESTNET_PROGRAM.url,
    hash: ORACLE_TESTNET_PROGRAM.sha256, build_target: ORACLE_TESTNET_PROGRAM.build_target } } };
  const route = { project: review.project, route_revision: 1, policy_revision: 1, payee_revision: 1, active: true };
  return { review, wasmBytes: wasm, trustedReviewHash: review.review_sha256, trustedOwnerPublicKey: ownerKey,
    stageId: STAGES[index], prior: previous, now: () => NOW, calls, provider: {
      async viewNodeStatus() { calls.push('status'); return { chain_id: opts.mainnet ? 'mainnet' : 'testnet' }; },
      async viewBlock() { calls.push('block'); return { header: { hash: BLOCK, height: 321,
        timestamp_nanosec: String(BigInt(NOW - (opts.stale ? 121_000 : 0)) * 1_000_000n) } }; },
      async query(q) {
        calls.push('query'); assert.equal(q.block_id, BLOCK);
        if (q.request_type === 'view_account' && q.account_id === owner) return { block_hash: opts.mixed ? hash(71) : BLOCK,
          code_hash: opts.ownerCode ? hash(72) : NO_LOCAL_CONTRACT_HASH, storage_usage: 300,
          amount: String((opts.lowNear ? 1n : 20n) * ONE) };
        if (q.request_type === 'view_account' && q.account_id === 'outlayer.testnet') return { block_hash: BLOCK, code_hash: hash(73) };
        if (q.request_type === 'view_access_key_list' && q.account_id === owner) return { block_hash: BLOCK, keys: [
          { public_key: ownerKey, access_key: { permission: opts.ownerRestricted ? { FunctionCall: {} } : 'FullAccess', nonce: 100 } },
          ...(index === 4 && !opts.agentMissing ? [{ public_key: agentKey, access_key: {
            nonce: opts.agentBadNonce ? -1 : 100, permission: opts.agentFullAccess ? 'FullAccess' : { FunctionCall: {
              receiver_id: opts.agentWrongReceiver ? 'evil.testnet' : vault,
              method_names: opts.agentWrongMethod ? ['set_policy'] : ['execute_outlayer_native_project'],
              allowance: opts.agentAllowanceLow ? '1' : opts.agentAllowanceAbove ? String(ONE) : review.agent_gas_allowance_yocto,
            } },
          } }] : opts.agentPresent ? [{ public_key: agentKey, access_key: { permission: 'FullAccess', nonce: 0 } }] : []),
        ] };
        if (q.request_type === 'view_access_key_list' && q.account_id === vault) return { block_hash: BLOCK, keys: opts.vaultHasKey ? [{ public_key: agentKey }] : [] };
        throw Error('unexpected query');
      },
      async viewTestnetAccountPresenceAt(id, h) {
        calls.push('presence'); assert.equal(id, vault); assert.equal(h, BLOCK);
        if (index === 0 || opts.childMissing) return { block_hash: BLOCK, exists: !!opts.childExists };
        return { block_hash: BLOCK, exists: true, account: { block_hash: BLOCK, code_hash: opts.badVaultCode ? hash(74) : NATIVE_ORACLE_V9_CODE_HASH,
          storage_usage: 455_000, amount: String(BigInt(NATIVE_ORACLE_VAULT_FUNDING) + (index >= 3 ? ONE / 10n : 0n)) } };
      },
      async experimental_protocolConfig() { calls.push('protocol'); return { chain_id: 'testnet', protocol_version: 90,
        runtime_config: { storage_amount_per_byte: '10000000000000000000', wasm_config: Object.fromEntries(V11_SELECTED_WASM_FEATURES.map(f => [f, !opts.featureOff])) } }; },
      async gasPrice() { calls.push('gas'); return { gas_price: opts.highGas ? '2000000000' : '100000000' }; },
      async callFunctionRaw(id, method, args, ref) {
        calls.push('view'); assert.deepEqual(ref, { blockId: BLOCK }); let value;
        if (id === 'outlayer.testnet' && method === 'get_project') value = opts.badProject ? { ...project, owner: 'evil.testnet' } : project;
        else if (id === 'outlayer.testnet' && method === 'get_version') value = version;
        else if (id === 'outlayer.testnet' && method === 'get_project_pricing') value = opts.priceChanged ? { price: '1' } : null;
        else if (id === vault && method === 'contract_version') value = 'bouncer-agent-v9';
        else if (id === vault && method === 'get_owner') value = opts.wrongOwner ? 'evil.testnet' : owner;
        else if (id === vault && method === 'get_policy') value = index === 1 ? (opts.alreadyPolicy ? { token: 'native' } : null) :
          { token: 'native', per_tx_cap: opts.badCap ? '1' : review.per_tx_cap_yocto, daily_cap: review.daily_cap_yocto };
        else if (id === vault && method === 'get_outlayer_native_project') value = index === 1 ? null : opts.routeInactive ? { ...route, active: false } : route;
        else if (id === vault && method === 'is_agent_key_allowed') value = index === 1 ? false : !opts.noGrant;
        else if (id === vault && method === 'vault_balance') value = index >= 3 ? (opts.badBalance ? '0' : review.vault_deposit_yocto) : '0';
        else if (id === vault && method === 'check') value = [!opts.checkBlocked, opts.checkBlocked ? 'blocked' : 'ok'];
        else throw Error(`unexpected view ${method}`);
        return { block_hash: opts.mixedView ? hash(71) : BLOCK, result: [...Buffer.from(JSON.stringify(value))] };
      },
    } };
}

test('all four stages check exact prior originals and fresh single-block state without authorizing a wallet prompt', async () => {
  for (let i = 0; i < 4; i++) {
    const f = fixture(i), result = await inspectNativeOracleWalletStage(f);
    assert.equal(result.status, 'STATE_CHECKS_PASSED_NOT_AUTHORIZED'); assert.deepEqual(result.blockers, []);
    assert.equal(result.stage_id, STAGES[i]); assert.deepEqual(result.prior_original_hashes, Array.from({ length: i }, (_, j) => hash(10 + j)));
    assert.equal(result.owner_key_nonce, '100'); assert.equal(result.wallet_prompt_authorized, false);
    assert.equal(result.signing_authorized, false); assert.equal(result.transaction_sent, false); assert.equal(result.independent_delivery_verified, false);
  }
});

test('stops before RPC for missing, failed, duplicate, changed or out-of-order original transactions', async () => {
  for (const mutate of [
    f => { f.prior.pop(); }, f => { f.prior.reverse(); }, f => { f.prior[0].trustedOriginalHash = hash(99); },
    f => { f.prior[1].trustedOriginalHash = f.prior[0].trustedOriginalHash; },
    f => { f.prior[0].result.final_execution_status = 'EXECUTED'; },
    f => { f.prior[0].result.status = { Failure: { ActionError: {} } }; f.prior[0].result.receipts_outcome[0].outcome.status = { Failure: { ActionError: {} } }; },
    f => { f.prior[0].attempt.receiver_id = 'evil.testnet'; },
  ]) { const f = fixture(3); mutate(f); await assert.rejects(inspectNativeOracleWalletStage(f)); assert.deepEqual(f.calls, []); }
});

test('changed keys, code, funds, provider terms, policy, route and tracked balance block the next stage', async () => {
  for (const [index, opts, name] of [
    [0, { childExists: true }, 'new_direct_child_absent'], [0, { ownerCode: true }, 'plain_owner'],
    [0, { ownerRestricted: true }, 'exact_owner_key'], [0, { agentPresent: true }, 'agent_key_absent'],
    [0, { lowNear: true }, 'owner_native_estimate'], [0, { featureOff: true }, 'protocol_and_selected_features'],
    [0, { highGas: true }, 'agent_gas_allowance_estimate'], [0, { badProject: true }, 'pinned_project_identity_and_native_pricing'],
    [0, { priceChanged: true }, 'pinned_project_identity_and_native_pricing'], [1, { childMissing: true }, 'exact_keyless_vault'],
    [1, { badVaultCode: true }, 'exact_keyless_vault'], [1, { vaultHasKey: true }, 'exact_keyless_vault'],
    [1, { wrongOwner: true }, 'exact_keyless_vault'], [1, { alreadyPolicy: true }, 'native_policy_state'],
    [2, { badCap: true }, 'native_policy_state'], [2, { routeInactive: true }, 'native_policy_state'],
    [2, { noGrant: true }, 'native_policy_state'], [3, { badBalance: true }, 'vault_native_balance'],
    [3, { checkBlocked: true }, 'onchain_policy_check'],
  ]) { const result = await inspectNativeOracleWalletStage(fixture(index, opts));
    assert.equal(result.status, 'BLOCKED_OR_UNKNOWN', name); assert(result.blockers.includes(name), name); }
});

test('mainnet, stale and mixed-block RPC data fail closed', async () => {
  for (const o of [{ mainnet: true }, { stale: true }, { mixed: true }, { mixedView: true }]) await assert.rejects(inspectNativeOracleWalletStage(fixture(0, o)));
});


test('completion requires all four original receipt graphs and a fresh exact one-method agent key', async () => {
  const { stageId, ...f } = fixture(4), result = await inspectNativeOracleWalletCompletion(f);
  assert.equal(result.status, 'FOUR_ORIGINALS_AND_STATE_MATCH_NOT_AUTHORIZED');
  assert.deepEqual(result.blockers, []); assert.equal(result.stage_id, 'verify_native_setup_completion');
  assert.deepEqual(result.prior_original_hashes, [hash(10), hash(11), hash(12), hash(13)]);
  assert.equal(result.checks.exact_agent_key, true); assert.equal(result.agent_key_nonce, '100');
  assert.equal(result.wallet_prompt_authorized, false); assert.equal(result.signing_authorized, false);
  assert.equal(result.independent_delivery_verified, false); assert.equal(result.local_key_custody_verified, false);
  assert.equal(result.no_inflight_request_proven, false);
  await assert.rejects(inspectNativeOracleWalletCompletion({ ...f, stageId: 'install_native_oracle_agent' }));
});

test('missing, changed, full-access or underfunded agent keys cannot pass completion', async () => {
  for (const opts of [{ agentMissing: true }, { agentFullAccess: true }, { agentWrongReceiver: true },
    { agentWrongMethod: true }, { agentAllowanceLow: true }, { agentAllowanceAbove: true }, { agentBadNonce: true }]) {
    const { stageId, ...f } = fixture(4, opts), result = await inspectNativeOracleWalletCompletion(f);
    assert.equal(result.status, 'BLOCKED_OR_UNKNOWN'); assert(result.blockers.includes('exact_agent_key'));
  }
  for (const [opts, blocker] of [[{ noGrant: true }, 'native_policy_state'], [{ badVaultCode: true }, 'exact_keyless_vault'],
    [{ badBalance: true }, 'vault_native_balance'], [{ checkBlocked: true }, 'onchain_policy_check']]) {
    const { stageId, ...f } = fixture(4, opts), result = await inspectNativeOracleWalletCompletion(f);
    assert.equal(result.status, 'BLOCKED_OR_UNKNOWN'); assert(result.blockers.includes(blocker));
  }
});

test('completion rejects an unresolved or altered fourth original before reading state', async () => {
  for (const mutate of [
    f => { f.prior.pop(); },
    f => { f.prior[3].trustedOriginalHash = hash(99); },
    f => { f.prior[3].result.final_execution_status = 'EXECUTED'; },
    f => { f.prior[3].result.transaction.actions[0].AddKey.access_key.permission.FunctionCall.method_names = ['set_policy']; },
    f => { f.prior[3].result.status = { Failure: { ActionError: {} } }; f.prior[3].result.receipts_outcome[0].outcome.status = { Failure: { ActionError: {} } }; },
  ]) {
    const { stageId, ...f } = fixture(4); mutate(f);
    await assert.rejects(inspectNativeOracleWalletCompletion(f)); assert.deepEqual(f.calls, []);
  }
});
