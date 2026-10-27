/**
 * Independent, offline policy simulation. Unlike the on-chain contract, this
 * uses rolling windows and does not check vault balance or agent-key grants.
 * It is not authoritative; the contract makes the final spending decision.
 *
 * @typedef {{periodNs: number, limit: bigint}} Window
 * @typedef {{label: string, token: string, perTxCap: bigint, windows: Window[],
 *            payeeAllowlist: string[]}} Policy
 * @typedef {{payee: string, amount: bigint, memo: string, at: number}} Spend
 * @typedef {{ok: boolean, reason: string}} Decision
 */

export const NS = { SEC: 1e9, MIN: 60e9, HOUR: 3600e9, DAY: 86400e9, MONTH: 2592000e9 };

/** @param {Policy} policy @param {Spend[]} history @param {string} payee
 *  @param {bigint} amount @param {number} nowNs @returns {Decision} */
export function check(policy, history, payee, amount, nowNs) {
  if (amount <= 0n) return { ok: false, reason: 'amount must be > 0' };

  // Rule 1 — single-transaction ceiling.
  if (amount > policy.perTxCap) {
    return { ok: false, reason: `over per-tx cap (${amount} > ${policy.perTxCap})` };
  }

  // Rule 2 — fail closed when there are no explicitly allowed payees.
  if (!policy.payeeAllowlist.includes(payee)) {
    return { ok: false, reason: `payee "${payee}" not in allowlist` };
  }

  // Rule 3 — rolling windows, evaluated against block time only.
  for (const w of policy.windows) {
    const spent = history
      .filter((s) => nowNs - s.at < w.periodNs)
      .reduce((a, s) => a + s.amount, 0n);
    if (spent + amount > w.limit) {
      return {
        ok: false,
        reason: `over ${fmtPeriod(w.periodNs)} window (${spent} spent + ${amount} > ${w.limit})`,
      };
    }
  }

  return { ok: true, reason: 'ok' };
}

/** @param {number} ns */
export function fmtPeriod(ns) {
  for (const [name, v] of [['month', NS.MONTH], ['day', NS.DAY], ['hour', NS.HOUR], ['min', NS.MIN]]) {
    if (Math.abs(ns - v) < 1) return name;
  }
  return `${ns}ns`;
}

/** Remaining budget per window — what an agent should consult before acting.
 *  @param {Policy} policy @param {Spend[]} history @param {number} nowNs */
export function remaining(policy, history, nowNs) {
  /** @type {Record<string, bigint>} */
  const out = { perTx: policy.perTxCap };
  for (const w of policy.windows) {
    const spent = history
      .filter((s) => nowNs - s.at < w.periodNs)
      .reduce((a, s) => a + s.amount, 0n);
    out[fmtPeriod(w.periodNs)] = w.limit - spent;
  }
  return out;
}

/** Largest amount currently payable — the agent's real ceiling right now. */
export function maxSpendable(policy, history, nowNs) {
  let cap = policy.perTxCap;
  for (const w of policy.windows) {
    const spent = history
      .filter((s) => nowNs - s.at < w.periodNs)
      .reduce((a, s) => a + s.amount, 0n);
    const left = w.limit - spent;
    if (left < cap) cap = left;
  }
  return cap < 0n ? 0n : cap;
}

/** Format a smallest-unit integer as a decimal string. */
export function fmt(amount, decimals = 6) {
  const d = BigInt(10) ** BigInt(decimals);
  const whole = amount / d;
  const frac = (amount % d).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}
