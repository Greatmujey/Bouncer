/**
 * Fresh read-only preflight for exactly the NEXT reviewed native-oracle setup
 * stage. Earlier stages must be verified against independently retained
 * original hashes and receipt-inclusive FINAL RPC results. This does not fence
 * a wallet prompt, sign, broadcast, prove custody or authorize spending.
 */
import { isDeepStrictEqual } from 'node:util';
import { readPinnedJsonView } from './read-only-near-rpc.mjs';
import { verifyNativeOracleWalletReview, inspectNativeOracleWalletAttempt } from './native-oracle-wallet-evidence.mjs';
import { verifyAtomicNativeOracleWalletReview, inspectAtomicNativeOracleWalletAttempt } from './native-oracle-atomic-wallet.mjs';
import { NATIVE_ORACLE_V9_CODE_HASH, NATIVE_ORACLE_V9_BYTES, NATIVE_ORACLE_VAULT_FUNDING, NATIVE_ORACLE_PAYEE } from './native-oracle-wallet-plan.mjs';
import { ORACLE_TESTNET_PROGRAM, ORACLE_PROJECT_ID, ORACLE_PROJECT_UUID } from './oracle-outlayer.mjs';
import { MIN_V11_TESTNET_PROTOCOL, selectedV11WasmFeaturesEnabled } from './svalin-setup-preflight.mjs';
import { estimateV11ResourceGasAllowance } from '../shared/access-key-gas.mjs';
import { hasPlainOwnerProfileAt } from '../shared/plain-owner-profile.mjs';
import { pinnedAccessKeyNonce } from '../shared/pinned-access-key-nonce.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

const STAGES = ['create_keyless_native_vault', 'configure_native_oracle_policy', 'fund_native_vault', 'install_native_oracle_agent'];
const ATOMIC_STAGES = ['create_configure_fund_native_vault', 'install_native_oracle_agent'];
const MAX = (1n << 128n) - 1n, ONE = 10n ** 24n, VAULT_RESERVE = ONE / 10n, OWNER_RESERVE = ONE;
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x, names) => record(x) && Object.keys(x).length === names.length && names.every(name => Object.hasOwn(x, name));
const amount = x => typeof x === 'string' && /^(?:0|[1-9][0-9]{0,38})$/.test(x) && BigInt(x) <= MAX ? BigInt(x) : null;
const localCode = x => record(x) && (x.global_contract_hash === undefined || x.global_contract_hash === null) &&
  (x.global_contract_account_id === undefined || x.global_contract_account_id === null) &&
  (x.state === undefined || x.state === 'initialized') && (x.bootstrap_nonce === undefined || x.bootstrap_nonce === null);

/** All arguments and receipt results are PUBLIC. Caller must independently
 * retain review/hash, owner key and each original hash. A caller-supplied RPC
 * can lie; an eligible snapshot is a necessary observation, not approval. */
export async function inspectNativeOracleWalletStage(args = {}) {
  return inspectNativeOracleWalletState(args, false);
}

/** Recheck all FOUR original receipts and the installed one-method agent key
 * at one fresh FINAL block. This is read-only evidence, not permission to sign
 * or spend, proof of local key custody, provider fulfillment, or a guarantee
 * that chain state will remain unchanged after the snapshot. */
export async function inspectNativeOracleWalletCompletion(args = {}) {
  if (Object.hasOwn(args, 'stageId')) throw new Error('completion does not accept a wallet stage');
  return inspectNativeOracleWalletState({ ...args, stageId: 'verify_native_setup_completion' }, true);
}

/** The atomic variant has two ORIGINALS, not four: one indivisible vault
 * create/configure/fund receipt and a separate owner-account AddKey receipt.
 * This is not a prompt fence, transaction submission or live phone feature. */
export async function inspectAtomicNativeOracleWalletStage(args = {}) {
  return inspectNativeOracleWalletState(args, false, true);
}
export async function inspectAtomicNativeOracleWalletCompletion(args = {}) {
  if (Object.hasOwn(args, 'stageId')) throw new Error('completion does not accept a wallet stage');
  return inspectNativeOracleWalletState({ ...args, stageId: 'verify_native_setup_completion' }, true, true);
}

