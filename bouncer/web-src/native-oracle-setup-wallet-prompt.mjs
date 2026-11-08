/**
 * Experimental, explicit one-shot wallet adapter for a REVIEWED native
 * testnet setup stage. The owner must individually approve each prompt.
 * Before use, a separately authenticated backend must verify prior original
 * receipt graphs and fresh state, commit a one-shot DB claim and obtain an
 * independent acknowledged witness. This module performs no automatic retry,
 * agent signing, RPC call, provider request or purchase. The account UI can
 * use it only when the separately configured experimental preview advertises
 * its disabled-by-default backend; it is not enabled on production. A wallet
 * response is not FINAL receipt evidence.
 *
 * A compromised same-origin app, backend or wallet can bypass these checks;
 * a 5-second preflight can still race chain changes while the user approves.
 * Do not expose this until cross-flow fencing, recovery, device custody and
 * real-phone/wallet compatibility are complete and independently reviewed.
 */
import { isTestnetAccount } from './wallet-utils.mjs';
import { assertNativeOracleWalletDeployAvailable, NATIVE_ORACLE_V9_BYTES } from './native-oracle-wallet-compatibility.mjs';

const STAGES = ['create_keyless_native_vault', 'configure_native_oracle_policy', 'fund_native_vault', 'install_native_oracle_agent'];
// Selected only for an explicitly enabled, verified atomic review. This list
// does not itself enable a wallet prompt or provide an independent fence.
const ATOMIC_STAGES = ['create_configure_fund_native_vault', 'install_native_oracle_agent'];
// Research-only until a separately configured backend and complete recovery
// are ready. This declaration alone does not enable a wallet prompt.
const COMPRESSED_STAGES = ['create_compressed_native_vault', 'configure_fund_native_oracle', 'install_native_oracle_agent'];
const COMPRESSED_FORMAT = 'bouncer-research-compressed-native-oracle-wallet-review-v1';
const LOADER_BYTES = 28_950, LOADER_SHA = '28b358e4ee4e6c7327dc17c63934a63e4cdad5d424dbfe67a80381cf1027bb7b';
const LOADER_HASH = '3jsvZj8cf2gPaAdregpu2tob8kMYCrMhe996Wb3Pss9t';
const DEFLATE_BYTES = 135_476, DEFLATE_SHA = '4fdc4feffcb7b690d3f6f4dec6f62af12b37cebdb3f1e78bc9486e366c81ec21';
const HEX64 = /^[a-f0-9]{64}$/, HEX32 = /^[a-f0-9]{32}$/, GIT = /^[a-f0-9]{40}$/;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const WASM_BYTES = NATIVE_ORACLE_V9_BYTES, WASM_SHA256 = '835f0baa51d08ddf3af6812df0caefb93283480735a63e3d382073e04fbaf8ee';
const WASM_HASH = '9qpU6d6MHZZXC2ivtQt3k3scGkiHLkkMnaTAiZWbaL6y';
const STORAGE = '5400000000000000000000000', MAX_TRIAL = 10n ** 23n, MAX_ALLOWANCE = 10n ** 24n;
const GAS = '30000000000000', METHOD = 'execute_outlayer_native_project', PAYEE = 'outlayer.testnet';
const PROJECT = Object.freeze({ project_id: 'zavodil2.testnet/price-oracle',
  version_key: '3585b3890f49748713b43ccb9b0ef4148f317d62f4d598db80fdaffc3f3185a0',
  input_data: '{"command":"fetch_external","token_id":"near","source":{"custom":{"url":"https://api.coinbase.com/v2/prices/NEAR-USD/spot","json_path":"data.amount","value_type":"number","method":"GET"}}}',
  max_instructions: 10000000000, max_memory_mb: 256, max_execution_seconds: 60 });
const TOP_FIELDS = ['format','status','network','owner','vault','policy_id','agent_public_key','asset','payee','project','per_tx_cap_yocto',
  'daily_cap_yocto','vault_deposit_yocto','agent_gas_allowance_yocto','vault_storage_funding_yocto','artifact','stages','limitations',
  'signing_authorized','transaction_sent','agent_key_installed','independent_delivery_verified','review_sha256'];
