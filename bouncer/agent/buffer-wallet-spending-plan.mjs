/**
 * Offline authorization plan for the named-wallet Buffer testnet path.
 *
 * This is an UNSIGNED review, not a wallet integration or proof of spending.
 * It cannot generate keys, contact a provider, sign, send, install access, or
 * establish that a vault or order exists. A caller must independently retain
 * the review, perform fresh same-FINAL-block checks, obtain separate owner
 * approvals and reconcile each original transaction before the next stage.
 */
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE } from '../scripts/circle-testnet-setup.mjs';
import { BUFFER_TESTNET_CONTRACT as SELLER } from '../experiments/buffer-forwarder/build.mjs';
import { unsignedSvalinBatchCommitment, assertSvalinBatchMatchesReview } from './svalin-setup-plan.mjs';

const TGAS = 10n ** 12n;
// The immediate fixed Buffer product was observed at 20 test USDC. This is a
// ceiling on this preliminary trial, not a current price or a promise of work.
export const BUFFER_WALLET_TRIAL_MAX_ATOMS = '20000000';
export const BUFFER_WALLET_MAX_AGENT_GAS_YOCTO = (10n ** 24n).toString();
const NAMES = ['owner', 'vault', 'adapter', 'policy_id', 'vault_agent_public_key', 'forwarder_agent_public_key',
  'per_tx_cap_atoms', 'daily_cap_atoms', 'vault_agent_gas_allowance_yocto', 'forwarder_agent_gas_allowance_yocto'];
