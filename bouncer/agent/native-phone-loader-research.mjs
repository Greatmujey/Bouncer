/**
 * RESEARCH ONLY: unsigned three-stage compressed native-vault review and
 * read-only original-hash receipt inspection. This is not connected to a
 * wallet, setup service, UI, database fence or public network. It does not
 * authorize a prompt, prove owner consent/current state/provider delivery, or
 * permit a retry of an uncertain original.
 *
 * The first transaction creates a keyless loader, initializes it, and requests
 * its asynchronous self-upgrade to the exact pinned V9. Configuration/funding
 * and restricted-key installation are separate owner transactions. A failed
 * or unobserved upgrade can leave the loader holding funds; refund requires
 * separately verified state and explicit owner authorization.
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import nearApi from 'near-api-js';
import { buildNativeOracleWalletPlan, isDirectTestnetChild, NATIVE_ORACLE_V9_BYTES,
  NATIVE_ORACLE_V9_SHA256, NATIVE_ORACLE_V9_CODE_HASH } from './native-oracle-wallet-plan.mjs';
import { validateNativeOracleOwnerPublicKey } from './native-oracle-wallet-evidence.mjs';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { graph, rootOf, statusKind, onlyProtocolGasRefund, protocolGasRefund } from './setup-receipt-graph.mjs';

export const NATIVE_PHONE_LOADER_BYTES = 28_950;
export const NATIVE_PHONE_LOADER_SHA256 = '28b358e4ee4e6c7327dc17c63934a63e4cdad5d424dbfe67a80381cf1027bb7b';
export const NATIVE_PHONE_COMPRESSED_BYTES = 135_476;
export const NATIVE_PHONE_COMPRESSED_SHA256 = '4fdc4feffcb7b690d3f6f4dec6f62af12b37cebdb3f1e78bc9486e366c81ec21';
export const NATIVE_PHONE_MAX_COMPRESSED_BYTES = 200_000;
const CREATE = 'create_compressed_native_vault', CONFIGURE = 'configure_fund_native_oracle', INSTALL = 'install_native_oracle_agent';
const STAGES = [CREATE, CONFIGURE, INSTALL], COUNTS = [5, 5, 1], TGAS = 10n ** 12n;
const DOMAIN = Buffer.from('bouncer-research-compressed-native-setup-batch-v1\0');
const DUMMY_KEY = nearApi.utils.PublicKey.from('ed25519:11111111111111111111111111111111');
const STAGE_FIELDS = ['id', 'signer_id', 'receiver_id', 'actions', 'action_commitment_sha256'];
const ATTEMPT_FIELDS = ['kind', 'status', 'network', 'review_sha256', 'stage_id', 'action_commitment_sha256',
  'tx_hash', 'signer_id', 'signer_public_key', 'receiver_id'];
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x, fields) => record(x) && Object.keys(x).length === fields.length && fields.every(k => Object.hasOwn(x, k));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const codeHash = bytes => nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(bytes).digest());
const numeric = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) :
  typeof value === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(value) ? value : null;

function checkedArtifacts(loaderBytes, compressedBytes, wasmBytes) {
  if (!(loaderBytes instanceof Uint8Array) || !(compressedBytes instanceof Uint8Array) || !(wasmBytes instanceof Uint8Array)) {
    throw new Error('explicit public loader, compressed stream and V9 bytes required');
  }
  const loader = Buffer.from(loaderBytes), compressed = Buffer.from(compressedBytes), wasm = Buffer.from(wasmBytes);
  if (loader.length !== NATIVE_PHONE_LOADER_BYTES || sha(loader) !== NATIVE_PHONE_LOADER_SHA256 ||
      compressed.length !== NATIVE_PHONE_COMPRESSED_BYTES || compressed.length > NATIVE_PHONE_MAX_COMPRESSED_BYTES ||
      sha(compressed) !== NATIVE_PHONE_COMPRESSED_SHA256 ||
      wasm.length !== NATIVE_ORACLE_V9_BYTES || sha(wasm) !== NATIVE_ORACLE_V9_SHA256) {
    throw new Error('research artifacts do not match pinned loader, bounds and V9');
  }
  let expanded;
  try { expanded = zlib.inflateRawSync(compressed, { maxOutputLength: NATIVE_ORACLE_V9_BYTES, info: true }); }
  catch { throw new Error('invalid or oversized raw-DEFLATE stream'); }
  if (expanded.engine.bytesWritten !== compressed.length || !expanded.buffer.equals(wasm)) {
    throw new Error('compressed stream must contain exactly the pinned V9 with no trailing bytes');
  }
  return { loader, compressed, wasm };
}

/** Public commitment with a dummy nonce, block hash and key: NOT a signed
 * transaction or its original hash. Changes to any encoded action alter it. */
