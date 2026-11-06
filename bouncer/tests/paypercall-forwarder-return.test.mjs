import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { buildExperimentalForwarder } from '../experiments/paypercall-forwarder/build.mjs';
import { CIRCLE_TESTNET_REVIEWED_CODE_HASH, PAYPERCALL_VAULT_CODE_HASHES,
  collectPayPerCallReturnSnapshots, inspectPayPerCallForwarderReturn,
  verifyPayPerCallForwarderReturn } from '../agent/paypercall-forwarder-evidence.mjs';
import { mockHash } from './mock-guarded-payment.mjs';

// All transactions, accounts, graphs and balances in this file are synthetic.
const OWNER = 'buyer.testnet', VAULT = 'vault.buyer.testnet', ADAPTER = 'forward.buyer.testnet';
const TOKEN = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
const NOW = 1_800_000_000_000, MSG = 'bouncer:forwarder-return';
const id = s => mockHash(`paypercall-return-${s}`);
const key = () => nearApi.KeyPair.fromRandom('ed25519').getPublicKey().toString();
const enc = x => Buffer.from(JSON.stringify(x)).toString('base64');
const action = (method, args, deposit = '0') => ({ FunctionCall: { method_name: method, args: enc(args), deposit, gas: 200_000_000_000_000 } });
const receipt = (name, predecessor, receiver, call, extra = {}) => ({ receipt_id: id(name), predecessor_id: predecessor,
  receiver_id: receiver, receipt: { Action: { actions: [call], ...extra } } });
const outcome = (name, block, executor, status, children = [], logs = []) => ({ id: id(name), block_hash: id(block),
  outcome: { executor_id: executor, status, receipt_ids: children.map(id), logs } });
const block = (name, height) => ({ header: { hash: id(name), height, prev_hash: id(`${name}-prev`) } });
const event = data => `EVENT_JSON:${JSON.stringify({ standard: 'nep141', version: '1.0.0', event: 'ft_transfer', data: [data] })}`;

async function fixture() {
  const vaultKey = key(), adapterKey = key();
  const terms = { owner: OWNER, vault: VAULT, adapter: ADAPTER, forwarder_agent_public_key: adapterKey,
    vault_agent_public_key: vaultKey, policy_id: 'data', intent_id: 'one-call', amount: '100', service_id: 7,
    request: 'wrap.testnet', expires_at_ms: NOW + 60_000,
    native_return_cap: '1000000000000000000000000', native_reserve: '1000000000000000000000000' };
  const artifact = await buildExperimentalForwarder(terms, { nowMs: NOW });
  const adapterCode = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(artifact.wasm).digest());
  const offer = { provider: 'provider.testnet', operator: 'operator.testnet', price: '60',
    vault_code_hash: PAYPERCALL_VAULT_CODE_HASHES[0], token_code_hash: CIRCLE_TESTNET_REVIEWED_CODE_HASH,
    escrow_code_hash: id('escrow-code') };
  const root = action('return_tokens', { amount: '40' });
  const transfer = action('ft_transfer_call', { receiver_id: VAULT, amount: '40', memo: MSG, msg: MSG }, '1');
  const receive = action('ft_on_transfer', { sender_id: ADAPTER, amount: '40', msg: MSG });
  const resolve = action('ft_resolve_transfer', { sender_id: ADAPTER, receiver_id: VAULT, amount: '40' });
  const result = { final_execution_status: 'FINAL', status: { SuccessValue: enc('40') },
    transaction: { hash: id('tx'), signer_id: OWNER, receiver_id: ADAPTER, public_key: adapterKey, actions: [root] },
    transaction_outcome: { id: id('tx'), block_hash: id('tx-block'), outcome: { executor_id: OWNER,
      status: { SuccessReceiptId: id('root') }, receipt_ids: [id('root')], logs: [] } },
    receipts: [receipt('root', OWNER, ADAPTER, root), receipt('transfer', ADAPTER, TOKEN, transfer),
      receipt('receive', TOKEN, VAULT, receive, { output_data_receivers: [{ receiver_id: TOKEN, data_id: id('return-data') }] }),
      receipt('resolve', TOKEN, TOKEN, resolve, { input_data_ids: [id('return-data')] })],
    receipts_outcome: [outcome('root', 'adapter-block', ADAPTER, { SuccessReceiptId: id('transfer') }, ['transfer']),
      outcome('transfer', 'token-block', TOKEN, { SuccessReceiptId: id('resolve') }, ['receive', 'resolve'],
        [event({ old_owner_id: ADAPTER, new_owner_id: VAULT, amount: '40', memo: MSG })]),
      outcome('receive', 'vault-block', VAULT, { SuccessValue: enc('0') }, [], ['BOUNCER deposit received']),
      outcome('resolve', 'resolve-block', TOKEN, { SuccessValue: enc('40') })] };
  const snapshots = {
    forwarder_transaction: { block_hash: id('tx-block'), code_hash: adapterCode, keys: [] },
    forwarder_execution: { block_hash: id('adapter-block'), code_hash: adapterCode, keys: [] },
    vault_callback: { block_hash: id('vault-block'), code_hash: offer.vault_code_hash, keys: [] },
    token_states: [{ block_hash: id('token-block'), code_hash: offer.token_code_hash },
      { block_hash: id('resolve-block'), code_hash: offer.token_code_hash }],
    blocks: [block('tx-block', 10), block('adapter-block', 11), block('token-block', 12),
      block('vault-block', 13), block('resolve-block', 14)] };
  return { terms, offer, amount: '40', returned: { txHash: id('tx'), result }, snapshots };
}
const verify = f => verifyPayPerCallForwarderReturn(f);

