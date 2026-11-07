import { getVercelOidcToken } from '@vercel/oidc';
import { createEncryptedBrowserRelayHandler } from '../core.mjs';
import { PREVIEW_SIGNING_PUBLIC_KEY, PREVIEW_ENCRYPTION_PUBLIC_KEY } from '../session-public-keys.mjs';

// Exact origins and public keys are deployment configuration, not request data.
const handler = createEncryptedBrowserRelayHandler({
  callbackOrigin: process.env.BOUNCER_RELAY_CALLBACK_ORIGIN,
  siteOrigin: process.env.BOUNCER_RELAY_SITE_ORIGIN,
  signingPublicKey: PREVIEW_SIGNING_PUBLIC_KEY,
  encryptionPublicKey: PREVIEW_ENCRYPTION_PUBLIC_KEY,
  getToken: getVercelOidcToken,
});
export default handler;
