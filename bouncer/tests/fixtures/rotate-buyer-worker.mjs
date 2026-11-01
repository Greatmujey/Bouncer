// Test-only fault worker: PostgreSQL is real; no NEAR or seller is contacted.
import pg from 'pg';
import { openPostgresBuyerJournal } from '../../agent/postgres-buyer-journal.mjs';

const base = new pg.Pool({ connectionString: process.env.BOUNCER_TEST_POSTGRES_URL, max: 1 });
const intercepted = { async connect() {
  const client = await base.connect();
  return { on: client.on.bind(client), removeListener: client.removeListener.bind(client), release: client.release.bind(client),
    async query(sql, args) {
      const result = await client.query(sql, args);
      if (typeof sql === 'string' && sql.includes('UPDATE bouncer_buyer_v1.journals SET key_check')) {
        process.send?.({ type: 'staged-before-commit' });
        await new Promise(() => {}); // parent SIGKILLs this process inside the transaction
      }
      return result;
    } };
} };
let journal;
try {
  journal = await openPostgresBuyerJournal({ pool: intercepted, contractId: 'bouncer.testnet',
    ownerAccountId: process.env.BOUNCER_TEST_OWNER, journalId: process.env.BOUNCER_TEST_JOURNAL,
    key: Buffer.from(process.env.BOUNCER_TEST_OLD_KEY, 'hex') });
  await journal.rotateEncryptionKey(Buffer.from(process.env.BOUNCER_TEST_NEW_KEY, 'hex'));
  process.send?.({ type: 'unexpected-completion' });
} catch (error) { process.send?.({ type: 'error', message: error.message }); }
finally { if (journal) await journal.close(); await base.end(); process.disconnect?.(); }