test('correlates one complete vault return without claiming its order-specific origin', async () => {
  const f = await fixture(), proof = await verify(f);
  assert.equal(proof.status, 'VAULT_RETURN_RECEIPTS_CORRELATED');
  assert.equal(proof.forwarder_to_vault_return_verified, true);
  assert.equal(proof.returned_atoms, '40');
  assert.equal(proof.order_refund_origin_verified, false);
  assert.equal(proof.rolling_budget_restoration_verified, false);
  assert.equal(proof.independent_fulfillment_verified, false);
  assert.equal(proof.deployed_source_equivalence_verified, false);
  assert.equal(proof.retry_authorized, false); assert.equal(proof.do_not_resend_original, true);
  assert.equal(proof.signed, false); assert.equal(proof.sent, false);
});

test('return fails closed on mismatched identity, callback, promise data, token event, code and chronology', async () => {
  const f = await fixture();
  const mutations = [
    x => { x.returned.txHash = id('other-tx'); },
    x => { x.returned.result.final_execution_status = 'EXECUTED'; },
    x => { x.returned.result.transaction.signer_id = 'other.testnet'; },
    x => { x.returned.result.transaction.public_key = key(); },
    x => { x.returned.result.transaction.actions[0].FunctionCall.deposit = '1'; },
    x => { x.returned.result.receipts[0].receipt.Action.actions[0].FunctionCall.args = enc({ amount: '39' }); },
    x => { x.returned.result.receipts_outcome[0].outcome.receipt_ids = []; },
    x => { x.returned.result.receipts[1].receipt.Action.actions[0].FunctionCall.args = enc({ receiver_id: 'other.testnet', amount: '40', memo: MSG, msg: MSG }); },
    x => { x.returned.result.receipts[1].receipt.Action.actions[0].FunctionCall.deposit = '0'; },
    x => { x.returned.result.receipts_outcome[1].outcome.logs = []; },
    x => { x.returned.result.receipts[2].receipt.Action.actions[0].FunctionCall.args = enc({ sender_id: 'other.testnet', amount: '40', msg: MSG }); },
    x => { x.returned.result.receipts_outcome[2].outcome.status = { SuccessValue: enc('40') }; },
    x => { x.returned.result.receipts_outcome[2].outcome.logs = []; },
    x => { x.returned.result.receipts[2].receipt.Action.output_data_receivers = []; },
    x => { x.returned.result.receipts[2].receipt.Action.output_data_receivers[0].receiver_id = VAULT; },
    x => { x.returned.result.receipts[3].receipt.Action.input_data_ids = [id('wrong-data')]; },
    x => { x.returned.result.receipts_outcome[3].outcome.status = { Failure: {} }; },
    x => { x.returned.result.receipts_outcome[3].outcome.status = { SuccessValue: enc('39') }; },
    x => { x.returned.result.receipts.push(structuredClone(x.returned.result.receipts[1])); },
    x => { x.snapshots.forwarder_transaction.keys.push({ public_key: key() }); },
    x => { x.snapshots.forwarder_execution.code_hash = id('changed-forwarder'); },
    x => { x.snapshots.vault_callback.keys.push({ public_key: key() }); },
    x => { x.snapshots.token_states[1].code_hash = id('changed-token'); },
    x => { x.snapshots.blocks[3].header.height = 15; },
  ];
  for (const [i, mutate] of mutations.entries()) {
    const x = structuredClone(f); mutate(x);
    await assert.rejects(verify(x), undefined, `return mutation ${i}`);
  }
  for (const amount of ['0', '01', '101', 'not-a-number', 40, null]) {
    await assert.rejects(verify({ ...f, amount }));
  }
});

