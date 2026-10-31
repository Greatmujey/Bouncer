/**
 * Conservative, non-atomic batch preview. Individual contract `check` calls
 * each see current state; tentatively reserve shared policy budgets and token
 * vaults so a plan is not presented as jointly affordable when it is not.
 * These views are not a reservation or a guarantee of later execution.
 */
const U128_MAX = (1n << 128n) - 1n;
function amount(value) {
  if (typeof value !== 'string' || !/^\d{1,39}$/.test(value)) throw new Error('invalid contract amount');
  const parsed = BigInt(value);
  if (parsed > U128_MAX) throw new Error('contract amount outside U128');
  return parsed;
}

/** Mutates checks to mark newly blocked requests; never sends a transaction. */
export async function reservePreview(provider, plan, checks, summary, { policyReservations = [] } = {}) {
  if (!Array.isArray(policyReservations)) throw new Error('invalid prior policy reservations');
  const prior = new Map();
  for (const item of policyReservations) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 3 ||
        typeof item.policy_id !== 'string' || !item.policy_id || typeof item.token !== 'string' || !item.token ||
        !Object.hasOwn(item, 'amount')) throw new Error('invalid prior policy reservation');
    const reserved = amount(item.amount);
    if (reserved === 0n) throw new Error('invalid prior policy reservation');
    const previous = prior.get(item.policy_id);
    if (previous && previous.token !== item.token) throw new Error('conflicting reservation tokens');
    prior.set(item.policy_id, { token: item.token, reserved: (previous?.reserved ?? 0n) + reserved });
  }
  const counts = status => checks.filter(check => check.status === status).length;
  if (!Array.isArray(checks) || checks.length !== plan.requests.length ||
      checks.some((check, i) => check?.id !== plan.requests[i].id || !['READY', 'BLOCKED', 'SKIPPED'].includes(check.status)) ||
      summary.paid !== 0 || summary.skipped !== counts('SKIPPED') || summary.ready !== counts('READY') || summary.blocked !== counts('BLOCKED')) {
    throw new Error('incomplete batch preflight');
  }
  const policies = new Map(), tokens = new Map();
  const final = { finality: 'final' };
  const adjusted = { ...summary };
  for (let i = 0; i < checks.length; i++) {
    if (checks[i].status !== 'READY') continue;
    const request = plan.requests[i];
    let policy = policies.get(request.policy_id);
    if (!policy) {
      const [view, spent] = await Promise.all([
        provider.callFunction(plan.contract_id, 'get_policy', { policy_id: request.policy_id }, final),
        provider.callFunction(plan.contract_id, 'daily_spent', { policy_id: request.policy_id }, final),
      ]);
      if (!view || view.token !== request.token) throw new Error('policy changed during batch preflight');
      const existing = prior.get(request.policy_id);
      if (existing && existing.token !== view.token) throw new Error('prior reservation token does not match policy');
      // Prior reservations affect the rolling policy budget only. They may
      // represent provider-held credit, not a debit from this FT vault.
      policy = { token: view.token, cap: amount(view.per_tx_cap), daily: amount(view.daily_cap), spent: amount(spent), reserved: existing?.reserved ?? 0n };
      policies.set(request.policy_id, policy);
    }
    if (policy.token !== request.token) throw new Error('conflicting policy tokens');
    let vault = tokens.get(request.token);
    if (!vault) {
      const balance = await provider.callFunction(plan.contract_id, 'vault_balance', { token: request.token }, final);
      vault = { balance: amount(balance), reserved: 0n };
      tokens.set(request.token, vault);
    }
    const payment = amount(request.amount);
    let reason;
    if (payment > policy.cap) reason = 'Per-transaction cap changed or would be exceeded.';
    else if (policy.daily > 0n && policy.spent + policy.reserved + payment > policy.daily) reason = 'Combined preview would exceed this rolling daily budget.';
    else if (vault.reserved + payment > vault.balance) reason = 'Combined preview would exceed this token vault balance.';
    if (reason) {
      checks[i] = { id: request.id, status: 'BLOCKED', reason };
      adjusted.ready--; adjusted.blocked++;
    } else {
      policy.reserved += payment;
      vault.reserved += payment;
    }
  }
  return adjusted;
}
