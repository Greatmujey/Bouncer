/** Temporary Arena preview backend; no private wallet keys or transaction broadcaster. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createPostgresWalletPromptAuth, initializePostgresWalletPromptAuth } from '../agent/postgres-wallet-prompt-auth.mjs';
import { createPostgresWalletPromptFence, initializePostgresWalletPromptFence } from '../agent/postgres-wallet-prompt-fence.mjs';
import { createGitBranchWitnessStore } from '../agent/git-branch-witness-store.mjs';
import { createWalletPromptWitness } from '../agent/git-wallet-prompt-witness.mjs';
import { createWitnessedWalletSetup } from '../agent/witnessed-wallet-setup.mjs';
import { createAuthenticatedWitnessedSetupService } from '../agent/authenticated-witnessed-setup-service.mjs';
import { createWitnessedSetupHttpHandler } from '../agent/witnessed-setup-http.mjs';
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
if (!wasmPath || !signPath || !decryptPath || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('pinned V12 artifact and valid port required');
const wasm = fs.readFileSync(wasmPath);
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
// This switch is deliberately off by default. It exposes authenticated,
// independently witnessed testnet setup claims but still never signs or
// broadcasts; it does NOT configure policy, purchase or prove delivery.
let setupFactory;
if (process.env.BOUNCER_ENABLE_WITNESSED_TESTNET_SETUP === '1') {
  const url = process.env.BOUNCER_TESTNET_SETUP_DATABASE_URL, anchor = process.env.BOUNCER_TESTNET_WITNESS_ANCHOR;
  if (!url || !/^[a-f0-9]{40}$/.test(anchor ?? '')) throw Error('dedicated testnet database and independently retained Git witness anchor required');
  const pool = new pg.Pool({ connectionString:url, max:8, connectionTimeoutMillis:5000 });
  await initializePostgresWalletPromptAuth({ pool });
  await initializePostgresWalletPromptFence({ pool });
  const auth = createPostgresWalletPromptAuth({ pool, origin:siteOrigin, provider });
  const fence = createPostgresWalletPromptFence({ pool, authenticate:auth.authenticate, setupWasmBytes:wasm,
    setupPreflightProvider:provider, setupReceiptProvider:provider });
  const store = createGitBranchWitnessStore({ repo:fileURLToPath(new URL('../../', import.meta.url)),
    branch:'arena/0ee9ab70-near-hub', initialHead:anchor });
  const witness = createWalletPromptWitness({ store }), coordinator = createWitnessedWalletSetup({ fence, witness });
  setupFactory = ({ getRetainedReview }) => {
    const owner = 'great_mujey.testnet';
    const setup = createAuthenticatedWitnessedSetupService({ auth, fence, witness, coordinator, getRetainedReview,
      setupWasmBytes:wasm, setupReceiptProvider:provider, owner });
    return createWitnessedSetupHttpHandler({ service:setup, siteOrigin, wasmBytes:wasm, owner });
  };
}
const service = createReadOnlyPreviewService({ bridge, siteOrigin, relayUrl, setupFactory,
  inspectOwnerKey: input => inspectReadOnlyOwnerKey({ ...input, provider }),
  inspectReadiness: () => inspectBufferWalletReadiness({ owner: 'great_mujey.testnet', vault: 'vault.great_mujey.testnet', provider }),
  makeReview: snapshot => buildBufferWalletSetup({ snapshot, wasmBytes: wasm }).review,
});
service.listen(port, '0.0.0.0', () => console.log(`Testnet preview backend listening on port ${port}; wallet signing and broadcast remain external.`));