const STAGE_FIELDS = ['id','signer_id','receiver_id','prerequisite','actions','action_commitment_sha256'];
const ATOMIC_TOP_FIELDS = ['format','status','network','owner','owner_public_key','vault','policy_id','agent_public_key','asset','payee','project','artifact',
  'per_tx_cap_yocto','daily_cap_yocto','vault_deposit_yocto','agent_gas_allowance_yocto','vault_storage_funding_yocto','base_review_sha256',
  'stages','limitations','signing_authorized','transaction_sent','agent_key_installed','independent_delivery_verified','review_sha256'];
const ATOMIC_STAGE_FIELDS = ['id','signer_id','receiver_id','actions','action_commitment_sha256'];
const COMPRESSED_TOP_FIELDS = ['format','status','network','owner','owner_public_key','vault','policy_id','agent_public_key','asset','payee','project',
  'per_tx_cap_yocto','daily_cap_yocto','vault_deposit_yocto','agent_gas_allowance_yocto','vault_storage_funding_yocto',
  'artifact','loader','compressed','base_review_sha256','stages','limitations','signing_authorized','transaction_sent',
  'agent_key_installed','independent_delivery_verified','review_sha256'];
const COMPRESSED_LIMITATIONS = Object.freeze([
  'Research only. This review is not an owner approval, a wallet prompt, a purchase, or a provider receipt.',
  'The first transaction self-upgrades asynchronously; failure can leave the loader and storage funds on the child.',
  'Never retry an unknown original. Any owner refund requires separately verified final state and explicit authorization.',
  'Each stage needs an independently retained one-shot claim, original hash, complete receipt graph and fresh FINAL state before the next prompt.',
  'Vault storage may be locked; the native deposit and gas allowance are additional and testnet-only.',
  'The agent key is restricted to the native OutLayer method and cannot attach the 1 yocto required for owner policy changes.',
  'Provider delivery, current code and policy, real-phone behavior and the independent prompt fence are not established by this review.',
]);
const ATOMIC_LIMITATIONS = Object.freeze([
  'Offline testnet review only: it does not establish wallet control, user approval, a live purchase or provider delivery.',
  'The first wallet transaction creates, configures and funds the vault; the second separately installs the one-method agent key. Wallet support for the nine actions is unverified.',
  'The keyless vault storage funding may be locked. Native provider funding and gas are additional; verify actual testnet balance and protocol costs first.',
  'A separately retained one-shot claim and original hash are required for each wallet prompt. An unknown, rejected or failed original must never be automatically resent.',
  'Before each prompt, verify the exact original receipt graph and fresh FINAL state, including code, owner, caps, route, balance and key scope.',
  'Atomic create/configure/fund prevents a successful duplicate vault creation, not all cross-device, rollback or bypassing-client risks.',
  'The restricted key can call only the fixed native-project method and cannot attach the 1 yocto needed for owner policy changes.',
  'OutLayer receives the maximum; a verified unused refund returns to the owner, not the vault. The full maximum remains in the rolling budget.',
  'The reviewed trial is one OutLayer price-data task, not independent storage, FT delivery, attestation or proof of price accuracy.',
]);
const fail = () => new Error('NATIVE_SETUP_PROMPT_UNAVAILABLE');
// Defense in depth within one JS realm only; reloads/devices still require the durable fence.
const locallyUsedClaims = new Set();
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x, fields) => object(x) && Object.keys(x).length === fields.length && fields.every(k => Object.hasOwn(x, k));
const bytes = x => new TextEncoder().encode(x);
const digest = async (crypto, input) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', input))].map(n => n.toString(16).padStart(2, '0')).join('');
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
function base58_32(value) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) return false;
  let n = 0n;
  for (const c of value) { const digit = B58.indexOf(c); if (digit < 0) return false; n = n * 58n + BigInt(digit); }
  let length = 0; while (n) { n >>= 8n; length++; }
  let leading = 0; while (value[leading] === '1') leading++;
  return leading + length === 32;
}
const publicKey = value => typeof value === 'string' && value.startsWith('ed25519:') && base58_32(value.slice(8));
const positive = (value, max) => typeof value === 'string' && /^[1-9][0-9]{0,38}$/.test(value) && BigInt(value) <= max;
function directChild(child, owner) {
  if (!isTestnetAccount(owner) || !owner.endsWith('.testnet') || owner === 'bouncer-owner-12f343b795633e357ae5560d.testnet' ||
      !isTestnetAccount(child) || !child.endsWith(`.${owner}`)) return false;
  const label = child.slice(0, -owner.length - 1); return !!label && !label.includes('.');
}
function expectedActions(r) {
  const call = (method, args, deposit = '1') => ({ type: 'function_call', method, args, gas: GAS, deposit_yocto: deposit });
  return [
    [{ type: 'create_account' }, { type: 'transfer', deposit_yocto: STORAGE },
      { type: 'deploy_contract', byte_length: WASM_BYTES, sha256: WASM_SHA256, near_code_hash: WASM_HASH },
      call('new', { owner: r.owner }, '0')],
    [call('set_policy', { policy_id: r.policy_id, token: 'native', per_tx_cap: r.per_tx_cap_yocto, daily_cap: r.daily_cap_yocto }),
      call('allow_payee', { policy_id: r.policy_id, payee: PAYEE }),
      call('set_outlayer_native_project', { policy_id: r.policy_id, project: { ...PROJECT } }),
      call('grant_agent_key', { policy_id: r.policy_id, public_key: r.agent_public_key })],
    [call('deposit_native', {}, r.vault_deposit_yocto)],
    [{ type: 'add_function_call_key', public_key: r.agent_public_key, receiver_id: r.vault,
      method_names: [METHOD], allowance_yocto: r.agent_gas_allowance_yocto }],
  ];
}
function canonicalReview(review, identity) {
  if (!exact(identity, ['owner','owner_public_key','operation_id','review_sha256','stages']) ||
      !exact(review, TOP_FIELDS) || review.format !== 'bouncer-native-oracle-wallet-review-v1' ||
      review.status !== 'UNSIGNED_OFFLINE_PLAN_ONLY' || review.network !== 'testnet' || !directChild(review.vault, review.owner) ||
      review.owner !== identity?.owner || !publicKey(identity?.owner_public_key) || !publicKey(review.agent_public_key) ||
      review.agent_public_key === identity.owner_public_key || typeof review.policy_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(review.policy_id) ||
      review.asset !== 'native' || review.payee !== PAYEE || !same(review.project, PROJECT) ||
      !positive(review.per_tx_cap_yocto, MAX_TRIAL) || !positive(review.daily_cap_yocto, MAX_TRIAL) ||
      !positive(review.vault_deposit_yocto, MAX_TRIAL) || !positive(review.agent_gas_allowance_yocto, MAX_ALLOWANCE) ||
      BigInt(review.per_tx_cap_yocto) > BigInt(review.daily_cap_yocto) || BigInt(review.per_tx_cap_yocto) > BigInt(review.vault_deposit_yocto) ||
      BigInt(review.vault_deposit_yocto) > BigInt(review.daily_cap_yocto) || review.vault_storage_funding_yocto !== STORAGE ||
      !same(review.artifact, { bytes: WASM_BYTES, sha256: WASM_SHA256, near_code_hash: WASM_HASH }) ||
      review.signing_authorized !== false || review.transaction_sent !== false || review.agent_key_installed !== false || review.independent_delivery_verified !== false ||
      !HEX64.test(review.review_sha256 ?? '') || identity.review_sha256 !== review.review_sha256 || !HEX32.test(identity.operation_id ?? '') ||
      !Array.isArray(review.stages) || review.stages.length !== 4 || !Array.isArray(identity.stages) || identity.stages.length !== 4 ||
      !Array.isArray(review.limitations) || review.limitations.length !== 7 ||
      review.limitations.some(x => typeof x !== 'string' || !x || x.length > 512)) throw fail();
  const expected = expectedActions(review);
  const stages = review.stages.map((stage, i) => {
    if (!exact(stage, STAGE_FIELDS) || stage.id !== STAGES[i] || stage.signer_id !== review.owner ||
        stage.receiver_id !== (i === 3 ? review.owner : review.vault) || typeof stage.prerequisite !== 'string' ||
        !stage.prerequisite || stage.prerequisite.length > 512 || !same(stage.actions, expected[i]) ||
        !HEX64.test(stage.action_commitment_sha256 ?? '') || !exact(identity.stages[i], ['stage_id','action_commitment_sha256']) || identity.stages[i]?.stage_id !== stage.id ||
        identity.stages[i]?.action_commitment_sha256 !== stage.action_commitment_sha256) throw fail();
    return { id: stage.id, signer_id: stage.signer_id, receiver_id: stage.receiver_id, prerequisite: stage.prerequisite,
      actions: expected[i], action_commitment_sha256: stage.action_commitment_sha256 };
  });
  // Rebuild in the planner's field order, so a JSONB round-trip that changes
  // object-key order does not break the original digest. Safety-critical
  // actions and terms above are independently reconstructed, not trusted text.
  const canonical = { format: review.format, status: review.status, network: review.network, owner: review.owner, vault: review.vault,
    policy_id: review.policy_id, agent_public_key: review.agent_public_key, asset: review.asset, payee: review.payee,
    project: { ...PROJECT }, per_tx_cap_yocto: review.per_tx_cap_yocto, daily_cap_yocto: review.daily_cap_yocto,
    vault_deposit_yocto: review.vault_deposit_yocto, agent_gas_allowance_yocto: review.agent_gas_allowance_yocto,
    vault_storage_funding_yocto: STORAGE, artifact: { bytes: WASM_BYTES, sha256: WASM_SHA256, near_code_hash: WASM_HASH },
    stages, limitations: [...review.limitations], signing_authorized: false, transaction_sent: false,
    agent_key_installed: false, independent_delivery_verified: false };
  return canonical;
}

