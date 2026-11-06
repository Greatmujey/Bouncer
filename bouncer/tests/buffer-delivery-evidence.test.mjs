/** All receipts, orders, report text and RPC views in this file are synthetic. */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { buildBufferForwarder, BUFFER_TESTNET_CONTRACT as SELLER } from '../experiments/buffer-forwarder/build.mjs';
import { BUFFER_V12_CODE_HASH, prepareBufferDeliveryEvidence, verifyBufferDeliveryEvidence,
  inspectBufferDeliveryEvidence, fetchBufferPrivateOrder } from '../agent/buffer-delivery-evidence.mjs';
import { CIRCLE_TESTNET_REVIEWED_CODE_HASH } from '../agent/paypercall-forwarder-evidence.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { mockHash } from './mock-guarded-payment.mjs';

const OWNER = 'buyer.testnet', VAULT = 'vault.buyer.testnet', ADAPTER = 'forward.buyer.testnet', AGENT = 'buffer-agent.testnet';
const NOW = 1_800_000_000_000, BRIEF = 'A private fixture brief for testing Buffer verification.', REPORT = 'A synthetic report, not an independent delivery. '.repeat(8).trim();
const key = () => nearApi.KeyPair.fromRandom('ed25519').getPublicKey().toString();
const enc = value => Buffer.from(JSON.stringify(value)).toString('base64');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const id = name => mockHash(`buffer-proof-${name}`);
const action = (method, args, deposit = '0', gas = 200_000_000_000_000) => ({ FunctionCall: { method_name: method, args: enc(args), deposit, gas } });
const receipt = (name, predecessor, receiver, call) => ({ receipt_id: id(name), predecessor_id: predecessor,
  receiver_id: receiver, receipt: { Action: { actions: [call] } } });
const outcome = (name, block, executor, status, children = [], logs = []) => ({ id: id(name), block_hash: id(block),
  outcome: { executor_id: executor, status, receipt_ids: children.map(id), logs } });
const event = (standard, name, data, version = '1.0.0') => `EVENT_JSON:${JSON.stringify({ standard, version, event: name, data: [data] })}`;
const tx = (name, signer, receiver, publicKey, call, root) => ({ hash: id(name), signer_id: signer, receiver_id: receiver,
  public_key: publicKey, actions: [call], root: id(root) });
function result(t, txBlock, receipts, outcomes, value = '') {
  const { root, ...transaction } = t;
  return { final_execution_status: 'FINAL', status: { SuccessValue: value }, transaction,
    transaction_outcome: { id: transaction.hash, block_hash: id(txBlock), outcome: {
      executor_id: transaction.signer_id, status: { SuccessReceiptId: root }, receipt_ids: [root], logs: [] } },
    receipts, receipts_outcome: outcomes };
}
const block = (name, height, prev) => ({ header: { hash: id(name), height, prev_hash: id(prev) } });

