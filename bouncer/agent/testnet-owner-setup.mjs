/**
 * One-shot owner setup transfer for the isolated testnet demonstrations only.
 * This is NOT a guarded agent swap or a general-purpose payments API. The
 * caller must use a provider with single-attempt sends (PaymentRpcProvider),
 * and must never automatically retry an unresolved recorded hash.
 */
import crypto from 'node:crypto';
import { signReviewedOneYoctoOwnerCall } from './reviewed-transaction.mjs';
import { isTestnetAccount, isTestnetToken } from '../shared/account-id.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

const MAX_U128 = (1n << 128n) - 1n;
const MAX_GAS = 300n * 10n ** 12n;

export async function submitOwnerSetupOnce({ id, account, publicKey, token, args, gas, provider, journal }) {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(id) ||
      !isTestnetAccount(account?.accountId) || !isTestnetToken(token) ||
      !args || typeof args !== 'object' || Array.isArray(args) ||
      Object.keys(args).sort().join(',') !== 'amount,msg,receiver_id' ||
      !isTestnetAccount(args.receiver_id) || typeof args.amount !== 'string' ||
      !/^[1-9][0-9]{0,38}$/.test(args.amount) || BigInt(args.amount) > MAX_U128 ||
      typeof args.msg !== 'string' || Buffer.byteLength(args.msg) > 4096 ||
      typeof gas !== 'bigint' || gas <= 0n || gas > MAX_GAS ||
      !provider || typeof provider.viewNodeStatus !== 'function' || typeof provider.sendTransactionUntil !== 'function' ||
      !journal || typeof journal.get !== 'function' || typeof journal.put !== 'function' ||
      journal.data?.owner_account_id !== account.accountId) throw new Error('invalid owner testnet setup call');
  // Snapshot public inputs before any asynchronous provider or signer call.
  const input = { receiver_id: args.receiver_id, amount: args.amount, msg: args.msg };
  const owner = account.accountId, signerKey = String(publicKey);
  if (journal.get(id)) throw new Error(`${id}: original setup transaction already recorded; reconcile it, never submit again`);
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('setup RPC must report testnet');
  const call = { signer_id: owner, public_key: signerKey, token, method: 'ft_transfer_call',
    args: input, gas: gas.toString(), deposit: '1' };
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(call)).digest('hex');
  const { txHash, signed } = await signReviewedOneYoctoOwnerCall({ account, publicKey, ownerId: owner,
    contractId: token, method: call.method, args: input, gas });
  if (!isTransactionHash(txHash)) throw new Error('invalid owner setup transaction hash');
  const pending = { kind: 'testnet-owner-setup-v1', status: 'pending', fingerprint, tx_hash: txHash,
    call, started_at: new Date().toISOString() };
  // Another caller sharing this journal may have recorded the same ID while
  // this one awaited RPC/signing. The final check and put are synchronous.
  if (journal.get(id)) throw new Error(`${id}: original setup transaction already recorded; reconcile it, never submit again`);
  // FileJournal syncs both file and directory. Failure here prevents send;
  // signed transaction bytes and the private key are never persisted.
  journal.put(id, pending);
  try {
    const result = await provider.sendTransactionUntil(signed, 'FINAL');
    if (result?.transaction_outcome?.id !== txHash || result.final_execution_status !== 'FINAL' ||
        typeof result.status?.SuccessValue !== 'string' || !Array.isArray(result.receipts_outcome) ||
        !result.receipts_outcome.length || result.receipts_outcome.some(r => r.outcome?.status?.Failure)) {
      throw new Error('missing matching FINAL successful receipts');
    }
    journal.put(id, { ...pending, status: 'completed', completed_at: new Date().toISOString() });
    return result;
  } catch (error) {
    throw new Error(`${id}: setup transaction ${txHash} is not safely confirmed; retain the journal and reconcile, never retry automatically: ${error.message}`, { cause: error });
  }
}