const plain = value => value && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
function ownData(object, names) {
  if (!plain(object)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(object);
  return Object.keys(descriptors).sort().join(',') === [...names].sort().join(',') &&
    names.every(name => Object.hasOwn(descriptors[name], 'value'));
}
function positive(value, max) {
  return typeof value === 'string' && /^[1-9][0-9]{0,38}$/.test(value) && BigInt(value) <= BigInt(max);
}
function directChild(child, parent) {
  const suffix = `.${parent}`;
  return child.endsWith(suffix) && child.slice(0, -suffix.length).length > 0 && !child.slice(0, -suffix.length).includes('.');
}
function canonicalAgentKey(value) {
  try {
    const key = nearApi.utils.PublicKey.from(value);
    if (typeof value !== 'string' || !value.startsWith('ed25519:') || String(key) !== value || key.ed25519Key?.data?.length !== 32) throw Error();
    return key;
  } catch { throw new Error('canonical Ed25519 agent public keys are required'); }
}

/** The supplied keys are PUBLIC only. Never pass a seed or private key here. */
export function buildBufferWalletSpendingPlan(raw) {
  if (!ownData(raw, NAMES)) throw new Error('exactly the public spending-plan fields are required');
  const r = Object.fromEntries(NAMES.map(name => [name, raw[name]]));
  if (!isTestnetAccount(r.owner) || !isTestnetAccount(r.vault) || !isTestnetAccount(r.adapter) ||
      !directChild(r.vault, r.owner) || !directChild(r.adapter, r.owner) || r.vault === r.adapter ||
      typeof r.policy_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(r.policy_id) ||
      !positive(r.per_tx_cap_atoms, BUFFER_WALLET_TRIAL_MAX_ATOMS) ||
      !positive(r.daily_cap_atoms, BUFFER_WALLET_TRIAL_MAX_ATOMS) || BigInt(r.per_tx_cap_atoms) > BigInt(r.daily_cap_atoms) ||
      !positive(r.vault_agent_gas_allowance_yocto, BUFFER_WALLET_MAX_AGENT_GAS_YOCTO) ||
      !positive(r.forwarder_agent_gas_allowance_yocto, BUFFER_WALLET_MAX_AGENT_GAS_YOCTO)) {
    throw new Error('invalid named-testnet Buffer spending limits or accounts');
  }
  const vaultKey = canonicalAgentKey(r.vault_agent_public_key), forwarderKey = canonicalAgentKey(r.forwarder_agent_public_key);
  if (String(vaultKey) === String(forwarderKey)) throw new Error('the vault and forwarder must use distinct agent keys');

  const t = nearApi.transactions;
  const call = (method, args) => t.functionCall(method, args, 30n * TGAS, 1n);
  const batches = [
    // Lock the FT policy before granting the key, in one atomic receipt. The
    // exact-intent lock prevents this policy from authorizing arbitrary FT sends.
    { id: 'configure_buffer_locked_policy', signerId: r.owner, receiverId: r.vault, actions: [
      call('set_policy', { policy_id: r.policy_id, token: CIRCLE, per_tx_cap: r.per_tx_cap_atoms, daily_cap: r.daily_cap_atoms }),
      call('allow_payee', { policy_id: r.policy_id, payee: r.adapter }),
      call('lock_ft_policy_to_intents', { policy_id: r.policy_id }),
      call('grant_agent_key', { policy_id: r.policy_id, public_key: String(vaultKey) }),
    ] },
    // These are receiver- and method-scoped owner-account FunctionCall keys,
    // NOT full-access keys. Such keys cannot attach the 1 yocto needed by the
    // owner-only configuration and intent methods.
    { id: 'install_buffer_vault_agent', signerId: r.owner, receiverId: r.owner, actions: [
      t.addKey(vaultKey, t.functionCallAccessKey(r.vault, ['execute_exact_ft'], BigInt(r.vault_agent_gas_allowance_yocto))),
    ] },
    { id: 'install_buffer_forwarder_agent', signerId: r.owner, receiverId: r.owner, actions: [
      t.addKey(forwarderKey, t.functionCallAccessKey(r.adapter, ['open', 'return_tokens'], BigInt(r.forwarder_agent_gas_allowance_yocto))),
    ] },
  ];
  const fc = (method, args) => ({ type: 'function_call', method, args, gas: String(30n * TGAS), deposit_yocto: '1' });
  const stages = [
    { id: batches[0].id, signer_id: r.owner, receiver_id: r.vault,
      prerequisite: 'At a fresh FINAL testnet block verify the immutable keyless V12 vault and owner, absent policy, absent agent keys, and reviewed forwarder identity. Reconcile all earlier originals.',
      actions: [
        fc('set_policy', { policy_id: r.policy_id, token: CIRCLE, per_tx_cap: r.per_tx_cap_atoms, daily_cap: r.daily_cap_atoms }),
        fc('allow_payee', { policy_id: r.policy_id, payee: r.adapter }),
        fc('lock_ft_policy_to_intents', { policy_id: r.policy_id }),
        fc('grant_agent_key', { policy_id: r.policy_id, public_key: String(vaultKey) }),
      ] },
    { id: batches[1].id, signer_id: r.owner, receiver_id: r.owner,
      prerequisite: 'Reconcile the original policy transaction and verify exact limits, allowlist, lock and grant at a fresh FINAL block. Ensure the agent key is absent, not broader.',
      actions: [{ type: 'add_function_call_key', public_key: String(vaultKey), receiver_id: r.vault,
        method_names: ['execute_exact_ft'], allowance_yocto: r.vault_agent_gas_allowance_yocto }] },
    { id: batches[2].id, signer_id: r.owner, receiver_id: r.owner,
      prerequisite: 'Reconcile the prior original; verify the order-specific keyless forwarder bytecode, owner, agent and Circle registration, and that this separate agent key is absent.',
      actions: [{ type: 'add_function_call_key', public_key: String(forwarderKey), receiver_id: r.adapter,
        method_names: ['open', 'return_tokens'], allowance_yocto: r.forwarder_agent_gas_allowance_yocto }] },
  ].map((stage, index) => ({ ...stage, action_commitment_sha256: unsignedSvalinBatchCommitment(batches[index]) }));

  for (let i = 0; i < batches.length; i++) assertSvalinBatchMatchesReview(batches[i], stages[i]);
  const review = { format: 'bouncer-buffer-wallet-spending-review-v1', status: 'UNSIGNED_OFFLINE_PLAN_ONLY', network: 'testnet',
    owner: r.owner, vault: r.vault, adapter: r.adapter, token: CIRCLE, seller: SELLER, policy_id: r.policy_id,
    per_tx_cap_atoms: r.per_tx_cap_atoms, daily_cap_atoms: r.daily_cap_atoms,
    vault_agent_public_key: String(vaultKey), forwarder_agent_public_key: String(forwarderKey), stages,
    limitations: [
      'No wallet is connected, no key installed and no transaction is signed or sent by this plan.',
      'The reviewed V12 artifact requires a named .testnet owner for the exact-intent lock; a 0x EVM account cannot use this exact plan.',
      'A V12 keyless vault, order-specific keyless forwarder, current token registration and fresh owner approvals are prerequisites, not established by this plan.',
      'The forwarder is unaudited and experimental; live seller code and source equivalence, price, refunds and delivery remain unproven.',
      'Each original hash must be preserved and reconciled before the next stage; no ambiguous transaction may be resent automatically.',
      'An owner must separately approve a specific short-lived intent before an agent can execute it. A policy or access key alone is not an order or payment.',
    ],
    signing_authorized: false, transaction_sent: false, agent_key_installed: false,
    provider_order_created: false, independent_delivery_verified: false };
  const review_sha256 = crypto.createHash('sha256').update(JSON.stringify(review)).digest('hex');
  return { review: { ...review, review_sha256 }, batches };
}

/** Re-check a mutable SDK batch against an independently retained review.
 * As with the shared Svalin checker, mutating both objects defeats this check. */
export function assertBufferSpendingBatchMatchesReview(batch, stage) {
  return assertSvalinBatchMatchesReview(batch, stage);
}
