import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { buildExperimentalForwarder } from '../experiments/paypercall-forwarder/build.mjs';
import { buildPayPerCallMessage } from '../agent/paypercall-inspect.mjs';
import { PAYPERCALL_VAULT_CODE_HASHES, CIRCLE_TESTNET_REVIEWED_CODE_HASH, preparePayPerCallEvidence,
  verifyPayPerCallForwarderEvidence, inspectPayPerCallForwarderEvidence } from '../agent/paypercall-forwarder-evidence.mjs';
import { mockHash } from './mock-guarded-payment.mjs';

// These are wholly synthetic, caller-supplied graphs and historical snapshots.
// A passing test is not a public-chain payment or independent fulfillment.
const OWNER = 'buyer.testnet', VAULT = 'vault.buyer.testnet', ADAPTER = 'forward.buyer.testnet';
const PROVIDER = 'provider.testnet', OPERATOR = 'operator.testnet';
const TOKEN = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
const ESCROW = 'devx-paypercall.testnet', NOW = 1_800_000_000_000;
const k = () => nearApi.KeyPair.fromRandom('ed25519').getPublicKey().toString();
const enc = x => Buffer.from(JSON.stringify(x)).toString('base64');
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const id = name => mockHash(`paypercall-proof-${name}`);
const action = (method, args, deposit = '0', gas = 200_000_000_000_000) =>
  ({ FunctionCall: { method_name: method, args: enc(args), deposit, gas } });
const receipt = (name, predecessor, receiver, call) => ({ receipt_id: id(name), predecessor_id: predecessor,
  receiver_id: receiver, receipt: { Action: { actions: [call] } } });
const outcome = (name, block, executor, status, children = [], logs = []) => ({ id: id(name), block_hash: id(block),
  outcome: { executor_id: executor, status, receipt_ids: children.map(id), logs } });
const event = (standard, name, data) => `EVENT_JSON:${JSON.stringify({ standard, version: '1.0.0', event: name, data: [data] })}`;
const tx = (name, signer, receiver, publicKey, call, root) => ({ hash: id(name), signer_id: signer, receiver_id: receiver,
  public_key: publicKey, actions: [call], root: id(root) });
function result(t, txBlock, receipts, outcomes, value = '') {
  const { root, ...transaction } = t;
  return { final_execution_status: 'FINAL', status: { SuccessValue: value }, transaction,
    transaction_outcome: { id: transaction.hash, block_hash: id(txBlock), outcome: {
      executor_id: transaction.signer_id, status: { SuccessReceiptId: root }, receipt_ids: [root], logs: [] } },
    receipts, receipts_outcome: outcomes };
}
function block(name, height, prev) { return { header: { hash: id(name), height, prev_hash: id(prev) } }; }

