// Default-OFF entrypoint; see v14-mission-journal-backup-handler.mjs.
import {createV14MissionJournalBackupHandler} from './v14-mission-journal-backup-handler.mjs';
if(typeof Deno!=='undefined') {
  Deno.serve(createV14MissionJournalBackupHandler({getEnv:key=>Deno.env.get(key),
    fetch:globalThis.fetch.bind(globalThis),crypto:globalThis.crypto}));
}
