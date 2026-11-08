// Testnet demonstration harness, not an agent execution API. The actual
// workflow runner is shared with normal use; this harness deliberately loses
// one response *after* a real broadcast to exercise hash-only recovery.
import { isDeepStrictEqual } from 'node:util';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { runWorkflow, validateWorkflow } from './workflow.mjs';
import { challengeFromOrderMemo, challengeFromOrderMemoV3, orderMemo, signClaimAuthorization, verifyClaimAuthorization } from '../packages/provider-sdk/index.mjs';

export function makeOracleDependentWorkflow({ goal, token, payee, policyId, price, providerUrl, orderBinding }) {
  const route = { policy_id: policyId, token, payee, max_amount: String(price),
    ...(orderBinding === undefined ? {} : { order_binding: orderBinding }) };
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
export async function runDependentLiveProof({ workflow: raw, provider, source, resources, getJournal, recoverWithoutKeys,
  recoverSourceWithoutKeys, log = () => {} }) {
  const workflow = validateWorkflow(raw);
  assert(workflow.source.kind === 'oracle' && workflow.steps.length === 3 &&
    workflow.steps.map(step => step.id).join(',') === 'dependent-compute,dependent-storage,dependent-api', 'unexpected proof workflow');
  assert(typeof getJournal === 'function' && typeof recoverWithoutKeys === 'function' &&
    (recoverSourceWithoutKeys === undefined || typeof recoverSourceWithoutKeys === 'function'), 'journal and recovery callback required');
  const journal = () => getJournal();
  // This fault-injection proof MUST NOT be run against an existing journal.
  for (const id of [`workflow:${workflow.id}`, workflow.source.goal.id, ...workflow.steps.map(step => step.id)]) {
    assert(!journal().get(id), `refusing to run a fresh proof with existing journal entry ${id}`);
  }
  const quoted = [];
  const trackedResources = { ...resources, getQuote: async (order, context) => {
    const observed = { order: structuredClone(order), context: structuredClone(context) };
    quoted.push(observed);
    const quote = await resources.getQuote(order, context);
    observed.quote = structuredClone(quote);
    return quote;
  } };
  let sourceBroadcasts = 0, resourceBroadcasts = 0, injected = false;
  const trackedProvider = new Proxy(provider, { get(target, property) {
    if (property === 'sendTransactionUntil' || property === 'sendTransactionOnce') {
      const transport = Reflect.get(target, property, target);
      if (typeof transport !== 'function') return transport;
      return async (...args) => {
      const method = signedMethod(args[0]);
      if (method === 'execute_outlayer_native_project') {
        assert(++sourceBroadcasts === 1, 'attempted more than one source broadcast');
      } else if (method === 'execute') {
        assert(++resourceBroadcasts <= 3, 'attempted more than three resource broadcasts');
      } else throw new Error('dependent proof: unexpected signed transaction');
      // The signed hash has already been durably saved by the runner. Do not
      // retry if the RPC itself errors or the outcome is ambiguous.
      const result = await transport.apply(target, args);
      if (method === 'execute' && !injected) {
        injected = true;
        throw new Error('injected lost response after actual broadcast');
      }
      return result;
      };
    }
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const common = () => ({ workflow, provider: trackedProvider, source, resources: trackedResources, journal: journal(), log });
  const preview = await runWorkflow(common());
  assert(preview.status === 'READY' && preview.preview?.payments?.blocked === 0 &&
    sourceBroadcasts === 0 && resourceBroadcasts === 0 && quoted.length === 0, 'maximum-budget preview was not read-only and ready');
  let executionError, sourceRecovered = false;
  try { await runWorkflow({ ...common(), execute: true }); }
  catch (error) { executionError = error; }
  // A transport timeout on the single source broadcast need not strand a fresh
  // proof if a key-free reader can reconcile that SAME hash. There is never a
  // second source submission. Failure to find FINAL evidence stops the proof.
  const pendingSource = journal().get(workflow.source.goal.id);
  if (executionError && recoverSourceWithoutKeys && /payment\/delivery unresolved/.test(String(executionError.message)) &&
      sourceBroadcasts === 1 && resourceBroadcasts === 0 && pendingSource?.status === 'pending' && pendingSource.tx_hash &&
      !workflow.steps.some(step => journal().get(step.id))) {
    const sourceHash = pendingSource.tx_hash;
    const recovered = await recoverSourceWithoutKeys({ sourceHash, workflow });
    assert(recovered?.status === 'RECOVERED' && recovered.next === workflow.steps[0].id && recovered.new_payments === 0 &&
      journal().get(workflow.source.goal.id)?.status === 'completed' && journal().get(workflow.source.goal.id)?.tx_hash === sourceHash &&
      sourceBroadcasts === 1 && resourceBroadcasts === 0, 'key-free source recovery did not reconcile the original hash');
    sourceRecovered = true;
    executionError = undefined;
    try { await runWorkflow({ ...common(), source: {}, execute: true }); }
    catch (error) { executionError = error; }
  }
  if (!executionError) throw new Error('dependent proof: lost-response injection unexpectedly completed');
  if (!/payment could not be confirmed.*injected lost response after actual broadcast/.test(executionError.message)) throw executionError;
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
  // The transaction journal must carry the exact memo actually quoted for
  // each dependent input. V2 challenges must be distinct, while legacy runs
  // must continue to use the original deterministic format.
  const quoteMemos = {}, challenges = [];
  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i], observed = quoted[i], memo = journal().get(step.id)?.request?.memo;
    assert(observed.context?.goalId === step.id && observed.quote?.memo === memo, `${step.id} quoted memo changed before payment`);
    if (['seller-v2', 'seller-v3'].includes(step.order_binding)) {
      assert(observed.order.order_binding === step.order_binding, `${step.id} did not request its reviewed seller binding`);
      const challenge = step.order_binding === 'seller-v3'
        ? challengeFromOrderMemoV3(step.resource, observed.order.input, memo) : challengeFromOrderMemo(step.resource, observed.order.input, memo);
      assert(!challenges.includes(challenge), `${step.id} reused a seller challenge`);
      challenges.push(challenge);
    } else {
      assert(observed.order.order_binding === undefined && memo === orderMemo(step.resource, observed.order.input),
        `${step.id} did not preserve the legacy order memo`);
    }
    quoteMemos[step.resource] = memo;
  }
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
  return { result, quoted: quoted.map(item => item.order), quoteMemos, challenges,
    sourceHash, firstHash, sourceBroadcasts, resourceBroadcasts, sourceRecovered };
}

/**
 * Verify the fresh reference seller's persisted claims after a v2 proof. This
 * checks consistency of local state and the already-verified buyer journal; it
 * is not an independent proof of seller behavior or a substitute for RPC proof.
 */
export function verifySellerV2ProofState({ workflow: raw, proof, journal, state }) {
  const workflow = validateWorkflow(raw), steps = workflow.steps;
  assert(steps.length === 3 && steps.every(step => step.order_binding === 'seller-v2'), 'seller-v2 proof needs three v2 steps');
  assert(journal && typeof journal.get === 'function' && Array.isArray(proof?.quoted) && proof.quoted.length === 3 &&
    Array.isArray(proof.challenges) && proof.challenges.length === 3, 'seller-v2 proof data is incomplete');
  assert(state?.version === 3 && state.network === 'testnet' && state.contract_id === workflow.source.goal.contract_id &&
    state.owner_account_id === workflow.source.goal.owner_account_id && state.quotes && state.redemptions &&
    Object.keys(state.quotes).length === 3 && Object.keys(state.redemptions).length === 3, 'seller-v2 state is not the fresh three-quote store');
  const hashes = new Set(), challenges = new Set();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i], order = proof.quoted[i], entry = journal.get(step.id), request = entry?.request;
    assert(order?.resource === step.resource && order.order_binding === 'seller-v2' && entry?.status === 'completed' &&
      entry.payment_version === 'direct-signed-v1' && entry.settlement?.tx_hash === entry.tx_hash &&
      entry.delivery?.status === 'verified' && entry.delivery.receipt?.tx_hash === entry.tx_hash &&
      proof.quoteMemos?.[step.resource] === request?.memo, `${step.id} buyer evidence is incomplete`);
    const challenge = challengeFromOrderMemo(step.resource, order.input, request.memo);
    assert(proof.challenges[i] === challenge && !challenges.has(challenge) && !hashes.has(entry.tx_hash), `${step.id} challenge or hash was reused`);
    challenges.add(challenge); hashes.add(entry.tx_hash);
    const quote = state.quotes[challenge], redeemed = state.redemptions[entry.tx_hash];
    assert(quote?.resource === step.resource && quote.memo === request.memo && quote.tx_hash === entry.tx_hash && quote.read_only === false &&
      isDeepStrictEqual(quote.product, { policy_id: request.policy_id, token: request.token, payee: request.payee, amount: request.amount }) &&
      redeemed?.status === 'completed' && redeemed.resource === step.resource && redeemed.memo === request.memo,
    `${step.id} persisted seller claim does not match the verified payment`);
  }
  assert(proof.firstHash === journal.get(steps[0].id)?.tx_hash, 'first recovered hash changed');
  return { quote_count: challenges.size, claimed_transaction_count: hashes.size, first_hash: proof.firstHash };
}

