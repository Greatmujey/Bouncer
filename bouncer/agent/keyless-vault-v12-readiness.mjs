/** Read-only, provider-neutral preflight for ONE new V12 keyless testnet
 * vault. This is not a signature, deployment, backup or code audit. */
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { inspectCircleOwnerRegistration } from './circle-owner-registration.mjs';
import { readPinnedJsonView } from './read-only-near-rpc.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { MIN_V11_TESTNET_PROTOCOL, reportedV11WasmFeatures, selectedV11WasmFeaturesEnabled } from './svalin-setup-preflight.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE } from '../scripts/circle-testnet-setup.mjs';

export const V12_EXPECTED_BYTES = 536_651;
export const V12_EXPECTED_SHA256 = '033f255c5822ff97495809f7d60fddf66f266f20c36285fe71296b66decc6d12';
export const CIRCLE_TESTNET_CODE_HASH = 'EoAUFWELjD9gYzsjKDXYRmHDHf1RJ95jaKNSYE6v9b2z';
export const VAULT_NATIVE_FUNDING_YOCTO = '6000000000000000000000000'; // 6 test NEAR; irreversible storage risk
const ONE_NEAR = 10n ** 24n, STORAGE_MARGIN_BYTES = 50_000n, VAULT_RESERVE = 10n ** 23n;
const uint = x => typeof x === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(x) && BigInt(x) <= (1n << 128n) - 1n;

/** Profile has a deterministic direct-child name and no seller-specific lock. */
export function newTestnetVaultId(plan) {
  const owner = validateOwnerBootstrapPlan(plan).account_id, id = `vault.${owner}`;
  if (id.length > 64) throw new Error('direct-child testnet vault id exceeds protocol account-id length');
  return id;
}

export async function inspectKeylessVaultBootstrap({ plan, provider, now = Date.now } = {}) {
  const owner = validateOwnerBootstrapPlan(plan), vault = newTestnetVaultId(owner);
  if (!provider || ['viewNodeStatus', 'viewBlock', 'query', 'callFunctionRaw', 'viewTestnetAccountPresenceAt', 'experimental_protocolConfig']
      .some(k => typeof provider[k] !== 'function') || typeof now !== 'function') throw new Error('pinned read-only testnet provider required');
  const base = await inspectCircleOwnerRegistration({ plan: owner, provider, now }), hash = base.block_hash;
  const [account, presence, protocol, vaultRegistration] = await Promise.all([
    provider.query({ request_type: 'view_account', account_id: owner.account_id, block_id: hash }),
    provider.viewTestnetAccountPresenceAt(vault, hash), provider.experimental_protocolConfig({ blockId: hash }),
    readPinnedJsonView(provider, hash, CIRCLE, 'storage_balance_of', { account_id: vault }),
  ]);
  const checks = {}, pass = (name, condition) => { checks[name] = condition ? 'PASS' : 'BLOCKED'; };
  const cost = uint(protocol?.runtime_config?.storage_amount_per_byte) ? BigInt(protocol.runtime_config.storage_amount_per_byte) : 0n;
  const storage = Number.isSafeInteger(account?.storage_usage) && account.storage_usage >= 0 ? BigInt(account.storage_usage) : null;
  const native = uint(account?.amount) ? BigInt(account.amount) : null;
  const available = native !== null && storage !== null && cost > 0n && native > storage * cost ? native - storage * cost : 0n;
  const estimatedVaultMinimum = cost > 0n ? (BigInt(V12_EXPECTED_BYTES) + STORAGE_MARGIN_BYTES) * cost + VAULT_RESERVE : 0n;
  pass('new_direct_child_absent', presence?.block_hash === hash && presence.exists === false);
  pass('owner_and_circle_ready', base.circle_registration === 'REGISTERED_AT_VIEW' && BigInt(base.circle_balance_atoms) >= 3_000n);
  pass('circle_code_pinned', base.circle_code_hash === CIRCLE_TESTNET_CODE_HASH);
  pass('vault_not_pre_registered_for_circle', vaultRegistration === null);
  pass('testnet_protocol_floor', protocol?.chain_id === 'testnet' && Number.isSafeInteger(protocol.protocol_version) &&
    protocol.protocol_version >= MIN_V11_TESTNET_PROTOCOL);
  pass('selected_v12_wasm_features', selectedV11WasmFeaturesEnabled(protocol));
  pass('owner_native_estimate', account?.block_hash === hash && account.amount === base.owner_native_yocto && cost > 0n &&
    available >= BigInt(VAULT_NATIVE_FUNDING_YOCTO) + BigInt(base.circle_storage_min_yocto) + ONE_NEAR);
  pass('vault_native_estimate', cost > 0n && BigInt(VAULT_NATIVE_FUNDING_YOCTO) >= estimatedVaultMinimum);
  const finished = now();
  if (!Number.isSafeInteger(finished) || finished < Date.parse(base.observed_at)) throw new Error('local clock moved backwards');
  assertFreshFinalBlock({ header: { hash, timestamp_nanosec: base.block_timestamp_nanosec } }, finished);
  const blockers = Object.entries(checks).filter(([, state]) => state !== 'PASS').map(([name, status]) => ({ check: name, status }));
  return { version: 1, status: blockers.length ? 'BLOCKED_OR_UNKNOWN' : 'READ_ONLY_BOOTSTRAP_INDICATED', network: 'testnet',
    owner: owner.account_id, public_key: owner.public_key, vault, block_hash: hash,
    block_timestamp_nanosec: base.block_timestamp_nanosec, observed_at: new Date(finished).toISOString(),
    owner_key_nonce: base.owner_key_nonce, owner_native_yocto: base.owner_native_yocto, owner_test_usdc_atoms: base.circle_balance_atoms,
    circle_token: CIRCLE, circle_code_hash: base.circle_code_hash, circle_storage_min_yocto: base.circle_storage_min_yocto,
    planned_vault_native_yocto: VAULT_NATIVE_FUNDING_YOCTO, v12_sha256: V12_EXPECTED_SHA256, v12_bytes: V12_EXPECTED_BYTES,
    observed_protocol_version: protocol?.protocol_version ?? null, selected_v12_wasm_features: reportedV11WasmFeatures(protocol),
    storage_cost_yocto_per_byte: cost.toString(), estimated_owner_available_yocto: available.toString(),
    estimated_vault_minimum_yocto: estimatedVaultMinimum.toString(), checks, blockers,
    signed: false, sent: false, vault_deployed: false, artifact_checked: false, backup_export_verified: false,
    independently_audited: false, seller_contacted: false,
    scope: 'single trusted-RPC FINAL views and approximate storage margins; no code audit, backup, runtime guarantee or future state' };
}
