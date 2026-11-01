import test from 'node:test';
import assert from 'node:assert/strict';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { MULTIAGENCY_BOARD, MULTIAGENCY_TREASURY, PRIOR_BUYER, PRIOR_OWNER, PRIOR_PAYEE, PRIOR_HASH,
  summarizeMultiAgencyReadiness, verifyMultiAgencyIndexerControl } from '../agent/multiagency-readiness.mjs';
import { mockGuardedPayment, MOCK_PUBLIC_KEY } from './mock-guarded-payment.mjs';

const args = { policy_id: 'compute', payee: PRIOR_PAYEE, amount: '1000', memo: 'bouncer-order-v3:compute:a:b', expected_token: TOKEN };
function control() {
  const final = mockGuardedPayment({ hash: PRIOR_HASH, owner: PRIOR_OWNER, contract: PRIOR_BUYER, publicKey: MOCK_PUBLIC_KEY, args });
  final.receipts_outcome[1].outcome.logs = ['EVENT_JSON:' + JSON.stringify({ standard: 'nep141', version: '1.0.0', event: 'ft_transfer',
    data: [{ old_owner_id: PRIOR_BUYER, new_owner_id: PRIOR_PAYEE, amount: '1000', memo: args.memo }] })];
  const indexed = { transaction: structuredClone(final.transaction), receipts: final.receipts.map(receipt => ({ receipt,
    execution_outcome: structuredClone(final.receipts_outcome.find(outcome => outcome.id === receipt.receipt_id)) })) };
  return { indexed, final };
}
function readiness() {
  return { nowMs: Date.parse('2026-11-01T15:10:00.000Z'),
    config: { network: 'testnet', treasury: MULTIAGENCY_TREASURY, usdc: TOKEN, deposit: '3000000', board: MULTIAGENCY_BOARD },
    health: { ok: true, coordinator: { running: true, last_completed_at: '2026-11-01T15:09:45.000Z' } },
    engagements: [{ deposit: '3000000', created_at: '2026-10-03T19:19:50Z' }, { deposit: '0', created_at: '2026-11-01T15:00:00Z' }],
    tasks: { tasks: [{ state: 'ready' }] } };
}

test('historical control requires indexer event and exact FINAL linked Bouncer receipts', () => {
  const c = control(), proof = verifyMultiAgencyIndexerControl(c);
  assert.equal(proof.nested_circle_event_indexed, true); assert.equal(proof.independently_final_verified, true);
  assert.equal(JSON.stringify(proof).includes(args.memo), false);
  for (const mutate of [
    x => { x.indexed.transaction.hash = 'wrong'; },
    x => { x.indexed.transaction.signer_id = 'other.testnet'; },
    x => { x.indexed.receipts[0].receipt.predecessor_id = 'other.testnet'; },
    x => { x.indexed.receipts[0].execution_outcome.outcome.logs = []; },
    x => { x.indexed.receipts[0].execution_outcome.outcome.logs.push(x.indexed.receipts[0].execution_outcome.outcome.logs[0]); },
    x => { x.indexed.receipts[0].execution_outcome.outcome.status = { Failure: {} }; },
    x => { x.final.final_execution_status = 'EXECUTED_OPTIMISTIC'; },
    x => { x.final.receipts_outcome[1].outcome.logs = []; },
    x => { x.final.receipts_outcome[0].outcome.receipt_ids = []; },
    x => { x.final.receipts[0].receipt.Action.actions[0].FunctionCall.deposit = '0'; },
  ]) { const bad = control(); mutate(bad); assert.throws(() => verifyMultiAgencyIndexerControl(bad)); }
});

test('readiness never treats healthy coordinator or historical jobs as current worker capacity', () => {
  const x = readiness(), result = summarizeMultiAgencyReadiness(x);
  assert.equal(result.status, 'BLOCKED_OR_UNPROVEN'); assert.equal(result.coordinator_recent, true);
  assert.equal(result.independent_worker_capacity, 'UNPROVEN'); assert.equal(result.quote_posts, 0);
  assert.equal(result.last_listed_paid_job_created_at, '2026-10-03T19:19:50Z');
  assert.equal(result.observed_default_deposit_micro_usdc, '3000000');
  const idleCycle = readiness(); idleCycle.health.coordinator.running = false;
  assert.equal(summarizeMultiAgencyReadiness(idleCycle).coordinator_recent, true);
  const unhealthy = readiness(); unhealthy.health.ok = false;
  assert.equal(summarizeMultiAgencyReadiness(unhealthy).coordinator_recent, false);
  const stale = readiness(); stale.health.coordinator.last_completed_at = '2026-10-31T00:00:00Z';
  assert.equal(summarizeMultiAgencyReadiness(stale).coordinator_recent, false);
  for (const mutate of [
    x => { x.config.network = 'mainnet'; }, x => { x.config.usdc = 'usdc.fakes.testnet'; },
    x => { x.config.treasury = 'other.testnet'; }, x => { x.config.deposit = '3000001'; },
    x => { x.config.board = 'https://github.com/attacker/repo'; }, x => { x.engagements = new Array(101); },
  ]) { const bad = readiness(); mutate(bad); assert.throws(() => summarizeMultiAgencyReadiness(bad)); }
});
