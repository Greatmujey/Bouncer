/**
 * OFFLINE, unsigned review for a small native-NEAR OutLayer trial. No wallet,
 * key generation, RPC, signature, broadcast, or provider request happens here.
 *
 * This uses the repository's pinned V9 artifact because the native oracle
 * runner has not established V12 compatibility. A keyless account may leave
 * storage collateral locked. Nothing in this plan authorizes a wallet prompt:
 * retain the review independently, verify fresh state and reconcile each
 * original transaction before the next stage. Never retry an uncertain prompt.
 */
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { unsignedSvalinBatchCommitment, assertSvalinBatchMatchesReview } from './svalin-setup-plan.mjs';
import { ORACLE_TESTNET_PROJECT } from './oracle-outlayer.mjs';
import { V3_OWNER } from './v3-faucet-github-fence.mjs';

const ONE = 10n ** 24n, TGAS = 10n ** 12n;
export const NATIVE_ORACLE_V9_BYTES = 452_675;
export const NATIVE_ORACLE_V9_SHA256 = '835f0baa51d08ddf3af6812df0caefb93283480735a63e3d382073e04fbaf8ee';
export const NATIVE_ORACLE_V9_CODE_HASH = '9qpU6d6MHZZXC2ivtQt3k3scGkiHLkkMnaTAiZWbaL6y';
export const NATIVE_ORACLE_VAULT_FUNDING = (54n * ONE / 10n).toString(); // 5.4 test NEAR; storage can be locked
export const NATIVE_ORACLE_TRIAL_MAX = (ONE / 10n).toString(); // 0.1 test NEAR, full maximum counts against budget
export const NATIVE_ORACLE_MAX_GAS_ALLOWANCE = ONE.toString(); // gas allowance, not a provider deposit
export const NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE = (ONE / 2n).toString();
export const NATIVE_ORACLE_METHOD = 'execute_outlayer_native_project';
export const NATIVE_ORACLE_PAYEE = 'outlayer.testnet';
const FIELDS = ['owner', 'vault', 'policy_id', 'agent_public_key', 'per_tx_cap_yocto', 'daily_cap_yocto',
  'vault_deposit_yocto', 'agent_gas_allowance_yocto'];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const positive = (value, max) => typeof value === 'string' && /^[1-9][0-9]{0,38}$/.test(value) && BigInt(value) <= BigInt(max);
const plain = value => value && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
function ownData(object, fields) {
  if (!plain(object)) return false;
  const d = Object.getOwnPropertyDescriptors(object);
  return Object.keys(d).sort().join(',') === [...fields].sort().join(',') &&
    fields.every(name => Object.hasOwn(d[name], 'value'));
}
export function isDirectTestnetChild(child, parent) {
  if (!isTestnetAccount(parent) || !isTestnetAccount(child) || !child.endsWith(`.${parent}`)) return false;
  const prefix = child.slice(0, -parent.length - 1);
  return prefix.length > 0 && !prefix.includes('.');
}
function checkedKey(value) {
  try {
    const key = nearApi.utils.PublicKey.from(value);
    if (typeof value !== 'string' || !value.startsWith('ed25519:') || String(key) !== value || key.ed25519Key?.data?.length !== 32) throw Error();
    return key;
  } catch { throw new Error('a canonical Ed25519 agent PUBLIC key is required'); }
}
function checkedWasm(input) {
  if (!(input instanceof Uint8Array)) throw new Error('the pinned V9 artifact is required');
  const code = Buffer.from(input);
  if (code.length !== NATIVE_ORACLE_V9_BYTES || sha(code) !== NATIVE_ORACLE_V9_SHA256 ||
      !code.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])) ||
      !code.includes(Buffer.from('bouncer-agent-v9'))) throw new Error('the V9 artifact differs from the pinned testnet bytes');
  return code;
}

