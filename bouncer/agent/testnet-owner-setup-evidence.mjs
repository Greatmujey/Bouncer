/** Read-only verification of one recorded testnet owner setup transaction. */
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isTestnetAccount, isTestnetToken } from '../shared/account-id.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

/**
 * Binds a FINAL RPC response to the original journaled owner call. This does
 * not infer non-payment from an unknown hash or authenticate the RPC itself.
 */
export function inspectOwnerSetupResult(entry, result) {
  const call = entry?.call;
  if (!entry || entry.kind !== 'testnet-owner-setup-v1' || !['pending', 'completed'].includes(entry.status) ||
      !isTransactionHash(entry.tx_hash) || !call || !isTestnetAccount(call.signer_id) || !isTestnetToken(call.token) ||
      typeof call.public_key !== 'string' || !call.public_key.startsWith('ed25519:') || call.method !== 'ft_transfer_call' ||
      call.deposit !== '1' || typeof call.gas !== 'string' || !/^[1-9][0-9]{0,14}$/.test(call.gas) || BigInt(call.gas) > 300_000_000_000_000n ||
      !call.args || Object.keys(call.args).sort().join(',') !== 'amount,msg,receiver_id' || !isTestnetAccount(call.args.receiver_id) ||
      typeof call.args.amount !== 'string' || !/^[1-9][0-9]{0,38}$/.test(call.args.amount) ||
      typeof call.args.msg !== 'string' || Buffer.byteLength(call.args.msg) > 4096 ||
      entry.fingerprint !== crypto.createHash('sha256').update(JSON.stringify(call)).digest('hex')) {
    throw new Error('invalid recorded testnet owner setup call');
  }
  const tx = result?.transaction;
  if (result?.final_execution_status !== 'FINAL' || result?.transaction_outcome?.id !== entry.tx_hash ||
      !tx || tx.hash !== entry.tx_hash || tx.signer_id !== call.signer_id || tx.public_key !== call.public_key ||
      tx.receiver_id !== call.token || !Array.isArray(tx.actions) || tx.actions.length !== 1 ||
      !Array.isArray(result.receipts_outcome) || result.receipts_outcome.length === 0) {
    throw new Error('FINAL setup transaction identity or receipts mismatch');
  }
  const action = tx.actions[0]?.FunctionCall;
  if (!action || action.method_name !== call.method || String(action.deposit) !== call.deposit || String(action.gas) !== call.gas ||
      typeof action.args !== 'string' || action.args.length > 16_384 || !/^[A-Za-z0-9+/]*={0,2}$/.test(action.args)) {
    throw new Error('FINAL owner setup action mismatch');
  }
  const bytes = Buffer.from(action.args, 'base64');
  if (bytes.toString('base64') !== action.args) throw new Error('invalid owner setup action encoding');
  let args;
  try { args = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('invalid owner setup action arguments'); }
  if (!isDeepStrictEqual(args, call.args)) throw new Error('FINAL owner setup arguments differ from the recorded call');
  const success = typeof result.status?.SuccessValue === 'string' && result.status?.Failure === undefined;
  const failure = result.status?.Failure !== undefined && result.status?.SuccessValue === undefined;
  if (!success && !failure) throw new Error('owner setup transaction has no terminal FINAL status');
  for (const receipt of result.receipts_outcome) {
    const status = receipt?.outcome?.status;
    if (!status || typeof status !== 'object' || Array.isArray(status) ||
        !((typeof status.SuccessValue === 'string' && status.SuccessReceiptId === undefined && status.Failure === undefined) ||
          (typeof status.SuccessReceiptId === 'string' && status.SuccessValue === undefined && status.Failure === undefined) ||
          (status.Failure !== undefined && status.SuccessValue === undefined && status.SuccessReceiptId === undefined))) {
      throw new Error('owner setup receipt status is incomplete');
    }
  }
  const failedReceipts = result.receipts_outcome.filter(receipt => receipt.outcome.status.Failure !== undefined).length;
  if (entry.status === 'completed' && (!success || failedReceipts)) throw new Error('completed owner setup contradicts its FINAL outcome');
  return { tx_hash: entry.tx_hash, signer: call.signer_id, token: call.token, receiver: call.args.receiver_id,
    amount: call.args.amount, status: success && !failedReceipts ? 'FINAL_SUCCESS' : 'FINAL_FAILURE_OR_FAILED_RECEIPT',
    failed_receipts: failedReceipts };
}
