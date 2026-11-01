#!/usr/bin/env node
/**
 * Read-only, pre-creation assessment for the reviewed V11 testnet setup.
 * It does not sign, send, create a journal, acquire tokens or contact a seller.
 * Estimates are not a guarantee of sufficient storage or gas; all RPC results
 * and the local clock are trusted, and can change after this snapshot.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildUnsignedSvalinTrialSetup } from './svalin-setup-plan.mjs';
import { verifySvalinSetupPlan } from './svalin-setup-evidence.mjs';
import { SVALIN_TRIAL_MAX_ATOMS } from './svalin-pro-preflight.mjs';
import { SVALIN_PAYEE } from './svalin-pro-readiness.mjs';
import { CIRCLE_TESTNET_USDC } from '../scripts/circle-testnet-setup.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { ReadOnlyNearRpcProvider, readPinnedJsonView } from './read-only-near-rpc.mjs';

const U128_MAX = (1n << 128n) - 1n;
const OWNER_ESTIMATE_RESERVE = 10n ** 24n; // 1 test NEAR; not a fee guarantee
const VAULT_EXTRA_STORAGE_BYTES = 50_000n; // margin for account/state; not a storage proof
const VAULT_ESTIMATE_RESERVE = 10n ** 23n; // 0.1 test NEAR; not a gas guarantee
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function amount(x) {
  if (typeof x === 'bigint') return x >= 0n && x <= U128_MAX ? x : null;
  if (typeof x !== 'string' || !/^(?:0|[1-9][0-9]{0,38})$/.test(x)) return null;
  const n = BigInt(x); return n <= U128_MAX ? n : null;
}
function registered(x) {
  const total = amount(x?.total), available = amount(x?.available);
  return record(x) && total !== null && total > 0n && available !== null && available <= total;
}
async function boundedSettled(tasks, concurrency = 4) {
  const results = Array(tasks.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next++;
      try { results[index] = { available: true, value: await tasks[index]() }; }
      catch { results[index] = { available: false }; }
    }
  }));
  return results;
}

/** Assess one new-vault plan at a single recent reported FINAL block. No check
 * authenticates the RPC, deployed Circle code, compiler, artifact, key backup,
 * owner consent or future state. This cannot authorize a transaction. */
