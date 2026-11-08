#!/usr/bin/env node
/**
 * Offline, unsigned action preparation for a NEW keyless V11 Svalin testnet
 * trial. This file has no signer, provider, journal, fetch or broadcast path.
 * The generated SDK action objects are NOT transactions and cannot establish
 * owner consent, source-to-binary reproducibility, funding or delivery.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { validateSvalinProGoal } from './svalin-pro-session.mjs';
import { SVALIN_PAYEE } from './svalin-pro-readiness.mjs';
import { SVALIN_TRIAL_MAX_ATOMS, SVALIN_TRIAL_MAX_GAS_ALLOWANCE } from './svalin-pro-preflight.mjs';
import { CIRCLE_TESTNET_USDC } from '../scripts/circle-testnet-setup.mjs';
import { isTestnetAccount } from '../shared/account-id.mjs';

const { transactions, utils } = nearApi;
const TGAS = 10n ** 12n;
const MAX_WASM_BYTES = 4 * 1024 * 1024;
const MAX_INITIAL_VAULT_YOCTO = 50n * 10n ** 24n; // a testnet ceiling, not a funding estimate
export const MAX_VAULT_TOKEN_REGISTRATION_YOCTO = 10n ** 23n; // 0.1 test NEAR ceiling, not a quote
const VERSION_MARKER = 'bouncer-agent-v11-exact-ft-testnet';
const WASM_HEADER = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
// Checking export NAMES and a marker catches some accidental artifact mixups.
// An adversarial or incorrect module can trivially satisfy both checks.
const REQUIRED_EXPORTS = [
  'new', 'contract_version', 'get_owner', 'get_policy', 'set_policy', 'allow_payee',
  'grant_agent_key', 'is_agent_key_allowed', 'lock_ft_policy_to_intents',
  'is_exact_ft_policy_locked', 'is_exact_ft_payee_locked', 'set_exact_ft_intent',
  'get_exact_ft_intent', 'execute_exact_ft', 'after_exact_ft_transfer',
  'ft_on_transfer', 'vault_balance', 'daily_spent', 'check', 'withdraw',
];
const HASH_DOMAIN = Buffer.from('bouncer-unsigned-setup-batch-v1\0');
// Used ONLY to encode an action commitment. This is not a transaction signer,
// a usable access key, a real block hash, or a transaction hash.
const COMMITMENT_KEY = utils.PublicKey.from('ed25519:11111111111111111111111111111111');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = value => crypto.createHash('sha256').update(value).digest();

function positiveAmount(value, maximum, label) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,38}$/.test(value)) throw new Error(`${label} must be a canonical positive yoctoNEAR string`);
  const amount = BigInt(value);
  if (amount > maximum) throw new Error(`${label} exceeds the bounded testnet profile`);
  return amount;
}
function canonicalAgentKey(value) {
  if (typeof value !== 'string') throw new Error('a canonical Ed25519 agent public key is required');
  let key;
  try { key = utils.PublicKey.from(value); } catch { throw new Error('invalid agent public key'); }
  if (key.keyType !== 0 || String(key) !== value) throw new Error('a canonical Ed25519 agent public key is required');
  return key;
}
function directChild(vault, owner) {
  const suffix = `.${owner}`;
  if (!vault.endsWith(suffix)) return false;
  const label = vault.slice(0, -suffix.length);
  return label.length > 0 && !label.includes('.');
}
function checkedWasm(input, expectedCodeHash) {
  if (!(input instanceof Uint8Array) || input.byteLength < WASM_HEADER.length || input.byteLength > MAX_WASM_BYTES) {
    throw new Error('V11 WASM must be a bounded byte array');
  }
  // Snapshot the code so subsequent mutations of the caller's buffer do not
  // silently alter the prepared deploy action.
  const bytes = Buffer.from(input);
  if (!bytes.subarray(0, 8).equals(WASM_HEADER) || !bytes.includes(Buffer.from(VERSION_MARKER))) {
    throw new Error('WASM header or V11 version marker is missing');
  }
  const hash = sha256(bytes), codeHash = utils.serialize.base_encode(hash);
  if (codeHash !== expectedCodeHash) throw new Error('WASM SHA-256 does not match the goal NEAR code hash');
  let exports;
  try { exports = WebAssembly.Module.exports(new WebAssembly.Module(bytes)); }
  catch { throw new Error('WASM is malformed or unsupported by this Node runtime'); }
  if (REQUIRED_EXPORTS.some(name => !exports.some(item => item.name === name && item.kind === 'function'))) {
    throw new Error('WASM is missing required V11 function exports');
  }
  return { bytes, hashHex: hash.toString('hex'), codeHash };
}

/** A deterministic commitment to signer ID, receiver ID and all serialized
 * actions. The zero block hash, fixed nonce and dummy key make this a REVIEW
 * fingerprint only, NOT the hash of any real or signed NEAR transaction.
 * Compare it again immediately before a future separately approved signer uses
 * the actions; the returned SDK objects are mutable. */