export function researchPhoneBatchCommitment(batch) {
  const index = STAGES.indexOf(batch?.id);
  if (index < 0 || !isTestnetAccount(batch.signerId) ||
      (index === 2 ? batch.receiverId !== batch.signerId : !isDirectTestnetChild(batch.receiverId, batch.signerId)) ||
      !Array.isArray(batch.actions) || batch.actions.length !== COUNTS[index]) {
    throw new Error('invalid research phone setup batch');
  }
  try {
    const tx = nearApi.transactions.createTransaction(batch.signerId, DUMMY_KEY, batch.receiverId, 1n, batch.actions, Buffer.alloc(32));
    return crypto.createHash('sha256').update(DOMAIN).update(nearApi.transactions.encodeTransaction(tx)).digest('hex');
  } catch { throw new Error('cannot encode research phone setup batch'); }
}

export function assertResearchPhoneBatchMatchesReview(batch, stage) {
  if (!exact(stage, STAGE_FIELDS) || !record(batch) || batch.id !== stage.id || batch.signerId !== stage.signer_id ||
      batch.receiverId !== stage.receiver_id || !Array.isArray(stage.actions) || stage.actions.length !== batch.actions?.length ||
      !/^[a-f0-9]{64}$/.test(stage.action_commitment_sha256 ?? '') ||
      researchPhoneBatchCommitment(batch) !== stage.action_commitment_sha256) {
    throw new Error('research phone batch differs from retained review');
  }
  return true;
}

