/** Temporary Arena preview backend; no private wallet keys or transaction broadcaster. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import { createIndependentSetupCheckpointClient } from '../agent/independent-setup-checkpoint.mjs';
import { createExperimentalPhoneSetupRuntime } from '../agent/experimental-phone-setup-runtime.mjs';
import { readProtectedCheckpointToken } from '../agent/protected-checkpoint-token.mjs';
import { ReadOnlyNearReceiptProvider } from '../agent/read-only-near-receipts.mjs';
import { createVercelOidcVerifier, createOidcReadOnlyRpcBridge } from '../agent/oidc-readonly-rpc-bridge.mjs';
import { inspectBufferWalletReadiness } from '../agent/buffer-wallet-readiness.mjs';
import { inspectReadOnlyOwnerKey } from '../agent/read-only-owner-key.mjs';
import { buildBufferWalletSetup } from '../agent/buffer-wallet-setup-plan.mjs';
import { createReadOnlyPreviewService } from '../agent/read-only-preview-service.mjs';
import { PREVIEW_SIGNING_PUBLIC_KEY, PREVIEW_ENCRYPTION_PUBLIC_KEY } from '../testnet-relay/session-public-keys.mjs';

const callbackOrigin = process.env.BOUNCER_RELAY_CALLBACK_ORIGIN;
const siteOrigin = process.env.BOUNCER_RELAY_SITE_ORIGIN;
const deploymentId = process.env.BOUNCER_RELAY_DEPLOYMENT_ID;
const environment = process.env.BOUNCER_RELAY_ENVIRONMENT || 'preview';
const wasmPath = process.env.BOUNCER_V12_WASM_PATH;
const signPath = process.env.BOUNCER_RELAY_SIGNING_KEY_PATH, decryptPath = process.env.BOUNCER_RELAY_ENCRYPTION_KEY_PATH;
const relayUrl = 'https://bouncer-testnet-readonly-relay-tau.vercel.app/api/read';
const port = Number(process.env.PORT || 8787);
if (!signPath || !decryptPath || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('relay keys and valid port required');
// V12 is optional for a native-only preview. Without it, FT review is
// unavailable rather than being fabricated or made a native prerequisite.
const wasm = wasmPath ? fs.readFileSync(wasmPath) : null;
const signingPrivateKey = fs.readFileSync(signPath), encryptionPrivateKey = fs.readFileSync(decryptPath);
const pub = privatePem => crypto.createPublicKey(crypto.createPrivateKey(privatePem)).export({ type: 'spki', format: 'pem' }).toString();
if (pub(signingPrivateKey) !== PREVIEW_SIGNING_PUBLIC_KEY || pub(encryptionPrivateKey) !== PREVIEW_ENCRYPTION_PUBLIC_KEY) {
  throw new Error('private relay session keys do not match the pinned public keys');
}
const jwks = JSON.parse(fs.readFileSync(new URL('../testnet-relay/oidc-jwks.team.json', import.meta.url), 'utf8'));
const owner = 'abdullahimujeeb0505-stacks-projects', project = 'bouncer-testnet-readonly-relay';
const verifyOidc = createVercelOidcVerifier({ jwks, issuer: `https://oidc.vercel.com/${owner}`,
  owner, ownerId: 'team_YRcHELn1K0MpXnck7nB7iWnM', project, projectId: 'prj_RuieThB12QLdmAEBR0V9hmsubM7h',
  deploymentId, environment });
const bridge = createOidcReadOnlyRpcBridge({ callbackOrigin, defaultAudience: `https://vercel.com/${owner}`, verifyOidc, signingPrivateKey, encryptionPrivateKey });
const provider = new ReadOnlyNearReceiptProvider('https://test.rpc.fastnear.com', { fetchImpl: bridge.fetch, timeoutMs: 25_000 });
// Both transports are OFF by default. Even when explicitly enabled, this is
// experimental testnet plumbing, not a spending-ready or deployed service.
// Reconstructed reviews are not independent backups, and browser storage
// can be lost or rolled back. The independently anchored witness is required;
// never infer from a missing record that a wallet prompt or trial did not happen.
const enableBuffer = process.env.BOUNCER_ENABLE_WITNESSED_TESTNET_SETUP === '1';
const enableNative = process.env.BOUNCER_ENABLE_NATIVE_ORACLE_TESTNET_SETUP === '1';
const enableNativeTrial = process.env.BOUNCER_ENABLE_NATIVE_ORACLE_TESTNET_TRIAL === '1';
const enableNativeAtomic = process.env.BOUNCER_ENABLE_NATIVE_ORACLE_ATOMIC_SETUP === '1';
const enableNativeCompressed = process.env.BOUNCER_ENABLE_NATIVE_ORACLE_COMPRESSED_SETUP === '1';
if ((enableNativeTrial || enableNativeAtomic || enableNativeCompressed) && !enableNative) throw Error('native testnet trial and shorter setups require the native setup runtime');
let setupFactory, nativeSetupFactory, setupPool;
if (enableBuffer || enableNative) {
  const env = process.env, url = env.BOUNCER_TESTNET_SETUP_DATABASE_URL;
  const repo = env.BOUNCER_TESTNET_WITNESS_GIT_REPO, branch = env.BOUNCER_TESTNET_WITNESS_BRANCH;
  const initialHead = env.BOUNCER_TESTNET_WITNESS_BASELINE, checkpointOrigin = env.BOUNCER_TESTNET_CHECKPOINT_ORIGIN;
  if (env.BOUNCER_ACK_EXPERIMENTAL_SETUP !== 'testnet-transport-only' || !url ||
      typeof repo !== 'string' || !path.isAbsolute(repo) || typeof branch !== 'string' ||
      !/^[a-f0-9]{40}$/.test(initialHead ?? '') || (enableBuffer && !wasm)) {
    throw Error('explicit experimental acknowledgement, dedicated testnet database, configured Git baseline and artifacts required');
  }
  const token = readProtectedCheckpointToken(env.BOUNCER_TESTNET_CHECKPOINT_TOKEN_FILE);
  const anchor = createIndependentSetupCheckpointClient({ origin:checkpointOrigin, token });
  try {
    setupPool = new pg.Pool({ connectionString:url, max:8, connectionTimeoutMillis:5000 });
    const nativeWasmBytes = enableNative ? fs.readFileSync(new URL('../../bouncer.wasm', import.meta.url)) : undefined;
    const nativeLoaderBytes = enableNativeCompressed ? fs.readFileSync(new URL('../contracts/native-phone-loader/fixtures/native-phone-loader-research.wasm',import.meta.url)) : undefined;
    const nativeCompressedBytes = enableNativeCompressed ? fs.readFileSync(new URL('../contracts/native-phone-loader/fixtures/native-v9.deflate',import.meta.url)) : undefined;
    const runtime = await createExperimentalPhoneSetupRuntime({ pool:setupPool, siteOrigin, provider, anchor, repo, branch, initialHead,
      nativeWasmBytes, nativeLoaderBytes, nativeCompressedBytes, bufferWasmBytes:wasm ?? undefined,
      enableNative, enableBuffer, enableNativeTrial, enableNativeAtomic, enableNativeCompressed });
    ({ setupFactory, nativeSetupFactory } = runtime);
  } catch {
    if (setupPool) await setupPool.end().catch(() => {});
    throw Error('experimental setup unavailable; no schema or checkpoint was provisioned or repaired');
  }
}
const service = createReadOnlyPreviewService({ bridge, siteOrigin, relayUrl, setupFactory, nativeSetupFactory,
  inspectOwnerKey: input => inspectReadOnlyOwnerKey({ ...input, provider }),
  inspectReadiness: () => {
    if (!wasm) throw Error('FT review unavailable without the pinned V12 artifact');
    return inspectBufferWalletReadiness({ owner: 'great_mujey.testnet', vault: 'vault.great_mujey.testnet', provider });
  },
  makeReview: snapshot => buildBufferWalletSetup({ snapshot, wasmBytes: wasm }).review,
});
service.listen(port, '0.0.0.0', () => console.log(`Testnet preview backend listening on port ${port}; wallet signing and broadcast remain external.`));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  service.close(() => { void setupPool?.end().finally(() => process.exit(0)); if (!setupPool) process.exit(0); });
});
