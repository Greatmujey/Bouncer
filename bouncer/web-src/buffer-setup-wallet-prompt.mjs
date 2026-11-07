/**
 * Browser-side one-shot wallet adapter for the three reviewed Buffer testnet
 * setup stages. The backend must authenticate the owner, perform fresh
 * same-block checks, and independently witness the claim BEFORE `invoke`.
 * This module never creates a seller order, stores a key, signs autonomously,
 * retries a wallet call, or treats an outcome as proof of FINAL execution.
 * A wallet request is NOT consent until the owner actually approves it.
 */
import { isTestnetAccount } from './wallet-utils.mjs';

const STAGES = ['create_keyless_vault', 'register_vault_circle', 'fund_vault_circle'];
const TOKEN = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
const SELLER = 'buffer-john-desk.testnet';
const WASM_SHA256 = '033f255c5822ff97495809f7d60fddf66f266f20c36285fe71296b66decc6d12';
const WASM_BYTES = 536651;
const WASM_NEAR_HASH = 'Dg53QzTrw3cDWdgYTptmpkqvoeUpSXQsxL5HLcoF6Cq';
const VAULT_DEPOSIT = '6000000000000000000000000';
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const HEX64 = /^[a-f0-9]{64}$/, HEX32 = /^[a-f0-9]{32}$/, GIT = /^[a-f0-9]{40}$/;
const fail = () => new Error('BUFFER_SETUP_PROMPT_UNAVAILABLE');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const digest = async (crypto, bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map(byte => byte.toString(16).padStart(2, '0')).join('');
const bytes = value => new TextEncoder().encode(value);
function txHash(value) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) return false;
  let n = 0n;
  for (const char of value) { const digit = BASE58.indexOf(char); if (digit < 0) return false; n = n * 58n + BigInt(digit); }
  let length = 0; while (n > 0n) { n >>= 8n; length++; }
  let leading = 0; while (value[leading] === '1') leading++;
  return leading + length === 32;
}
function stageActions(review, stageId) {
  const { owner, vault } = review;
  if (stageId === STAGES[0]) return [
    { type: 'create_account' },
    { type: 'transfer', deposit_yocto: VAULT_DEPOSIT },
    { type: 'deploy_contract', bytes: WASM_BYTES, sha256: WASM_SHA256, near_code_hash: WASM_NEAR_HASH },
    { type: 'function_call', method: 'new', args: { owner }, gas: '30000000000000', deposit_yocto: '0' },
  ];
  if (stageId === STAGES[1]) {
    const amount = review.stages?.[1]?.actions?.[0]?.deposit_yocto;
    if (typeof amount !== 'string' || !/^[1-9][0-9]{0,22}$/.test(amount) || BigInt(amount) > 10n ** 22n) throw fail();
    return [{ type: 'function_call', method: 'storage_deposit', args: { account_id: vault, registration_only: true },
      gas: '50000000000000', deposit_yocto: amount }];
  }
  if (stageId === STAGES[2]) return [{ type: 'function_call', method: 'ft_transfer_call',
    args: { receiver_id: vault, amount: '20000000', msg: '' }, gas: '300000000000000', deposit_yocto: '1' }];
  throw fail();
}
function validateReview(review, identity, stageId) {
  const index = STAGES.indexOf(stageId), stage = review?.stages?.[index], tracked = identity?.stages?.[index];
  if (index < 0 || review?.format !== 'bouncer-buffer-wallet-setup-review-v1' || review.network !== 'testnet' ||
      !isTestnetAccount(review.owner) || review.owner !== identity?.owner || review.vault !== `vault.${review.owner}` ||
      review.token !== TOKEN || review.seller !== SELLER || review.fixed_product !== 'weekly-market-brief' ||
      review.fixed_product_price_atoms !== '20000000' || review.vault_wasm_sha256 !== WASM_SHA256 ||
      review.vault_wasm_near_hash !== WASM_NEAR_HASH || review.signing_or_broadcast_authorized !== false ||
      review.wallet_approval_obtained !== false || !HEX64.test(review.review_sha256 ?? '') ||
      identity.review_sha256 !== review.review_sha256 || !HEX32.test(identity.operation_id ?? '') ||
      typeof identity.owner_public_key !== 'string' || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(identity.owner_public_key) ||
      !Array.isArray(review.stages) || review.stages.length !== 3 || !Array.isArray(identity.stages) || identity.stages.length !== 3 ||
      review.stages.some((s, i) => s?.id !== STAGES[i] || identity.stages[i]?.stage_id !== STAGES[i] ||
        !HEX64.test(s.action_commitment_sha256 ?? '') || identity.stages[i].action_commitment_sha256 !== s.action_commitment_sha256) ||
      stage.signer_id !== review.owner || stage.receiver_id !== (index === 0 ? review.vault : TOKEN) ||
      tracked.action_commitment_sha256 !== stage.action_commitment_sha256 || !equal(stage.actions, stageActions(review, stageId))) throw fail();
  return { index, stage };
}

