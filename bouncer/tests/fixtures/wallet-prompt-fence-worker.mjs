// Synthetic cross-process PostgreSQL fence probe. No wallet, secrets or chain.
import pg from 'pg';
import { createPostgresWalletPromptFence } from '../../agent/postgres-wallet-prompt-fence.mjs';

const pool = new pg.Pool({ connectionString: process.env.BOUNCER_TEST_POSTGRES_URL, max: 1 });
const fence = createPostgresWalletPromptFence({ pool, authenticate: async ({ evidence }) => evidence === 'synthetic-auth' });
process.on('message', async payload => {
  try {
    const record = await fence.reserve({ ...payload, evidence: 'synthetic-auth' });
    process.send?.({ ok: true, operationId: record.operation_id });
  } catch (error) { process.send?.({ ok: false, code: error.code || 'ERROR' }); }
  finally { await pool.end(); process.disconnect(); }
});
process.send?.({ ready: true });