// Reconstruct both atomic stages from fixed public terms, rather than trusting
// action text supplied by a server. Reordering JSON object keys is harmless;
// changing a cap, route, key scope, code, amount or action is not.
function canonicalAtomicReview(review, identity) {
  if (!exact(identity, ['owner','owner_public_key','operation_id','review_sha256','stages']) ||
      !exact(review, ATOMIC_TOP_FIELDS) || review.format !== 'bouncer-atomic-native-oracle-wallet-review-v1' ||
      review.status !== 'UNSIGNED_OFFLINE_PLAN_ONLY' || review.network !== 'testnet' || !directChild(review.vault, review.owner) ||
      review.owner !== identity?.owner || review.owner_public_key !== identity?.owner_public_key ||
      !publicKey(identity?.owner_public_key) || !publicKey(review.agent_public_key) || review.agent_public_key === identity.owner_public_key ||
      typeof review.policy_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(review.policy_id) ||
      review.asset !== 'native' || review.payee !== PAYEE || !same(review.project, PROJECT) ||
      !positive(review.per_tx_cap_yocto, MAX_TRIAL) || !positive(review.daily_cap_yocto, MAX_TRIAL) ||
      !positive(review.vault_deposit_yocto, MAX_TRIAL) || !positive(review.agent_gas_allowance_yocto, MAX_ALLOWANCE) ||
      BigInt(review.per_tx_cap_yocto) > BigInt(review.daily_cap_yocto) || BigInt(review.per_tx_cap_yocto) > BigInt(review.vault_deposit_yocto) ||
      BigInt(review.vault_deposit_yocto) > BigInt(review.daily_cap_yocto) || review.vault_storage_funding_yocto !== STORAGE ||
      !same(review.artifact, { bytes: WASM_BYTES, sha256: WASM_SHA256, near_code_hash: WASM_HASH }) ||
      review.signing_authorized !== false || review.transaction_sent !== false || review.agent_key_installed !== false ||
      review.independent_delivery_verified !== false || !HEX64.test(review.base_review_sha256 ?? '') ||
      !HEX64.test(review.review_sha256 ?? '') || identity.review_sha256 !== review.review_sha256 || !HEX32.test(identity.operation_id ?? '') ||
      !Array.isArray(review.stages) || review.stages.length !== 2 || !Array.isArray(identity.stages) || identity.stages.length !== 2 ||
      !same(review.limitations, ATOMIC_LIMITATIONS)) throw fail();
  const pieces = expectedActions(review), expected = [pieces.slice(0, 3).flat(), pieces[3]];
  const stages = review.stages.map((stage, i) => {
    if (!exact(stage, ATOMIC_STAGE_FIELDS) || stage.id !== ATOMIC_STAGES[i] || stage.signer_id !== review.owner ||
        stage.receiver_id !== (i === 1 ? review.owner : review.vault) || !same(stage.actions, expected[i]) ||
        !HEX64.test(stage.action_commitment_sha256 ?? '') || !exact(identity.stages[i], ['stage_id','action_commitment_sha256']) ||
        identity.stages[i]?.stage_id !== stage.id || identity.stages[i]?.action_commitment_sha256 !== stage.action_commitment_sha256) throw fail();
    return { id: stage.id, signer_id: stage.signer_id, receiver_id: stage.receiver_id,
      actions: expected[i], action_commitment_sha256: stage.action_commitment_sha256 };
  });
  return { format: review.format, status: review.status, network: review.network, owner: review.owner, owner_public_key: review.owner_public_key,
    vault: review.vault, policy_id: review.policy_id, agent_public_key: review.agent_public_key, asset: review.asset, payee: review.payee,
    project: { ...PROJECT }, artifact: { bytes: WASM_BYTES, sha256: WASM_SHA256, near_code_hash: WASM_HASH },
    per_tx_cap_yocto: review.per_tx_cap_yocto, daily_cap_yocto: review.daily_cap_yocto, vault_deposit_yocto: review.vault_deposit_yocto,
    agent_gas_allowance_yocto: review.agent_gas_allowance_yocto, vault_storage_funding_yocto: STORAGE,
    base_review_sha256: review.base_review_sha256, stages, limitations: [...ATOMIC_LIMITATIONS], signing_authorized: false,
    transaction_sent: false, agent_key_installed: false, independent_delivery_verified: false };
}

