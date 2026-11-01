/**
 * Strictly one signed setup transaction for isolated testnet probes. The
 * reviewed hash and public intent must be durable before the only broadcast.
 * A failed/lost response is inspected by original hash, never re-signed or
 * resent. This is not a general production transaction orchestrator.
 */
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { signReviewedProbeSetup } from './reviewed-transaction.mjs';
import { redactProbeReceipt } from './testnet-receipt.mjs';
import { withExclusiveJournalOperation } from './journal-operation.mjs';

const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const success = status => !!status && typeof status === 'object' && status.Failure === undefined &&
  (typeof status.SuccessValue === 'string' || typeof status.SuccessReceiptId === 'string');

export function verifyTestnetProbeSetupResult({ result, txHash, signerId, receiverId, publicKey }) {
  if (result?.final_execution_status !== 'FINAL' || result?.transaction_outcome?.id !== txHash ||
      result?.transaction?.hash !== txHash || result.transaction.signer_id !== signerId ||
      result.transaction.receiver_id !== receiverId || result.transaction.public_key !== String(publicKey) ||
      typeof result.status?.SuccessValue !== 'string' || result.status.Failure !== undefined ||
      !success(result.transaction_outcome?.outcome?.status) || !Array.isArray(result.receipts_outcome) ||
      !result.receipts_outcome.length || result.receipts_outcome.some(item => !success(item?.outcome?.status))) {
    throw new Error('setup transaction has no matching successful FINAL receipts');
  }
  return { tx_hash: txHash, signer_id: signerId, receiver_id: receiverId, final_execution_status: 'FINAL' };
}

async function submitUnlocked({ id, account, publicKey, receiverId, actions, review, provider, journal, persistIntent, saveReceipt }) {
  const signerId = account?.accountId;
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(id) || !isTestnetAccount(signerId) ||
      !isTestnetAccount(receiverId) || !publicKey || !Array.isArray(actions) || !actions.length ||
      !review || typeof review !== 'object' || Array.isArray(review) ||
      !provider || typeof provider.viewNodeStatus !== 'function' || typeof provider.sendTransactionOnce !== 'function' ||
      typeof provider.txStatusReceipts !== 'function' || !journal || typeof journal.get !== 'function' ||
      typeof journal.put !== 'function' || ![journal.data?.owner_account_id, journal.data?.contract_id].includes(signerId) ||
      typeof persistIntent !== 'function' || typeof saveReceipt !== 'function') throw new Error('invalid one-shot testnet setup');
  // Freeze the public review across all asynchronous signing/RPC steps.
  const reviewed = structuredClone(review), keyText = String(publicKey);
  const key = nearApi.utils.PublicKey.from(keyText);
  // Snapshot the action bytes before ANY provider or signer awaits: otherwise
  // a shared mutable action could change between review and preparation.
  const canonical = list => Buffer.from(nearApi.transactions.encodeTransaction(nearApi.transactions.createTransaction(
    signerId, key, receiverId, 1n, list, Buffer.alloc(32))));
  const reviewedActions = canonical(actions);
  if (journal.get(id)) throw new Error(`${id}: original setup hash already exists; reconcile, never resend`);
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('setup requires testnet');
  const signed = await signReviewedProbeSetup({ account, signerId, publicKey: key, receiverId, actions });
  if (!canonical(signed.signed.transaction.actions).equals(reviewedActions)) throw new Error('setup actions changed since review');
  if (journal.get(id)) throw new Error(`${id}: another reservation appeared; reconcile, never overwrite`);
  const pending = { kind: 'testnet-probe-setup-v1', status: 'pending', fingerprint: fingerprint(reviewed),
    tx_hash: signed.txHash, signer_id: signerId, receiver_id: receiverId, public_key: keyText, review: reviewed };
  journal.put(id, pending);
  // Both the durable journal and an independent public intent/annotation must
  // succeed before sending. Failure leaves a pending hash and stops the run.
  await persistIntent({ id, signer_id: signerId, receiver_id: receiverId, public_key: keyText,
    tx_hash: signed.txHash, review: reviewed });
  try { await provider.sendTransactionOnce(signed.signed, 'FINAL'); }
  catch { /* Ambiguous: the original hash is the only permitted next lookup. */ }
  let result;
  try { result = await provider.txStatusReceipts(signed.txHash, signerId, 'FINAL'); }
  catch (error) { throw new Error(`${id}: unresolved original hash ${signed.txHash}; inspect without resending`, { cause: error }); }
  const proof = verifyTestnetProbeSetupResult({ result, txHash: signed.txHash, signerId, receiverId, publicKey });
  await saveReceipt(redactProbeReceipt(result));
  journal.put(id, { ...pending, status: 'completed', proof, completed_at: new Date().toISOString() });
  return proof;
}

export function submitTestnetProbeSetupOnce(options) {
  return withExclusiveJournalOperation(options?.journal, () => submitUnlocked(options));
}
