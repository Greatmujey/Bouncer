/**
 * Read-only, single-FINAL-block indication for a NEW native oracle vault.
 * No wallet, secret, agent key, signature, transaction or provider HTTP call.
 * A trusted RPC and local clock are assumed; this is not consent or a quote.
 */
import { isDeepStrictEqual } from 'node:util';
import { readPinnedJsonView } from './read-only-near-rpc.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { hasPlainOwnerProfileAt } from '../shared/plain-owner-profile.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { estimateV11ResourceGasAllowance } from '../shared/access-key-gas.mjs';
import { MIN_V11_TESTNET_PROTOCOL, selectedV11WasmFeaturesEnabled } from './svalin-setup-preflight.mjs';
import { ORACLE_TESTNET_PROGRAM, ORACLE_PROJECT_ID, ORACLE_PROJECT_UUID } from './oracle-outlayer.mjs';
import { V3_OWNER } from './v3-faucet-github-fence.mjs';
import { isDirectTestnetChild, NATIVE_ORACLE_PAYEE, NATIVE_ORACLE_V9_BYTES, NATIVE_ORACLE_VAULT_FUNDING,
  NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE, NATIVE_ORACLE_MAX_GAS_ALLOWANCE, NATIVE_ORACLE_TRIAL_MAX } from './native-oracle-wallet-plan.mjs';

const MAX = (1n << 128n) - 1n, ONE = 10n ** 24n, STORAGE_MARGIN_BYTES = 50_000n;
const VAULT_RESERVE = ONE / 10n, OWNER_RESERVE = ONE; // estimates, not proof of admission or future recoverability
const uint = x => typeof x === 'string' && /^(?:0|[1-9][0-9]{0,38})$/.test(x) && BigInt(x) <= MAX;
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);

/** The output is a public indication only, NOT an authorization for any plan
 * or wallet prompt. It deliberately assumes the conservative maximum trial. */