/** Only public inputs and signed-off-by-nobody testnet terms are accepted. */
export function buildResearchPhonePlan({ terms, wasmBytes, loaderBytes, compressedBytes, trustedOwnerPublicKey } = {}) {
  const { loader, compressed, wasm } = checkedArtifacts(loaderBytes, compressedBytes, wasmBytes);
  const base = buildNativeOracleWalletPlan({ terms, wasmBytes: wasm });
  const r = base.review, ownerKey = validateNativeOracleOwnerPublicKey(trustedOwnerPublicKey, r.agent_public_key), t = nearApi.transactions;
  const first = { id: CREATE, signerId: r.owner, receiverId: r.vault, actions: [
    t.createAccount(), t.transfer(BigInt(r.vault_storage_funding_yocto)), t.deployContract(loader),
    t.functionCall('loader_init', {}, 20n * TGAS, 1n), t.functionCall('loader_deploy', compressed, 240n * TGAS, 1n),
  ] };
  const second = { id: CONFIGURE, signerId: r.owner, receiverId: r.vault,
    actions: [...base.batches[1].actions, ...base.batches[2].actions] };
  const third = { ...base.batches[3], actions: [...base.batches[3].actions] };
  const batches = [first, second, third];
  const compressedSummary = { type: 'function_call', method: 'loader_deploy', args_encoding: 'raw-deflate',
    args_bytes: compressed.length, args_sha256: sha(compressed), gas: String(240n * TGAS), deposit_yocto: '1',
    self_deployment: { artifact_sha256: NATIVE_ORACLE_V9_SHA256, near_code_hash: NATIVE_ORACLE_V9_CODE_HASH,
      method: 'new', args: { owner: r.owner }, gas: String(30n * TGAS), deposit_yocto: '0' } };
  const summaries = [
    [{ type: 'create_account' }, { type: 'transfer', deposit_yocto: r.vault_storage_funding_yocto },
      { type: 'deploy_contract', byte_length: loader.length, sha256: sha(loader), near_code_hash: codeHash(loader) },
      { type: 'function_call', method: 'loader_init', args: {}, gas: String(20n * TGAS), deposit_yocto: '1' }, compressedSummary],
    r.stages.slice(1, 3).flatMap(stage => structuredClone(stage.actions)), structuredClone(r.stages[3].actions),
  ];
  const stages = batches.map((batch, i) => ({ id: batch.id, signer_id: batch.signerId, receiver_id: batch.receiverId,
    actions: summaries[i], action_commitment_sha256: researchPhoneBatchCommitment(batch) }));
  batches.forEach((batch, i) => assertResearchPhoneBatchMatchesReview(batch, stages[i]));
  const review = { format: 'bouncer-research-compressed-native-oracle-wallet-review-v1', status: 'UNSIGNED_OFFLINE_PLAN_ONLY',
    network: 'testnet', owner: r.owner, owner_public_key: ownerKey, vault: r.vault, policy_id: r.policy_id,
    agent_public_key: r.agent_public_key, asset: r.asset, payee: r.payee, project: structuredClone(r.project),
    per_tx_cap_yocto: r.per_tx_cap_yocto, daily_cap_yocto: r.daily_cap_yocto, vault_deposit_yocto: r.vault_deposit_yocto,
    agent_gas_allowance_yocto: r.agent_gas_allowance_yocto, vault_storage_funding_yocto: r.vault_storage_funding_yocto,
    artifact: structuredClone(r.artifact), loader: { bytes: loader.length, sha256: sha(loader), near_code_hash: codeHash(loader) },
    compressed: { bytes: compressed.length, sha256: sha(compressed), encoding: 'raw-deflate' },
    base_review_sha256: r.review_sha256, stages,
    limitations: [
      'Research only. This review is not an owner approval, a wallet prompt, a purchase, or a provider receipt.',
      'The first transaction self-upgrades asynchronously; failure can leave the loader and storage funds on the child.',
      'Never retry an unknown original. Any owner refund requires separately verified final state and explicit authorization.',
      'Each stage needs an independently retained one-shot claim, original hash, complete receipt graph and fresh FINAL state before the next prompt.',
      'Vault storage may be locked; the native deposit and gas allowance are additional and testnet-only.',
      'The agent key is restricted to the native OutLayer method and cannot attach the 1 yocto required for owner policy changes.',
      'Provider delivery, current code and policy, real-phone behavior and the independent prompt fence are not established by this review.',
    ], signing_authorized: false, transaction_sent: false, agent_key_installed: false, independent_delivery_verified: false };
  return { review: { ...review, review_sha256: sha(Buffer.from(JSON.stringify(review))) }, batches };
}

