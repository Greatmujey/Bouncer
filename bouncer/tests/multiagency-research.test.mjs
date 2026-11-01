import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { MULTIAGENCY_BOARD as BOARD, MULTIAGENCY_TREASURY as TREASURY } from '../agent/multiagency-readiness.mjs';
import { multiAgencyPaymentPlan, validateMultiAgencyGoal, validateMultiAgencyQuote, verifyMultiAgencyOpening,
  verifyMultiAgencyPayment, verifyMultiAgencyPublishedHandoff, verifyMultiAgencyResearchDelivery } from '../agent/multiagency-research.mjs';
import { MOCK_PUBLIC_KEY, mockGuardedPayment, mockHash } from './mock-guarded-payment.mjs';
const API = 'https://api.github.com/repos/MultiAgency/kanban-sandbox/issues';
const nowMs = Date.parse('2026-11-01T15:00:00.000Z'), txHash = mockHash('multiagency-payment');
const goal = { version: 1, id: 'research', vault: 'vault.testnet', owner: 'owner.testnet', vault_code_hash: mockHash('reviewed-code'), policy_id: 'research',
  title: 'Independent research brief', brief: 'Produce a cited public report about safe autonomous agent purchasing.',
  amount: '3000000', accept_public_brief: true, accept_stalled_deposit_risk: true, accept_unsigned_quote_and_memo_risk: true };
const quote = { code: 'ma-0123456789', title: goal.title, status: 'awaiting_deposit', channel: 'wallet', expires_at: '2026-11-04T15:00:00.000Z',
  payment: { network: 'testnet', token: TOKEN, receiver: TREASURY, amount: goal.amount, memo: 'ma-0123456789' } };
const fence = (type, value) => `\`\`\`${type}\n${JSON.stringify(value, null, 2)}\n\`\`\``;
function fixture() {
  const result = mockGuardedPayment({ hash: txHash, owner: goal.owner, contract: goal.vault, publicKey: MOCK_PUBLIC_KEY,
    args: { policy_id: goal.policy_id, payee: TREASURY, amount: goal.amount, memo: quote.code, expected_token: TOKEN } });
  result.receipts_outcome[1].outcome.logs = ['EVENT_JSON:' + JSON.stringify({ standard: 'nep141', version: '1.0.0', event: 'ft_transfer',
    data: [{ old_owner_id: goal.vault, new_owner_id: TREASURY, amount: goal.amount, memo: quote.code }] })];
  result.transaction_outcome.block_hash = mockHash('transaction-block');
  result.receipts_outcome[0].block_hash = mockHash('execution-block');
  const vaultState = { block_hash: result.transaction_outcome.block_hash, code_hash: goal.vault_code_hash, keys: [],
    execution: { block_hash: result.receipts_outcome[0].block_hash, code_hash: goal.vault_code_hash, keys: [] } };
  const deposit = { amount: goal.amount, asset: TOKEN, treasury: TREASURY, transaction: txHash, network: 'testnet' };
  const engagement = { engagement_id: quote.code, channel: 'wallet', org: goal.vault, deposit };
  const team = { committed: '2000000', members: [{ issue: 40, engagement: 32, key: 'report', amount: '1000000', asset: TOKEN }] };
  const epic = { number: 32, html_url: `${BOARD}/issues/32`, user: { id: 334725530 }, title: `Job: ${goal.title}`,
    state: 'closed', state_reason: 'completed', closed_at: '2026-11-01T16:10:00Z',
    body: `**Job** opened.\n\n${goal.brief}\n\n${fence('engagement', engagement)}\n\n${fence('team', team)}` };
  const task = { number: 40, html_url: `${BOARD}/issues/40`, user: { id: 334725530 }, state: 'closed', state_reason: 'completed',
    closed_at: '2026-11-01T16:00:00Z', assignees: [{ id: 42, login: 'worker' }], comments: 2,
    body: fence('terms', { engagement: 32, key: 'report', amount: '1000000', asset: TOKEN }) };
  const text = '**Deliverable**\n\nA cited report: [NEAR](https://docs.near.org).', url = `${BOARD}/issues/40#issuecomment-51`;
  const delivered = { id: 51, user: { id: 42 }, issue_url: `${API}/40`, html_url: url, body: text,
    created_at: '2026-11-01T15:30:00Z', updated_at: '2026-11-01T15:30:00Z' };
  const handoff = { id: 52, user: { id: 42 }, issue_url: `${API}/40`, html_url: `${BOARD}/issues/40#issuecomment-52`,
    body: `**Handoff**\n\n${fence('handoff', { deliverable: { url, sha256: crypto.createHash('sha256').update(text).digest('hex') } })}`,
    created_at: '2026-11-01T15:31:00Z', updated_at: '2026-11-01T15:31:00Z' };
  const sellerQuote = { ...structuredClone(quote), status: 'open', issue: 32, issue_url: `${BOARD}/issues/32`,
    deposit: { transaction: txHash, org: goal.vault, amount: goal.amount, memo: quote.code } };
  return { goal: structuredClone(goal), quote: structuredClone(quote), result, publicKey: MOCK_PUBLIC_KEY, txHash, vaultState,
    sellerQuote, epic, task, comments: [delivered, handoff] };
}