function providerFor(f, options = {}) {
  const calls = [], states = new Map();
  for (const [account, entries] of [[ADAPTER, [f.snapshots.forwarder_transaction, f.snapshots.forwarder_execution]],
    [VAULT, [f.snapshots.vault_callback]], [TOKEN, f.snapshots.token_states]]) {
    for (const state of entries) states.set(`${account}:${state.block_hash}`, state);
  }
  return { calls,
    async viewNodeStatus() { calls.push('status'); return { chain_id: options.chain ?? 'testnet' }; },
    async txStatusReceipts(hash, owner, wait) {
      calls.push('receipt'); assert.equal(hash, f.returned.txHash); assert.equal(owner, OWNER); assert.equal(wait, 'FINAL');
      if (options.missingReceipt) throw new Error('unavailable');
      return structuredClone(f.returned.result);
    },
    async viewBlock({ blockId }) {
      calls.push('block'); const b = f.snapshots.blocks.find(x => x.header.hash === blockId);
      if (!b) throw new Error('missing block');
      return structuredClone(options.mixedBlock ? { ...b, header: { ...b.header, hash: id('wrong') } } : b);
    },
    async query(query) {
      calls.push('query');
      assert.ok(['view_account', 'view_access_key_list'].includes(query.request_type));
      const state = states.get(`${query.account_id}:${query.block_id}`);
      if (!state) throw new Error('missing state');
      return query.request_type === 'view_account' ? { block_hash: state.block_hash, code_hash: state.code_hash } :
        { block_hash: state.block_hash, keys: structuredClone(state.keys) };
    } };
}

test('read-only collector and testnet inspector fetch the original return and pinned code/key views only', async () => {
  const f = await fixture(), p = providerFor(f);
  const snapshots = await collectPayPerCallReturnSnapshots({ ...f, provider: p });
  assert.equal((await verify({ ...f, snapshots })).forwarder_to_vault_return_verified, true);
  p.calls.length = 0;
  const proof = await inspectPayPerCallForwarderReturn({ terms: f.terms, offer: f.offer, amount: f.amount,
    returnHash: f.returned.txHash, provider: p });
  assert.equal(proof.network, 'testnet'); assert.equal(proof.historical_views_collected, true);
  assert.equal(proof.order_refund_origin_verified, false); assert.equal(proof.operator_contacted, false);
  assert.equal(p.calls.filter(x => x === 'receipt').length, 1);
  assert.ok(p.calls.every(x => ['status', 'receipt', 'block', 'query'].includes(x)));
  assert.equal(typeof p.sendTransaction, 'undefined');
});

test('testnet return inspection stops on wrong chain, unavailable history and malformed retained input', async () => {
  const f = await fixture();
  for (const options of [{ chain: 'mainnet' }, { missingReceipt: true }, { mixedBlock: true }]) {
    const p = providerFor(f, options);
    await assert.rejects(inspectPayPerCallForwarderReturn({ terms: f.terms, offer: f.offer, amount: f.amount,
      returnHash: f.returned.txHash, provider: p }));
    if (options.chain) assert.equal(p.calls.includes('receipt'), false);
  }
  const p = providerFor(f);
  await assert.rejects(inspectPayPerCallForwarderReturn({ terms: f.terms, offer: { ...f.offer, token_code_hash: id('unreviewed') },
    amount: f.amount, returnHash: f.returned.txHash, provider: p }));
  await assert.rejects(inspectPayPerCallForwarderReturn({ terms: f.terms, offer: f.offer, amount: '101',
    returnHash: f.returned.txHash, provider: p }));
  assert.equal(p.calls.length, 0);
});