async function fixture() {
  const vaultKey = k(), adapterKey = k();
  const terms = { owner: OWNER, vault: VAULT, adapter: ADAPTER, forwarder_agent_public_key: adapterKey,
    vault_agent_public_key: vaultKey, policy_id: 'data', intent_id: 'one-call', amount: '100', service_id: 7,
    request: 'wrap.testnet', expires_at_ms: NOW + 60_000,
    native_return_cap: '1000000000000000000000000', native_reserve: '1000000000000000000000000' };
  const artifact = await buildExperimentalForwarder(terms, { nowMs: NOW });
  const r = artifact.review, adapterCode = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(artifact.wasm).digest());
  const offer = { provider: PROVIDER, operator: OPERATOR, price: '60', vault_code_hash: PAYPERCALL_VAULT_CODE_HASHES[0],
    token_code_hash: id('token-code'), escrow_code_hash: id('escrow-code') };
  const signedFunding = action('execute_exact_ft', { intent_id: r.intent_id });
  const transfer = action('ft_transfer', { receiver_id: ADAPTER, amount: '100', memo: r.intent_memo }, '1');
  const cb = action('after_exact_ft_transfer', { intent_id: r.intent_id, policy_id: r.policy_id, token: TOKEN,
    amount: '100', bucket: 24, policy_revision: 1 });
  const fundingResult = result(tx('fund-tx', OWNER, VAULT, vaultKey, signedFunding, 'fund-root'), 'fund-tx-block', [
    receipt('fund-root', OWNER, VAULT, signedFunding), receipt('fund-transfer', VAULT, TOKEN, transfer),
    receipt('fund-callback', VAULT, VAULT, cb),
  ], [
    outcome('fund-root', 'fund-exec-block', VAULT, { SuccessReceiptId: id('fund-callback') }, ['fund-transfer', 'fund-callback'],
      ['BOUNCER exact FT intent consumed; transfer initiated']),
    outcome('fund-transfer', 'fund-token-block', TOKEN, { SuccessValue: '' }, [],
      [event('nep141', 'ft_transfer', { old_owner_id: VAULT, new_owner_id: ADAPTER, amount: '100', memo: r.intent_memo })]),
    outcome('fund-callback', 'fund-callback-block', VAULT, { SuccessValue: '' }, [],
      ['BOUNCER exact FT transfer succeeded; intent stays consumed']),
  ]);
  const msg = buildPayPerCallMessage({ service_id: 7, request: terms.request, max_price: '100' }).msg;
  const openAction = action('open', {}, '0', 300_000_000_000_000);
  const tokenCall = action('ft_transfer_call', { receiver_id: ESCROW, amount: '100', memo: 'bouncer:experimental-forwarder', msg }, '1');
  const receiver = action('ft_on_transfer', { sender_id: ADAPTER, amount: '100', msg });
  const resolver = action('ft_resolve_transfer', { sender_id: ADAPTER, receiver_id: ESCROW, amount: '100' });
  const deadline = String(NOW + 120_000);
  const requestEvent = { call_id: 7, service_id: 7, payer: ADAPTER, referrer: null, token: TOKEN,
    amount: '60', request_hash: r.request_hash, deadline_ms: deadline, request: terms.request };
  const openingResult = result(tx('open-tx', OWNER, ADAPTER, adapterKey, openAction, 'open-root'), 'open-tx-block', [
    receipt('open-root', OWNER, ADAPTER, openAction), receipt('open-token', ADAPTER, TOKEN, tokenCall),
    receipt('open-receiver', TOKEN, ESCROW, receiver), receipt('open-resolver', TOKEN, TOKEN, resolver),
  ], [
    outcome('open-root', 'adapter-block', ADAPTER, { SuccessReceiptId: id('open-token') }, ['open-token']),
    outcome('open-token', 'open-token-block', TOKEN, { SuccessReceiptId: id('open-resolver') }, ['open-receiver', 'open-resolver'],
      [event('nep141', 'ft_transfer', { old_owner_id: ADAPTER, new_owner_id: ESCROW, amount: '100', memo: 'bouncer:experimental-forwarder' })]),
    outcome('open-receiver', 'escrow-open-block', ESCROW, { SuccessValue: enc('40') }, [], [event('paypercall', 'call_requested', requestEvent)]),
    outcome('open-resolver', 'resolver-block', TOKEN, { SuccessValue: enc('60') }),
  ], enc('60'));
  const answerBytes = Buffer.from('{"token":"wrap.testnet","source":"fixture"}\n'), answerHash = hash(answerBytes);
  const fulfillAction = action('fulfill', { call_id: 7, result_hash: answerHash, result_uri: null }, '0', 250_000_000_000_000);
  const payoutAction = action('ft_transfer', { receiver_id: PROVIDER, amount: '60' }, '1');
  const fulfilledEvent = { call_id: 7, result_hash: answerHash, result_uri: null, provider_amount: '60', referrer_amount: '0' };
  const fulfillmentResult = result(tx('fulfill-tx', OPERATOR, ESCROW, k(), fulfillAction, 'fulfill-root'), 'fulfill-tx-block', [
    receipt('fulfill-root', OPERATOR, ESCROW, fulfillAction), receipt('payout', ESCROW, TOKEN, payoutAction),
  ], [
    outcome('fulfill-root', 'escrow-fulfill-block', ESCROW, { SuccessValue: '' }, ['payout'], [event('paypercall', 'call_fulfilled', fulfilledEvent)]),
    outcome('payout', 'payout-block', TOKEN, { SuccessValue: '' }, [],
      [event('nep141', 'ft_transfer', { old_owner_id: ESCROW, new_owner_id: PROVIDER, amount: '60' })]),
  ]);
  const intent = { intent_id: r.intent_id, policy_id: r.policy_id, token: TOKEN, payee: ADAPTER, amount: '100',
    memo: r.intent_memo, review_hash: r.review_sha256, expires_at_ms: String(r.expires_at_ms), agent_public_key: vaultKey,
    policy_revision: 1, payee_revision: 1, agent_revision: 1, consumed: true, cancelled: false, active: false };
  const service = { provider: PROVIDER, operator: OPERATOR, token: TOKEN, price: '60', active: true };
  const call = { service_id: 7, payer: ADAPTER, token: TOKEN, amount: '60', referrer: null,
    request_hash: r.request_hash, deadline_ms: deadline, status: 'Fulfilled', result_hash: answerHash, result_uri: null };
  const tokenBlocks = ['fund-token-block', 'open-token-block', 'payout-block', 'fund-token-prev', 'adapter-block'];
  const snapshots = {
    vault_transaction: { block_hash: id('fund-tx-block'), code_hash: offer.vault_code_hash, keys: [] },
    vault_execution: { block_hash: id('fund-exec-block'), code_hash: offer.vault_code_hash, keys: [] },
    intent: { block_hash: id('fund-exec-block'), view: intent },
    adapter_funding: { block_hash: id('fund-token-block'), code_hash: adapterCode, keys: [] },
    adapter_transaction: { block_hash: id('open-tx-block'), code_hash: adapterCode, keys: [] },
    adapter_execution: { block_hash: id('adapter-block'), code_hash: adapterCode, keys: [] },
    token_states: tokenBlocks.map(n => ({ block_hash: id(n), code_hash: offer.token_code_hash })),
    escrow_states: ['escrow-open-block', 'escrow-fulfill-block'].map(n => ({ block_hash: id(n), code_hash: offer.escrow_code_hash })),
    service_open: { block_hash: id('escrow-open-block'), view: structuredClone(service) },
    service_fulfillment: { block_hash: id('escrow-fulfill-block'), view: structuredClone(service) },
    call_fulfillment: { block_hash: id('escrow-fulfill-block'), view: call },
    blocks: [block('fund-token-block', 10, 'fund-token-prev'), block('fund-callback-block', 11, 'fund-token-block'),
      block('open-tx-block', 12, 'fund-callback-block'), block('open-token-block', 14, 'adapter-block'),
      block('escrow-open-block', 15, 'open-token-block'), block('escrow-fulfill-block', 18, 'fulfill-tx-block'),
      block('fund-tx-block', 8, 'earlier'), block('fund-exec-block', 9, 'fund-tx-block'),
      block('adapter-block', 13, 'open-tx-block'), block('payout-block', 19, 'escrow-fulfill-block')],
    balances: [{ block_hash: id('fund-token-prev'), account_id: ADAPTER, token: TOKEN, amount: '0' },
      { block_hash: id('fund-token-block'), account_id: ADAPTER, token: TOKEN, amount: '100' },
      { block_hash: id('adapter-block'), account_id: ADAPTER, token: TOKEN, amount: '100' }],
  };
  return { terms, offer, funding: { txHash: id('fund-tx'), result: fundingResult },
    opening: { txHash: id('open-tx'), result: openingResult },
    fulfillment: { txHash: id('fulfill-tx'), result: fulfillmentResult }, answerBytes, snapshots };
}
const verify = f => verifyPayPerCallForwarderEvidence(f);

