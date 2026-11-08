/**
 * Deterministic reconstruction of the fixed, unsigned native testnet trial.
 * The task ID is the entire review SHA-256; callers also supply the public
 * agent key needed to reconstruct it. Nothing is retained in process memory,
 * so a restart or a different instance with identical pinned code and artifact
 * yields the same review. The ID is public, not an authorization or a secret.
 *
 * After reservation, the authenticated PostgreSQL/Git fences—not this
 * catalog—retain the operation, review and original hashes. A reconstructed
 * review is never evidence that no prompt occurred. Fresh owner challenges,
 * independent witnesses, on-chain preflights and reconciliation still apply.
 * Planner changes intentionally invalidate old unreserved IDs; a reviewed
 * and reserved plan remains in the durable fence. Limit public request rates
 * before exposing this experimental feature. No key, prompt, RPC or spend.
 */
import crypto from 'node:crypto';
import { buildNativeOracleWalletPlan, NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE, NATIVE_ORACLE_V9_BYTES,
  NATIVE_ORACLE_V9_SHA256 } from './native-oracle-wallet-plan.mjs';
import { buildAtomicNativeOracleWalletPlan } from './native-oracle-atomic-wallet.mjs';
import { buildResearchPhonePlan, NATIVE_PHONE_LOADER_BYTES, NATIVE_PHONE_LOADER_SHA256,
  NATIVE_PHONE_COMPRESSED_BYTES, NATIVE_PHONE_COMPRESSED_SHA256 } from './native-phone-loader-research.mjs';

const OWNER = 'great_mujey.testnet', VAULT = `native.${OWNER}`;
const fail = () => new Error('NATIVE_REVIEW_UNAVAILABLE');
const HEX64 = /^[a-f0-9]{64}$/;
const PUBLIC_KEY = /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function createNativeOracleReviewCatalog({ wasmBytes, loaderBytes, compressedBytes, enableAtomic = false, enableCompressed = false } = {}) {
  if (typeof enableAtomic !== 'boolean' || typeof enableCompressed !== 'boolean' ||
      !(wasmBytes instanceof Uint8Array) || wasmBytes.length !== NATIVE_ORACLE_V9_BYTES ||
      crypto.createHash('sha256').update(wasmBytes).digest('hex') !== NATIVE_ORACLE_V9_SHA256 ||
      (enableCompressed && (!(loaderBytes instanceof Uint8Array) || loaderBytes.length!==NATIVE_PHONE_LOADER_BYTES ||
        crypto.createHash('sha256').update(loaderBytes).digest('hex')!==NATIVE_PHONE_LOADER_SHA256 ||
        !(compressedBytes instanceof Uint8Array) || compressedBytes.length!==NATIVE_PHONE_COMPRESSED_BYTES ||
        crypto.createHash('sha256').update(compressedBytes).digest('hex')!==NATIVE_PHONE_COMPRESSED_SHA256))) throw fail();
  const wasm = Buffer.from(wasmBytes), compact=enableCompressed ? {loaderBytes:Buffer.from(loaderBytes),compressedBytes:Buffer.from(compressedBytes)} : null;
  function build(agentPublicKey, ownerPublicKey, mode) {
    if (typeof agentPublicKey !== 'string' || !PUBLIC_KEY.test(agentPublicKey) ||
        (mode !== 'standard' && (typeof ownerPublicKey !== 'string' || !PUBLIC_KEY.test(ownerPublicKey)))) throw fail();
    const terms = { owner: OWNER, vault: VAULT, policy_id: 'price', agent_public_key: agentPublicKey,
      per_tx_cap_yocto: '100000000000000000000000', daily_cap_yocto: '100000000000000000000000',
      vault_deposit_yocto: '100000000000000000000000', agent_gas_allowance_yocto: NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE };
    try { return mode === 'compressed' ? buildResearchPhonePlan({wasmBytes:wasm,...compact,terms,trustedOwnerPublicKey:ownerPublicKey}).review :
      mode === 'atomic' ? buildAtomicNativeOracleWalletPlan({ wasmBytes: wasm, terms, trustedOwnerPublicKey: ownerPublicKey }).review :
      buildNativeOracleWalletPlan({ wasmBytes: wasm, terms }).review; }
    catch { throw fail(); }
  }
  return Object.freeze({
    async create(input = {}) {
      const fields = enableAtomic || enableCompressed ? ['agentPublicKey', 'ownerPublicKey'] : ['agentPublicKey'];
      if (!input || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== fields.length ||
          fields.some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key) ?? {}, 'value'))) throw fail();
      const review = build(input.agentPublicKey, input.ownerPublicKey, enableCompressed ? 'compressed' : enableAtomic ? 'atomic' : 'standard');
      return { task_id: review.review_sha256, review, signing_authorized: false, transaction_sent: false };
    },
    async getRetainedReview(taskId, agentPublicKey, ownerPublicKey) {
      if (typeof taskId !== 'string' || !HEX64.test(taskId) || typeof agentPublicKey !== 'string') return null;
      // Preserve recovery of an already reserved four-stage operation after an
      // opt-in update. An atomic ID additionally binds its owner public key.
      const modes=['standard',...(enableAtomic?['atomic']:[]),...(enableCompressed?['compressed']:[])];
      for (const mode of modes) {
        let review; try { review = build(agentPublicKey, ownerPublicKey, mode); } catch { continue; }
        if (review.review_sha256 === taskId) return { review };
      }
      return null;
    },
  });
}