async function fixture() {
  const vaultKey = key(), adapterKey = key();
  const terms = { owner: OWNER, vault: VAULT, adapter: ADAPTER, forwarder_agent_public_key: adapterKey,
    vault_agent_public_key: vaultKey, policy_id: 'data', intent_id: 'buffer-1', amount: '100',
    expires_at_ms: NOW + 60_000, native_return_cap: '1000000000000000000000000', native_reserve: '1000000000000000000000000',
    api_order_id: '123e4567-e89b-12d3-a456-426614174000', onchain_order_id: 'o-123456789abc',
    sku: 'weekly-market-brief', brief_sha256: sha(BRIEF) };
  const artifact = await buildBufferForwarder(terms, { nowMs: NOW }), r = artifact.review;
  const adapterCode = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(artifact.wasm).digest());
  const pins = { vault_code_hash: BUFFER_V12_CODE_HASH, token_code_hash: id('token-code'), seller_code_hash: id('seller-code'), fulfillment_signer: AGENT };
  const fund = action('execute_exact_ft', { intent_id: r.intent_id });
  const transfer = action('ft_transfer', { receiver_id: ADAPTER, amount: '100', memo: r.intent_memo }, '1');
  const callback = action('after_exact_ft_transfer', { intent_id: r.intent_id, policy_id: r.policy_id, token: TOKEN,
    amount: '100', bucket: 24, policy_revision: 1 });
  const funding = { txHash: id('fund-tx'), result: result(tx('fund-tx', OWNER, VAULT, vaultKey, fund, 'fund-root'), 'fund-tx-block', [
    receipt('fund-root', OWNER, VAULT, fund), receipt('fund-transfer', VAULT, TOKEN, transfer), receipt('fund-callback', VAULT, VAULT, callback),
  ], [
    outcome('fund-root', 'fund-exec-block', VAULT, { SuccessReceiptId: id('fund-callback') }, ['fund-transfer', 'fund-callback'],
      ['BOUNCER exact FT intent consumed; transfer initiated']),
    outcome('fund-transfer', 'fund-token-block', TOKEN, { SuccessValue: '' }, [],
      [event('nep141', 'ft_transfer', { old_owner_id: VAULT, new_owner_id: ADAPTER, amount: '100', memo: r.intent_memo })]),
    outcome('fund-callback', 'fund-callback-block', VAULT, { SuccessValue: '' }, [],
      ['BOUNCER exact FT transfer succeeded; intent stays consumed']),
  ]) };
  funding.result.receipts[1].receipt.Action.output_data_receivers = [{ receiver_id: VAULT, data_id: id('fund-result') }];
  funding.result.receipts[2].receipt.Action.input_data_ids = [id('fund-result')];
  const msg = JSON.stringify({ order_id: r.onchain_order_id, sku: r.sku });
  const open = action('open', {}, '0', 300_000_000_000_000);
  const tokenCall = action('ft_transfer_call', { receiver_id: SELLER, amount: '100', memo: 'bouncer:experimental-forwarder', msg }, '1');
  const receiver = action('ft_on_transfer', { sender_id: ADAPTER, amount: '100', msg });
  const resolver = action('ft_resolve_transfer', { sender_id: ADAPTER, receiver_id: SELLER, amount: '100' });
  const paid = { order_id: r.onchain_order_id, sku: r.sku, customer: ADAPTER, amount: '100' };
  const opening = { txHash: id('open-tx'), result: result(tx('open-tx', OWNER, ADAPTER, adapterKey, open, 'open-root'), 'open-tx-block', [
    receipt('open-root', OWNER, ADAPTER, open), receipt('open-token', ADAPTER, TOKEN, tokenCall),
    receipt('open-receiver', TOKEN, SELLER, receiver), receipt('open-resolver', TOKEN, TOKEN, resolver),
  ], [
    outcome('open-root', 'adapter-block', ADAPTER, { SuccessReceiptId: id('open-token') }, ['open-token']),
    outcome('open-token', 'open-token-block', TOKEN, { SuccessReceiptId: id('open-resolver') }, ['open-receiver', 'open-resolver'],
      [event('nep141', 'ft_transfer', { old_owner_id: ADAPTER, new_owner_id: SELLER, amount: '100', memo: 'bouncer:experimental-forwarder' })]),
    outcome('open-receiver', 'seller-paid-block', SELLER, { SuccessValue: enc('0') }, [], [event('buffer', 'payment_received', paid, '1.1.0')]),
    outcome('open-resolver', 'resolver-block', TOKEN, { SuccessValue: enc('100') }),
  ], enc('100')) };
  opening.result.receipts[2].receipt.Action.output_data_receivers = [{ receiver_id: TOKEN, data_id: id('open-result') }];
  opening.result.receipts[3].receipt.Action.input_data_ids = [id('open-result')];
  const digest = sha(REPORT), fulfillAction = action('mark_fulfilled', { order_id: r.onchain_order_id, report_hash: digest });
  const fulfillment = { txHash: id('fulfill-tx'), result: result(tx('fulfill-tx', AGENT, SELLER, key(), fulfillAction, 'fulfill-root'),
    'fulfill-tx-block', [receipt('fulfill-root', AGENT, SELLER, fulfillAction)], [
      outcome('fulfill-root', 'seller-fulfill-block', SELLER, { SuccessValue: '' }, [],
        [event('buffer', 'order_fulfilled', { order_id: r.onchain_order_id, report_hash: digest }, '1.1.0')]),
    ]) };
  const intent = { intent_id: r.intent_id, policy_id: r.policy_id, token: TOKEN, payee: ADAPTER, amount: '100',
    memo: r.intent_memo, review_hash: r.review_sha256, expires_at_ms: String(r.expires_at_ms), agent_public_key: vaultKey,
    policy_revision: 1, payee_revision: 1, agent_revision: 1, consumed: true, cancelled: false, active: false };
  const privateOrder = { id: r.api_order_id, onchainOrderId: r.onchain_order_id, contractId: SELLER, tokenContract: TOKEN,
    sku: r.sku, priceUnits: r.amount, state: 'DELIVERED', authorised: true, brief: BRIEF,
    report: { content: REPORT, content_hash: digest } };
  const snapshots = {
    vault_transaction: { block_hash: id('fund-tx-block'), code_hash: pins.vault_code_hash, keys: [] },
    vault_execution: { block_hash: id('fund-exec-block'), code_hash: pins.vault_code_hash, keys: [] },
    intent: { block_hash: id('fund-exec-block'), view: intent },
    adapter_funding: { block_hash: id('fund-token-block'), code_hash: adapterCode, keys: [] },
    adapter_transaction: { block_hash: id('open-tx-block'), code_hash: adapterCode, keys: [] },
    adapter_execution: { block_hash: id('adapter-block'), code_hash: adapterCode, keys: [] },
    token_states: ['fund-token-block', 'open-token-block', 'fund-token-prev', 'adapter-block'].map(n => ({ block_hash: id(n), code_hash: pins.token_code_hash })),
    seller_states: ['seller-paid-block', 'seller-fulfill-block'].map(n => ({ block_hash: id(n), code_hash: pins.seller_code_hash })),
    order_paid: { block_hash: id('seller-paid-block'), view: { state: 'Paid', customer: ADAPTER, sku: r.sku, gross: '100', report_hash: null } },
    order_fulfilled: { block_hash: id('seller-fulfill-block'), view: { state: 'Fulfilled', customer: ADAPTER, sku: r.sku, gross: '100', report_hash: digest } },
    seller_config: { block_hash: id('seller-fulfill-block'), view: { token_id: TOKEN, agent: AGENT } },
    blocks: [block('fund-tx-block', 8, 'earlier'), block('fund-exec-block', 9, 'fund-tx-block'),
      block('fund-token-block', 10, 'fund-token-prev'), block('fund-callback-block', 11, 'fund-token-block'),
      block('open-tx-block', 12, 'fund-callback-block'), block('adapter-block', 13, 'open-tx-block'),
      block('open-token-block', 14, 'adapter-block'), block('seller-paid-block', 15, 'open-token-block'),
      block('fulfill-tx-block', 17, 'seller-paid-block'), block('seller-fulfill-block', 18, 'fulfill-tx-block')],
    balances: [{ block_hash: id('fund-token-prev'), account_id: ADAPTER, token: TOKEN, amount: '0' },
      { block_hash: id('fund-token-block'), account_id: ADAPTER, token: TOKEN, amount: '100' },
      { block_hash: id('adapter-block'), account_id: ADAPTER, token: TOKEN, amount: '100' }],
  };
  return { terms, pins, funding, opening, fulfillment, privateOrder, snapshots };
}

