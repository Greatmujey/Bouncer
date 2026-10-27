import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check, remaining, maxSpendable, NS, fmt } from './policy.mjs';

const USDC = 1_000_000n; // 6 decimals

/** A realistic procurement agent: $20/day, $3 per payment, 2 approved suppliers. */
const policy = {
  label: 'procurement-agent',
  token: 'usdc.near',
  perTxCap: 3n * USDC,
  windows: [
    { periodNs: NS.DAY, limit: 20n * USDC },
    { periodNs: NS.MONTH, limit: 200n * USDC },
  ],
  payeeAllowlist: ['supplier-a.near', 'supplier-b.near'],
};

const T0 = 1_700_000_000 * 1e9;

test('allows a payment inside every rule', () => {
  const d = check(policy, [], 'supplier-a.near', 2n * USDC, T0);
  assert.equal(d.ok, true);
});

test('BLOCKS agent trying to exceed the per-transaction cap', () => {
  const d = check(policy, [], 'supplier-a.near', 25n * USDC, T0);
  assert.equal(d.ok, false);
  assert.match(d.reason, /per-tx cap/);
});

test('BLOCKS unknown payee — the agent cannot invent a supplier', () => {
  const d = check(policy, [], 'attacker.near', 1n * USDC, T0);
  assert.equal(d.ok, false);
  assert.match(d.reason, /not in allowlist/);
});

test('BLOCKS the obvious bypass: splitting one big payment into many small ones', () => {
  // 7 × $3 = $21, over the $20/day cap. Each individual call passes rule 1.
  const history = [];
  let approvals = 0;
  for (let i = 0; i < 7; i++) {
    const d = check(policy, history, 'supplier-a.near', 3n * USDC, T0 + i);
    if (d.ok) {
      approvals++;
      history.push({ payee: 'supplier-a.near', amount: 3n * USDC, memo: '', at: T0 + i });
    }
  }
  assert.equal(approvals, 6, 'exactly 6 × $3 fit in the $20 daily cap');
  assert.equal(BigInt(history.length) * 3n * USDC, 18n * USDC);
});

test('window budget frees up as time passes', () => {
  const history = [{ payee: 'supplier-a.near', amount: 18n * USDC, memo: '', at: T0 }];
  assert.equal(check(policy, history, 'supplier-a.near', 3n * USDC, T0 + NS.HOUR).ok, false);
  // 24h later the daily window is empty again (monthly still has room).
  assert.equal(check(policy, history, 'supplier-a.near', 3n * USDC, T0 + NS.DAY + 1).ok, true);
});

test('monthly cap still binds even after the daily window resets', () => {
  const history = [{ payee: 'supplier-a.near', amount: 200n * USDC, memo: '', at: T0 }];
  const d = check(policy, history, 'supplier-a.near', 1n * USDC, T0 + 2 * NS.DAY);
  assert.equal(d.ok, false);
  assert.match(d.reason, /month window/);
});

test('remaining() and maxSpendable() report the true ceiling', () => {
  const history = [{ payee: 'supplier-a.near', amount: 15n * USDC, memo: '', at: T0 }];
  const r = remaining(policy, history, T0);
  assert.equal(r.perTx, 3n * USDC);
  assert.equal(r.day, 5n * USDC);
  assert.equal(maxSpendable(policy, history, T0), 3n * USDC); // per-tx cap binds first
  const heavy = [{ payee: 'supplier-a.near', amount: 19n * USDC, memo: '', at: T0 }];
  assert.equal(maxSpendable(policy, heavy, T0), 1n * USDC); // now the day binds
});

test('empty allowlist means unrestricted — documented footgun', () => {
  const lax = { ...policy, payeeAllowlist: [] };
  assert.equal(check(lax, [], 'anyone.near', 1n * USDC, T0).ok, true);
});

test('rejects zero and nonsense amounts', () => {
  assert.equal(check(policy, [], 'supplier-a.near', 0n, T0).ok, false);
});

test('fmt renders smallest units as money', () => {
  assert.equal(fmt(20n * USDC), '20');
  assert.equal(fmt(8_936_173n), '8.936173');
});