/** Probe access control using only an existing completed test order; never pays. */
export async function verifySellerV3AccessControls({ workflow: raw, proof, journal, fulfill, readStorage }) {
  const workflow = validateWorkflow(raw), [first, storageStep] = workflow.steps;
  assert(workflow.steps.length === 3 && workflow.steps.every(step => step.order_binding === 'seller-v3') &&
    typeof fulfill === 'function' && typeof readStorage === 'function', 'v3 access probe needs a completed authenticated workflow');
  const entry = journal.get(first.id), request = entry?.request, input = proof.quoted?.[0]?.input;
  assert(entry?.status === 'completed' && request && input, 'v3 access probe requires completed evidence');
  const rejected = async (label, pattern, operation) => {
    try { await operation(); } catch (error) {
      if (!pattern.test(String(error?.message))) throw new Error(`${label}: unexpected rejection`, { cause: error });
      return;
    }
    throw new Error(`${label}: unexpectedly succeeded`);
  };
  // Anyone can observe this proof; it must not reveal a cached result.
  const publicProof = { tx_hash: entry.tx_hash, resource: request.resource, input, memo: request.memo };
  await rejected('public proof without claim signature', /invalid seller-bound redemption/,
    () => fulfill(publicProof, { goalId: first.id }));
  const other = nearApi.KeyPair.fromRandom('ed25519');
  const forged = await signClaimAuthorization({ signer: new nearApi.KeyPairSigner(other), publicKey: other.getPublicKey(), terms: {
    network: 'near:testnet', contract_id: workflow.source.goal.contract_id, owner_account_id: workflow.source.goal.owner_account_id,
    seller_origin: new URL(workflow.provider_url).origin, resource: request.resource, policy_id: request.policy_id,
    token: request.token, payee: request.payee, amount: request.amount, memo: request.memo, tx_hash: entry.tx_hash } });
  await rejected('wrong-key signed claim', /recorded transaction key/,
    () => fulfill({ ...publicProof, authorization: forged }, { goalId: first.id }));
  const storage = proof.result.deliveries[1].result, stored = journal.get(storageStep.id);
  await rejected('unauthenticated storage read', /HTTP 403/, () => readStorage(storage.object_id));
  const content = await readStorage(storage.object_id, { txHash: stored.tx_hash, authorization: stored.resource_authorization });
  assert(crypto.createHash('sha256').update(content).digest('hex') === storage.sha256, 'authenticated storage readback did not match delivery');
  return { public_proof_only_rejected: true, wrong_signing_key_rejected: true, authenticated_storage_read_checked: true };
}

