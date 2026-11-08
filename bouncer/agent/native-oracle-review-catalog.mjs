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

const OWNER = 'great_mujey.testnet', VAULT = `native.${OWNER}`;
const fail = () => new Error('NATIVE_REVIEW_UNAVAILABLE');
const HEX64 = /^[a-f0-9]{64}$/;
const PUBLIC_KEY = /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function createNativeOracleReviewCatalog({ wasmBytes, enableAtomic = false } = {}) {
  if (typeof enableAtomic !== 'boolean' || !(wasmBytes instanceof Uint8Array) || wasmBytes.length !== NATIVE_ORACLE_V9_BYTES ||
      crypto.createHash('sha256').update(wasmBytes).digest('hex') !== NATIVE_ORACLE_V9_SHA256) throw fail();
  const wasm = Buffer.from(wasmBytes);
  function build(agentPublicKey, ownerPublicKey, atomic) {
    if (typeof agentPublicKey !== 'string' || !PUBLIC_KEY.test(agentPublicKey) ||
        (atomic && (typeof ownerPublicKey !== 'string' || !PUBLIC_KEY.test(ownerPublicKey)))) throw fail();
    const terms = { owner: OWNER, vault: VAULT, policy_id: 'price', agent_public_key: agentPublicKey,
      per_tx_cap_yocto: '100000000000000000000000', daily_cap_yocto: '100000000000000000000000',
      vault_deposit_yocto: '100000000000000000000000', agent_gas_allowance_yocto: NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE };
    try { return atomic ? buildAtomicNativeOracleWalletPlan({ wasmBytes: wasm, terms, trustedOwnerPublicKey: ownerPublicKey }).review :
      buildNativeOracleWalletPlan({ wasmBytes: wasm, terms }).review; }
    catch { throw fail(); }
  }
  return Object.freeze({
    async create(input = {}) {
      const fields = enableAtomic ? ['agentPublicKey', 'ownerPublicKey'] : ['agentPublicKey'];
      if (!input || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== fields.length ||
          fields.some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key) ?? {}, 'value'))) throw fail();
      const review = build(input.agentPublicKey, input.ownerPublicKey, enableAtomic);
      return { task_id: review.review_sha256, review, signing_authorized: false, transaction_sent: false };
    },
    async getRetainedReview(taskId, agentPublicKey, ownerPublicKey) {
      if (typeof taskId !== 'string' || !HEX64.test(taskId) || typeof agentPublicKey !== 'string') return null;
      // Preserve recovery of an already reserved four-stage operation after an
      // opt-in update. An atomic ID additionally binds its owner public key.
      for (const atomic of enableAtomic ? [false, true] : [false]) {
        let review; try { review = build(agentPublicKey, ownerPublicKey, atomic); } catch { continue; }
        if (review.review_sha256 === taskId) return { review };
      }
      return null;
    },
  });
}
