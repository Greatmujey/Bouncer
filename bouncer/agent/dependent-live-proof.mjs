// Testnet demonstration harness, not an agent execution API. The actual
// workflow runner is shared with normal use; this harness deliberately loses
// one response *after* a real broadcast to exercise hash-only recovery.
import { isDeepStrictEqual } from 'node:util';
import { runWorkflow, validateWorkflow } from './workflow.mjs';

export function makeOracleDependentWorkflow({ goal, token, payee, policyId, price, providerUrl }) {
  const route = { policy_id: policyId, token, payee, max_amount: String(price) };
  return validateWorkflow({
    version: 1, id: 'live-dependent-oracle', source: { kind: 'oracle', goal }, provider_url: providerUrl,
    steps: [
      { id: 'dependent-compute', resource: 'compute', ...route,
        input: { text: { from: goal.id }, rounds: 25 } },
      { id: 'dependent-storage', resource: 'storage', ...route,
        input: { name: 'dependent-oracle-report', content: { from: 'dependent-compute' } } },
      { id: 'dependent-api', resource: 'api', ...route,
        input: { text: { from: 'dependent-storage' } } },
    ],
  });
}

function assert(condition, message) { if (!condition) throw new Error(`dependent proof: ${message}`); }
function signedMethod(signed) {
  const actions = signed?.transaction?.actions;
  return Array.isArray(actions) && actions.length === 1 ? actions[0]?.functionCall?.methodName : undefined;
}
function parseArtifact(text, id) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(`dependent proof: ${id} did not receive a JSON artifact`); }
  assert(value && typeof value === 'object' && !Array.isArray(value), `${id} artifact is invalid`);
  return value;
}

/**
 * Exercises one freshly configured testnet workflow. The caller supplies a
 * key-free recovery callback that must reopen its journal after recovery.
 * Any unexpected/ambiguous error escapes; there is no payment retry here.
 */