export function unsignedSvalinBatchCommitment(batch) {
  if (!record(batch) || !isTestnetAccount(batch.signerId) ||
      !(isTestnetAccount(batch.receiverId) || batch.receiverId === CIRCLE_TESTNET_USDC) ||
      !Array.isArray(batch.actions) || batch.actions.length < 1 || batch.actions.length > 8) {
    throw new Error('invalid unsigned testnet setup batch');
  }
  let bytes;
  try {
    const placeholder = transactions.createTransaction(batch.signerId, COMMITMENT_KEY, batch.receiverId,
      1n, batch.actions, Buffer.alloc(32));
    bytes = transactions.encodeTransaction(placeholder);
  } catch { throw new Error('cannot encode unsigned setup actions'); }
  return crypto.createHash('sha256').update(HASH_DOMAIN).update(bytes).digest('hex');
}

function summarizeAction(action) {
  switch (action.enum) {
    case 'createAccount': return { type: 'create_account' };
    case 'transfer': return { type: 'transfer', deposit_yocto: action.transfer.deposit.toString() };
    case 'deployContract': {
      const code = Buffer.from(action.deployContract.code);
      const hash = sha256(code);
      return { type: 'deploy_contract', byte_length: code.length, sha256: hash.toString('hex'),
        near_code_hash: utils.serialize.base_encode(hash) };
    }
    case 'functionCall': return { type: 'function_call', method: action.functionCall.methodName,
      args: JSON.parse(Buffer.from(action.functionCall.args).toString('utf8')),
      gas: action.functionCall.gas.toString(), deposit_yocto: action.functionCall.deposit.toString() };
    // DeleteKey appears only in separately reviewed recovery batches; the
    // commitment still binds signer, receiver and the exact public key.
    case 'deleteKey': return { type: 'delete_key', public_key: String(action.deleteKey.publicKey) };
    case 'addKey': {
      const key = action.addKey, permission = key.accessKey.permission.functionCall;
      if (key.accessKey.permission.enum !== 'functionCall' || !permission || permission.allowance === null) {
        throw new Error('only a bounded function-call key can appear in this plan');
      }
      return { type: 'add_function_call_key', public_key: String(key.publicKey),
        receiver_id: permission.receiverId, method_names: [...permission.methodNames],
        allowance_yocto: permission.allowance.toString() };
    }
    default: throw new Error('unsupported unsigned setup action');
  }
}

/** Detect later changes to mutable action objects against an independently
 * retained stage review. This is not signature validation or owner approval;
 * it cannot help if both the stage and the supposed trusted review are altered. */
export function assertSvalinBatchMatchesReview(batch, reviewedStage) {
  if (!record(batch) || !record(reviewedStage) || batch.id !== reviewedStage.id ||
      batch.signerId !== reviewedStage.signer_id || batch.receiverId !== reviewedStage.receiver_id ||
      typeof reviewedStage.action_commitment_sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(reviewedStage.action_commitment_sha256) || !Array.isArray(reviewedStage.actions)) {
    throw new Error('unsigned batch does not match its retained review');
  }
  let summary;
  try { summary = batch.actions.map(summarizeAction); }
  catch { throw new Error('unsigned batch does not match its retained review'); }
  if (unsignedSvalinBatchCommitment(batch) !== reviewedStage.action_commitment_sha256 ||
      JSON.stringify(summary) !== JSON.stringify(reviewedStage.actions)) {
    throw new Error('unsigned batch does not match its retained review');
  }
  return true;
}

/** Returns public review metadata plus unsigned near-api-js action batches.
 * Nothing here signs, writes files or sends transactions. The artifact must
 * be independently reviewed; an export/marker/hash match does not prove its
 * source or behavior. Account availability, chain identity, balances,
 * registration, storage costs, gas and seller state remain unverified. */
