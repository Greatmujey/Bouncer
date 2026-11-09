// Bundled once per fixed action by build-web.mjs. The resulting Vercel
// functions are disabled by default and contain no credentials or signers.
import { createVercelNativeMissionProxy } from '../agent/native-mission-proxy.mjs';
export default createVercelNativeMissionProxy({action: __BOUNCER_NATIVE_MISSION_ACTION__});