/** Prefetch and verify the large V12 bytes BEFORE claiming the prompt, so
 * mobile transfer size does not consume the short post-preflight window. */
export async function prepareBufferSetupWalletPrompt({ wallet, review: rawReview, identity: rawIdentity, stageId,
  wasmBytes, crypto = globalThis.crypto, now = Date.now } = {}) {
  if (!wallet || typeof wallet.signAndSendTransaction !== 'function' || wallet.manifest?.features?.signAndSendTransaction !== true ||
      !crypto?.subtle || typeof now !== 'function') throw fail();
  const review = structuredClone(rawReview), identity = structuredClone(rawIdentity);
  const { index, stage } = validateReview(review, identity, stageId);
  const unsigned = { ...review }; delete unsigned.review_sha256;
  if (await digest(crypto, bytes(JSON.stringify(unsigned))) !== review.review_sha256) throw fail();
  let code = null;
  if (index === 0) {
    if (!(wasmBytes instanceof Uint8Array) || wasmBytes.length !== WASM_BYTES) throw fail();
    code = new Uint8Array(wasmBytes);
    if (!equal([...code.slice(0, 8)], [0, 97, 115, 109, 1, 0, 0, 0]) || await digest(crypto, code) !== WASM_SHA256) throw fail();
  }
  const actions = stage.actions.map(a => {
    if (a.type === 'create_account') return { type: 'CreateAccount' };
    if (a.type === 'transfer') return { type: 'Transfer', params: { deposit: a.deposit_yocto } };
    if (a.type === 'deploy_contract') return { type: 'DeployContract', params: { code: new Uint8Array(code) } };
    if (a.type === 'function_call') return { type: 'FunctionCall', params: { methodName: a.method,
      args: structuredClone(a.args), gas: a.gas, deposit: a.deposit_yocto } };
    throw fail();
  });
  let invoked = false;
  return Object.freeze({
    stage_id: stageId, owner: review.owner, receiver_id: stage.receiver_id,
    /** This is the sole wallet invocation. A rejected/unknown response stays
     * unresolved, even if the wallet claims the owner rejected; never retry. */
    async invoke(rawClaim) {
      if (invoked) throw fail();
      const claim = structuredClone(rawClaim), clock = now(), checked = Date.parse(claim?.preflight_checked_at);
      if (claim?.status !== 'PROMPT_CLAIMED_NO_HASH' || claim.independently_witnessed !== true ||
          claim.do_not_retry !== true || claim.execution_authorized !== false || claim.owner !== review.owner ||
          claim.operation_id !== identity.operation_id || claim.review_sha256 !== review.review_sha256 || claim.stage_id !== stageId ||
          claim.action_commitment_sha256 !== stage.action_commitment_sha256 || !GIT.test(claim.witness_head ?? '') ||
          !txHash(claim.preflight_block_hash) || !Number.isSafeInteger(clock) || !Number.isSafeInteger(checked) ||
          clock < checked || clock - checked > 5_000) throw fail();
      invoked = true; // set before any wallet code, including synchronous throws
      let outcome;
      try { outcome = await wallet.signAndSendTransaction({ network: 'testnet', signerId: review.owner,
        receiverId: stage.receiver_id, actions: structuredClone(actions) }); }
      catch { return { status: 'WALLET_RESULT_UNKNOWN', do_not_retry: true, original_hash: null }; }
      const candidates = [outcome?.transaction?.hash, outcome?.transaction_outcome?.id].filter(x => x !== undefined);
      if (!candidates.length || candidates.some(x => !txHash(x)) || new Set(candidates).size !== 1) {
        return { status: 'WALLET_RESULT_UNKNOWN', do_not_retry: true, original_hash: null };
      }
      return { status: 'ORIGINAL_HASH_RETURNED', original_hash: candidates[0], do_not_retry: true,
        final_execution_verified: false, independent_delivery_verified: false };
    },
  });
}
