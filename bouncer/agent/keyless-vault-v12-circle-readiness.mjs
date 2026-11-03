/** Provider-neutral Circle TESTNET registration/funding readiness for the
 * backed-up owner keyless V12 vault. Pinned views only; no signatures or sends.
 * A fresh RPC view is not a consensus proof or a backup/audit guarantee. */
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { inspectCircleOwnerRegistration } from './circle-owner-registration.mjs';
import { newTestnetVaultId, CIRCLE_TESTNET_CODE_HASH } from './keyless-vault-v12-readiness.mjs';
import { V12_NEAR_CODE_HASH } from './keyless-vault-v12.mjs';
import { readPinnedJsonView } from './read-only-near-rpc.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE } from '../scripts/circle-testnet-setup.mjs';

const MAX = (1n << 128n) - 1n;
const uint = x => typeof x === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(x) && BigInt(x) <= MAX;
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const RESERVE = 10n ** 22n; // 0.01 test NEAR vault storage/gas headroom, estimate only

export async function inspectVaultCircleFunding({ plan: raw, provider, now = Date.now } = {}) {
  const plan = validateOwnerBootstrapPlan(raw), vault = newTestnetVaultId(plan);
  if (!provider || ['viewNodeStatus','viewBlock','query','callFunctionRaw','experimental_protocolConfig']
      .some(k => typeof provider[k] !== 'function') || typeof now !== 'function') throw new Error('pinned read-only testnet provider required');
  const base = await inspectCircleOwnerRegistration({ plan, provider, now }), hash = base.block_hash;
  const query = q => provider.query({ ...q, block_id: hash });
  const view = (account, method, args) => readPinnedJsonView(provider, hash, account, method, args);
  const [account, keys, owner, version, tracked, actual, registration, protocol] = await Promise.all([
    query({ request_type: 'view_account', account_id: vault }),
    query({ request_type: 'view_access_key_list', account_id: vault }),
    view(vault, 'get_owner', {}), view(vault, 'contract_version', {}),
    view(vault, 'vault_balance', { token: CIRCLE }), view(CIRCLE, 'ft_balance_of', { account_id: vault }),
    view(CIRCLE, 'storage_balance_of', { account_id: vault }), provider.experimental_protocolConfig({ blockId: hash }),
  ]);
  if (base.circle_registration !== 'REGISTERED_AT_VIEW' || base.circle_code_hash !== CIRCLE_TESTNET_CODE_HASH || account?.block_hash !== hash ||
      account.code_hash !== V12_NEAR_CODE_HASH || !uint(account.amount) || !Number.isSafeInteger(account.storage_usage) || account.storage_usage < 0 ||
      keys?.block_hash !== hash || !Array.isArray(keys.keys) || keys.keys.length !== 0 || owner !== plan.account_id ||
      version !== 'bouncer-agent-v12-exact-ft-testnet' || !uint(tracked) || !uint(actual) ||
      protocol?.chain_id !== 'testnet' || !uint(protocol?.runtime_config?.storage_amount_per_byte) ||
      BigInt(protocol.runtime_config.storage_amount_per_byte) === 0n) throw new Error('keyless V12, Circle owner or pinned vault state differs');
  let registrationState;
  if (registration === null) registrationState = 'NOT_REGISTERED_AT_VIEW';
  else if (record(registration) && uint(registration.total) && BigInt(registration.total) >= BigInt(base.circle_storage_min_yocto) &&
      uint(registration.available) && BigInt(registration.available) <= BigInt(registration.total)) registrationState = 'REGISTERED_AT_VIEW';
  else throw new Error('invalid vault Circle registration view');
  const vaultAvailable = BigInt(account.amount) - BigInt(account.storage_usage) * BigInt(protocol.runtime_config.storage_amount_per_byte);
  const finished = now();
  if (!Number.isSafeInteger(finished) || finished < Date.parse(base.observed_at)) throw new Error('local clock moved backwards');
  assertFreshFinalBlock({ header: { hash, timestamp_nanosec: base.block_timestamp_nanosec } }, finished);
  return { version: 1, network: 'testnet', owner: plan.account_id, public_key: plan.public_key, vault,
    block_hash: hash, block_timestamp_nanosec: base.block_timestamp_nanosec, observed_at: new Date(finished).toISOString(),
    owner_key_nonce: base.owner_key_nonce, owner_native_yocto: base.owner_native_yocto, owner_circle_atoms: base.circle_balance_atoms,
    circle_token: CIRCLE, circle_code_hash: base.circle_code_hash, circle_storage_min_yocto: base.circle_storage_min_yocto,
    vault_code_hash: account.code_hash, vault_key_count: keys.keys.length, vault_native_yocto: account.amount,
    vault_estimated_available_yocto: vaultAvailable > 0n ? vaultAvailable.toString() : '0',
    vault_circle_registration: registrationState, vault_registration_total_yocto: registration?.total ?? null,
    vault_actual_circle_atoms: actual, vault_tracked_circle_atoms: tracked,
    register_eligible: registrationState === 'NOT_REGISTERED_AT_VIEW' && actual === '0' && tracked === '0' && vaultAvailable >= RESERVE,
    fund_eligible: registrationState === 'REGISTERED_AT_VIEW' && actual === '0' && tracked === '0' && vaultAvailable >= RESERVE,
    signed: false, sent: false, seller_contacted: false,
    scope: 'pinned trusted-RPC V12/Circle views and estimated storage; no audit, backup or independent provider delivery' };
}
