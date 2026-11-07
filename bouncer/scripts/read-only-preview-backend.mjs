/** Temporary Arena preview backend; no signer, transactions or production use. */
import fs from 'node:fs';
import { ReadOnlyNearReceiptProvider } from '../agent/read-only-near-receipts.mjs';
import { createVercelOidcVerifier, createOidcReadOnlyRpcBridge } from '../agent/oidc-readonly-rpc-bridge.mjs';
import { inspectBufferWalletReadiness } from '../agent/buffer-wallet-readiness.mjs';
import { buildBufferWalletSetup } from '../agent/buffer-wallet-setup-plan.mjs';
import { createReadOnlyPreviewService } from '../agent/read-only-preview-service.mjs';

const callbackOrigin = process.env.BOUNCER_RELAY_CALLBACK_ORIGIN;
const siteOrigin = process.env.BOUNCER_RELAY_SITE_ORIGIN;
const deploymentId = process.env.BOUNCER_RELAY_DEPLOYMENT_ID;
const environment = process.env.BOUNCER_RELAY_ENVIRONMENT || 'preview';
const wasmPath = process.env.BOUNCER_V12_WASM_PATH;
const port = Number(process.env.PORT || 8787);
if (!wasmPath || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('pinned V12 artifact and valid port required');
const wasm = fs.readFileSync(wasmPath);
const jwks = JSON.parse(fs.readFileSync(new URL('../testnet-relay/oidc-jwks.team.json', import.meta.url), 'utf8'));
const owner = 'abdullahimujeeb0505-stacks-projects', project = 'bouncer-testnet-readonly-relay';
const verifyOidc = createVercelOidcVerifier({ jwks, issuer: `https://oidc.vercel.com/${owner}`,
  owner, ownerId: 'team_YRcHELn1K0MpXnck7nB7iWnM', project, projectId: 'prj_RuieThB12QLdmAEBR0V9hmsubM7h',
  deploymentId, environment });
const bridge = createOidcReadOnlyRpcBridge({ callbackOrigin, defaultAudience: `https://vercel.com/${owner}`, verifyOidc });
const provider = new ReadOnlyNearReceiptProvider('https://test.rpc.fastnear.com', { fetchImpl: bridge.fetch, timeoutMs: 25_000 });
const service = createReadOnlyPreviewService({ bridge, siteOrigin,
  inspectReadiness: () => inspectBufferWalletReadiness({ owner: 'great_mujey.testnet', vault: 'vault.great_mujey.testnet', provider }),
  makeReview: snapshot => buildBufferWalletSetup({ snapshot, wasmBytes: wasm }).review,
});
service.listen(port, '0.0.0.0', () => console.log(`Read-only wallet readiness backend listening on port ${port}. No signer or transaction route.`));
