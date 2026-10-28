// Research probe only: a fresh ephemeral testnet account calls OutLayer directly.
// This is NOT a Bouncer-guarded payment. Never use a mainnet account or retry
// an ambiguous send. The pinned upstream example is a bounded randomness demo.
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { MonotonicAccount } from '../agent/near-account.mjs';
import { validateRpcEndpoint } from '../shared/rpc-endpoint.mjs';

const { KeyPair, KeyPairSigner, providers } = nearApi;
const provider = new providers.JsonRpcProvider({ url: validateRpcEndpoint(process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com') });
const hash = '0bb0668611f0fa9abeabbfaabf48436a46c94aa65ae1a0d106db7212f2d5f88a';
const amount = 100_000_000_000_000_000_000_000n; // 0.1 testnet NEAR, not mainnet
const input = { min: 1, max: 100 };
const args = {
  source: { WasmUrl: { url: `https://wasmhub.testnet.fastfs.io/fastfs.testnet/${hash}.wasm`, hash, build_target: 'wasm32-wasip1' } },
  resource_limits: { max_instructions: 10_000_000, max_memory_mb: 128, max_execution_seconds: 60 },
  input_data: JSON.stringify(input), response_format: 'Json',
};

function eventLogs(result, name) {
  const found = [];
  for (const receipt of result.receipts_outcome || []) {
    if (receipt?.outcome?.executor_id !== 'outlayer.testnet') continue;
    for (const log of receipt.outcome.logs || []) {
      if (!log.startsWith('EVENT_JSON:')) continue;
      try {
        const event = JSON.parse(log.slice('EVENT_JSON:'.length));
        if (event.standard === 'near-outlayer' && event.event === name && Array.isArray(event.data)) found.push(...event.data);
      } catch { /* Ignore unrelated malformed logs. */ }
    }
  }
  return found;
}

async function main() {
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const id = `bouncer-probe-${crypto.randomBytes(4).toString('hex')}.testnet`;
  const key = KeyPair.fromRandom('ed25519');
  const created = await fetch('https://helper.testnet.near.org/account', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newAccountId: id, newAccountPublicKey: key.getPublicKey().toString() }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!created.ok) throw new Error(`testnet helper returned HTTP ${created.status}`);
  const account = new MonotonicAccount(id, provider, new KeyPairSigner(key));
  console.log(`Direct OutLayer research probe (NOT Bouncer-guarded); ephemeral account ${id}`);
  // One send, with no retry on timeout, expiration, or any ambiguous outcome.
  const result = await account.callFunctionRaw({ contractId: 'outlayer.testnet', methodName: 'request_execution', args,
    deposit: amount, gas: 300n * 10n ** 12n, waitUntil: 'FINAL' });
  const tx = result.transaction_outcome?.id;
  console.log(`Transaction: https://testnet.nearblocks.io/txns/${tx}`);
  if (result.final_execution_status !== 'FINAL' || typeof result.status?.SuccessValue !== 'string' ||
      !result.receipts_outcome?.length || result.receipts_outcome.some(r => r.outcome?.status?.Failure)) {
    throw new Error('OutLayer transaction did not settle successfully at FINAL');
  }
  const output = JSON.parse(Buffer.from(result.status.SuccessValue, 'base64').toString('utf8'));
  if (!Number.isInteger(output?.random_number) || output.random_number < input.min || output.random_number > input.max) {
    throw new Error('OutLayer output did not match the expected bounded random-number shape');
  }
  const requested = eventLogs(result, 'execution_requested').map(e => {
    try { return JSON.parse(e.request_data); } catch { return null; }
  }).find(e => e?.predecessor_id === id && e.code_source?.WasmUrl?.hash === hash && e.payment === amount.toString());
  const completed = eventLogs(result, 'execution_completed').find(e => e.success === true && e.sender_id === id && e.code_source?.WasmUrl?.hash === hash);
  if (!requested || !completed || !/^\d+$/.test(completed.payment_charged || '') || !/^\d+$/.test(completed.payment_refunded || '')) {
    throw new Error('missing matching OutLayer request/completion evidence');
  }
  const charged = BigInt(completed.payment_charged), refund = BigInt(completed.payment_refunded);
  if (charged <= 0n || charged > amount || refund > amount - charged) throw new Error('unexpected provider charge/refund');
  console.log(`::notice title=Direct independent-provider research::provider=outlayer.testnet; tx=${tx}; output=${output.random_number}; charged_yocto=${charged}; provider_reported_refund_yocto=${refund}; guarded=no`);
  console.log('Scope: output shape and provider-reported execution/payment only; randomness and TEE attestation were not independently verified.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