test('correlates synthetic funding, exact Buffer receipt and report hash without claiming HTTP delivery', async () => {
  const f = await fixture(), proof = await verifyBufferDeliveryEvidence(f);
  assert.equal(proof.status, 'BUFFER_RECEIPTS_AND_REPORT_HASH_CORRELATED');
  assert.equal(proof.guarded_forwarder_funding_verified, true); assert.equal(proof.seller_payment_receipt_verified, true);
  assert.equal(proof.report_sha256, sha(REPORT)); assert.equal(proof.report_hash_matches_onchain_commitment, true);
  assert.equal(proof.seller_http_delivery_verified, false); assert.equal(proof.independent_fulfillment_verified, false);
  assert.equal(proof.deployed_source_equivalence_verified, false); assert.equal(proof.retry_authorized, false);
  assert(!JSON.stringify(proof).includes(BRIEF)); assert(!JSON.stringify(proof).includes(REPORT));
});

test('private order, seller, token, payer, amount and report cannot be swapped', async () => {
  const f = await fixture();
  const changes = [
    x => { x.privateOrder.authorised = false; }, x => { x.privateOrder.id = 'bad'; },
    x => { x.privateOrder.onchainOrderId = 'o-123456789abd'; }, x => { x.privateOrder.contractId = 'attacker.testnet'; },
    x => { x.privateOrder.tokenContract = 'bad.testnet'; }, x => { x.privateOrder.sku = 'crosschain-brief'; },
    x => { x.privateOrder.priceUnits = '99'; }, x => { x.privateOrder.state = 'REFUNDED'; },
    x => { x.privateOrder.brief += 'changed'; }, x => { x.privateOrder.report.content += 'changed'; },
    x => { x.privateOrder.report.content_hash = 'a'.repeat(64); }, x => { x.snapshots.order_paid.view.customer = 'attacker.testnet'; },
    x => { x.snapshots.order_paid.view.gross = '1'; }, x => { x.snapshots.order_fulfilled.view.report_hash = 'a'.repeat(64); },
    x => { x.snapshots.order_fulfilled.view.state = 'Refunded'; }, x => { x.snapshots.seller_config.view.agent = 'attacker.testnet'; },
    x => { x.snapshots.seller_config.view.token_id = 'bad.testnet'; },
  ];
  for (const change of changes) { const sample = structuredClone(f); change(sample); await assert.rejects(verifyBufferDeliveryEvidence(sample)); }
});