function canonicalCompressedReview(review, identity) {
  if (!exact(identity, ['owner','owner_public_key','operation_id','review_sha256','stages']) ||
      !exact(review, COMPRESSED_TOP_FIELDS) || review.format !== COMPRESSED_FORMAT || review.status !== 'UNSIGNED_OFFLINE_PLAN_ONLY' ||
      review.network !== 'testnet' || !directChild(review.vault, review.owner) || review.owner !== identity.owner ||
      review.owner_public_key !== identity.owner_public_key || !publicKey(identity.owner_public_key) || !publicKey(review.agent_public_key) ||
      review.agent_public_key === identity.owner_public_key || typeof review.policy_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(review.policy_id) ||
      review.asset !== 'native' || review.payee !== PAYEE || !same(review.project, PROJECT) ||
      !positive(review.per_tx_cap_yocto, MAX_TRIAL) || !positive(review.daily_cap_yocto, MAX_TRIAL) ||
      !positive(review.vault_deposit_yocto, MAX_TRIAL) || !positive(review.agent_gas_allowance_yocto, MAX_ALLOWANCE) ||
      BigInt(review.per_tx_cap_yocto) > BigInt(review.daily_cap_yocto) || BigInt(review.per_tx_cap_yocto) > BigInt(review.vault_deposit_yocto) ||
      BigInt(review.vault_deposit_yocto) > BigInt(review.daily_cap_yocto) || review.vault_storage_funding_yocto !== STORAGE ||
      !same(review.artifact,{bytes:WASM_BYTES,sha256:WASM_SHA256,near_code_hash:WASM_HASH}) ||
      !same(review.loader,{bytes:LOADER_BYTES,sha256:LOADER_SHA,near_code_hash:LOADER_HASH}) ||
      !same(review.compressed,{bytes:DEFLATE_BYTES,sha256:DEFLATE_SHA,encoding:'raw-deflate'}) ||
      review.signing_authorized !== false || review.transaction_sent !== false || review.agent_key_installed !== false ||
      review.independent_delivery_verified !== false || !HEX64.test(review.base_review_sha256 ?? '') ||
      !HEX64.test(review.review_sha256 ?? '') || identity.review_sha256 !== review.review_sha256 || !HEX32.test(identity.operation_id ?? '') ||
      !Array.isArray(review.stages) || review.stages.length !== 3 || !Array.isArray(identity.stages) || identity.stages.length !== 3 ||
      !same(review.limitations,COMPRESSED_LIMITATIONS)) throw fail();
  const pieces = expectedActions(review);
  const compressedCall = {type:'function_call',method:'loader_deploy',args_encoding:'raw-deflate',args_bytes:DEFLATE_BYTES,
    args_sha256:DEFLATE_SHA,gas:'240000000000000',deposit_yocto:'1',
    self_deployment:{artifact_sha256:WASM_SHA256,near_code_hash:WASM_HASH,method:'new',args:{owner:review.owner},gas:GAS,deposit_yocto:'0'}};
  const expected = [[{type:'create_account'},{type:'transfer',deposit_yocto:STORAGE},
    {type:'deploy_contract',byte_length:LOADER_BYTES,sha256:LOADER_SHA,near_code_hash:LOADER_HASH},
    {type:'function_call',method:'loader_init',args:{},gas:'20000000000000',deposit_yocto:'1'},compressedCall],
    [...pieces[1],...pieces[2]],pieces[3]];
  const stages=review.stages.map((stage,i)=>{
    if (!exact(stage,ATOMIC_STAGE_FIELDS) || stage.id!==COMPRESSED_STAGES[i] || stage.signer_id!==review.owner ||
        stage.receiver_id!==(i===2?review.owner:review.vault) || !same(stage.actions,expected[i]) ||
        !HEX64.test(stage.action_commitment_sha256??'') || !exact(identity.stages[i],['stage_id','action_commitment_sha256']) ||
        identity.stages[i].stage_id!==stage.id || identity.stages[i].action_commitment_sha256!==stage.action_commitment_sha256) throw fail();
    return {id:stage.id,signer_id:stage.signer_id,receiver_id:stage.receiver_id,actions:expected[i],
      action_commitment_sha256:stage.action_commitment_sha256};
  });
  return {format:review.format,status:review.status,network:review.network,owner:review.owner,owner_public_key:review.owner_public_key,
    vault:review.vault,policy_id:review.policy_id,agent_public_key:review.agent_public_key,asset:review.asset,payee:review.payee,
    project:{...PROJECT},per_tx_cap_yocto:review.per_tx_cap_yocto,daily_cap_yocto:review.daily_cap_yocto,
    vault_deposit_yocto:review.vault_deposit_yocto,agent_gas_allowance_yocto:review.agent_gas_allowance_yocto,
    vault_storage_funding_yocto:STORAGE,artifact:{bytes:WASM_BYTES,sha256:WASM_SHA256,near_code_hash:WASM_HASH},
    loader:{bytes:LOADER_BYTES,sha256:LOADER_SHA,near_code_hash:LOADER_HASH},
    compressed:{bytes:DEFLATE_BYTES,sha256:DEFLATE_SHA,encoding:'raw-deflate'},base_review_sha256:review.base_review_sha256,
    stages,limitations:[...COMPRESSED_LIMITATIONS],signing_authorized:false,transaction_sent:false,
    agent_key_installed:false,independent_delivery_verified:false};
}