export function buildUnsignedSvalinTrialSetup(options) {
  const fields = ['goal', 'agentPublicKey', 'wasmBytes', 'initialVaultFundingYocto', 'agentGasAllowanceYocto',
    'vaultTokenStorageDepositYocto'];
  if (!record(options) || Object.keys(options).length !== fields.length || fields.some(k => !Object.hasOwn(options, k))) {
    throw new Error('exactly the public goal, artifact, agent key and bounded funding inputs are required');
  }
  const goal = validateSvalinProGoal(options.goal);
  if (!directChild(goal.vault, goal.owner)) throw new Error('the new vault must be an immediate subaccount of the owner');
  const agentKey = canonicalAgentKey(options.agentPublicKey);
  const initialFunding = positiveAmount(options.initialVaultFundingYocto, MAX_INITIAL_VAULT_YOCTO, 'initial vault funding');
  const allowance = positiveAmount(options.agentGasAllowanceYocto, BigInt(SVALIN_TRIAL_MAX_GAS_ALLOWANCE), 'agent gas allowance');
  const tokenStorage = positiveAmount(options.vaultTokenStorageDepositYocto, MAX_VAULT_TOKEN_REGISTRATION_YOCTO,
    'vault token registration deposit');
  const wasm = checkedWasm(options.wasmBytes, goal.vault_code_hash);
  const policy = goal.policy_id;
  const functionCall = (method, args, gas = 30n * TGAS, deposit = 1n) =>
    transactions.functionCall(method, args, gas, deposit);
  const batches = [
    // Create + fund + deploy + init in ONE receipt; no vault access key is
    // added. Separating deploy from new would expose an initialization race.
    { id: 'create_keyless_vault', signerId: goal.owner, receiverId: goal.vault, actions: [
      transactions.createAccount(), transactions.transfer(initialFunding), transactions.deployContract(wasm.bytes),
      functionCall('new', { owner: goal.owner }, 30n * TGAS, 0n),
    ] },
    // Lock BEFORE granting the key, with all four actions in one receipt.
    { id: 'configure_locked_policy', signerId: goal.owner, receiverId: goal.vault, actions: [
      functionCall('set_policy', { policy_id: policy, token: CIRCLE_TESTNET_USDC,
        per_tx_cap: SVALIN_TRIAL_MAX_ATOMS, daily_cap: SVALIN_TRIAL_MAX_ATOMS }),
      functionCall('allow_payee', { policy_id: policy, payee: SVALIN_PAYEE }),
      functionCall('lock_ft_policy_to_intents', { policy_id: policy }),
      functionCall('grant_agent_key', { policy_id: policy, public_key: String(agentKey) }),
    ] },
    // An owner account key is separate from the vault's policy grant. This
    // installs ONLY execute_exact_ft and never installs a vault access key.
    { id: 'install_restricted_agent_key', signerId: goal.owner, receiverId: goal.owner, actions: [
      transactions.addKey(agentKey, transactions.functionCallAccessKey(goal.vault, ['execute_exact_ft'], allowance)),
    ] },
    // Register exactly this vault, funded by the owner. The reviewed amount is
    // not a quote: require a fresh pinned storage_balance_bounds.min match and
    // an unregistered vault immediately before any separately approved send.
    { id: 'register_vault_for_test_usdc', signerId: goal.owner, receiverId: CIRCLE_TESTNET_USDC, actions: [
      functionCall('storage_deposit', { account_id: goal.vault, registration_only: true }, 50n * TGAS, tokenStorage),
    ] },
    // Owner holdings and acquisition are NOT assumed. The live one-shot owner
    // setup path must journal and reconcile this separate funding call.
    { id: 'fund_vault_with_test_usdc', signerId: goal.owner, receiverId: CIRCLE_TESTNET_USDC, actions: [
      functionCall('ft_transfer_call', { receiver_id: goal.vault, amount: SVALIN_TRIAL_MAX_ATOMS, msg: '' }, 200n * TGAS, 1n),
    ] },
  ];
  const prerequisites = {
    create_keyless_vault: 'Separately approve a reviewed artifact and native funding; check trusted testnet, owner authority, storage/gas and fresh direct-child availability.',
    configure_locked_policy: 'First reconcile the original deployment hash and verify a FINAL, initialized keyless vault, code hash and owner.',
    install_restricted_agent_key: 'First reconcile policy setup and verify the exact lock and grant; check this public key is not already installed with broader permission.',
    register_vault_for_test_usdc: 'First reconcile key installation; at one fresh FINAL block verify the vault is unregistered and Circle storage minimum equals the reviewed deposit; check owner funds.',
    fund_vault_with_test_usdc: 'First reconcile vault registration and verify owner, vault and seller Circle registrations and owner holdings; retain and reconcile the original funding hash and its asynchronous receipts.',
  };
  const review = {
    format: 'bouncer-svalin-setup-review-v2', status: 'UNSIGNED_OFFLINE_PLAN_ONLY', network: 'testnet',
    goal, agent_public_key: String(agentKey),
    artifact: { byte_length: wasm.bytes.length, sha256: wasm.hashHex, near_code_hash: wasm.codeHash,
      marker_and_exports_are_not_an_audit: true },
    stages: batches.map(batch => ({ id: batch.id, signer_id: batch.signerId, receiver_id: batch.receiverId,
      prerequisite: prerequisites[batch.id], action_commitment_sha256: unsignedSvalinBatchCommitment(batch),
      actions: batch.actions.map(summarizeAction) })),
    unresolved: [
      'Independent source/binary review and owner approval; a marker and hash are not an audit.',
      'A trusted testnet RPC, fresh direct-child account availability, owner full-access authority and sufficient native storage/gas.',
      'The agent public key must not already be installed with broader owner-account permission; protect and back up keys.',
      'Check fresh Circle registration and storage bounds before the reviewed registration; the owner and seller must also be registered.',
      'Acquire and verify owner test USDC separately; the final stage is a deposit to the vault, not a seller payment.',
      'A keyless V11 vault cannot be upgraded or deleted through the current contract; storage stake and token registration may remain locked.',
      'Reconcile every original transaction hash and successful FINAL receipts before proceeding; never blindly retry an unknown outcome.',
      'Run the separate pinned-block preflight after setup; then obtain separate approval for any reservation, intent, payment or paid call.',
    ],
    transaction_signed: false, transaction_sent: false, seller_contacted: false,
    setup_or_funding_verified: false, owner_approval_obtained: false, independent_fulfillment_verified: false,
  };
  // The review hash covers exactly the JSON printed to the human, not an
  // on-chain transaction. It is useful only if retained through a trusted
  // channel; it is not a signature, authorization or proof of consent.
  const reviewDigest = sha256(Buffer.from(JSON.stringify(review))).toString('hex');
  return { review: { ...review, review_sha256: reviewDigest }, batches };
}

