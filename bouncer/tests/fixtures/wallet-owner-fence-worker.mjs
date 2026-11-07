// Synthetic child process used only by the disposable cross-flow DB test.
import fs from 'node:fs';
import pg from 'pg';
import { createPostgresWalletPromptFence } from '../../agent/postgres-wallet-prompt-fence.mjs';
import { createPostgresNativeOraclePromptFence } from '../../agent/postgres-native-oracle-prompt-fence.mjs';

const pool = new pg.Pool({ connectionString: process.env.BOUNCER_TEST_POSTGRES_URL, max: 2, connectionTimeoutMillis: 5000 });
const wasm = fs.readFileSync(new URL('../../../bouncer.wasm', import.meta.url));
const authenticate = async ({ evidence }) => evidence === 'synthetic-auth';
const never = async () => { throw Error('synthetic worker must not call RPC'); };
const receiptProvider = { viewNodeStatus: never, txStatusReceipts: never };
const preflightProvider = Object.fromEntries(['viewNodeStatus','viewBlock','query','viewTestnetAccountPresenceAt',
  'callFunctionRaw','experimental_protocolConfig','gasPrice'].map(x => [x, never]));
process.send?.({ ready: true });
process.once('message', async input => {
  try {
    const fence = input.flow === 'native_oracle'
      ? createPostgresNativeOraclePromptFence({ pool, authenticate, wasmBytes: wasm, receiptProvider, preflightProvider })
      : createPostgresWalletPromptFence({ pool, authenticate });
    const result = await fence.reserve(input.request);
    process.send?.({ ok: true, operation_id: result.operation_id });
  } catch (error) { process.send?.({ ok: false, code: error?.code ?? 'ERROR' }); }
  finally { await pool.end(); process.disconnect?.(); }
});
