/** Read-only comparison of a locally source-built Buffer WASM against one
 * trusted testnet RPC's account code hash at a single FINAL block. Matching
 * bytes support this specific source/build comparison, not a code audit,
 * future state, operator behavior, seller availability, payment or delivery.
 * This module never calls a seller endpoint, signs, sends or creates an order.
 */
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { BUFFER_TESTNET_CONTRACT } from '../experiments/buffer-forwarder/build.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

export async function compareBufferCode({ wasmBytes, provider, now = Date.now } = {}) {
  if (!(wasmBytes instanceof Uint8Array) || wasmBytes.length < 8 || wasmBytes.length > 4 * 1024 * 1024 ||
      !Buffer.from(wasmBytes.subarray(0, 8)).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])) ||
      typeof now !== 'function' || !provider ||
      ['viewNodeStatus', 'viewBlock', 'viewAccount'].some(name => typeof provider[name] !== 'function')) {
    throw new Error('bounded source-built WASM and read-only provider required');
  }
  // Capture and validate the module before any asynchronous RPC calls. This
  // does not establish that it came from the claimed source or is safe.
  const bytes = Buffer.from(wasmBytes);
  try { new WebAssembly.Module(bytes); } catch { throw new Error('source-built WASM is malformed'); }
  const localDigest = crypto.createHash('sha256').update(bytes).digest();
  const localNearHash = nearApi.utils.serialize.base_encode(localDigest);
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('testnet RPC required');
  const block = await provider.viewBlock({ finality: 'final' });
  const { hash, timestamp_ms } = assertFreshFinalBlock(block, now());
  if (!Number.isSafeInteger(block?.header?.height) || block.header.height < 1) throw new Error('valid FINAL height required');
  const account = await provider.viewAccount(BUFFER_TESTNET_CONTRACT, { blockId: hash });
  if (!account || account.block_hash !== hash || !isTransactionHash(account.code_hash) ||
      (account.global_contract_hash !== undefined && account.global_contract_hash !== null) ||
      (account.global_contract_account_id !== undefined && account.global_contract_account_id !== null)) {
    throw new Error('pinned local seller code hash unavailable or globally redirected');
  }
  const same = account.code_hash === localNearHash;
  return { network: 'testnet', seller: BUFFER_TESTNET_CONTRACT, block_hash: hash, block_height: block.header.height,
    block_timestamp_ms: timestamp_ms, deployed_code_hash: account.code_hash, local_wasm_sha256: localDigest.toString('hex'),
    local_wasm_near_code_hash: localNearHash, local_wasm_bytes: bytes.length,
    bytecode_matches: same, source_equivalence_scope: same ? 'matches this local source build at this trusted-RPC block only' :
      'does not match this local source build; source equivalence not established',
    audited: false, current_or_future_code_proven: false, seller_service_verified: false,
    payment_authorized: false, signed: false, sent: false, independent_delivery_verified: false };
}
