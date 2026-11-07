import { getVercelOidcToken } from '@vercel/oidc';
import { createReadOnlyRelayHandler } from '../core.mjs';

// Exact origins are deployment configuration, not request parameters.
const handler = createReadOnlyRelayHandler({
  callbackOrigin: process.env.BOUNCER_RELAY_CALLBACK_ORIGIN,
  siteOrigin: process.env.BOUNCER_RELAY_SITE_ORIGIN,
  getToken: getVercelOidcToken,
});
export default handler;