function readBoundedRegularFile(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) throw new Error('invalid size or file type');
    // Do not use readFileSync here: a growing file could exceed its initial
    // stat size and bypass the memory bound before a later length check.
    const bytes = Buffer.alloc(stat.size); let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) throw new Error('file shrank during read');
      offset += count;
    }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0 || fs.fstatSync(fd).size !== stat.size) {
      throw new Error('file changed during read');
    }
    return bytes;
  } catch { throw new Error('cannot read a bounded regular public input file'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function parseCli(argv) {
  const names = ['--goal', '--wasm', '--agent-public-key', '--vault-funding-yocto', '--agent-allowance-yocto',
    '--vault-token-storage-yocto'];
  if (argv.length === 1 && argv[0] === '--help') return null;
  if (argv.length !== names.length * 2) throw new Error('six public input options are required; see --help');
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!names.includes(argv[i]) || Object.hasOwn(values, argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error('invalid or repeated option; see --help');
    }
    values[argv[i]] = argv[i + 1];
  }
  return values;
}
function cli(argv) {
  const options = parseCli(argv);
  if (options === null) {
    console.log('Offline unsigned V11 Svalin TESTNET setup plan; testnet USDC has no value.');
    console.log('Required: --goal PUBLIC.json --wasm REVIEWED-V11.wasm --agent-public-key ed25519:...');
    console.log('          --vault-funding-yocto INTEGER --agent-allowance-yocto INTEGER');
    console.log('          --vault-token-storage-yocto INTEGER');
    console.log('No private keys, network, signature, deployment, funding, seller request or approval.');
    return;
  }
  let goal;
  try { goal = JSON.parse(readBoundedRegularFile(options['--goal'], 16 * 1024).toString('utf8')); }
  catch { throw new Error('invalid bounded public goal file'); }
  const wasm = readBoundedRegularFile(options['--wasm'], MAX_WASM_BYTES);
  const { review } = buildUnsignedSvalinTrialSetup({ goal, wasmBytes: wasm,
    agentPublicKey: options['--agent-public-key'], initialVaultFundingYocto: options['--vault-funding-yocto'],
    agentGasAllowanceYocto: options['--agent-allowance-yocto'],
    vaultTokenStorageDepositYocto: options['--vault-token-storage-yocto'] });
  console.log(JSON.stringify(review, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { cli(process.argv.slice(2)); }
  catch (error) { console.error(`Setup plan blocked: ${error.message}`); process.exitCode = 1; }
}