test('correlates a one-shot exact payment, escrow open, answer commitment and separately linked provider payout', async () => {
  const f = await fixture(), proof = await verify(f);
  assert.equal(proof.status, 'RECEIPTS_AND_ANSWER_HASH_CORRELATED');
  assert.equal(proof.guarded_forwarder_funding_verified, true); assert.equal(proof.escrow_opening_verified, true);
  assert.equal(proof.provider_token_payout_verified, true); assert.equal(proof.answer_hash_matches_onchain_commitment, true);
  assert.equal(proof.escrowed_atoms, '60'); assert.equal(proof.maximum_atoms, '100');
  assert.equal(proof.call_id, 7); assert.equal(proof.answer_sha256, hash(f.answerBytes));
  assert.equal(proof.seller_http_delivery_verified, false); assert.equal(proof.independent_fulfillment_verified, false);
  assert.equal(proof.deployed_source_equivalence_verified, false); assert.equal(proof.retry_authorized, false);
  assert(!JSON.stringify(proof).includes(f.answerBytes.toString()));
});

test('historical preparation is offline, exact, testnet-only and not an authorization', async () => {
  const f = await fixture(), prepared = await preparePayPerCallEvidence(f.terms, f.offer);
  assert.equal(prepared.review.sent, false); assert.equal(prepared.review.signed, false);
  for (const change of [
    x => { x.offer.price = '101'; }, x => { x.offer.price = '0'; }, x => { x.offer.price = '01'; },
    x => { x.offer.vault_code_hash = id('other-vault'); }, x => { x.offer.provider = 'seller.near'; },
    x => { x.offer.operator = 'bad'; }, x => { x.offer.escrow_code_hash = 'invalid'; },
    x => { x.terms.forwarder_agent_public_key = x.terms.vault_agent_public_key; },
    x => { x.terms.request = '\ud800'; }, x => { x.terms.token = 'attacker.testnet'; },
  ]) { const x = structuredClone(f); change(x); await assert.rejects(preparePayPerCallEvidence(x.terms, x.offer)); }
});