export async function inspectSvalinSetupPrerequisites({ plan, trustedReviewHash, ownerPublicKey, provider, now = Date.now }) {
  const identity = verifySvalinSetupPlan({ plan, trustedReviewHash, ownerPublicKey });
  // Snapshot the verified public review before the first await. The plan's SDK
  // objects are mutable, but no caller mutation may change this assessment.
  const review = structuredClone(plan.review), goal = review.goal;
  const initial = BigInt(review.stages[0].actions[1].deposit_yocto);
  const registration = BigInt(review.stages[3].actions[0].deposit_yocto);
  const bytes = BigInt(review.artifact.byte_length);
  if (typeof now !== 'function' || !provider ||
      ['viewNodeStatus', 'viewBlock', 'viewAccount', 'viewAccessKey', 'viewAccessKeyList',
        'viewTestnetAccountPresenceAt', 'callFunctionRaw', 'experimental_protocolConfig']
        .some(name => typeof provider[name] !== 'function')) throw new Error('a read-only testnet RPC is required');
  const started = now();
  if (!Number.isSafeInteger(started) || started < 1 || !Number.isFinite(new Date(started).getTime())) throw new Error('invalid local time');
  let network, block;
  try { network = await provider.viewNodeStatus(); } catch { throw new Error('testnet RPC status unavailable'); }
  if (network?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  try { block = await provider.viewBlock({ finality: 'final' }); } catch { throw new Error('FINAL block unavailable'); }
  let fresh;
  try { fresh = assertFreshFinalBlock(block, started); } catch { throw new Error('FINAL block is invalid, stale or local clock is incorrect'); }
  const snapshot = { header: { hash: block.header.hash, timestamp_nanosec: block.header.timestamp_nanosec } };
  const hash = fresh.hash, at = { blockId: hash };
  const view = (method, args) => readPinnedJsonView(provider, hash, CIRCLE_TESTNET_USDC, method, args);
  const tasks = {
    protocol: () => provider.experimental_protocolConfig(at),
    owner: () => provider.viewAccount(goal.owner, at),
    owner_key: () => provider.viewAccessKey(goal.owner, identity.owner_public_key, at),
    owner_keys: () => provider.viewAccessKeyList(goal.owner, at),
    vault_presence: () => provider.viewTestnetAccountPresenceAt(goal.vault, hash),
    bounds: () => view('storage_balance_bounds', {}),
    owner_registration: () => view('storage_balance_of', { account_id: goal.owner }),
    vault_registration: () => view('storage_balance_of', { account_id: goal.vault }),
    seller_registration: () => view('storage_balance_of', { account_id: SVALIN_PAYEE }),
    owner_usdc: () => view('ft_balance_of', { account_id: goal.owner }),
  };
  const names = Object.keys(tasks), settled = await boundedSettled(names.map(name => tasks[name]));
  const reads = Object.fromEntries(names.map((name, i) => [name, settled[i]]));
  const atBlock = name => reads[name].available && reads[name].value?.block_hash === hash;
  const checks = {};
  const put = (name, dependencies, predicate) => {
    checks[name] = dependencies.some(dep => !reads[dep].available) ? 'UNKNOWN' : predicate() ? 'PASS' : 'BLOCKED';
  };
  put('testnet_protocol_and_storage_cost', ['protocol'], () => reads.protocol.value?.chain_id === 'testnet' &&
    amount(reads.protocol.value?.runtime_config?.storage_amount_per_byte) > 0n);
  const cost = amount(reads.protocol.value?.runtime_config?.storage_amount_per_byte);
  put('owner_full_access_key', ['owner_key'], () => atBlock('owner_key') && reads.owner_key.value.permission === 'FullAccess');
  put('agent_key_not_already_on_owner', ['owner_keys'], () => {
    const keys = reads.owner_keys.value?.keys;
    return atBlock('owner_keys') && Array.isArray(keys) && keys.length <= 10_000 &&
      keys.every(key => record(key) && typeof key.public_key === 'string') &&
      new Set(keys.map(key => key.public_key)).size === keys.length &&
      keys.some(key => key.public_key === identity.owner_public_key && key.access_key?.permission === 'FullAccess') &&
      !keys.some(key => key.public_key === identity.agent_public_key);
  });
  put('new_direct_child_absent', ['vault_presence'], () => atBlock('vault_presence') && reads.vault_presence.value.exists === false);
  put('circle_registration_min_matches_review', ['bounds'], () => {
    const bounds = reads.bounds.value, minimum = amount(bounds?.min), maximum = bounds?.max === null ? null : amount(bounds?.max);
    return record(bounds) && minimum !== null && minimum > 0n && minimum === registration &&
      (bounds.max === null || (maximum !== null && maximum >= minimum));
  });
  put('owner_registered_for_circle', ['owner_registration'], () => registered(reads.owner_registration.value));
  put('vault_not_already_registered_for_circle', ['vault_registration'], () => reads.vault_registration.value === null);
  put('seller_registered_for_circle', ['seller_registration'], () => registered(reads.seller_registration.value));
  put('owner_test_usdc_covers_funding', ['owner_usdc'], () => {
    const n = amount(reads.owner_usdc.value); return n !== null && n >= BigInt(SVALIN_TRIAL_MAX_ATOMS);
  });
  let estimatedOwnerAvailable = null, estimatedVaultRequired = null;
  put('owner_native_estimate', ['protocol', 'owner'], () => {
    const owner = reads.owner.value, native = amount(owner?.amount);
    if (!atBlock('owner') || reads.protocol.value?.chain_id !== 'testnet' || cost === null || cost === 0n ||
        native === null || !Number.isSafeInteger(owner?.storage_usage) || owner.storage_usage < 0) return false;
    const held = BigInt(owner.storage_usage) * cost;
    estimatedOwnerAvailable = native > held ? native - held : 0n;
    return estimatedOwnerAvailable >= initial + registration + OWNER_ESTIMATE_RESERVE;
  });
  put('vault_native_estimate', ['protocol'], () => {
    if (reads.protocol.value?.chain_id !== 'testnet' || cost === null || cost === 0n) return false;
    estimatedVaultRequired = (bytes + VAULT_EXTRA_STORAGE_BYTES) * cost + VAULT_ESTIMATE_RESERVE;
    return initial >= estimatedVaultRequired;
  });
  const finished = now();
  if (!Number.isSafeInteger(finished) || finished < started || !Number.isFinite(new Date(finished).getTime())) {
    throw new Error('local clock is invalid or moved backwards');
  }
  try { assertFreshFinalBlock(snapshot, finished); checks.final_block_fresh_at_completion = 'PASS'; }
  catch { checks.final_block_fresh_at_completion = 'BLOCKED'; }
  const blockers = Object.entries(checks).filter(([, state]) => state !== 'PASS').map(([check, state]) => ({ check, status: state }));
  const observedMin = reads.bounds.available ? amount(reads.bounds.value?.min) : null;
  const observedUsdc = reads.owner_usdc.available ? amount(reads.owner_usdc.value) : null;
  const deficit = observedUsdc === null ? null : BigInt(SVALIN_TRIAL_MAX_ATOMS) > observedUsdc
    ? BigInt(SVALIN_TRIAL_MAX_ATOMS) - observedUsdc : 0n;
  return {
    status: blockers.length ? 'BLOCKED_OR_UNKNOWN' : 'READ_ONLY_PREREQUISITES_INDICATED',
    network: 'testnet', block_hash: hash, block_timestamp: new Date(fresh.timestamp_ms).toISOString(),
    checked_at: new Date(finished).toISOString(), review_sha256: identity.review_sha256,
    owner: goal.owner, vault: goal.vault, token: CIRCLE_TESTNET_USDC, payee: SVALIN_PAYEE,
    reviewed_vault_funding_yocto: initial.toString(), reviewed_token_registration_yocto: registration.toString(),
    observed_token_registration_min_yocto: observedMin?.toString() ?? null,
    required_test_usdc_atoms: SVALIN_TRIAL_MAX_ATOMS, observed_owner_test_usdc_atoms: observedUsdc?.toString() ?? null,
    missing_test_usdc_atoms: deficit?.toString() ?? null,
    estimated_owner_available_yocto: estimatedOwnerAvailable?.toString() ?? null,
    estimated_vault_minimum_yocto: estimatedVaultRequired?.toString() ?? null,
    estimates_are_not_storage_or_gas_guarantees: true, checks, blockers,
    artifact_independently_reviewed: false, deployed_circle_code_verified: false, owner_approval_verified: false,
    backup_verified: false, setup_or_funding_verified: false, execution_authorized: false,
    transaction_signed: false, transaction_sent: false, seller_contacted: false,
    scope: 'read-only trusted-RPC indications for an uncreated vault; recheck before each separately approved action',
  };
}

function readBoundedFile(file, max) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > max) throw new Error('invalid size');
    const bytes = Buffer.alloc(stat.size); let offset = 0;
    while (offset < bytes.length) {
      const n = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!n) throw new Error('file shrank'); offset += n;
    }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, null) || fs.fstatSync(fd).size !== stat.size) throw new Error('file changed');
    return bytes;
  } catch { throw new Error('cannot read bounded regular public input file'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
async function cli(argv) {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('Read-only V11 testnet setup prerequisites; no signing, transaction, funding, journal or seller request.');
    console.log('Required: --goal PUBLIC.json --wasm V11.wasm --agent-public-key ed25519:... --owner-public-key ed25519:...');
    console.log('          --vault-funding-yocto INTEGER --agent-allowance-yocto INTEGER --vault-token-storage-yocto INTEGER --rpc HTTPS_URL');
    return;
  }
  const names = ['--goal', '--wasm', '--agent-public-key', '--owner-public-key', '--vault-funding-yocto',
    '--agent-allowance-yocto', '--vault-token-storage-yocto', '--rpc'], options = {};
  if (argv.length !== 2 * names.length) throw new Error('eight public input options are required; see --help');
  for (let i = 0; i < argv.length; i += 2) {
    if (!names.includes(argv[i]) || Object.hasOwn(options, argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error('invalid or repeated option; see --help');
    }
    options[argv[i]] = argv[i + 1];
  }
  let goal;
  try { goal = JSON.parse(readBoundedFile(options['--goal'], 16 * 1024).toString('utf8')); }
  catch { throw new Error('invalid bounded public goal file'); }
  const plan = buildUnsignedSvalinTrialSetup({ goal, wasmBytes: readBoundedFile(options['--wasm'], 4 * 1024 * 1024),
    agentPublicKey: options['--agent-public-key'], initialVaultFundingYocto: options['--vault-funding-yocto'],
    agentGasAllowanceYocto: options['--agent-allowance-yocto'], vaultTokenStorageDepositYocto: options['--vault-token-storage-yocto'] });
  const output = await inspectSvalinSetupPrerequisites({ plan, trustedReviewHash: plan.review.review_sha256,
    ownerPublicKey: options['--owner-public-key'], provider: new ReadOnlyNearRpcProvider(options['--rpc']) });
  console.log(JSON.stringify(output, null, 2));
  if (output.status !== 'READ_ONLY_PREREQUISITES_INDICATED') process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await cli(process.argv.slice(2)); }
  catch (error) { console.error(`Setup prerequisites blocked: ${error.message}`); process.exitCode = 1; }
}