/** Reconstruct public terms for read-only original recovery. This does not
 * establish custody, consent, chain state or authority to sign or submit. */
export async function verifyNativeOracleRetainedReview({ review: rawReview, identity: rawIdentity, crypto = globalThis.crypto } = {}) {
  if (!crypto?.subtle) throw fail();
  const review = structuredClone(rawReview), identity = structuredClone(rawIdentity);
  const canonical = canonicalReview(review, identity);
  if (await digest(crypto, bytes(JSON.stringify(canonical))) !== review.review_sha256) throw fail();
  return canonical;
}

/** Public atomic-review recovery only; does not grant authority or custody. */
export async function verifyAtomicNativeOracleRetainedReview({ review: rawReview, identity: rawIdentity, crypto = globalThis.crypto } = {}) {
  if (!crypto?.subtle) throw fail();
  const review = structuredClone(rawReview), identity = structuredClone(rawIdentity);
  const canonical = canonicalAtomicReview(review, identity);
  if (await digest(crypto, bytes(JSON.stringify(canonical))) !== review.review_sha256) throw fail();
  return canonical;
}
/** Research-only compressed-review validation; this does not enable a prompt. */
export async function verifyCompressedNativeOracleRetainedReview({ review: rawReview, identity: rawIdentity, crypto = globalThis.crypto } = {}) {
  if (!crypto?.subtle) throw fail();
  const review=structuredClone(rawReview),identity=structuredClone(rawIdentity),canonical=canonicalCompressedReview(review,identity);
  if (await digest(crypto,bytes(JSON.stringify(canonical)))!==review.review_sha256) throw fail();
  return canonical;
}