test('funding terms, locked intent, keyless vault, transfer event and callback must all match', async () => {
  const f = await fixture();
  const mutations = [
    x => { x.funding.result.final_execution_status = 'EXECUTED'; },
    x => { x.funding.result.transaction.public_key = k(); },
    x => { x.funding.result.transaction.actions[0].FunctionCall.args = enc({ intent_id: 'other' }); },
    x => { x.snapshots.vault_execution.keys = [{ public_key: k() }]; },
    x => { x.snapshots.vault_transaction.code_hash = id('other-vault'); },
    x => { x.snapshots.intent.view.review_hash = 'f'.repeat(64); },
    x => { x.snapshots.intent.view.consumed = false; },
    x => { x.funding.result.receipts_outcome[1].outcome.logs = []; },
    x => { x.funding.result.receipts_outcome[2].outcome.status = { Failure: {} }; },
    x => { x.funding.result.receipts_outcome[0].outcome.receipt_ids = [id('fund-callback')]; },
    x => { x.funding.result.receipts[0].receipt.Action.actions[0].FunctionCall.deposit = '1'; },
    x => { x.snapshots.token_states[0].code_hash = id('other-token'); },
  ];
  for (const [i, change] of mutations.entries()) { const x = structuredClone(f); change(x); await assert.rejects(verify(x), undefined, `funding mutation ${i}`); }
});

test('one-shot forwarder, escrow message, resolver and original opening event cannot be substituted or borrowed', async () => {
  const f = await fixture();
  const mutations = [
    x => { x.opening.result.transaction.public_key = k(); },
    x => { x.opening.result.receipts[0].receipt.Action.actions[0].FunctionCall.deposit = '1'; },
    x => { x.opening.result.receipts_outcome[0].outcome.receipt_ids = []; },
    x => { x.opening.result.receipts[1].receipt.Action.actions[0].FunctionCall.args = enc({ receiver_id: 'evil.testnet', amount: '100', msg: '{}' }); },
    x => { x.opening.result.receipts_outcome[1].outcome.logs = []; },
    x => { x.opening.result.receipts_outcome[2].outcome.status = { SuccessValue: enc('0') }; },
    x => { x.opening.result.receipts_outcome[2].outcome.logs.push(x.opening.result.receipts_outcome[2].outcome.logs[0]); },
    x => { x.opening.result.receipts_outcome[3].outcome.status = { SuccessValue: enc('100') }; },
    x => { x.opening.result.receipts.push(structuredClone(x.opening.result.receipts[1])); },
    x => { x.snapshots.adapter_execution.keys.push({ public_key: k() }); },
    x => { x.snapshots.adapter_funding.keys.push({ public_key: k() }); },
    x => { x.snapshots.adapter_transaction.code_hash = id('wrong-forwarder'); },
    x => { x.snapshots.service_open.view.provider = 'other.testnet'; },
    x => { x.snapshots.escrow_states[0].block_hash = id('wrong-block'); },
  ];
  for (const [i, change] of mutations.entries()) { const x = structuredClone(f); change(x); await assert.rejects(verify(x), undefined, `opening mutation ${i}`); }
});