function canonical(options) {
  const { review, trustedReviewHash, trustedOwnerPublicKey } = options;
  if (!record(review) || typeof trustedReviewHash !== 'string' || !/^[a-f0-9]{64}$/.test(trustedReviewHash) ||
      review.review_sha256 !== trustedReviewHash || review.owner_public_key !== trustedOwnerPublicKey) {
    throw new Error('separately retained research review and owner public key required');
  }
  try {
    const plan = buildResearchPhonePlan({ ...options, terms: { owner: review.owner, vault: review.vault, policy_id: review.policy_id,
      agent_public_key: review.agent_public_key, per_tx_cap_yocto: review.per_tx_cap_yocto, daily_cap_yocto: review.daily_cap_yocto,
      vault_deposit_yocto: review.vault_deposit_yocto, agent_gas_allowance_yocto: review.agent_gas_allowance_yocto } });
    if (!isDeepStrictEqual(plan.review, review)) throw Error();
    return plan;
  } catch { throw new Error('research review differs from its constrained canonical plan'); }
}
export function verifyResearchPhoneReview(options = {}) {
  const { review } = canonical(options);
  return { review_sha256: review.review_sha256, owner: review.owner, owner_public_key: review.owner_public_key,
    vault: review.vault, agent_public_key: review.agent_public_key, wallet_prompt_authorized: false };
}
function attemptForPlan(plan, stageId, originalHash) {
  const index = STAGES.indexOf(stageId);
  if (index < 0 || !isTransactionHash(originalHash)) throw new Error('reviewed research stage and original hash required');
  const r = plan.review, s = r.stages[index];
  return { kind: 'research-compressed-native-oracle-attempt-v1', status: 'pending', network: 'testnet',
    review_sha256: r.review_sha256, stage_id: s.id, action_commitment_sha256: s.action_commitment_sha256,
    tx_hash: originalHash, signer_id: s.signer_id, signer_public_key: r.owner_public_key, receiver_id: s.receiver_id };
}
export function prepareResearchPhoneAttempt(options = {}) {
  return attemptForPlan(canonical(options), options.stageId, options.trustedOriginalHash);
}

function metadata(receipt) {
  const a = receipt?.receipt?.Action;
  return exact(receipt?.receipt, ['Action']) && record(a) &&
    Object.keys(a).every(k => ['signer_id','signer_public_key','gas_price','input_data_ids','output_data_receivers','actions','is_promise_yield','refund_to'].includes(k)) &&
    Array.isArray(a.input_data_ids) && a.input_data_ids.length === 0 &&
    Array.isArray(a.output_data_receivers) && a.output_data_receivers.length === 0 &&
    (a.is_promise_yield === undefined || a.is_promise_yield === false) && (a.refund_to === undefined || a.refund_to === null);
}
function assertUpgradeGraph(result, root, g, attempt, review) {
  const out = root.outcome, id = out.status?.SuccessReceiptId;
  if (statusKind(out.status) !== 'receipt' || !out.receipt_ids.includes(id) ||
      result.transaction_outcome.outcome.receipt_ids.length !== 1 || result.transaction_outcome.outcome.receipt_ids[0] !== root.id) {
    throw new Error('original loader outcome does not link its unique self-upgrade');
  }
  const receipt = g.receipts.get(id), outcome = g.outcomes.get(id), action = receipt?.receipt?.Action, calls = action?.actions;
  const code = Buffer.from(NATIVE_ORACLE_V9_SHA256, 'hex').toString('base64');
  const newArgs = Buffer.from(JSON.stringify({ owner: review.owner })).toString('base64');
  if (id === root.id || receipt?.predecessor_id !== review.vault || receipt?.receiver_id !== review.vault ||
      !metadata(receipt) || action.signer_id !== attempt.signer_id || action.signer_public_key !== attempt.signer_public_key ||
      !Array.isArray(calls) || calls.length !== 2 || !exact(calls[0], ['DeployContract']) ||
      !exact(calls[0].DeployContract, ['code']) || calls[0].DeployContract.code !== code ||
      !exact(calls[1], ['FunctionCall']) || !exact(calls[1].FunctionCall, ['method_name','args','gas','deposit']) ||
      calls[1].FunctionCall.method_name !== 'new' || calls[1].FunctionCall.args !== newArgs ||
      numeric(calls[1].FunctionCall.gas) !== String(30n * TGAS) || numeric(calls[1].FunctionCall.deposit) !== '0' ||
      outcome?.executor_id !== review.vault || !isDeepStrictEqual(outcome?.status, { SuccessValue: '' }) ||
      !isDeepStrictEqual(result.status, outcome.status)) {
    throw new Error('linked self-upgrade does not match the pinned V9 and owner initialization');
  }
  const known = new Set([root.id, id]);
  for (const [parent, required] of [[out, [id]], [outcome, []]]) {
    if (!Array.isArray(parent.receipt_ids) || required.some(child => !parent.receipt_ids.includes(child))) throw new Error('incomplete loader receipt graph');
    const extra = parent.receipt_ids.filter(child => !required.includes(child));
    if (extra.length > 1) throw new Error('unexpected loader descendant');
    for (const child of extra) {
      if (known.has(child) || !protocolGasRefund(g.receipts.get(child), g.outcomes.get(child), attempt)) {
        throw new Error('unexpected loader descendant');
      }
      known.add(child);
    }
  }
  if (g.receipts.size !== known.size || g.outcomes.size !== known.size ||
      [...known].some(child => !g.receipts.has(child) || !g.outcomes.has(child))) {
    throw new Error('unlinked or incomplete loader receipt graph');
  }
  return id;
}

