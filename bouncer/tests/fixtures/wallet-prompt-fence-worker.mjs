// Synthetic cross-process PostgreSQL fence probe. No wallet, secrets or chain.
import pg from 'pg';
import { createPostgresWalletPromptFence } from '../../agent/postgres-wallet-prompt-fence.mjs';
import { wasm } from '../buffer-wallet-setup-fixture.mjs';
import { firstSetupPreflightFixture, setSyntheticSetupStage } from './wallet-setup-preflight-provider.mjs';

const pool = new pg.Pool({ connectionString: process.env.BOUNCER_TEST_POSTGRES_URL, max: 1 });
const authenticate = async ({ evidence }) => evidence === 'synthetic-auth';
process.on('message', async payload => {
  try {
    const { __mode, __originals, ...input } = payload;
    let fence;
    if (__mode === 'setup-claim') {
      const { provider, state, blockHash } = firstSetupPreflightFixture({ owner: input.owner, ownerKey: input.ownerPublicKey });
      setSyntheticSetupStage(state, blockHash, 1);
      const receiptProvider = { async viewNodeStatus() { return { chain_id: 'testnet' }; },
        async txStatusReceipts(id) { if (!Object.hasOwn(__originals, id)) throw Error('unknown synthetic receipt'); return __originals[id]; } };
      fence = createPostgresWalletPromptFence({ pool, authenticate, setupWasmBytes: wasm,
        setupReceiptProvider: receiptProvider, setupPreflightProvider: provider });
    } else fence = createPostgresWalletPromptFence({ pool, authenticate });
    const record = __mode === 'setup-claim' ? await fence.claimSetupStage({ ...input, evidence: 'synthetic-auth' }) :
      __mode === 'claim' ? await fence.claimPrompt({ ...input, evidence: 'synthetic-auth' }) :
      await fence.reserve({ ...input, evidence: 'synthetic-auth' });
    process.send?.({ ok: true, operationId: record.operation_id });
  } catch (error) { process.send?.({ ok: false, code: error.code || 'ERROR' }); }
  finally { await pool.end(); process.disconnect(); }
});
process.send?.({ ready: true });