test('answer commitment and detached provider payout are distinct required facts', async () => {
  const f = await fixture();
  const mutations = [
    x => { x.answerBytes = Buffer.from('different'); },
    x => { x.answerBytes = Buffer.alloc(0); },
    x => { x.fulfillment.result.transaction.signer_id = 'stranger.testnet'; },
    x => { x.fulfillment.result.receipts[1].receipt.Action.actions[0].FunctionCall.args = enc({ receiver_id: 'other.testnet', amount: '60' }); },
    x => { x.fulfillment.result.receipts_outcome[0].outcome.receipt_ids = []; },
    x => { x.fulfillment.result.receipts_outcome[1].outcome.status = { Failure: {} }; },
    x => { x.fulfillment.result.receipts_outcome[1].outcome.logs = []; },
    x => { x.snapshots.call_fulfillment.view.status = 'Refunded'; },
    x => { x.snapshots.call_fulfillment.view.deadline_ms = '1'; },
    x => { x.snapshots.service_fulfillment.view.operator = 'other.testnet'; },
  ];
  for (const [i, change] of mutations.entries()) { const x = structuredClone(f); change(x); await assert.rejects(verify(x), undefined, `fulfillment mutation ${i}`); }
});

test('block order and zero/maximum forwarder balances are required but do not establish token provenance', async () => {
  const f = await fixture();
  for (const change of [
    x => { x.snapshots.blocks[1].header.height = 12; },
    x => { x.snapshots.blocks[4].header.height = 18; },
    x => { x.snapshots.balances[0].amount = '1'; },
    x => { x.snapshots.balances[1].amount = '101'; },
    x => { x.snapshots.balances[2].amount = '99'; },
    x => { x.snapshots.balances.push(structuredClone(x.snapshots.balances[0])); },
    x => { x.snapshots.token_states[3].code_hash = id('changed-token'); },
  ]) { const x = structuredClone(f); change(x); await assert.rejects(verify(x)); }
});

function syntheticHistoricalProvider(f, options = {}) {
  const calls = [], s = f.snapshots;
  const states = new Map();
  for (const [account, entries] of [
    [VAULT, [s.vault_transaction, s.vault_execution]],
    [ADAPTER, [s.adapter_funding, s.adapter_transaction, s.adapter_execution]],
    [TOKEN, s.token_states], [ESCROW, s.escrow_states],
  ]) for (const state of entries) states.set(`${account}|${state.block_hash}`, state);
  const rpc = { calls,
    async viewNodeStatus() { calls.push(['status']); return { chain_id: options.chain ?? 'testnet' }; },
    async txStatusReceipts(txHash, signer, wait) {
      calls.push(['receipt', txHash, signer, wait]); assert.equal(wait, 'FINAL');
      const entry = [f.funding, f.opening, f.fulfillment].find(x => x.txHash === txHash);
      if (!entry || entry.result.transaction.signer_id !== signer || options.missingReceipt) throw new Error('not found');
      return structuredClone(entry.result);
    },
    async viewBlock({ blockId }) {
      calls.push(['block', blockId]); const block = s.blocks.find(x => x.header.hash === blockId);
      if (!block) throw new Error('historical block missing');
      return structuredClone(block);
    },
    async query(q) {
      calls.push(['query', q]); const state = states.get(`${q.account_id}|${q.block_id}`);
      if (!state || options.missingState) throw new Error('historical state missing');
      const block_hash = options.mixedBlock ? id('unrelated-block') : q.block_id;
      if (q.request_type === 'view_account') return { block_hash, code_hash: state.code_hash };
      if (q.request_type === 'view_access_key_list') return { block_hash, keys: state.keys };
      throw new Error('unsupported query');
    },
    async callFunctionRaw(account, method, args, { blockId }) {
      calls.push(['view', account, method, args, blockId]);
      let value;
      if (method === 'get_exact_ft_intent') value = s.intent.block_hash === blockId && s.intent.view;
      else if (method === 'get_service') value = [s.service_open, s.service_fulfillment].find(v => v.block_hash === blockId)?.view;
      else if (method === 'get_call') value = s.call_fulfillment.block_hash === blockId && s.call_fulfillment.view;
      else if (method === 'ft_balance_of') value = s.balances.find(v => v.block_hash === blockId && v.account_id === args.account_id)?.amount;
      if (value === undefined || value === false) throw new Error('historical view unavailable');
      return { block_hash: options.mixedView ? id('unrelated-block') : blockId, result: [...Buffer.from(JSON.stringify(value))] };
    },
  };
  return rpc;
}
function request(f, provider, overrides = {}) {
  return { terms: f.terms, offer: f.offer, fundingHash: f.funding.txHash, openingHash: f.opening.txHash,
    fulfillmentHash: f.fulfillment.txHash, fulfillmentSigner: OPERATOR, answerBytes: f.answerBytes, provider, ...overrides };
}