/** PUBLIC parameters and pinned Wasm only. No private keys or credentials. */
export function buildNativeOracleWalletPlan({ terms, wasmBytes } = {}) {
  if (!ownData(terms, FIELDS)) throw new Error('exactly the public native trial fields are required');
  const r = Object.fromEntries(FIELDS.map(name => [name, terms[name]]));
  if (r.owner === V3_OWNER) throw new Error('the V3 owner has unresolved originals; reconcile them before unrelated transactions');
  if (!isDirectTestnetChild(r.vault, r.owner) || typeof r.policy_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(r.policy_id) ||
      !positive(r.per_tx_cap_yocto, NATIVE_ORACLE_TRIAL_MAX) || !positive(r.daily_cap_yocto, NATIVE_ORACLE_TRIAL_MAX) ||
      !positive(r.vault_deposit_yocto, NATIVE_ORACLE_TRIAL_MAX) || !positive(r.agent_gas_allowance_yocto, NATIVE_ORACLE_MAX_GAS_ALLOWANCE) ||
      BigInt(r.per_tx_cap_yocto) > BigInt(r.daily_cap_yocto) || BigInt(r.per_tx_cap_yocto) > BigInt(r.vault_deposit_yocto) ||
      BigInt(r.vault_deposit_yocto) > BigInt(r.daily_cap_yocto)) throw new Error('invalid named-testnet native trial accounts or limits');
  const key = checkedKey(r.agent_public_key), wasm = checkedWasm(wasmBytes), t = nearApi.transactions;
  const fc = (method, args, gas, deposit) => t.functionCall(method, args, gas, deposit);
  const policyArgs = { policy_id: r.policy_id, token: 'native', per_tx_cap: r.per_tx_cap_yocto, daily_cap: r.daily_cap_yocto };
  const allowArgs = { policy_id: r.policy_id, payee: NATIVE_ORACLE_PAYEE };
  const projectArgs = { policy_id: r.policy_id, project: structuredClone(ORACLE_TESTNET_PROJECT) };
  const grantArgs = { policy_id: r.policy_id, public_key: String(key) };
  const batches = [
    { id: 'create_keyless_native_vault', signerId: r.owner, receiverId: r.vault, actions: [
      t.createAccount(), t.transfer(BigInt(NATIVE_ORACLE_VAULT_FUNDING)), t.deployContract(wasm), fc('new', { owner: r.owner }, 30n * TGAS, 0n),
    ] },
    { id: 'configure_native_oracle_policy', signerId: r.owner, receiverId: r.vault, actions: [
      fc('set_policy', policyArgs, 30n * TGAS, 1n), fc('allow_payee', allowArgs, 30n * TGAS, 1n),
      fc('set_outlayer_native_project', projectArgs, 30n * TGAS, 1n), fc('grant_agent_key', grantArgs, 30n * TGAS, 1n),
    ] },
    { id: 'fund_native_vault', signerId: r.owner, receiverId: r.vault, actions: [
      fc('deposit_native', {}, 30n * TGAS, BigInt(r.vault_deposit_yocto)),
    ] },
    { id: 'install_native_oracle_agent', signerId: r.owner, receiverId: r.owner, actions: [
      t.addKey(key, t.functionCallAccessKey(r.vault, [NATIVE_ORACLE_METHOD], BigInt(r.agent_gas_allowance_yocto))),
    ] },
  ];
  const call = (method, args, deposit = '1') => ({ type: 'function_call', method, args, gas: String(30n * TGAS), deposit_yocto: deposit });
  const summaries = [
    [{ type: 'create_account' }, { type: 'transfer', deposit_yocto: NATIVE_ORACLE_VAULT_FUNDING },
      { type: 'deploy_contract', byte_length: wasm.length, sha256: NATIVE_ORACLE_V9_SHA256, near_code_hash: NATIVE_ORACLE_V9_CODE_HASH },
      call('new', { owner: r.owner }, '0')],
    [call('set_policy', policyArgs), call('allow_payee', allowArgs), call('set_outlayer_native_project', projectArgs), call('grant_agent_key', grantArgs)],
    [call('deposit_native', {}, r.vault_deposit_yocto)],
    [{ type: 'add_function_call_key', public_key: String(key), receiver_id: r.vault,
      method_names: [NATIVE_ORACLE_METHOD], allowance_yocto: r.agent_gas_allowance_yocto }],
  ];
  const prerequisites = [
    'At a fresh FINAL testnet block verify the owner and exact signing key, an absent direct-child vault, funding, protocol compatibility and independently retained original-hash fence.',
    'Reconcile the original creation transaction. Verify the exact V9 code hash, zero vault keys, owner and an absent policy at a fresh FINAL block.',
    'Reconcile the configuration original and recheck the exact active native route, limits, payee, key grant and owner balance. This is a vault deposit, not a provider payment.',
    'Reconcile the deposit original. Recheck tracked native funds, the exact policy and route, the absent agent key and a conservative gas allowance at a fresh FINAL block.',
  ];
  const stages = batches.map((b, i) => ({ id: b.id, signer_id: b.signerId, receiver_id: b.receiverId,
    prerequisite: prerequisites[i], actions: summaries[i], action_commitment_sha256: unsignedSvalinBatchCommitment(b) }));
  for (let i = 0; i < batches.length; i++) assertSvalinBatchMatchesReview(batches[i], stages[i]);
  const review = { format: 'bouncer-native-oracle-wallet-review-v1', status: 'UNSIGNED_OFFLINE_PLAN_ONLY', network: 'testnet',
    owner: r.owner, vault: r.vault, policy_id: r.policy_id, agent_public_key: String(key), asset: 'native',
    payee: NATIVE_ORACLE_PAYEE, project: structuredClone(ORACLE_TESTNET_PROJECT), per_tx_cap_yocto: r.per_tx_cap_yocto,
    daily_cap_yocto: r.daily_cap_yocto, vault_deposit_yocto: r.vault_deposit_yocto,
    agent_gas_allowance_yocto: r.agent_gas_allowance_yocto, vault_storage_funding_yocto: NATIVE_ORACLE_VAULT_FUNDING,
    artifact: { bytes: NATIVE_ORACLE_V9_BYTES, sha256: NATIVE_ORACLE_V9_SHA256, near_code_hash: NATIVE_ORACLE_V9_CODE_HASH }, stages,
    limitations: [
      'No wallet approval, transaction, provider execution or delivery is established. This review does not authorize a prompt.',
      'Keyless deployment can lock storage collateral; gas and actual storage requirements may differ. Testnet funds only.',
      'Each stage needs a separately retained one-shot prompt claim, owner approval, original hash and FINAL receipt verification before the next stage; an unknown outcome must not be resent.',
      'The agent key can call only the fixed native-project method and cannot attach the 1 yocto required for owner-only changes. Its allowance pays gas, not provider charges.',
      'OutLayer receives the full maximum; a verified unused refund returns to the owner, not the vault. The full maximum remains in the rolling budget.',
      'This is one independent OutLayer price-data task. It does not establish independent storage, independent FT delivery, TEE attestation or price accuracy.',
      'Wallet support for deployment, multiple actions and restricted-key installation is unverified, particularly on a real phone.',
    ], signing_authorized: false, transaction_sent: false, agent_key_installed: false, independent_delivery_verified: false };
  return { review: { ...review, review_sha256: sha(Buffer.from(JSON.stringify(review))) }, batches };
}

/** Compare a mutable SDK batch with a separately retained public stage. */
export function assertNativeOracleBatchMatchesReview(batch, stage) {
  return assertSvalinBatchMatchesReview(batch, stage);
}