async function inspectNativeOracleWalletState({ review: rawReview, wasmBytes, trustedReviewHash, trustedOwnerPublicKey,
  stageId, prior = [], provider, now = Date.now } = {}, completion = false, atomic = false) {
  if (!(wasmBytes instanceof Uint8Array)) throw new Error('pinned native artifact required');
  const wasm = Buffer.from(wasmBytes), review = structuredClone(rawReview), previous = structuredClone(prior);
  const verifyReview = atomic ? verifyAtomicNativeOracleWalletReview : verifyNativeOracleWalletReview;
  const inspectAttempt = atomic ? inspectAtomicNativeOracleWalletAttempt : inspectNativeOracleWalletAttempt;
  const stages = atomic ? ATOMIC_STAGES : STAGES;
  const identity = verifyReview({ review, wasmBytes: wasm, trustedReviewHash, trustedOwnerPublicKey });
  const stageIndex = completion ? stages.length : stages.indexOf(stageId);
  if (stageIndex < 0 || !Array.isArray(previous) || previous.length !== stageIndex) {
    throw new Error('exactly the earlier original native stages are required');
  }
  const hashes = new Set();
  for (let i = 0; i < previous.length; i++) {
    const item = previous[i];
    if (!exact(item, ['attempt', 'trustedOriginalHash', 'result']) || item.attempt?.stage_id !== stages[i] ||
        !isTransactionHash(item.trustedOriginalHash) || hashes.has(item.trustedOriginalHash)) throw new Error('earlier original stage or hash is missing, repeated or out of order');
    hashes.add(item.trustedOriginalHash);
    const proof = inspectAttempt({ review, wasmBytes: wasm, trustedReviewHash, trustedOwnerPublicKey,
      trustedOriginalHash: item.trustedOriginalHash, attempt: item.attempt, result: item.result });
    if (!(atomic ? ['FINAL_ATOMIC_NATIVE_SETUP_RECEIPT_MATCH', 'FINAL_LOCAL_ADD_KEY_OUTCOME_MATCH'] :
      ['FINAL_NATIVE_SETUP_RECEIPT_MATCH', 'FINAL_LOCAL_ADD_KEY_OUTCOME_MATCH']).includes(proof.status)) {
      throw new Error('an earlier native original failed or remains unresolved; reconcile before another prompt');
    }
  }
  // The original state machine's 0, 3 and 4 snapshots correspond exactly to
  // before atomic creation, after the funded vault, and after AddKey. We still
  // verify the atomic originals above; never fabricate four separate receipts.
  const index = atomic ? [0, 3, 4][stageIndex] : stageIndex;
  if (typeof now !== 'function' || !provider || ['viewNodeStatus', 'viewBlock', 'query', 'viewTestnetAccountPresenceAt',
      'callFunctionRaw', 'experimental_protocolConfig', 'gasPrice'].some(name => typeof provider[name] !== 'function')) {
    throw new Error('read-only testnet provider required');
  }
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const started = now(), block = await provider.viewBlock({ finality: 'final' });
  const { hash } = assertFreshFinalBlock(block, started);
  if (!Number.isSafeInteger(block.header.height) || block.header.height < 1) throw new Error('invalid FINAL block height');
  const query = (request_type, account_id) => provider.query({ request_type, account_id, block_id: hash });
  const view = (account, method, args = {}) => readPinnedJsonView(provider, hash, account, method, args);
  const [owner, ownerKeys, child, outlayer, protocol, gas, project, version, pricing] = await Promise.all([
    query('view_account', review.owner), query('view_access_key_list', review.owner), provider.viewTestnetAccountPresenceAt(review.vault, hash),
    query('view_account', NATIVE_ORACLE_PAYEE), provider.experimental_protocolConfig({ blockId: hash }), provider.gasPrice(hash),
    view(NATIVE_ORACLE_PAYEE, 'get_project', { project_id: ORACLE_PROJECT_ID }),
    view(NATIVE_ORACLE_PAYEE, 'get_version', { project_id: ORACLE_PROJECT_ID, version_key: ORACLE_TESTNET_PROGRAM.sha256 }),
    view(NATIVE_ORACLE_PAYEE, 'get_project_pricing', { project_id: ORACLE_PROJECT_ID }),
  ]);
  const cost = amount(protocol?.runtime_config?.storage_amount_per_byte), gasPrice = amount(gas?.gas_price), ownerAmount = amount(owner?.amount);
  if (owner?.block_hash !== hash || ownerAmount === null || !Number.isSafeInteger(owner.storage_usage) || owner.storage_usage < 0 ||
      ownerKeys?.block_hash !== hash || !Array.isArray(ownerKeys.keys) || ownerKeys.keys.length > 1000 ||
      !ownerKeys.keys.every(k => record(k) && typeof k.public_key === 'string' && record(k.access_key)) ||
      new Set(ownerKeys.keys.map(k => k.public_key)).size !== ownerKeys.keys.length ||
      child?.block_hash !== hash || typeof child.exists !== 'boolean' || outlayer?.block_hash !== hash ||
      !isTransactionHash(outlayer.code_hash) || cost === null || cost === 0n || gasPrice === null || gasPrice === 0n) {
    throw new Error('malformed or mixed-block native setup views');
  }
  const ownerKey = ownerKeys.keys.find(k => k.public_key === identity.owner_public_key), nonce = pinnedAccessKeyNonce(ownerKey?.access_key?.nonce);
  const agentKey = ownerKeys.keys.find(k => k.public_key === identity.agent_public_key), agentNonce = pinnedAccessKeyNonce(agentKey?.access_key?.nonce);
  const ownerStorage = BigInt(owner.storage_usage) * cost, available = ownerAmount > ownerStorage ? ownerAmount - ownerStorage : 0n;
  const requiredOwner = OWNER_RESERVE + (index === 0 ? BigInt(NATIVE_ORACLE_VAULT_FUNDING) : 0n) +
    (index <= 2 ? BigInt(review.vault_deposit_yocto) : 0n);
  const gasEstimate = estimateV11ResourceGasAllowance(gas.gas_price);
  const expectedSource = { WasmUrl: { url: ORACLE_TESTNET_PROGRAM.url, hash: ORACLE_TESTNET_PROGRAM.sha256,
    build_target: ORACLE_TESTNET_PROGRAM.build_target } };
  const checks = {
    plain_owner: hasPlainOwnerProfileAt(owner, hash),
    exact_owner_key: !!ownerKey && ownerKey.access_key.permission === 'FullAccess' && nonce !== null,
    owner_native_estimate: available >= requiredOwner,
    protocol_and_selected_features: protocol?.chain_id === 'testnet' && Number.isSafeInteger(protocol.protocol_version) &&
      protocol.protocol_version >= MIN_V11_TESTNET_PROTOCOL && selectedV11WasmFeaturesEnabled(protocol),
    agent_gas_allowance_estimate: BigInt(review.agent_gas_allowance_yocto) >= gasEstimate,
    pinned_project_identity_and_native_pricing: project?.project_id === ORACLE_PROJECT_ID && project?.uuid === ORACLE_PROJECT_UUID &&
      project?.owner === 'zavodil2.testnet' && version?.wasm_hash === ORACLE_TESTNET_PROGRAM.sha256 &&
      isDeepStrictEqual(version?.source, expectedSource) && pricing === null,
  };
  if (completion) {
    const permission = agentKey?.access_key?.permission?.FunctionCall, allowance = amount(permission?.allowance);
    checks.exact_agent_key = exact(agentKey?.access_key?.permission, ['FunctionCall']) &&
      exact(permission, ['allowance', 'receiver_id', 'method_names']) && permission.receiver_id === review.vault &&
      isDeepStrictEqual(permission.method_names, ['execute_outlayer_native_project']) && agentNonce !== null && allowance !== null &&
      allowance >= gasEstimate && allowance <= BigInt(review.agent_gas_allowance_yocto);
  } else checks.agent_key_absent = !agentKey;
  let vaultState = null;
  if (index === 0) {
    checks.new_direct_child_absent = child.exists === false;
    checks.vault_storage_estimate = BigInt(NATIVE_ORACLE_VAULT_FUNDING) >= (BigInt(NATIVE_ORACLE_V9_BYTES) + 50_000n) * cost + VAULT_RESERVE;
  } else if (child.exists === false) {
    checks.exact_keyless_vault = false; checks.native_policy_state = false; checks.vault_native_balance = false;
    if (index >= 3) checks.onchain_policy_check = false;
  } else {
    const vaultAccount = child.account;
    const [vaultKeys, contractVersion, vaultOwner, policy, route, grant, tracked, verdict] = await Promise.all([
      query('view_access_key_list', review.vault), view(review.vault, 'contract_version'), view(review.vault, 'get_owner'),
      view(review.vault, 'get_policy', { policy_id: review.policy_id }),
      view(review.vault, 'get_outlayer_native_project', { policy_id: review.policy_id }),
      view(review.vault, 'is_agent_key_allowed', { policy_id: review.policy_id, public_key: identity.agent_public_key }),
      view(review.vault, 'vault_balance', { token: 'native' }),
      index >= 3 ? view(review.vault, 'check', { policy_id: review.policy_id, payee: NATIVE_ORACLE_PAYEE, amount: review.per_tx_cap_yocto }) : null,
    ]);
    const native = amount(vaultAccount?.amount), trackedAmount = amount(tracked);
    if (vaultAccount?.block_hash !== hash || native === null || !Number.isSafeInteger(vaultAccount.storage_usage) || vaultAccount.storage_usage < 0 ||
        vaultKeys?.block_hash !== hash || !Array.isArray(vaultKeys.keys) || vaultKeys.keys.length > 1000 || trackedAmount === null) {
      throw new Error('malformed or mixed-block native vault views');
    }
    const expectedRoute = { project: review.project, route_revision: 1, policy_revision: 1, payee_revision: 1, active: true };
    const exactPolicy = isDeepStrictEqual(policy, { token: 'native', per_tx_cap: review.per_tx_cap_yocto, daily_cap: review.daily_cap_yocto });
    checks.exact_keyless_vault = localCode(vaultAccount) && vaultAccount.code_hash === NATIVE_ORACLE_V9_CODE_HASH &&
      vaultKeys.keys.length === 0 && contractVersion === 'bouncer-agent-v9' && vaultOwner === review.owner;
    checks.native_policy_state = index === 1 ? policy === null && route === null && grant === false :
      exactPolicy && isDeepStrictEqual(route, expectedRoute) && grant === true;
    checks.vault_native_balance = trackedAmount === (index < 3 ? 0n : BigInt(review.vault_deposit_yocto)) &&
      native >= (BigInt(vaultAccount.storage_usage) + (index < 3 ? 50_000n : 0n)) * cost + trackedAmount + VAULT_RESERVE;
    if (index >= 3) checks.onchain_policy_check = Array.isArray(verdict) && verdict.length === 2 && verdict[0] === true;
    vaultState = { code_hash: vaultAccount.code_hash, key_count: vaultKeys.keys.length, tracked_native_yocto: trackedAmount.toString() };
  }
  const finished = now();
  if (!Number.isSafeInteger(finished) || finished < started) throw new Error('local clock moved backwards');
  assertFreshFinalBlock(block, finished);
  const blockers = Object.keys(checks).filter(name => !checks[name]);
  return { version: 1, network: 'testnet', status: blockers.length ? 'BLOCKED_OR_UNKNOWN' :
      completion ? (atomic ? 'TWO_ORIGINALS_AND_STATE_MATCH_NOT_AUTHORIZED' : 'FOUR_ORIGINALS_AND_STATE_MATCH_NOT_AUTHORIZED') : 'STATE_CHECKS_PASSED_NOT_AUTHORIZED',
    owner: review.owner, vault: review.vault, stage_id: stageId, review_sha256: trustedReviewHash,
    action_commitment_sha256: completion ? null : review.stages[stageIndex].action_commitment_sha256, prior_original_hashes: [...hashes],
    block_hash: hash, block_height: block.header.height, block_timestamp_nanosec: block.header.timestamp_nanosec,
    observed_at: new Date(finished).toISOString(), owner_key_nonce: nonce?.toString() ?? null,
    ...(completion ? { agent_key_nonce: agentNonce?.toString() ?? null, local_key_custody_verified: false, no_inflight_request_proven: false } : {}),
    owner_estimated_available_yocto: available.toString(), estimated_owner_minimum_yocto: requiredOwner.toString(),
    gas_price_yocto_per_gas: gasPrice.toString(), estimated_agent_gas_yocto: gasEstimate.toString(), vault_state: vaultState,
    checks, blockers, owner_approval_obtained: false, wallet_prompt_authorized: false, signing_authorized: false,
    transaction_sent: false, independent_delivery_verified: false,
    scope: 'trusted-RPC single FINAL block plus independently supplied prior receipt graphs; no custody, consent, prompt fence, current-time reservation, provider fulfillment or code audit' };
}
