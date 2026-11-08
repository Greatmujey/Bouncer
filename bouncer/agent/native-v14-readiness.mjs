/** Public, read-only V14 preflight for a candidate direct-child testnet vault.
 * A trusted RPC supplies one fresh FINAL block. Nothing here proves wallet
 * control, consent, transaction absence elsewhere, backup or provider delivery. */
import { isTestnetAccount } from '../shared/account-id.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { hasPlainOwnerProfileAt } from '../shared/plain-owner-profile.mjs';
import { V14_TESTNET_ARTIFACT } from '../shared/v14-testnet-artifact.mjs';
import { readPinnedJsonView } from './read-only-near-rpc.mjs';
import { ORACLE_PROJECT_ID, ORACLE_TESTNET_HASH, oracleTestnetRegistryMatches } from './oracle-testnet-registry.mjs';
import { MIN_V11_TESTNET_PROTOCOL, selectedV11WasmFeaturesEnabled } from './svalin-setup-preflight.mjs';

const ONE = 10n ** 24n, MAX = (1n << 128n) - 1n, MARGIN_BYTES = 50_000n;
// This is only the current example manifest, NOT a wallet-approved cap.
const EXAMPLE_MISSION_MAX = 3n * 10n ** 21n;
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const uint = x => typeof x === 'string' && /^(?:0|[1-9][0-9]{0,38})$/.test(x) && BigInt(x) <= MAX;
function directChild(vault, owner) {
  if (!isTestnetAccount(vault) || !isTestnetAccount(owner) || !vault.endsWith(`.${owner}`)) return false;
  const label = vault.slice(0, -owner.length - 1);
  return label.length > 0 && !label.includes('.');
}

/** Produces estimates and blockers, never a wallet request or spending plan. */
export async function inspectV14Readiness({ owner, vault, provider, now = Date.now } = {}) {
  if (!directChild(vault, owner) || owner === 'bouncer-owner-12f343b795633e357ae5560d.testnet' ||
      typeof now !== 'function' || !provider ||
      ['viewNodeStatus','viewBlock','query','viewTestnetAccountPresenceAt','callFunctionRaw','experimental_protocolConfig','gasPrice']
        .some(name => typeof provider[name] !== 'function')) throw new Error('named testnet owner, candidate direct child and read-only provider required');
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const started = now(), block = await provider.viewBlock({ finality: 'final' }), { hash } = assertFreshFinalBlock(block, started);
  if (!Number.isSafeInteger(block.header.height) || block.header.height < 1) throw new Error('invalid FINAL block height');
  const query = (request_type, account_id) => provider.query({ request_type, account_id, block_id: hash });
  const view = (method, args) => readPinnedJsonView(provider, hash, 'outlayer.testnet', method, args);
  // An unavailable absence proof is explicitly UNKNOWN, never "absent".
  const presence = Promise.resolve().then(() => provider.viewTestnetAccountPresenceAt(vault, hash)).catch(() => null);
  const [account, keys, child, outlayer, protocol, gas, project, version, pricing] = await Promise.all([
    query('view_account', owner), query('view_access_key_list', owner), presence, query('view_account','outlayer.testnet'),
    provider.experimental_protocolConfig({ blockId: hash }), provider.gasPrice(hash),
    view('get_project',{project_id:ORACLE_PROJECT_ID}),
    view('get_version',{project_id:ORACLE_PROJECT_ID,version_key:ORACLE_TESTNET_HASH}),
    view('get_project_pricing',{project_id:ORACLE_PROJECT_ID}),
  ]);
  const cost = protocol?.runtime_config?.storage_amount_per_byte;
  if (account?.block_hash !== hash || !uint(account.amount) || !Number.isSafeInteger(account.storage_usage) || account.storage_usage < 0 ||
      keys?.block_hash !== hash || !Array.isArray(keys.keys) || keys.keys.length > 1000 ||
      !keys.keys.every(k => record(k) && record(k.access_key)) ||
      outlayer?.block_hash !== hash || !isTransactionHash(outlayer.code_hash) || !uint(cost) || cost === '0' ||
      protocol?.chain_id !== 'testnet' || !uint(gas?.gas_price) || gas.gas_price === '0') {
    throw new Error('malformed or mixed-block public views');
  }
  if (child !== null && (child.block_hash !== hash || typeof child.exists !== 'boolean')) throw new Error('malformed candidate-vault presence');
  const storageCost = BigInt(cost), balance = BigInt(account.amount), currentStorage = BigInt(account.storage_usage) * storageCost;
  const available = balance > currentStorage ? balance - currentStorage : 0n;
  // Margin and reserve are estimates; actual NEAR storage, gas and wallet
  // actions require a separately reviewed, fresh plan. No amount is approved.
  const storageEstimate = (BigInt(V14_TESTNET_ARTIFACT.bytes) + MARGIN_BYTES) * storageCost + ONE / 10n;
  if (storageEstimate > MAX || storageEstimate + EXAMPLE_MISSION_MAX > MAX) throw new Error('invalid estimated funding');
  const checks = {
    owner_has_plain_account_profile: hasPlainOwnerProfileAt(account, hash),
    owner_has_a_full_access_key: keys.keys.some(k => k.access_key.permission === 'FullAccess'),
    candidate_vault_absent_at_block: child?.exists === false,
    selected_protocol_features: Number.isSafeInteger(protocol.protocol_version) && protocol.protocol_version >= MIN_V11_TESTNET_PROTOCOL &&
      selectedV11WasmFeaturesEnabled(protocol),
    outlayer_contract_present: outlayer.code_hash !== '11111111111111111111111111111111',
    pinned_oracle_registry: oracleTestnetRegistryMatches(project,version,pricing),
    available_covers_example_storage_and_cap_before_gas: available >= storageEstimate + EXAMPLE_MISSION_MAX,
  };
  const finished = now();
  if (!Number.isSafeInteger(finished) || finished < started) throw new Error('local clock moved backwards');
  assertFreshFinalBlock(block, finished);
  const blockers = Object.keys(checks).filter(name => !checks[name]);
  return { status:blockers.length ? 'BLOCKED_OR_UNKNOWN' : 'READ_ONLY_CHECKS_PASSED_NOT_AUTHORIZED', network:'testnet',
    owner, candidate_vault:vault, candidate_presence:child === null ? 'UNKNOWN' : child.exists ? 'PRESENT' : 'ABSENT_AT_FINAL_BLOCK',
    block_hash:hash, block_height:block.header.height, observed_at:new Date(finished).toISOString(),
    artifact:{...V14_TESTNET_ARTIFACT}, storage_amount_per_byte_yocto:cost, estimated_owner_available_yocto:available.toString(),
    storage_margin_bytes:Number(MARGIN_BYTES), storage_reserve_yocto:(ONE/10n).toString(),
    estimated_vault_storage_funding_yocto:storageEstimate.toString(), illustrative_mission_max_yocto:EXAMPLE_MISSION_MAX.toString(),
    gas_price_yocto_per_gas:gas.gas_price, checks, blockers,
    wallet_control_proven:false, wallet_approval_obtained:false, transaction_sent:false, provider_execution_requested:false,
    independent_original_backup_verified:false, vault_deployed_by_this_check:false,
    scope:'Trusted-RPC single FINAL snapshot; proposed name and amounts are examples only, not approved funding or a quote. Gas is additional. Storage estimates, artifact identity and RPC views do not prove deployment, independent recovery, wallet support or provider execution.' };
}
