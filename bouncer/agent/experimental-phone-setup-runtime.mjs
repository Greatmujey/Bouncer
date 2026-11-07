/**
 * Wiring for the opt-in testnet phone setup prototype. All durable schemas
 * and the independent latest-head checkpoint must ALREADY exist. This module
 * neither provisions nor repairs them and never signs or broadcasts.
 *
 * Startup inspection is not proof of an independently operated checkpoint,
 * an unrolled-back database, owner consent, device-key custody, provider
 * delivery or a safe lock release. Native pre-reservation reviews are
 * reconstructed from pinned code and a public key, not independently retained;
 * the native UI is not mounted. Do not use this for real spending or deploy
 * it as a production service without independent review and recovery work.
 */
import { createAnchoredSetupWitnessPair } from './anchored-setup-witness-pair.mjs';
import { createPostgresWalletPromptAuth, inspectPostgresWalletPromptAuthSchema } from './postgres-wallet-prompt-auth.mjs';
import { createPostgresWalletPromptFence, inspectPostgresWalletPromptFenceSchema } from './postgres-wallet-prompt-fence.mjs';
import { createPostgresNativeOraclePromptFence, inspectPostgresNativeOraclePromptFenceSchema } from './postgres-native-oracle-prompt-fence.mjs';
import { createWitnessedWalletSetup } from './witnessed-wallet-setup.mjs';
import { createWitnessedNativeOracleSetup } from './witnessed-native-oracle-wallet-setup.mjs';
import { createAuthenticatedWitnessedSetupService } from './authenticated-witnessed-setup-service.mjs';
import { createAuthenticatedNativeOracleSetupService } from './authenticated-native-oracle-setup-service.mjs';
import { createWitnessedSetupHttpHandler } from './witnessed-setup-http.mjs';
import { createNativeOracleSetupHttpHandler } from './native-oracle-setup-http.mjs';
import { createNativeOracleReviewCatalog } from './native-oracle-review-catalog.mjs';

const OWNER = 'great_mujey.testnet';
const validCheckpoint = value => value && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).length === 2 && Object.hasOwn(value, 'head') && Object.hasOwn(value, 'revision') &&
  typeof value.head === 'string' && /^[a-f0-9]{40}$/.test(value.head) &&
  typeof value.revision === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value.revision);
const sameCheckpoint = (a, b) => validCheckpoint(a) && validCheckpoint(b) && a.head === b.head && a.revision === b.revision;
const fail = () => new Error('experimental setup unavailable: preprovisioned schemas and the separately retained current witness head are required');

export async function createExperimentalPhoneSetupRuntime({ pool, siteOrigin, provider, anchor, repo, branch, initialHead,
  nativeWasmBytes, bufferWasmBytes, enableNative = false, enableBuffer = false } = {}) {
  if (typeof enableNative !== 'boolean' || typeof enableBuffer !== 'boolean' || (!enableNative && !enableBuffer) ||
      !pool || typeof pool.connect !== 'function' || !anchor || typeof anchor.read !== 'function' ||
      typeof anchor.compareAndSet !== 'function') throw fail();

  // Both flows share the same irreversible owner fence even when only one UI
  // is enabled. Never silently recreate a missing opposite-flow schema.
  await inspectPostgresWalletPromptAuthSchema({ pool });
  await inspectPostgresWalletPromptFenceSchema({ pool });
  await inspectPostgresNativeOraclePromptFenceSchema({ pool });

  const before = await anchor.read();
  if (!validCheckpoint(before)) throw fail();
  const pair = createAnchoredSetupWitnessPair({ repo, branch, initialHead, anchor });
  const wallet = await pair.wallet.inspect(OWNER), native = await pair.native.inspect(OWNER);
  const after = await anchor.read();
  if (!sameCheckpoint(before, after) || wallet.head !== before.head || native.head !== before.head) throw fail();
  // This is a startup stop, not a release, consent check or missing-history
  // inference. Existing witness records remain available for reconciliation.

  const auth = createPostgresWalletPromptAuth({ pool, origin: siteOrigin, provider });
  let setupFactory, nativeSetupFactory;
  if (enableBuffer) {
    const fence = createPostgresWalletPromptFence({ pool, authenticate: auth.authenticate, setupWasmBytes: bufferWasmBytes,
      setupPreflightProvider: provider, setupReceiptProvider: provider });
    const coordinator = createWitnessedWalletSetup({ fence, witness: pair.wallet, otherWitness: pair.native });
    setupFactory = ({ getRetainedReview } = {}) => {
      const service = createAuthenticatedWitnessedSetupService({ auth, fence, witness: pair.wallet, coordinator, getRetainedReview,
        setupWasmBytes: bufferWasmBytes, setupReceiptProvider: provider, owner: OWNER });
      return createWitnessedSetupHttpHandler({ service, siteOrigin, wasmBytes: bufferWasmBytes, owner: OWNER });
    };
  }
  if (enableNative) {
    const fence = createPostgresNativeOraclePromptFence({ pool, authenticate: auth.authenticate, wasmBytes: nativeWasmBytes,
      receiptProvider: provider, preflightProvider: provider });
    const coordinator = createWitnessedNativeOracleSetup({ fence, witness: pair.native, otherWitness: pair.wallet });
    const catalog = createNativeOracleReviewCatalog({ wasmBytes: nativeWasmBytes });
    const service = createAuthenticatedNativeOracleSetupService({ auth, fence, witness: pair.native, otherWitness: pair.wallet,
      coordinator, getRetainedReview: catalog.getRetainedReview, wasmBytes: nativeWasmBytes, receiptProvider: provider, owner: OWNER });
    const handler = createNativeOracleSetupHttpHandler({ service, siteOrigin, wasmBytes: nativeWasmBytes,
      owner: OWNER, createReview: catalog.create });
    nativeSetupFactory = () => handler;
  }
  return Object.freeze({ setupFactory, nativeSetupFactory, ready_for_real_spending: false,
    scope: 'experimental testnet transport only; no provisioning, wallet consent, broadcast, purchase or delivery' });
}
