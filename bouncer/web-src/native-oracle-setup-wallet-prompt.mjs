/**
 * Experimental, explicit one-shot wallet adapter for a REVIEWED native
 * testnet setup stage. The owner must individually approve each prompt.
 * Before use, a separately authenticated backend must verify prior original
 * receipt graphs and fresh state, commit a one-shot DB claim and obtain an
 * independent acknowledged witness. This module performs no automatic retry,
 * agent signing, RPC call, provider request or purchase, and is NOT connected
 * to the production UI. A wallet response is not FINAL receipt evidence.
 *
 * A compromised same-origin app, backend or wallet can bypass these checks;
 * a 5-second preflight can still race chain changes while the user approves.
 * Do not expose this until cross-flow fencing, recovery, device custody and
 * real-phone/wallet compatibility are complete and independently reviewed.
 */
import { isTestnetAccount } from './wallet-utils.mjs';

const STAGES = ['create_keyless_native_vault', 'configure_native_oracle_policy', 'fund_native_vault', 'install_native_oracle_agent'];
const HEX64 = /^[a-f0-9]{64}$/, HEX32 = /^[a-f0-9]{32}$/, GIT = /^[a-f0-9]{40}$/;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const WASM_BYTES = 452675, WASM_SHA256 = '835f0baa51d08ddf3af6812df0caefb93283480735a63e3d382073e04fbaf8ee';
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
function canonicalReview(review, identity, device, origin) {
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
      review.limitations.some(x => typeof x !== 'string' || !x || x.length > 512) ||
      device?.status !== 'LOCAL_DEVICE_KEY_AVAILABLE' || device.origin !== origin || device.owner !== review.owner || device.vault !== review.vault ||
      device.public_key !== review.agent_public_key || device.expected_public_key_matched !== true || device.private_key_exportable !== false ||
      device.local_storage_only !== true || device.signing_authorized !== false) throw fail();
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
function walletActions(stage, code) {
  return stage.actions.map(a => {
    if (a.type === 'create_account') return { type: 'CreateAccount' };
    if (a.type === 'transfer') return { type: 'Transfer', params: { deposit: a.deposit_yocto } };
    if (a.type === 'deploy_contract') return { type: 'DeployContract', params: { code: new Uint8Array(code) } };
    if (a.type === 'function_call') return { type: 'FunctionCall', params: { methodName: a.method,
      args: structuredClone(a.args), gas: a.gas, deposit: a.deposit_yocto } };
    if (a.type === 'add_function_call_key') return { type: 'AddKey', params: { publicKey: a.public_key,
      accessKey: { nonce: 0, permission: { receiverId: a.receiver_id, allowance: a.allowance_yocto, methodNames: [...a.method_names] } } } };
    throw fail();
  });
}

/** Verify the entire review and (for creation) pinned WASM before a claim is
 * consumed. `deviceKey` is public metadata, never a private key. */
export async function prepareNativeOracleSetupWalletPrompt({ wallet, review: rawReview, identity: rawIdentity, deviceKey: rawDevice,
  stageId, wasmBytes, location = globalThis.location, isTopLevel, crypto = globalThis.crypto, now = Date.now } = {}) {
  if (!wallet || typeof wallet.signAndSendTransaction !== 'function' || wallet.manifest?.features?.signAndSendTransaction !== true ||
      !crypto?.subtle || typeof now !== 'function' || isTopLevel !== true || typeof location?.origin !== 'string') throw fail();
  let origin;
  try {
    const url = new URL(location.origin); origin = url.origin;
    if (url.protocol !== 'https:' || origin !== location.origin || url.hostname === 'github.io' || url.hostname.endsWith('.github.io') ||
        url.hostname === 'madethis.website' || url.hostname.endsWith('.madethis.website')) throw Error();
  } catch { throw fail(); }
  const review = structuredClone(rawReview), identity = structuredClone(rawIdentity), device = structuredClone(rawDevice), index = STAGES.indexOf(stageId);
  if (index < 0) throw fail();
  const canonical = canonicalReview(review, identity, device, origin);
  if (await digest(crypto, bytes(JSON.stringify(canonical))) !== review.review_sha256) throw fail();
  let code = null;
  if (index === 0) {
    if (!(wasmBytes instanceof Uint8Array) || wasmBytes.length !== WASM_BYTES) throw fail();
    code = new Uint8Array(wasmBytes);
    if (!same([...code.slice(0, 8)], [0, 97, 115, 109, 1, 0, 0, 0]) || await digest(crypto, code) !== WASM_SHA256) throw fail();
  }
  const stage = canonical.stages[index], actions = walletActions(stage, code); let invoked = false;
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