/** Read-only consistency check; signed claim bytes stay in the private buyer journal. */
export function verifySellerV3ProofState({ workflow: raw, proof, journal, state }) {
  const workflow = validateWorkflow(raw), steps = workflow.steps;
  assert(steps.length === 3 && steps.every(step => step.order_binding === 'seller-v3'), 'seller-v3 proof needs three authenticated steps');
  assert(journal && typeof journal.get === 'function' && Array.isArray(proof?.quoted) && proof.quoted.length === 3 &&
    Array.isArray(proof.challenges) && proof.challenges.length === 3, 'seller-v3 proof data is incomplete');
  assert(state?.version === 4 && state.network === 'testnet' && state.contract_id === workflow.source.goal.contract_id &&
    state.owner_account_id === workflow.source.goal.owner_account_id && state.quotes && state.redemptions &&
    Object.keys(state.quotes).length === 3 && Object.keys(state.redemptions).length === 3, 'seller-v3 state is not the fresh three-quote store');
  const hashes = new Set(), challenges = new Set(), origin = new URL(workflow.provider_url).origin;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i], order = proof.quoted[i], entry = journal.get(step.id), request = entry?.request;
    assert(order?.resource === step.resource && order.order_binding === 'seller-v3' && entry?.status === 'completed' &&
      entry.payment_version === 'direct-signed-v1' && entry.settlement?.tx_hash === entry.tx_hash &&
      entry.delivery?.status === 'verified' && entry.delivery.receipt?.tx_hash === entry.tx_hash &&
      proof.quoteMemos?.[step.resource] === request?.memo, `${step.id} authenticated buyer evidence is incomplete`);
    const challenge = challengeFromOrderMemoV3(step.resource, order.input, request.memo);
    assert(proof.challenges[i] === challenge && !challenges.has(challenge) && !hashes.has(entry.tx_hash), `${step.id} challenge or hash was reused`);
    challenges.add(challenge); hashes.add(entry.tx_hash);
    const quote = state.quotes[challenge], redeemed = state.redemptions[entry.tx_hash];
    assert(quote?.resource === step.resource && quote.memo === request.memo && quote.tx_hash === entry.tx_hash && quote.read_only === false &&
      quote.seller_origin === origin && quote.agent_public_key === entry.agent_public_key &&
      isDeepStrictEqual(quote.product, { policy_id: request.policy_id, token: request.token, payee: request.payee, amount: request.amount }) &&
      redeemed?.status === 'completed' && redeemed.resource === step.resource && redeemed.memo === request.memo,
    `${step.id} persisted authenticated seller claim does not match the payment`);
    verifyClaimAuthorization({ network: 'near:testnet', contract_id: workflow.source.goal.contract_id,
      owner_account_id: workflow.source.goal.owner_account_id, seller_origin: origin, resource: request.resource,
      policy_id: request.policy_id, token: request.token, payee: request.payee, amount: request.amount, memo: request.memo, tx_hash: entry.tx_hash },
    entry.resource_authorization, entry.agent_public_key);
  }
  assert(proof.firstHash === journal.get(steps[0].id)?.tx_hash, 'first recovered hash changed');
  return { quote_count: challenges.size, claimed_transaction_count: hashes.size, first_hash: proof.firstHash };
}