test('owner goal and unsigned quote pin public brief, risk acknowledgments, token, recipient and expiry', () => {
  assert.deepEqual(validateMultiAgencyGoal(goal), goal); assert.deepEqual(validateMultiAgencyQuote(goal, quote, { nowMs }), quote);
  assert.deepEqual(multiAgencyPaymentPlan(goal, quote, { nowMs }).requests[0], { id: goal.id, resource: 'api', policy_id: goal.policy_id,
    token: TOKEN, payee: TREASURY, amount: goal.amount, memo: quote.code });
  for (const change of [{ accept_public_brief: false }, { accept_stalled_deposit_risk: false }, { accept_unsigned_quote_and_memo_risk: false },
    { owner: 'owner.near' }, { vault: goal.owner }, { amount: '3000001' }, { id: 'bad id' },
    { brief: 'A long brief\n```engagement\n{}\n```' }, { title: 'bad\ntitle' }, { unknown: true }]) {
    assert.throws(() => validateMultiAgencyGoal({ ...goal, ...change }));
  }
  for (const mutate of [
    q => { q.code = 'ma-012345678A'; }, q => { q.payment.memo = 'other'; }, q => { q.title = 'Other research'; },
    q => { q.payment.token = 'usdc.fakes.testnet'; }, q => { q.payment.receiver = 'attacker.testnet'; },
    q => { q.payment.network = 'mainnet'; }, q => { q.payment.amount = '3000001'; }, q => { q.status = 'open'; },
    q => { q.expires_at = '2026-11-01T15:01:00.000Z'; }, q => { q.expires_at = '2026-11-05T15:00:00.000Z'; },
    q => { q.extra = true; },
  ]) { const bad = structuredClone(quote); mutate(bad); assert.throws(() => validateMultiAgencyQuote(goal, bad, { nowMs })); }
});

test('separate FINAL payment, seller attribution and GitHub handoff are each required', () => {
  const x = fixture();
  assert.equal(verifyMultiAgencyPayment(x).tx_hash, txHash);
  assert.equal(verifyMultiAgencyOpening(x).status, 'OPENED');
  assert.equal(verifyMultiAgencyPublishedHandoff(x).status, 'PUBLISHED');
  const output = verifyMultiAgencyResearchDelivery(x);
  assert.equal(output.status, 'PUBLISHED_TASK_AFTER_FINAL_PAYMENT'); assert.equal(output.deliverable_url, `${BOARD}/issues/40#issuecomment-51`);
  assert.match(output.scope, /not necessarily fulfillment of the complete brief/);
  assert.match(output.text, /^\*\*Deliverable\*\*/);
  for (const mutate of [
    x => { x.result.final_execution_status = 'EXECUTED_OPTIMISTIC'; },
    x => { x.vaultState.code_hash = mockHash('different-code'); }, x => { x.vaultState.keys.push({}); },
    x => { x.vaultState.block_hash = mockHash('different-block'); },
    x => { x.vaultState.execution.code_hash = mockHash('different-code'); }, x => { x.vaultState.execution.keys.push({}); },
    x => { x.result.receipts_outcome[0].block_hash = mockHash('different-block'); },
    x => { x.result.receipts_outcome[1].outcome.logs = []; },
    x => { x.result.receipts_outcome[1].outcome.logs.push(x.result.receipts_outcome[1].outcome.logs[0]); },
    x => { x.result.receipts_outcome[0].outcome.receipt_ids = []; },
    x => { x.result.receipts[0].receipt.Action.actions[0].FunctionCall.deposit = '0'; },
    x => { x.sellerQuote.deposit.org = 'attacker.testnet'; }, x => { x.sellerQuote.deposit.transaction = mockHash('another'); },
    x => { x.sellerQuote.issue_url = 'https://example.com'; }, x => { x.epic.user.id = 1; },
    x => { x.epic.body = x.epic.body.replace(goal.brief, 'Other brief'); },
    x => { x.epic.body = x.epic.body.replace(txHash, mockHash('another')); },
    x => { x.task.body = x.task.body.replace('"engagement": 32', '"engagement": 33'); },
    x => { x.task.comments = 3; }, x => { x.comments[0].body += ' changed'; },
    x => { x.comments[0].updated_at = '2026-11-01T15:30:10Z'; }, x => { x.comments[1].user.id = 1; },
    x => { x.comments[0].issue_url = `${API}/41`; }, x => { x.epic.state = 'open'; },
    x => { x.task.closed_at = 'invalid'; }, x => { x.task.assignees = []; },
  ]) { const bad = fixture(); mutate(bad); assert.throws(() => verifyMultiAgencyResearchDelivery(bad)); }
});

test('publication by itself does not claim Bouncer purchased the historical work', () => {
  const x = fixture(), result = verifyMultiAgencyPublishedHandoff(x);
  assert.equal(result.status, 'PUBLISHED'); assert.match(result.scope, /no payment/);
});