/** Only inspect the independently retained original, never derive retry or
 * spending authority from a failure, a missing hash, or a successful receipt. */
export function inspectResearchPhoneAttempt(options = {}) {
  const { attempt, result } = options;
  if (!exact(attempt, ATTEMPT_FIELDS)) throw new Error('separately retained research attempt required');
  const plan = canonical(options), expected = attemptForPlan(plan, attempt.stage_id, options.trustedOriginalHash);
  if (!isDeepStrictEqual(attempt, expected)) throw new Error('research attempt differs from its retained original');
  const index = STAGES.indexOf(attempt.stage_id), batch = plan.batches[index];
  if (!record(result) || result.final_execution_status !== 'FINAL' || !['value', 'failure'].includes(statusKind(result.status))) {
    throw new Error('original research transaction is not terminal FINAL; preserve it and do not resend');
  }
  const g = graph(result, attempt.stage_id === INSTALL), root = rootOf(result, batch, attempt, g);
  if (!root.localReceiptOmitted && !metadata(root.receipt)) throw new Error('unexpected research action receipt metadata');
  const base = { stage_id: attempt.stage_id, tx_hash: options.trustedOriginalHash, do_not_resend: true,
    current_state_verified: false, independent_prompt_fence_verified: false, wallet_prompt_authorized: false,
    owner_approval_verified: false, independent_delivery_verified: false };
  if (statusKind(result.status) === 'failure' || [...g.outcomes.values()].some(out => statusKind(out.status) === 'failure')) {
    return { ...base, status: 'FINAL_FAILURE_NEEDS_STATE_REVIEW' };
  }
  let upgrade;
  if (attempt.stage_id === CREATE) upgrade = assertUpgradeGraph(result, root, g, attempt, plan.review);
  else if (!isDeepStrictEqual(result.status, { SuccessValue: '' }) || !isDeepStrictEqual(root.outcome.status, result.status) ||
      result.transaction_outcome.outcome.receipt_ids.length !== 1 || result.transaction_outcome.outcome.receipt_ids[0] !== root.id ||
      !onlyProtocolGasRefund(root.outcome, g, attempt, root.localReceiptOmitted) ||
      (attempt.stage_id === CONFIGURE && (!Array.isArray(root.outcome.logs) || !root.outcome.logs.includes('BOUNCER native deposit received')))) {
    throw new Error('unexpected, incomplete or nonterminal research setup receipt graph');
  }
  return { ...base, status: root.localReceiptOmitted ? 'FINAL_LOCAL_ADD_KEY_OUTCOME_MATCH' :
    attempt.stage_id === CREATE ? 'FINAL_RESEARCH_LOADER_AND_UPGRADE_MATCH' : 'FINAL_RESEARCH_NATIVE_SETUP_RECEIPT_MATCH',
    root_receipt: root.id, ...(upgrade ? { self_upgrade_receipt: upgrade } : {}), local_receipt_body_omitted: root.localReceiptOmitted,
    scope: 'trusted-RPC original and bounded receipt graph only; fresh state, independent fence, consent and delivery need separate checks' };
}
