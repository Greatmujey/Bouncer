// Vercel Node.js Function entry. The project ID is public client configuration;
// no wallet key, pairing URI, session state or transaction is stored here.
import { createRelayBridge } from './relay-bridge.mjs';
export default createRelayBridge({ projectId: process.env.BOUNCER_WALLETCONNECT_PROJECT_ID });