export async function runDependentLiveProof({ workflow: raw, provider, source, resources, getJournal, recoverWithoutKeys, log = () => {} }) {
  const workflow = validateWorkflow(raw);
  assert(workflow.source.kind === 'oracle' && workflow.steps.length === 3 &&
    workflow.steps.map(step => step.id).join(',') === 'dependent-compute,dependent-storage,dependent-api', 'unexpected proof workflow');
  assert(typeof getJournal === 'function' && typeof recoverWithoutKeys === 'function', 'journal and recovery callback required');
  const journal = () => getJournal();
  // This fault-injection proof MUST NOT be run against an existing journal.
  for (const id of [`workflow:${workflow.id}`, workflow.source.goal.id, ...workflow.steps.map(step => step.id)]) {
    assert(!journal().get(id), `refusing to run a fresh proof with existing journal entry ${id}`);
  }
  const quoted = [];
  const trackedResources = { ...resources, getQuote: async (order, context) => {
    quoted.push({ order: structuredClone(order), context: structuredClone(context) });
    return resources.getQuote(order, context);
  } };
  let sourceBroadcasts = 0, resourceBroadcasts = 0, injected = false;
  const trackedProvider = new Proxy(provider, { get(target, property) {
    if (property === 'sendTransactionUntil') return async (...args) => {
      const method = signedMethod(args[0]);
      if (method === 'execute_outlayer_native_project') {
        assert(++sourceBroadcasts === 1, 'attempted more than one source broadcast');
      } else if (method === 'execute') {
        assert(++resourceBroadcasts <= 3, 'attempted more than three resource broadcasts');
      } else throw new Error('dependent proof: unexpected signed transaction');
      // The signed hash has already been durably saved by the runner. Do not
      // retry if the RPC itself errors or the outcome is ambiguous.
      const result = await target.sendTransactionUntil(...args);
      if (method === 'execute' && !injected) {
        injected = true;
        throw new Error('injected lost response after actual broadcast');
      }
      return result;
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const common = () => ({ workflow, provider: trackedProvider, source, resources: trackedResources, journal: journal(), log });
  const preview = await runWorkflow(common());
  assert(preview.status === 'READY' && preview.preview?.payments?.blocked === 0 &&
    sourceBroadcasts === 0 && resourceBroadcasts === 0 && quoted.length === 0, 'maximum-budget preview was not read-only and ready');
  try {
    await runWorkflow({ ...common(), execute: true });
    throw new Error('dependent proof: lost-response injection unexpectedly completed');
  } catch (error) {
    if (!/payment could not be confirmed.*injected lost response after actual broadcast/.test(error.message)) throw error;
  }
  const first = journal().get(workflow.steps[0].id), firstHash = first?.tx_hash;
  const sourceHash = journal().get(workflow.source.goal.id)?.tx_hash;
  assert(injected && sourceBroadcasts === 1 && resourceBroadcasts === 1 && sourceHash && firstHash &&
    journal().get(workflow.source.goal.id)?.status === 'completed' && first.status === 'pending' &&
    first.payment_version === 'direct-signed-v1' && !journal().get(workflow.steps[1].id) && !journal().get(workflow.steps[2].id),
  'lost response did not leave exactly one unresolved signed resource hash');

  // The recovery callback receives neither an agent account nor a private key.
  // Failure must stop the proof; never move on to the next payment.
  const recovered = await recoverWithoutKeys({ firstHash, sourceHash, workflow });
  assert(recovered?.status === 'RECOVERED' && recovered.next === workflow.steps[1].id && recovered.new_payments === 0 &&
    sourceBroadcasts === 1 && resourceBroadcasts === 1 && journal().get(workflow.steps[0].id)?.tx_hash === firstHash &&
    journal().get(workflow.steps[0].id)?.delivery?.status === 'verified' && !journal().get(workflow.steps[1].id),
  'key-free recovery did not verify the first payment without a second broadcast');

  // Resume with only the FT agent key. The existing source and first payment
  // are recovered by hash, not signed again, before the next purchase.
  const result = await runWorkflow({ ...common(), source: {}, execute: true });
  assert(result.status === 'FULFILLED' && result.new_source_payments === 0 && result.new_resource_payments === 2 &&
    sourceBroadcasts === 1 && resourceBroadcasts === 3 && result.deliveries.length === 3 && quoted.length === 3 &&
    result.independent.delivery.tx_hash === sourceHash && journal().get(workflow.steps[0].id)?.tx_hash === firstHash &&
    workflow.steps.every(step => journal().get(step.id)?.delivery?.status === 'verified'),
  'resumed workflow did not complete using exactly the recorded payments');

  // Check actual data flow, not merely the existence of three successful
  // payments. Each paid order must include the immediately preceding verified
  // artifact (including the original transaction hash and bounded result).
  const [computeOrder, storageOrder, apiOrder] = quoted.map(item => item.order);
  assert(computeOrder.resource === 'compute' && storageOrder.resource === 'storage' && apiOrder.resource === 'api', 'quote order changed');
  const sourceArtifact = parseArtifact(computeOrder.input.text, 'compute');
  const computeArtifact = parseArtifact(storageOrder.input.content, 'storage');
  const storageArtifact = parseArtifact(apiOrder.input.text, 'api');
  const observation = result.independent.delivery.result;
  assert(sourceArtifact.goal_id === workflow.source.goal.id && sourceArtifact.kind === 'oracle' && sourceArtifact.tx_hash === sourceHash &&
    isDeepStrictEqual(sourceArtifact.result, { token_id: observation.token_id, source: observation.source,
      price_usd: observation.price_usd, timestamp: observation.timestamp }), 'compute input was not the verified independent result');
  assert(computeArtifact.goal_id === workflow.steps[0].id && computeArtifact.kind === 'compute' && computeArtifact.tx_hash === firstHash &&
    isDeepStrictEqual(computeArtifact.result, result.deliveries[0].result), 'storage input was not the verified compute result');
  assert(storageArtifact.goal_id === workflow.steps[1].id && storageArtifact.kind === 'storage' &&
    storageArtifact.tx_hash === journal().get(workflow.steps[1].id).tx_hash &&
    isDeepStrictEqual(storageArtifact.result, result.deliveries[1].result), 'API input was not the verified storage result');
  return { result, quoted: quoted.map(item => item.order), sourceHash, firstHash, sourceBroadcasts, resourceBroadcasts };
}
