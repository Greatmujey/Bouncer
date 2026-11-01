import test from 'node:test';
import assert from 'node:assert/strict';
import { reservePreview } from '../agent/preflight.mjs';
import { validatePlan } from '../agent/procurement.mjs';

const plan = validatePlan({ contract_id: 'bouncer.testnet', owner_account_id: 'owner.testnet', requests: [
  { id: 'one', resource: 'compute', policy_id: 'resources', token: 'token.testnet', payee: 'vendor.testnet', amount: '80' } ] });
const provider = { async callFunction(_, method) {
  if (method === 'get_policy') return { token: 'token.testnet', per_tx_cap: '1000', daily_cap: '150' };
  if (method === 'daily_spent') return '0';
  if (method === 'vault_balance') return '100';
  throw new Error('unexpected view');
} };
const preview = async options => {
  const checks = [{ id: 'one', status: 'READY' }];
  const summary = await reservePreview(provider, plan, checks, { paid: 0, ready: 1, blocked: 0, skipped: 0 }, options);
  return { checks, summary };
};

test('prior vault reservations apply across policies while prior policy-only credit does not double-debit', async () => {
  const policyOnly = await preview({ policyReservations: [{ policy_id: 'other', token: 'token.testnet', amount: '30' }] });
  assert.equal(policyOnly.summary.blocked, 0);
  const sameVault = await preview({ vaultReservations: [{ token: 'token.testnet', amount: '21' }] });
  assert.equal(sameVault.summary.blocked, 1); assert.match(sameVault.checks[0].reason, /vault/);
  const exact = await preview({ vaultReservations: [{ token: 'token.testnet', amount: '10' }, { token: 'token.testnet', amount: '10' }] });
  assert.equal(exact.summary.blocked, 0);
  const sharedPolicy = await preview({ policyReservations: [{ policy_id: 'resources', token: 'token.testnet', amount: '71' }],
    vaultReservations: [{ token: 'token.testnet', amount: '1' }] });
  assert.equal(sharedPolicy.summary.blocked, 1); assert.match(sharedPolicy.checks[0].reason, /daily budget/);
});

test('invalid prior vault reservations fail closed', async () => {
  for (const bad of [null, {}, { token: '', amount: '1' }, { token: 'token.testnet', amount: '0' },
    { token: 'token.testnet', amount: '-1' }, { token: 'token.testnet', amount: (1n << 128n).toString() },
    { token: 'token.testnet', amount: '1', extra: true }]) {
    await assert.rejects(preview({ vaultReservations: [bad] }));
  }
  await assert.rejects(preview({ vaultReservations: null }));
});
