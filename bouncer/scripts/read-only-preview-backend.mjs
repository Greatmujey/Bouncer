/** Temporary Arena preview backend; no signer, transactions or production use. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { ReadOnlyNearReceiptProvider } from '../agent/read-only-near-receipts.mjs';
import { createVercelOidcVerifier, createOidcReadOnlyRpcBridge } from '../agent/oidc-readonly-rpc-bridge.mjs';
import { inspectBufferWalletReadiness } from '../agent/buffer-wallet-readiness.mjs';
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
const service = createReadOnlyPreviewService({ bridge, siteOrigin, relayUrl,
  inspectReadiness: () => inspectBufferWalletReadiness({ owner: 'great_mujey.testnet', vault: 'vault.great_mujey.testnet', provider }),
  makeReview: snapshot => buildBufferWalletSetup({ snapshot, wasmBytes: wasm }).review,
});
service.listen(port, '0.0.0.0', () => console.log(`Read-only wallet readiness backend listening on port ${port}. No signer or transaction route.`));
