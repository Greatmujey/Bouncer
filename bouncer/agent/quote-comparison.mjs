/**
 * Compare owner-approved providers for already-validated testnet tasks.
 * There is no discovery, currency conversion, payment, or model decision here.
 * Every candidate inherits one owner-pinned FT per resource, and all quotes
 * must match their approved policy/payee/order and maximum before selection.
 */
import { goalsFromModel, validatePlanningConfig } from './goal-planner.mjs';
import { httpResourceProvider, planFromQuotes } from './resource-agent.mjs';

const allowedGoalKeys = ['id', 'resource', 'input', 'policy_id', 'token', 'payee', 'max_amount'];
const MAX_QUOTES_IN_FLIGHT = 5;

// Limit simultaneous external requests and retain owner order regardless of
// response timing. Once any quote fails, start no queued requests and wait for
// already-started ones to settle; callers must never use a partial selection.
async function boundedQuotes(candidates, work) {
  const results = new Array(candidates.length);
  let cursor = 0, failure;
  async function worker() {
    while (!failure && cursor < candidates.length) {
      const index = cursor++;
      try { results[index] = await work(candidates[index]); }
      catch (error) { failure ||= error instanceof Error ? error : new Error('quote failed'); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_QUOTES_IN_FLIGHT, candidates.length) }, worker));
  if (failure) throw failure;
  return results;
}

/**
 * Reconstruct the proposal from task inputs and the owner catalog, so callers
 * cannot smuggle a different payee, token, route, policy or cap into selection.
 * `createClient` is injectable for tests; normal callers use the HTTP helper.
 */
export async function compareApprovedQuotes({ config: rawConfig, proposedGoals, createClient = url => httpResourceProvider(url) }) {
  const config = validatePlanningConfig(rawConfig);
  if (typeof createClient !== 'function' || !proposedGoals || typeof proposedGoals !== 'object' ||
      !Array.isArray(proposedGoals.goals) || proposedGoals.contract_id !== config.contract_id ||
      proposedGoals.owner_account_id !== config.owner_account_id || proposedGoals.provider_url !== config.provider_url) {
    throw new Error('proposal must match the owner-controlled catalog');
  }
  for (const goal of proposedGoals.goals) {
    if (!goal || typeof goal !== 'object' || Array.isArray(goal) ||
        Object.keys(goal).length !== allowedGoalKeys.length || Object.keys(goal).some(key => !allowedGoalKeys.includes(key))) {
      throw new Error('proposal contains unauthorized goal fields');
    }
  }
  const baseline = goalsFromModel({ tasks: proposedGoals.goals.map(goal => ({ resource: goal.resource, input: goal.input })) }, config);
  for (let i = 0; i < baseline.goals.length; i++) {
    const expected = baseline.goals[i], actual = proposedGoals.goals[i];
    if (['id', 'resource', 'policy_id', 'token', 'payee', 'max_amount'].some(key => actual[key] !== expected[key])) {
      throw new Error('proposal contains unauthorized financial authority');
    }
  }

  // Set up clients only after validating the complete proposal/catalog. A
  // provider sees the normalized order; it never sees keys or owner limits.
  const groups = baseline.goals.map(goal => {
    const resource = config.resources[goal.resource];
    const offers = [{ id: 'primary', provider_url: config.provider_url, policy_id: resource.policy_id,
      payee: resource.payee, max_amount: resource.max_amount }, ...(resource.alternatives || [])];
    return offers.map(offer => {
      const client = createClient(offer.provider_url);
      if (!client || typeof client.getQuote !== 'function') throw new Error('invalid approved quote client');
      return { offer, goal: { ...goal, policy_id: offer.policy_id, payee: offer.payee, max_amount: offer.max_amount }, client };
    });
  });

  // All candidates must respond with valid comparable quotes. An unavailable,
  // malformed, changed-token or unauthorized quote aborts the entire comparison;
  // no silent fallback to a more expensive provider and no payment is made here.
  const quoted = await boundedQuotes(groups.flat(), async candidate => {
    try {
      const plan = await planFromQuotes({ contractId: config.contract_id, ownerAccountId: config.owner_account_id,
        goals: [candidate.goal], getQuote: candidate.client.getQuote });
      return { offer: candidate.offer, amount: plan.requests[0].amount };
    } catch (error) {
      const message = String(error?.message || 'quote failed').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200);
      throw new Error(`${candidate.goal.id}/${candidate.offer.id}: comparison failed: ${message}`);
    }
  });
  let offset = 0;
  const results = groups.map(group => { const slice = quoted.slice(offset, offset + group.length); offset += group.length; return slice; });

  const comparisons = [];
  const selectedGoals = results.map((quotes, index) => {
    // BigInt comparison uses smallest units of ONE pinned FT. Ties preserve
    // owner order (primary, then alternatives as listed), never network timing.
    const selected = quotes.reduce((best, current) => BigInt(current.amount) < BigInt(best.amount) ? current : best);
    const goal = baseline.goals[index];
    comparisons.push({ goal_id: goal.id, token: goal.token,
      quotes: quotes.map(({ offer, amount }) => ({ provider_id: offer.id, amount })), selected_provider: selected.offer.id });
    return { ...goal, policy_id: selected.offer.policy_id, payee: selected.offer.payee,
      max_amount: selected.offer.max_amount, quote_amount: selected.amount,
      provider_id: selected.offer.id, provider_url: selected.offer.provider_url };
  });
  return { ...baseline, goals: selectedGoals, quote_comparisons: comparisons };
}
