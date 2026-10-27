#!/usr/bin/env node
/**
 * The agent side. Deliberately written as if the agent is hostile/unreliable:
 * it plans, checks its own budget with the view method, tries things it should
 * not, and gets refused. Run: node agent/agent.mjs
 */
import { check, maxSpendable, remaining, fmt, NS } from '../packages/policy/policy.mjs';

const USDC = 1_000_000n;
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

const C = { dim: '\x1b[2m', ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', acc: '\x1b[36m', off: '\x1b[0m' };
const line = (s = '') => console.log(s);

let ledger = [];
let now = 1_700_000_000 * 1e9;

function execute(payee, amount, memo) {
  const d = check(policy, ledger, payee, amount, now);
  if (!d.ok) {
    line(`  ${C.bad}✗ REVERTED${C.off} ${C.dim}execute(${payee}, ${fmt(amount)})${C.off}`);
    line(`    ${C.dim}reason: ${d.reason}${C.off}`);
    return false;
  }
  ledger.push({ payee, amount, memo, at: now });
  line(`  ${C.ok}✓ SETTLED${C.off}  execute(${payee}, ${fmt(amount)}) ${C.dim}${memo}${C.off}`);
  return true;
}

const step = (n, title) => { line(); line(`${C.acc}[${n}] ${title}${C.off}`); now += 3_600 * 1e9; };

line(`${C.acc}BOUNCER agent simulation${C.off}`);
line(`${C.dim}vault owner: human.near · agent key: scoped to execute() only${C.off}`);
line(`${C.dim}budget now: ${fmt(maxSpendable(policy, ledger, now))} USDC spendable${C.off}`);

step(1, 'Agent plans honestly: buy packaging from an approved supplier');
execute('supplier-a.near', 3n * USDC, 'order #1042 · packaging');

step(2, 'Agent tries to overspend in one go (over the $3 per-payment cap)');
execute('supplier-a.near', 25n * USDC, 'bulk stock');

step(3, 'Agent tries a new payee — "the supplier changed their address"');
execute('supplier-x.near', 2n * USDC, 'redirected invoice');

step(4, 'Agent tries to beat the daily cap by splitting into small payments');
for (let i = 1; i <= 7; i++) {
  now += 5 * 60 * 1e9;
  const ok = execute('supplier-b.near', 3n * USDC, `installment ${i}/7`);
  if (!ok) break;
}

step(5, 'Agent asks the contract what it can still do, then stops cleanly');
const r = remaining(policy, ledger, now);
line(`  ${C.dim}remaining per-tx: ${fmt(r.perTx)} · today: ${fmt(r.day)} · month: ${fmt(r.month)}${C.off}`);
line(`  ${C.dim}agent: budget exhausted for today, stopping instead of retrying${C.off}`);

step(6, 'A day passes — the daily window resets, the agent works again');
now += NS.DAY;
execute('supplier-a.near', 3n * USDC, 'order #1043 · next day');

line();
line(`${C.acc}audit${C.off} ${C.dim}${ledger.length} approved payments, ${fmt(ledger.reduce((a, s) => a + s.amount, 0n))} USDC total, every rejection above is on the record.${C.off}`);