function assertLocalDevice(canonical, deviceKey, origin) {
  if (typeof origin !== 'string') throw fail();
  const device = structuredClone(deviceKey);
  if (device?.status !== 'LOCAL_DEVICE_KEY_AVAILABLE' || device.origin !== origin || device.owner !== canonical.owner ||
      device.vault !== canonical.vault || device.public_key !== canonical.agent_public_key ||
      device.expected_public_key_matched !== true || device.private_key_exportable !== false ||
      device.local_storage_only !== true || device.signing_authorized !== false) throw fail();
  return canonical;
}
/** Signing paths additionally require the real local, non-extractable key. */
export async function verifyNativeOracleSetupReview({ review, identity, deviceKey, origin, crypto = globalThis.crypto } = {}) {
  return assertLocalDevice(await verifyNativeOracleRetainedReview({ review, identity, crypto }), deviceKey, origin);
}
/** Atomic equivalent; separately fenced/anchored operation still required. */
export async function verifyAtomicNativeOracleSetupReview({ review, identity, deviceKey, origin, crypto = globalThis.crypto } = {}) {
  return assertLocalDevice(await verifyAtomicNativeOracleRetainedReview({ review, identity, crypto }), deviceKey, origin);
}
/** Compressed research equivalent; still requires local, non-extractable key. */
export async function verifyCompressedNativeOracleSetupReview({ review, identity, deviceKey, origin, crypto = globalThis.crypto } = {}) {
  return assertLocalDevice(await verifyCompressedNativeOracleRetainedReview({review,identity,crypto}),deviceKey,origin);
}
/** Choose by the retained format, never by a caller-supplied stage count. */
export async function verifySupportedNativeOracleRetainedReview(args = {}) {
  if (args.review?.format === 'bouncer-native-oracle-wallet-review-v1') return verifyNativeOracleRetainedReview(args);
  if (args.review?.format === 'bouncer-atomic-native-oracle-wallet-review-v1') return verifyAtomicNativeOracleRetainedReview(args);
  if (args.review?.format === COMPRESSED_FORMAT) return verifyCompressedNativeOracleRetainedReview(args);
  throw fail();
}
export async function verifySupportedNativeOracleSetupReview(args = {}) {
  if (args.review?.format === 'bouncer-native-oracle-wallet-review-v1') return verifyNativeOracleSetupReview(args);
  if (args.review?.format === 'bouncer-atomic-native-oracle-wallet-review-v1') return verifyAtomicNativeOracleSetupReview(args);
  if (args.review?.format === COMPRESSED_FORMAT) return verifyCompressedNativeOracleSetupReview(args);
  throw fail();
}

