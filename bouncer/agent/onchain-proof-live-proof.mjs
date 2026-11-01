// Test harness for ONE fresh testnet x402 onchain-proof run. The production
// buyer/recovery functions are unchanged. Deliberately lose one response only
// AFTER the single signed payment returns from the real provider. A provider
// error is never retried; the original journals must be retained for review.
import { isDeepStrictEqual } from 'node:util';
import { runOnchainProofGoal, recoverOnchainProofGoal, redeemOnchainProofOnce, validateOnchainProofGoal } from './onchain-proof.mjs';

function assert(ok, message) { if (!ok) throw new Error(`onchain-proof live check: ${message}`); }
export async function runOnchainProofLiveProof({ goal: raw, provider, account, publicKey, getJournal, reopenJournal,
  fetchImpl = globalThis.fetch, log = () => {} }) {
  const goal = validateOnchainProofGoal(raw);
  assert(typeof getJournal === 'function' && typeof reopenJournal === 'function', 'journal callbacks are required');
  const journal = () => getJournal();
  assert(!journal().get(goal.id), 'refusing to send with an existing payment entry');
  let broadcasts = 0, quotes = 0, redemptions = 0, injected = false;
  const trackedProvider = new Proxy(provider, { get(target, property) {
    if (property === 'sendTransactionUntil') return async (...args) => {
      assert(++broadcasts === 1, 'more than one payment broadcast was attempted');
      const result = await target.sendTransactionUntil(...args);
      injected = true;
      throw new Error('injected lost response after actual broadcast');
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const trackedFetch = async (...args) => {
    if (args[1]?.headers?.['payment-signature']) assert(++redemptions === 1, 'more than one seller request was attempted');
    else assert(++quotes === 1, 'more than one seller quote was requested');
    return fetchImpl(...args);
  };
  try {
    await runOnchainProofGoal({ goal, provider: trackedProvider, account, publicKey, journal: journal(),
      execute: true, fetchImpl: trackedFetch, log });
    throw new Error('onchain-proof live check: lost response injection unexpectedly completed');
  } catch (error) {
    if (!/unresolved.*never resend automatically.*injected lost response after actual broadcast/.test(error.message)) throw error;
  }
  const pending = journal().get(goal.id), originalHash = pending?.tx_hash;
  assert(injected && broadcasts === 1 && quotes === 1 && redemptions === 0 && originalHash &&
    pending.status === 'pending' && pending.payment_version === 'direct-signed-v1' && pending.redemption?.status === 'not_started',
  'single lost-response payment was not safely journaled');
  // The callback only closes and reopens public journal data. Recovery below
  // receives neither the signing account nor a private key.
  await reopenJournal();
  const recovered = await recoverOnchainProofGoal({ goal, provider, journal: journal(), log });
  assert(recovered.status === 'RECONCILED' && recovered.settlement.tx_hash === originalHash &&
    recovered.redemption_status === 'not_started' && broadcasts === 1 && redemptions === 0, 'original hash did not recover safely');
  const response = await redeemOnchainProofOnce({ goal, provider, journal: journal(), fetchImpl: trackedFetch, log });
  assert(response.status === 'RESPONDED' && response.settlement.tx_hash === originalHash && redemptions === 1,
    'first seller request did not complete');
  await reopenJournal();
  const replay = await recoverOnchainProofGoal({ goal, provider, journal: journal(), log });
  const cached = await redeemOnchainProofOnce({ goal, provider, journal: journal(), fetchImpl: trackedFetch, log });
  assert(replay.redemption_status === 'delivered' && replay.settlement.tx_hash === originalHash &&
    cached.status === 'REUSED' && isDeepStrictEqual(cached.response, response.response) &&
    quotes === 1 && redemptions === 1 && broadcasts === 1, 'restart did not reuse the recorded response');
  return { tx_hash: originalHash, settlement: recovered.settlement, response: response.response,
    quote_requests: quotes, payment_broadcasts: broadcasts, seller_redemption_requests: redemptions,
    lost_payment_response_recovered_without_key: true, response_reused_after_journal_restart: true };
}