test('receipt graph links, promise data, callback, code and ordering fail closed', async () => {
  const f = await fixture();
  const changes = [
    x => { x.funding.result.final_execution_status = 'EXECUTED'; },
    x => { x.funding.result.receipts[1].receipt.Action.output_data_receivers[0].data_id = id('other'); },
    x => { x.snapshots.intent.view.review_hash = '0'.repeat(64); },
    x => { x.snapshots.adapter_funding.keys = [{ public_key: 'attacker' }]; },
    x => { x.opening.result.receipts_outcome[1].outcome.receipt_ids = []; },
    x => { x.opening.result.receipts[3].receipt.Action.input_data_ids = [id('other')]; },
    x => { x.opening.result.receipts_outcome[2].outcome.status.SuccessValue = enc('100'); },
    x => { x.opening.result.status.SuccessValue = enc('99'); },
    x => { x.opening.result.receipts_outcome[2].outcome.logs = []; },
    x => { x.opening.result.receipts_outcome[2].outcome.logs[0] = event('buffer', 'payment_received',
      { order_id: x.terms.onchain_order_id, sku: x.terms.sku, customer: 'attacker.testnet', amount: '100' }, '1.1.0'); },
    x => { x.fulfillment.result.transaction.signer_id = 'attacker.testnet'; },
    x => { x.fulfillment.result.receipts_outcome[0].outcome.logs = []; },
    x => { x.snapshots.token_states[0].code_hash = id('bad'); },
    x => { x.snapshots.seller_states[0].code_hash = id('bad'); },
    x => { x.snapshots.blocks.find(b => b.header.hash === id('open-tx-block')).header.height = 9; },
    x => { x.snapshots.balances[0].amount = '1'; },
  ];
  for (const change of changes) { const sample = structuredClone(f); change(sample); await assert.rejects(verifyBufferDeliveryEvidence(sample)); }
});

test('historical preparation does not authorize spending and requires separately pinned public code', async () => {
  const f = await fixture(), prepared = await prepareBufferDeliveryEvidence(f.terms, f.pins);
  assert.equal(prepared.review.signed, false); assert.equal(prepared.review.sent, false);
  for (const change of [x => { x.pins.vault_code_hash = id('unknown'); }, x => { x.pins.seller_code_hash = 'bad'; },
    x => { x.pins.fulfillment_signer = 'attacker.near'; }, x => { x.terms.sku = 'custom-brief'; }]) {
    const sample = structuredClone(f); change(sample); await assert.rejects(prepareBufferDeliveryEvidence(sample.terms, sample.pins));
  }
  await assert.rejects(inspectBufferDeliveryEvidence({ terms: f.terms, pins: f.pins, fundingHash: f.funding.txHash,
    openingHash: f.opening.txHash, fulfillmentHash: f.fulfillment.txHash, privateOrder: f.privateOrder, provider: {} }), /reviewed Circle/);
  const p = { ...f.pins, token_code_hash: CIRCLE_TESTNET_REVIEWED_CODE_HASH };
  const provider = { viewNodeStatus: async () => ({ chain_id: 'mainnet' }), txStatusReceipts() {}, query() {}, viewBlock() {}, callFunctionRaw() {} };
  await assert.rejects(inspectBufferDeliveryEvidence({ terms: f.terms, pins: p, fundingHash: f.funding.txHash,
    openingHash: f.opening.txHash, fulfillmentHash: f.fulfillment.txHash, privateOrder: f.privateOrder, provider }), /testnet/);
});

test('private order fetch uses one fixed HTTPS origin and never exposes bearer in errors', async () => {
  const token = 'aa'.repeat(24), orderId = '123e4567-e89b-12d3-a456-426614174000'; let calls = 0;
  const data = await fetchBufferPrivateOrder({ orderId, accessToken: token, fetchImpl: async (url, options) => {
    calls++; const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://buffer-zeta.vercel.app'); assert.equal(parsed.pathname, `/api/orders/${orderId}`);
    assert.equal(parsed.searchParams.get('token'), token); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify({ authorised: true }), { status: 200 });
  } });
  assert.deepEqual(data, { authorised: true }); assert.equal(calls, 1);
  await assert.rejects(fetchBufferPrivateOrder({ orderId, accessToken: token, fetchImpl: async url => { throw new Error(`network ${url}`); } }),
    error => error.message === 'private Buffer order could not be read' && !error.message.includes(token));
  await assert.rejects(fetchBufferPrivateOrder({ orderId: '../bad', accessToken: token }), /invalid private/);
  await assert.rejects(fetchBufferPrivateOrder({ orderId, accessToken: token, fetchImpl: async () => new Response('x'.repeat(1024 * 1024 + 1)) }), /could not be read/);
});