function walletActions(stage, code, compressed) {
  return stage.actions.map(a => {
    if (a.type === 'create_account') return { type: 'CreateAccount' };
    if (a.type === 'transfer') return { type: 'Transfer', params: { deposit: a.deposit_yocto } };
    if (a.type === 'deploy_contract') return { type: 'DeployContract', params: { code: new Uint8Array(code) } };
    if (a.type === 'function_call') return { type: 'FunctionCall', params: { methodName: a.method,
      args: a.args_encoding === 'raw-deflate' ? new Uint8Array(compressed) : structuredClone(a.args), gas: a.gas, deposit: a.deposit_yocto } };
    if (a.type === 'add_function_call_key') return { type: 'AddKey', params: { publicKey: a.public_key,
      accessKey: { nonce: 0, permission: { receiverId: a.receiver_id, allowance: a.allowance_yocto, methodNames: [...a.method_names] } } } };
    throw fail();
  });
}

/** Verify the entire review and (for creation) pinned WASM before a claim is
 * consumed. `deviceKey` is public metadata, never a private key. */
export async function prepareNativeOracleSetupWalletPrompt(args = {}) {
  return prepareWalletPrompt(args, 'standard');
}
/** Experimental two-stage variant. Never invoke without a separately anchored one-shot claim. */
export async function prepareAtomicNativeOracleSetupWalletPrompt(args = {}) {
  return prepareWalletPrompt(args, 'atomic');
}
/** Research-only compressed variant. Not enabled by this export; the caller
 * still needs a separately anchored one-shot claim and real owner approval. */
