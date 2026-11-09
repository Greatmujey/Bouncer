// Default-OFF server-to-server entrypoint. No browser origins are accepted.
import {createV14OriginalCheckpointHandler} from './v14-original-checkpoint-handler.mjs';
export {createV14OriginalCheckpointHandler} from './v14-original-checkpoint-handler.mjs';

if (typeof Deno!=='undefined') {
  Deno.serve(createV14OriginalCheckpointHandler({getEnv:key=>Deno.env.get(key),fetch:globalThis.fetch.bind(globalThis),crypto:globalThis.crypto}));
}
