/**
 * Read-only, single-FINAL-block preflight for one independently retained
 * native agent-key revocation stage. It never opens a wallet, claims a prompt,
 * signs, sends, deletes browser data or proves wallet control. A trusted RPC,
 * clock, authenticated owner, independently durable prompt fence and retained
 * original hashes remain separate trust boundaries.
 */
import { verifyNativeOracleRevocationReview, inspectNativeOracleRevocationAttempt } from './native-oracle-wallet-recovery.mjs';
import { NATIVE_ORACLE_V9_CODE_HASH } from './native-oracle-wallet-plan.mjs';
import { readPinnedJsonView } from './read-only-near-rpc.mjs';
import { hasPlainOwnerProfileAt } from '../shared/plain-owner-profile.mjs';
import { pinnedAccessKeyNonce } from '../shared/pinned-access-key-nonce.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';

const REMOVE = 'remove_native_oracle_access_key', REVOKE = 'revoke_native_oracle_vault_grant';
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x, fields) => object(x) && Object.keys(x).length === fields.length && fields.every(k => Object.hasOwn(x, k));
const localCode = x => object(x) && (x.global_contract_hash === undefined || x.global_contract_hash === null) &&
  (x.global_contract_account_id === undefined || x.global_contract_account_id === null) &&
  (x.state === undefined || x.state === 'initialized') && (x.bootstrap_nonce === undefined || x.bootstrap_nonce === null);

export async function inspectNativeOracleRevocationStage(options = {}) {
  const { provider, now = Date.now, stageId } = options;
  const recoveryReview = structuredClone(options.recoveryReview), setupReview = structuredClone(options.setupReview);
  const prior = structuredClone(options.prior ?? []), args = { ...options, recoveryReview, setupReview };
  const id = verifyNativeOracleRevocationReview(args);
  const stages = recoveryReview.stages, index = stages.findIndex(s => s.id === stageId);
  if (index < 0 || !Array.isArray(prior) || prior.length !== index || index > 1) {
    throw new Error('exactly the earlier retained recovery original is required');
  }
  const hashes = [];
  if (index === 1) {
    const item = prior[0];
    if (stages[0].id !== REMOVE || stageId !== REVOKE || !exact(item, ['attempt', 'trustedOriginalHash', 'result']) ||
        item.attempt?.stage_id !== REMOVE) throw new Error('earlier original recovery stage is missing or out of order');
    const proof = inspectNativeOracleRevocationAttempt({ ...args, ...item });
    if (!['FINAL_LOCAL_DELETE_KEY_OUTCOME_MATCH', 'FINAL_NATIVE_RECOVERY_RECEIPT_MATCH'].includes(proof.status)) {
      throw new Error('earlier recovery original failed or remains unresolved; stop and reconcile');
    }
    hashes.push(item.trustedOriginalHash);
  }
  if (typeof now !== 'function' || !provider || ['viewNodeStatus', 'viewBlock', 'query', 'callFunctionRaw']
      .some(name => typeof provider[name] !== 'function')) throw new Error('trusted read-only testnet provider required');
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const started = now(), block = await provider.viewBlock({ finality: 'final' }), { hash } = assertFreshFinalBlock(block, started);
  if (!Number.isSafeInteger(block.header.height) || block.header.height < 1) throw new Error('invalid FINAL block height');
  const query = (request_type, account_id) => provider.query({ request_type, account_id, block_id: hash });
  const [owner, ownerKeys] = await Promise.all([query('view_account', id.owner), query('view_access_key_list', id.owner)]);
  if (owner?.block_hash !== hash || ownerKeys?.block_hash !== hash || !Array.isArray(ownerKeys.keys) || ownerKeys.keys.length > 1000 ||
      !ownerKeys.keys.every(k => object(k) && typeof k.public_key === 'string' && object(k.access_key)) ||
      new Set(ownerKeys.keys.map(k => k.public_key)).size !== ownerKeys.keys.length) throw new Error('malformed or mixed-block owner views');
  const ownerKey = ownerKeys.keys.find(k => k.public_key === id.owner_public_key), nonce = pinnedAccessKeyNonce(ownerKey?.access_key?.nonce);
  const agentKey = ownerKeys.keys.find(k => k.public_key === id.agent_public_key);
  const checks = { plain_owner: hasPlainOwnerProfileAt(owner, hash), exact_owner_full_access_key: !!ownerKey &&
    ownerKey.access_key.permission === 'FullAccess' && nonce !== null,
    expected_agent_access_key_state: stageId === REMOVE ? !!agentKey : !agentKey };
  let vaultState = null;
  if (stageId === REVOKE) {
    const view = (method, args = {}) => readPinnedJsonView(provider, hash, id.vault, method, args);
    const [vault, vaultKeys, version, vaultOwner, granted] = await Promise.all([
      query('view_account', id.vault), query('view_access_key_list', id.vault), view('contract_version'), view('get_owner'),
      view('is_agent_key_allowed', { policy_id: id.policy_id, public_key: id.agent_public_key }),
    ]);
    if (vault?.block_hash !== hash || vaultKeys?.block_hash !== hash || !Array.isArray(vaultKeys.keys) || vaultKeys.keys.length > 1000 ||
        typeof granted !== 'boolean') throw new Error('malformed or mixed-block vault recovery views');
    checks.exact_keyless_vault = localCode(vault) && vault.code_hash === NATIVE_ORACLE_V9_CODE_HASH &&
      vaultKeys.keys.length === 0 && version === 'bouncer-agent-v9' && vaultOwner === id.owner;
    checks.agent_grant_still_active = granted === true;
    vaultState = { code_hash: vault.code_hash, key_count: vaultKeys.keys.length, agent_grant_active: granted };
  }
  const finished = now();
  if (!Number.isSafeInteger(finished) || finished < started) throw new Error('local clock moved backwards');
  assertFreshFinalBlock(block, finished);
  const blockers = Object.keys(checks).filter(name => !checks[name]);
  return { version: 1, network: 'testnet', status: blockers.length ? 'BLOCKED_OR_UNKNOWN' : 'STATE_CHECKS_PASSED_NOT_AUTHORIZED',
    owner: id.owner, vault: id.vault, agent_public_key: id.agent_public_key, stage_id: stageId,
    recovery_review_sha256: id.recovery_review_sha256, setup_review_sha256: id.setup_review_sha256,
    action_commitment_sha256: stages[index].action_commitment_sha256, prior_original_hashes: hashes,
    block_hash: hash, block_height: block.header.height, block_timestamp_nanosec: block.header.timestamp_nanosec,
    observed_at: new Date(finished).toISOString(), owner_key_nonce: nonce?.toString() ?? null, vault_state: vaultState,
    checks, blockers, wallet_prompt_authorized: false, signing_authorized: false, transaction_sent: false,
    onchain_revocation_verified: false, scope: 'trusted-RPC single FINAL block and supplied prior original only; no prompt fence, owner consent or lasting chain state' };
}