export async function prepareCompressedNativeOracleSetupWalletPrompt(args = {}) {
  return prepareWalletPrompt(args, 'compressed');
}
async function prepareWalletPrompt({ wallet, review: rawReview, identity: rawIdentity, deviceKey: rawDevice,
  stageId, wasmBytes, loaderBytes, compressedBytes, location = globalThis.location, isTopLevel,
  crypto = globalThis.crypto, now = Date.now } = {}, mode = 'standard') {
  if (!wallet || typeof wallet.signAndSendTransaction !== 'function' || wallet.manifest?.features?.signAndSendTransaction !== true ||
      !crypto?.subtle || typeof now !== 'function' || isTopLevel !== true || typeof location?.origin !== 'string') throw fail();
  let origin;
  try {
    const url = new URL(location.origin); origin = url.origin;
    if (url.protocol !== 'https:' || origin !== location.origin || url.hostname === 'github.io' || url.hostname.endsWith('.github.io') ||
        url.hostname === 'madethis.website' || url.hostname.endsWith('.madethis.website')) throw Error();
  } catch { throw fail(); }
  const review = structuredClone(rawReview), identity = structuredClone(rawIdentity), device = structuredClone(rawDevice);
  const index = (mode === 'compressed' ? COMPRESSED_STAGES : mode === 'atomic' ? ATOMIC_STAGES : STAGES).indexOf(stageId);
  if (index < 0) throw fail();
  // Direct V9 remains blocked for Meteor. The separately enabled compressed
  // path checks its smaller pinned bytes below; real-wallet support is unproven.
  if (index === 0 && mode !== 'compressed') assertNativeOracleWalletDeployAvailable(wallet);
  const verify = mode === 'compressed' ? verifyCompressedNativeOracleSetupReview :
    mode === 'atomic' ? verifyAtomicNativeOracleSetupReview : verifyNativeOracleSetupReview;
  const canonical = await verify({ review, identity, deviceKey: device, origin, crypto });
  let code = null, compressed = null;
  if (index === 0) {
    const source = mode === 'compressed' ? loaderBytes : wasmBytes;
    if (!(source instanceof Uint8Array) || source.length !== (mode === 'compressed' ? LOADER_BYTES : WASM_BYTES)) throw fail();
    code = new Uint8Array(source);
    if (!same([...code.slice(0, 8)], [0, 97, 115, 109, 1, 0, 0, 0]) ||
        await digest(crypto, code) !== (mode === 'compressed' ? LOADER_SHA : WASM_SHA256)) throw fail();
    if (mode === 'compressed') {
      if (!(compressedBytes instanceof Uint8Array) || compressedBytes.length !== DEFLATE_BYTES) throw fail();
      compressed = new Uint8Array(compressedBytes);
      if (await digest(crypto, compressed) !== DEFLATE_SHA) throw fail();
    }
  }
  const stage = canonical.stages[index], actions = walletActions(stage, code, compressed); let invoked = false;
  return Object.freeze({
    stage_id: stageId, owner: review.owner, receiver_id: stage.receiver_id,
    async invoke(rawClaim) {
      if (invoked) throw fail();
      const claim = structuredClone(rawClaim), clock = now(), checked = Date.parse(claim?.preflight_checked_at);
      if (claim?.status !== 'PROMPT_CLAIMED_NO_HASH' || claim.independently_witnessed !== true || claim.do_not_retry !== true ||
          claim.execution_authorized !== false || claim.owner !== review.owner || claim.operation_id !== identity.operation_id ||
          claim.review_sha256 !== review.review_sha256 || claim.stage_id !== stageId ||
          claim.action_commitment_sha256 !== stage.action_commitment_sha256 || !GIT.test(claim.witness_head ?? '') ||
          !base58_32(claim.preflight_block_hash) || !Number.isSafeInteger(clock) || !Number.isSafeInteger(checked) ||
          clock < checked || clock - checked > 5000) throw fail();
      const localClaim = [origin, review.owner, identity.operation_id, stageId].join('|');
      if (locallyUsedClaims.has(localClaim)) throw fail();
      locallyUsedClaims.add(localClaim); invoked = true; // before any wallet code, including a synchronous throw
      let outcome;
      try { outcome = await wallet.signAndSendTransaction({ network: 'testnet', signerId: review.owner,
        receiverId: stage.receiver_id, actions: structuredClone(actions) }); }
      catch { return { status: 'WALLET_RESULT_UNKNOWN', do_not_retry: true, original_hash: null }; }
      const candidates = [outcome?.transaction?.hash, outcome?.transaction_outcome?.id].filter(x => x !== undefined);
      if (!candidates.length || candidates.some(x => !base58_32(x)) || new Set(candidates).size !== 1) {
        return { status: 'WALLET_RESULT_UNKNOWN', do_not_retry: true, original_hash: null };
      }
      return { status: 'ORIGINAL_HASH_RETURNED', original_hash: candidates[0], do_not_retry: true,
        final_execution_verified: false, independent_delivery_verified: false };
    },
  });
}
