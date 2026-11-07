/**
 * Offline compatibility inspection of reviewed unsigned Buffer batches through
 * the pinned NEAR Connect action converter. No wallet, RPC, session, approval,
 * signed transaction or send occurs. JSON sizes are illustrative action
 * encodings, not measured transport limits or proof any wallet can approve.
 */
import { isDeepStrictEqual } from 'node:util';
import nearConnect from '@hot-labs/near-connect';
import { assertSvalinBatchMatchesReview } from './svalin-setup-plan.mjs';
import { assertBufferWalletBatchMatchesReview } from './buffer-wallet-setup-plan.mjs';
import { assertNativeOracleBatchMatchesReview } from './native-oracle-wallet-plan.mjs';

const { nearActionsToConnectorActions } = nearConnect;
const SETUP = ['create_keyless_vault', 'register_vault_circle', 'fund_vault_circle'];
const NATIVE = ['create_keyless_native_vault', 'configure_native_oracle_policy', 'fund_native_vault', 'install_native_oracle_agent'];
const OTHER = ['configure_buffer_locked_policy', 'install_buffer_vault_agent', 'install_buffer_forwarder_agent',
  'create_buffer_forwarder', 'register_buffer_forwarder_circle', 'pin_buffer_exact_intent'];
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exactKeys = (x, fields) => record(x) && Object.keys(x).length === fields.length && fields.every(k => Object.hasOwn(x, k));
function convertedMatches(expected, actual) {
  if (expected.enum === 'createAccount') return exactKeys(actual, ['type']) && actual.type === 'CreateAccount';
  if (expected.enum === 'transfer') return exactKeys(actual, ['type', 'params']) && actual.type === 'Transfer' &&
    exactKeys(actual.params, ['deposit']) && actual.params.deposit === expected.transfer.deposit.toString();
  if (expected.enum === 'deployContract') return exactKeys(actual, ['type', 'params']) && actual.type === 'DeployContract' &&
    exactKeys(actual.params, ['code']) && actual.params.code instanceof Uint8Array &&
    Buffer.from(actual.params.code).equals(Buffer.from(expected.deployContract.code));
  if (expected.enum === 'functionCall') {
    const e = expected.functionCall, p = actual?.params;
    return exactKeys(actual, ['type', 'params']) && actual.type === 'FunctionCall' &&
      exactKeys(p, ['methodName', 'args', 'gas', 'deposit']) && p.methodName === e.methodName &&
      p.gas === e.gas.toString() && p.deposit === e.deposit.toString() &&
      Buffer.from(JSON.stringify(p.args)).equals(Buffer.from(e.args));
  }
  if (expected.enum === 'addKey') {
    const e = expected.addKey, p = actual?.params, k = p?.accessKey, permission = k?.permission, restricted = e.accessKey.permission.functionCall;
    return exactKeys(actual, ['type', 'params']) && actual.type === 'AddKey' && exactKeys(p, ['publicKey', 'accessKey']) &&
      p.publicKey === String(e.publicKey) && exactKeys(k, ['nonce', 'permission']) && k.nonce === Number(e.accessKey.nonce) &&
      restricted && exactKeys(permission, ['receiverId', 'allowance', 'methodNames']) &&
      permission.receiverId === restricted.receiverId && permission.allowance === restricted.allowance?.toString() &&
      isDeepStrictEqual(permission.methodNames, restricted.methodNames);
  }
  return false;
}
function payloadShapes(actions) {
  const meteor = actions.map(action => {
    if (action.type === 'CreateAccount') return { type: action.type, params: {} };
    if (action.type === 'DeployContract') return { type: action.type,
      params: { code: Buffer.from(action.params.code).toString('base64'), codeEncoding: 'base64' } };
    if (action.type === 'AddKey') return { ...action, params: { ...action.params,
      accessKey: { ...action.params.accessKey, nonce: String(action.params.accessKey.nonce) } } };
    return action;
  });
  const intear = actions.map(action => action.type === 'DeployContract'
    ? { ...action, params: { ...action.params, code: Array.from(action.params.code) } } : action);
  // Illustrative JSON for one action array, excluding envelope, escaping,
  // transport and wallet-protocol overhead. Never send these representations.
  return { meteor_action_array_json_bytes: Buffer.byteLength(JSON.stringify(meteor)),
    intear_action_array_json_bytes: Buffer.byteLength(JSON.stringify(intear)) };
}

/** A matching retained stage is a consistency check, not consent or authority.
 * The caller must retain the original review separately; editing both defeats
 * the review comparison. Never use these results as live capability claims. */
export function inspectBufferConnectorCompatibility({ batch, retainedStage } = {}) {
  if (!batch || typeof batch.id !== 'string') throw new Error('reviewed Buffer batch required');
  if (SETUP.includes(batch.id)) assertBufferWalletBatchMatchesReview(batch, retainedStage);
  else if (OTHER.includes(batch.id)) assertSvalinBatchMatchesReview(batch, retainedStage);
  else if (NATIVE.includes(batch.id)) assertNativeOracleBatchMatchesReview(batch, retainedStage);
  else throw new Error('known reviewed Buffer or native oracle stage required');
  if (batch.actions.some(a => a.enum === 'deployContract' &&
      (!(a.deployContract.code instanceof Uint8Array) || a.deployContract.code.length > 1_000_000))) {
    throw new Error('bounded reviewed contract bytes required');
  }
  const converted = nearActionsToConnectorActions(batch.actions);
  if (!Array.isArray(converted) || converted.length !== batch.actions.length ||
      !batch.actions.every((action, i) => convertedMatches(action, converted[i]))) {
    throw new Error('NEAR Connect conversion differs from the retained reviewed actions');
  }
  const deployment = batch.actions.find(a => a.enum === 'deployContract');
  return { stage_id: batch.id, action_commitment_sha256: retainedStage.action_commitment_sha256,
    converter: '@hot-labs/near-connect@0.12.0', action_types: converted.map(a => a.type),
    code_bytes: deployment ? deployment.deployContract.code.length : 0,
    ...payloadShapes(converted),
    ethereum_named_v12_path_supported: false, walletconnect_account_only: true, typed_account_is_signer: false,
    actual_wallet_or_phone_tested: false, transport_size_limit_verified: false, wallet_approval_obtained: false,
    execution_authorized: false, transaction_signed: false, transaction_sent: false,
    scope: 'Offline converter consistency and illustrative encodings only; not real-wallet compatibility, approval or payment.' };
}

/** Same byte-for-byte offline check for the four native-oracle stages. It
 * remains a converter test, not evidence of a working phone or wallet. */
export function inspectNativeOracleConnectorCompatibility({ batch, retainedStage } = {}) {
  if (!NATIVE.includes(batch?.id)) throw new Error('known reviewed native oracle stage required');
  return inspectBufferConnectorCompatibility({ batch, retainedStage });
}