test('testnet inspector reads only original hashes and block-pinned historical views', async () => {
  const f = await fixture();
  // Supply the reviewed Circle code pin to the pure synthetic provider. No
  // Circle implementation or public testnet is contacted by this test.
  f.offer.token_code_hash = CIRCLE_TESTNET_REVIEWED_CODE_HASH;
  for (const item of f.snapshots.token_states) item.code_hash = CIRCLE_TESTNET_REVIEWED_CODE_HASH;
  const p = syntheticHistoricalProvider(f), proof = await inspectPayPerCallForwarderEvidence(request(f, p));
  assert.equal(proof.historical_views_collected, true); assert.equal(proof.network, 'testnet');
  assert.equal(proof.operator_contacted, false); assert.equal(proof.sent, false);
  assert.equal(proof.independent_fulfillment_verified, false);
  assert.equal(p.calls.filter(c => c[0] === 'receipt').length, 3);
  assert.ok(p.calls.every(c => ['status', 'receipt', 'block', 'query', 'view'].includes(c[0])));
  assert.ok(p.calls.filter(c => c[0] === 'query').every(c =>
    ['view_account', 'view_access_key_list'].includes(c[1].request_type) && c[1].block_id));
  assert.ok(p.calls.filter(c => c[0] === 'view').every(c => c[4]));
});

test('testnet inspection rejects wrong chain, stale/mixed histories and unavailable original receipts', async () => {
  const f = await fixture(); f.offer.token_code_hash = CIRCLE_TESTNET_REVIEWED_CODE_HASH;
  for (const item of f.snapshots.token_states) item.code_hash = CIRCLE_TESTNET_REVIEWED_CODE_HASH;
  for (const options of [{ chain: 'mainnet' }, { missingReceipt: true }, { missingState: true },
    { mixedBlock: true }, { mixedView: true }]) {
    const p = syntheticHistoricalProvider(f, options);
    await assert.rejects(inspectPayPerCallForwarderEvidence(request(f, p)));
    if (options.chain) assert.equal(p.calls.filter(c => c[0] === 'receipt').length, 0);
  }
  const p = syntheticHistoricalProvider(f);
  await assert.rejects(inspectPayPerCallForwarderEvidence(request(f, p, { fulfillmentSigner: 'stranger.testnet' })));
  await assert.rejects(inspectPayPerCallForwarderEvidence(request(f, p, { openingHash: f.funding.txHash })));
  await assert.rejects(inspectPayPerCallForwarderEvidence(request(f, p, { offer: { ...f.offer, token_code_hash: id('unreviewed-token') } })));
  assert.equal(p.calls.length, 0, 'malformed identity must stop before RPC');
});