function historicalProvider(f, options = {}) {
  const calls = [], s = f.snapshots, states = new Map();
  for (const [account, entries] of [[VAULT, [s.vault_transaction, s.vault_execution]],
    [ADAPTER, [s.adapter_funding, s.adapter_transaction, s.adapter_execution]], [TOKEN, s.token_states], [SELLER, s.seller_states]]) {
    for (const state of entries) states.set(`${account}|${state.block_hash}`, state);
  }
  return { calls,
    async viewNodeStatus() { calls.push(['status']); return { chain_id: options.chain ?? 'testnet' }; },
    async txStatusReceipts(hash, signer, wait) {
      calls.push(['receipt', hash, signer, wait]); const entry = [f.funding, f.opening, f.fulfillment].find(x => x.txHash === hash);
      if (!entry || entry.result.transaction.signer_id !== signer || wait !== 'FINAL' || options.missingReceipt) throw Error('unknown');
      return structuredClone(entry.result);
    },
    async viewBlock({ blockId }) {
      calls.push(['block', blockId]); const found = s.blocks.find(x => x.header.hash === blockId);
      if (!found) throw Error('unknown'); return structuredClone(found);
    },
    async query(q) {
      calls.push(['query', q]); const state = states.get(`${q.account_id}|${q.block_id}`);
      if (!state || options.missingState) throw Error('unknown');
      const block_hash = options.mixedBlock ? id('other') : q.block_id;
      if (q.request_type === 'view_account') return { block_hash, code_hash: state.code_hash };
      if (q.request_type === 'view_access_key_list') return { block_hash, keys: state.keys };
      throw Error('unsupported');
    },
    async callFunctionRaw(account, method, args, { blockId }) {
      calls.push(['view', account, method, args, blockId]); let value;
      if (method === 'get_exact_ft_intent') value = s.intent.block_hash === blockId && s.intent.view;
      else if (method === 'get_order') value = [s.order_paid, s.order_fulfilled].find(x => x.block_hash === blockId)?.view;
      else if (method === 'get_config') value = s.seller_config.block_hash === blockId && s.seller_config.view;
      else if (method === 'ft_balance_of') value = s.balances.find(x => x.block_hash === blockId && x.account_id === args.account_id)?.amount;
      if (value === undefined || value === false) throw Error('unknown');
      return { block_hash: options.mixedView ? id('other') : blockId, result: [...Buffer.from(JSON.stringify(value))] };
    },
  };
}
const inspectRequest = (f, provider) => ({ terms: f.terms, pins: f.pins, fundingHash: f.funding.txHash,
  openingHash: f.opening.txHash, fulfillmentHash: f.fulfillment.txHash, privateOrder: f.privateOrder, provider });
test('testnet inspector collects only the three originals and pinned historical views', async () => {
  const f = await fixture(); f.pins.token_code_hash = CIRCLE_TESTNET_REVIEWED_CODE_HASH;
  for (const state of f.snapshots.token_states) state.code_hash = CIRCLE_TESTNET_REVIEWED_CODE_HASH;
  const provider = historicalProvider(f), proof = await inspectBufferDeliveryEvidence(inspectRequest(f, provider));
  assert.equal(proof.network, 'testnet'); assert.equal(proof.historical_views_collected, true);
  assert.equal(proof.seller_contacted_by_inspector, false); assert.equal(proof.independent_fulfillment_verified, false);
  assert.equal(provider.calls.filter(c => c[0] === 'receipt').length, 3);
  assert(provider.calls.every(c => ['status', 'receipt', 'block', 'query', 'view'].includes(c[0])));
  assert(provider.calls.filter(c => c[0] === 'query').every(c => ['view_account', 'view_access_key_list'].includes(c[1].request_type) && c[1].block_id));
  assert(provider.calls.filter(c => c[0] === 'view').every(c => c[4]));
  for (const options of [{ chain: 'mainnet' }, { missingReceipt: true }, { missingState: true }, { mixedBlock: true }, { mixedView: true }]) {
    const bad = historicalProvider(f, options); await assert.rejects(inspectBufferDeliveryEvidence(inspectRequest(f, bad)));
    if (options.chain) assert.equal(bad.calls.filter(c => c[0] === 'receipt').length, 0);
  }
});
