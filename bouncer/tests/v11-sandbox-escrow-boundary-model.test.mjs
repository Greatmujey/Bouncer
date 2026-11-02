/** Synthetic RPC, synthetic token and synthetic receipts around actual V11
 * bytecode. These tests verify harness wiring and fail-closed assertions only;
 * they do NOT run nearcore, Circle, PayPerCall or an independent seller. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { exerciseSandboxEscrowBoundary } from '../integration/v11-sandbox-escrow-boundary.mjs';
import { readExactArtifact } from './fixtures/v11-synthetic-host.mjs';
import { createSyntheticEscrowRpc } from './fixtures/v11-escrow-synthetic-rpc.mjs';
const file = process.env.BOUNCER_V11_WASM_PATH;
const skip = file ? false : 'set BOUNCER_V11_WASM_PATH to the hash-pinned recovered artifact';

for (const callbackOnPlain of [false, true]) {
  test(callbackOnPlain ? 'escrow harness rejects a synthetic token that incorrectly callbacks on a plain transfer' :
    'escrow harness checks its assertions on actual V11 bytecode and a synthetic token model', { skip }, async () => {
    const wasm = readExactArtifact(file), rpc = await createSyntheticEscrowRpc(wasm, { callbackOnPlain });
    try {
      const operation = exerciseSandboxEscrowBoundary({ rpcUrl: rpc.url, root: rpc.root, tokenOwner: rpc.tokenOwner,
        wasm, storageMin: '1250000000000000000000' });
      if (callbackOnPlain) await assert.rejects(operation, error => {
        assert.equal(error.code, 'ERR_ASSERTION');
        assert.equal(error.actual, '1000'); assert.equal(error.expected, '900');
        return true;
      });
      else {
        const result = await operation;
        assert.match(result.scope, /NOT PayPerCall or Circle/);
        assert.equal(result.locked_exact_policy_rejected_ft_call, true);
        assert.equal(result.v11_runner_first_payment_and_original_hash_recovery, false, 'synthetic RPC does not model full receipt graphs');
        assert.equal(result.unlocked_route_repeated_within_daily_budget, true);
        assert.equal(result.plain_return_vault_ledger_delta, '0');
        assert.equal(result.callback_return_vault_ledger_delta, '100');
        assert.equal(result.seller_contacted, false); assert.equal(result.independent_fulfillment_verified, false);
      }
      assert.ok(rpc.state.sends > 0); assert.deepEqual(rpc.state.unexpected, []);
    } catch (error) {
      error.message += `; synthetic diagnostics: ${rpc.state.lastFailure ?? 'none'} ${rpc.state.unexpected.join('; ')}`;
      throw error;
    } finally { await rpc.close(); }
  });
}
