import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import nearApi from 'near-api-js';
import { buildNativeOracleWalletPlan, NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } from '../agent/native-oracle-wallet-plan.mjs';
import { inspectNativeOracleConnectorCompatibility } from '../agent/buffer-wallet-connector-compat.mjs';

const wasm = fs.readFileSync(new URL('../../bouncer.wasm', import.meta.url));
const agentKey = String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
function plan() { return buildNativeOracleWalletPlan({ wasmBytes: wasm, terms: { owner: 'buyer.testnet', vault: 'native.buyer.testnet',
  policy_id: 'price', agent_public_key: agentKey, per_tx_cap_yocto: '100000000000000000000000',
  daily_cap_yocto: '100000000000000000000000', vault_deposit_yocto: '100000000000000000000000',
  agent_gas_allowance_yocto: NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } }); }

test('pinned NEAR Connect converter preserves each reviewed native wallet action exactly', () => {
  const { review, batches } = plan();
  const expected = [['CreateAccount','Transfer','DeployContract','FunctionCall'],
    ['FunctionCall','FunctionCall','FunctionCall','FunctionCall'], ['FunctionCall'], ['AddKey']];
  for (let i = 0; i < batches.length; i++) {
    const result = inspectNativeOracleConnectorCompatibility({ batch: batches[i], retainedStage: review.stages[i] });
    assert.deepEqual(result.action_types, expected[i]);
    assert.equal(result.code_bytes, i ? 0 : wasm.length);
    assert.equal(result.actual_wallet_or_phone_tested, false); assert.equal(result.wallet_approval_obtained, false);
    assert.equal(result.execution_authorized, false); assert.equal(result.transaction_sent, false);
  }
});

test('altered native batches never reach compatibility claim', () => {
  const { review, batches } = plan(); batches[3].actions[0].addKey.accessKey.permission.functionCall.methodNames.push('set_policy');
  assert.throws(() => inspectNativeOracleConnectorCompatibility({ batch: batches[3], retainedStage: review.stages[3] }));
  assert.throws(() => inspectNativeOracleConnectorCompatibility({ batch: { ...batches[0], id: 'not-native' }, retainedStage: review.stages[0] }));
});
