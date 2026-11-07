// TEST ONLY: synthetic OutLayer FINAL evidence for the real oracle runner.
// Nothing here is proof of a live transaction or a current market price.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { ORACLE_PROJECT_ID, ORACLE_PROJECT_UUID, ORACLE_TESTNET_PROGRAM } from '../agent/oracle-outlayer.mjs';

export function attachSyntheticOracle({ provider, goal, journal, events, ambiguous = false, workflowId = 'research' }) {
  const keypair = nearApi.KeyPair.fromRandom('ed25519'), signer = new nearApi.KeyPairSigner(keypair), publicKey = keypair.getPublicKey();
  const blockHash = 'B'.repeat(44), bouncerReceipt = '6'.repeat(44), requestReceipt = '7'.repeat(44), completedReceipt = '8'.repeat(44), refundReceipt = '9'.repeat(44);
  const stamp = Math.floor(Date.now() / 1000), encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
  const event = (name, data) => `EVENT_JSON:${JSON.stringify({ standard: 'near-outlayer', version: '1.0.0', event: name, data: [data] })}`;
  const source = { WasmUrl: { url: ORACLE_TESTNET_PROGRAM.url, hash: ORACLE_TESTNET_PROGRAM.sha256, build_target: ORACLE_TESTNET_PROGRAM.build_target } };
  const project = goal.route.project, signedArgs = { policy_id: goal.policy_id, amount: goal.amount, expected_route: goal.route };
  const account = { accountId: goal.owner_account_id, signer, async createTransaction(receiver, actions, key) {
    return nearApi.transactions.createTransaction(goal.owner_account_id, key, receiver, 1n, actions, Buffer.alloc(32, 9));
  } };
  const viewKey = provider.viewAccessKey.bind(provider), call = provider.callFunction.bind(provider), send = provider.sendTransactionUntil.bind(provider),
    receipts = provider.txStatusReceipts.bind(provider);
  let sourceSends = 0, sourceHash, chain;
  provider.viewAccessKey = async (owner, key, ...rest) => String(key) === String(publicKey)
    ? { permission: { FunctionCall: { receiver_id: goal.contract_id, method_names: ['execute_outlayer_native_project'] } } }
    : viewKey(owner, key, ...rest);
  provider.callFunction = async (receiver, method, args, ...rest) => {
    if (method === 'get_owner') return goal.owner_account_id;
    if (method === 'get_policy' && args?.policy_id === goal.policy_id) return { token: 'native', per_tx_cap: '100', daily_cap: '100' };
    if (method === 'get_outlayer_native_project') return structuredClone(goal.route);
    if (method === 'get_project') return { project_id: ORACLE_PROJECT_ID, uuid: ORACLE_PROJECT_UUID, owner: 'zavodil2.testnet' };
    if (method === 'get_version') return { wasm_hash: ORACLE_TESTNET_PROGRAM.sha256, source };
    if (method === 'get_project_pricing') return null;
    return call(receiver, method, args, ...rest);
  };
  provider.block = async () => ({ header: { hash: blockHash, timestamp_nanosec: `${stamp}000000000` } });
  provider.sendTransactionOnce = async (signed, wait) => {
    if (signed.transaction.actions[0].functionCall.methodName !== 'execute_outlayer_native_project') return send(signed, wait);
    sourceSends++; events.push('real-source:pay');
    sourceHash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(nearApi.transactions.encodeTransaction(signed.transaction)).digest());
    assert.equal(journal.get(`workflow:${workflowId}`).status, 'pending');
    assert.equal(journal.get(goal.id).status, 'pending'); assert.equal(journal.get(goal.id).tx_hash, sourceHash);
    const limits = { max_instructions: project.max_instructions, max_memory_mb: project.max_memory_mb, max_execution_seconds: project.max_execution_seconds };
    const data = { success: true, token_id: 'near', source: 'custom', price_usd: 2.75, timestamp: stamp };
    const request = { sender_id: goal.owner_account_id, predecessor_id: goal.contract_id, payment: goal.amount,
      input_data: project.input_data, code_source: source, project_id: ORACLE_PROJECT_ID, project_uuid: ORACLE_PROJECT_UUID, attached_usd: '0' };
    const completion = { success: true, sender_id: goal.owner_account_id, code_source: source, payment_charged: '10', payment_refunded: '90' };
    const outlayerArgs = { source: { Project: { project_id: ORACLE_PROJECT_ID, version_key: project.version_key } }, resource_limits: limits,
      input_data: project.input_data, secrets_ref: null, response_format: 'Json', payer_account_id: goal.owner_account_id, params: null };
    const outcome = (id, executor_id, status, logs = []) => ({ id, block_hash: blockHash, outcome: { executor_id, status, logs } });
    const receipt = (id, predecessor_id, receiver_id, actions) => ({ receipt_id: id, predecessor_id, receiver_id, receipt: { Action: { actions } } });
    chain = { final_execution_status: 'FINAL', status: { SuccessValue: encode(data) }, transaction_outcome: { id: sourceHash },
      transaction: { hash: sourceHash, signer_id: goal.owner_account_id, receiver_id: goal.contract_id, public_key: String(publicKey),
        actions: [{ FunctionCall: { method_name: 'execute_outlayer_native_project', deposit: '0', args: encode(signedArgs) } }] },
      receipts_outcome: [outcome(bouncerReceipt, goal.contract_id, { SuccessReceiptId: requestReceipt }, ['BOUNCER independent native project initiated; full maximum reserved']),
        outcome(requestReceipt, 'outlayer.testnet', { SuccessReceiptId: completedReceipt }, [event('execution_requested', { request_data: JSON.stringify(request) })]),
        outcome(completedReceipt, 'outlayer.testnet', { SuccessValue: encode(data) }, [event('execution_completed', completion)]),
        outcome(refundReceipt, goal.owner_account_id, { SuccessValue: '' })],
      receipts: [receipt(requestReceipt, goal.contract_id, 'outlayer.testnet', [{ FunctionCall: { method_name: 'request_execution', deposit: goal.amount, args: encode(outlayerArgs) } }]),
        receipt(refundReceipt, 'outlayer.testnet', goal.owner_account_id, [{ Transfer: { deposit: '90' } }])] };
    if (ambiguous) { ambiguous = false; throw new Error('synthetic source timeout after broadcast'); }
    return { transaction_outcome: { id: sourceHash } };
  };
  provider.txStatusReceipts = async (hash, owner, wait) => hash === sourceHash ? structuredClone(chain) : receipts(hash, owner, wait);
  return { account, publicKey, get sends() { return sourceSends; }, get hash() { return sourceHash; }, stamp };
}