export async function inspectNativeOracleReadiness({ owner, vault, provider, now = Date.now,
  gasAllowanceYocto = NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } = {}) {
  if (!isDirectTestnetChild(vault, owner) || owner === V3_OWNER || typeof now !== 'function' ||
      !uint(gasAllowanceYocto) || gasAllowanceYocto === '0' || BigInt(gasAllowanceYocto) > BigInt(NATIVE_ORACLE_MAX_GAS_ALLOWANCE) ||
      !provider || ['viewNodeStatus', 'viewBlock', 'query', 'viewTestnetAccountPresenceAt', 'callFunctionRaw', 'experimental_protocolConfig', 'gasPrice']
        .some(name => typeof provider[name] !== 'function')) throw new Error('a non-V3 named owner, direct-child vault and read-only testnet provider are required');
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const started = now(), block = await provider.viewBlock({ finality: 'final' });
  const { hash } = assertFreshFinalBlock(block, started);
  if (!Number.isSafeInteger(block.header.height) || block.header.height < 1) throw new Error('invalid FINAL block height');
  const query = (request_type, account_id) => provider.query({ request_type, account_id, block_id: hash });
  const view = (method, args) => readPinnedJsonView(provider, hash, NATIVE_ORACLE_PAYEE, method, args);
  const [account, keys, child, providerAccount, providerKeys, protocol, gas, project, version, pricing] = await Promise.all([
    query('view_account', owner), query('view_access_key_list', owner), provider.viewTestnetAccountPresenceAt(vault, hash),
    query('view_account', NATIVE_ORACLE_PAYEE), query('view_access_key_list', NATIVE_ORACLE_PAYEE),
    provider.experimental_protocolConfig({ blockId: hash }), provider.gasPrice(hash),
    view('get_project', { project_id: ORACLE_PROJECT_ID }),
    view('get_version', { project_id: ORACLE_PROJECT_ID, version_key: ORACLE_TESTNET_PROGRAM.sha256 }),
    view('get_project_pricing', { project_id: ORACLE_PROJECT_ID }),
  ]);
  const cost = protocol?.runtime_config?.storage_amount_per_byte;
  if (account?.block_hash !== hash || !uint(account.amount) || !Number.isSafeInteger(account.storage_usage) || account.storage_usage < 0 ||
      keys?.block_hash !== hash || !Array.isArray(keys.keys) || keys.keys.length > 1000 ||
      child?.block_hash !== hash || typeof child.exists !== 'boolean' ||
      providerAccount?.block_hash !== hash || !isTransactionHash(providerAccount.code_hash) ||
      providerKeys?.block_hash !== hash || !Array.isArray(providerKeys.keys) || providerKeys.keys.length > 1000 ||
      !uint(cost) || cost === '0' || !uint(gas?.gas_price) || gas.gas_price === '0') throw new Error('malformed or mixed-block native readiness view');
  const storageCost = BigInt(cost), native = BigInt(account.amount), ownerStorage = BigInt(account.storage_usage) * storageCost;
  const available = native > ownerStorage ? native - ownerStorage : 0n;
  const estimatedVaultMinimum = (BigInt(NATIVE_ORACLE_V9_BYTES) + STORAGE_MARGIN_BYTES) * storageCost + VAULT_RESERVE;
  const estimatedOwnerMinimum = BigInt(NATIVE_ORACLE_VAULT_FUNDING) + BigInt(NATIVE_ORACLE_TRIAL_MAX) + OWNER_RESERVE;
  const gasEstimate = estimateV11ResourceGasAllowance(gas.gas_price);
  const expectedSource = { WasmUrl: { url: ORACLE_TESTNET_PROGRAM.url, hash: ORACLE_TESTNET_PROGRAM.sha256,
    build_target: ORACLE_TESTNET_PROGRAM.build_target } };
  const checks = {
    named_owner_has_no_local_or_global_code: hasPlainOwnerProfileAt(account, hash),
    owner_has_full_access_key: keys.keys.some(k => k?.access_key?.permission === 'FullAccess'),
    new_direct_child_absent: child.exists === false,
    protocol_and_selected_features: protocol?.chain_id === 'testnet' && Number.isSafeInteger(protocol.protocol_version) &&
      protocol.protocol_version >= MIN_V11_TESTNET_PROTOCOL && selectedV11WasmFeaturesEnabled(protocol),
    vault_storage_estimate: BigInt(NATIVE_ORACLE_VAULT_FUNDING) >= estimatedVaultMinimum,
    owner_native_estimate: available >= estimatedOwnerMinimum,
    agent_gas_allowance_estimate: BigInt(gasAllowanceYocto) >= gasEstimate,
    pinned_project_identity_and_native_pricing: record(project) && project.project_id === ORACLE_PROJECT_ID &&
      project.uuid === ORACLE_PROJECT_UUID && project.owner === 'zavodil2.testnet' && record(version) &&
      version.wasm_hash === ORACLE_TESTNET_PROGRAM.sha256 && isDeepStrictEqual(version.source, expectedSource) && pricing === null,
  };
  const finished = now();
  if (!Number.isSafeInteger(finished) || finished < started) throw new Error('local clock moved backwards');
  assertFreshFinalBlock(block, finished);
  return { version: 1, network: 'testnet', owner, candidate_vault: vault,
    block_hash: hash, block_height: block.header.height, block_timestamp_nanosec: block.header.timestamp_nanosec,
    observed_at: new Date(finished).toISOString(), owner_native_yocto: native.toString(),
    owner_estimated_available_yocto: available.toString(), estimated_owner_minimum_yocto: estimatedOwnerMinimum.toString(),
    planned_vault_storage_funding_yocto: NATIVE_ORACLE_VAULT_FUNDING, estimated_vault_minimum_yocto: estimatedVaultMinimum.toString(),
    maximum_trial_deposit_yocto: NATIVE_ORACLE_TRIAL_MAX, gas_price_yocto_per_gas: gas.gas_price,
    planned_agent_gas_allowance_yocto: gasAllowanceYocto, estimated_minimum_agent_allowance_yocto: gasEstimate.toString(),
    owner_key_count: keys.keys.length, outlayer_account: NATIVE_ORACLE_PAYEE, outlayer_code_hash: providerAccount.code_hash,
    outlayer_key_count: providerKeys.keys.length, outlayer_has_full_access_key: providerKeys.keys.some(k => k?.access_key?.permission === 'FullAccess'),
    project_id: ORACLE_PROJECT_ID, project_version_sha256: ORACLE_TESTNET_PROGRAM.sha256,
    checks, blockers: Object.keys(checks).filter(name => !checks[name]),
    wallet_control_proven: false, wallet_approval_obtained: false, signer_present: false, signed: false, sent: false,
    vault_deployed: false, provider_execution_requested: false, independent_delivery_verified: false,
    scope: 'single trusted-RPC FINAL block, storage/gas estimates and public registry views; not a quote, reservation, wallet control, approval, bytecode audit or delivery; provider and state may change' };
}
