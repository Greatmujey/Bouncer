/**
 * Key-free reinspection of an already completed one-shot testnet Ref swap.
 * The original exclusive journal must be supplied. This function deliberately
 * forbids writes and never signs or broadcasts; the RPC and contracts remain
 * trusted. Balance views are a point-in-time observation, not a payment proof.
 */
import { recoverRefSwap } from './ref-swap.mjs';
import { validateRefSwapGoal, REF_SWAP_OUTPUT } from './ref-swap-evidence.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

export async function inspectCompletedRefSwap({ goal: rawGoal, provider, journal, expectedInput, expectedSweep, expectedReceipt, expectedAmount }) {
  const goal = validateRefSwapGoal(rawGoal);
  if (!provider || !journal || typeof journal.get !== 'function' ||
      ![expectedInput, expectedSweep, expectedReceipt].every(isTransactionHash) ||
      typeof expectedAmount !== 'string' || !/^[1-9][0-9]{0,5}$/.test(expectedAmount)) {
    throw new Error('invalid completed Ref reinspection context');
  }
  const input = journal.get(`${goal.id}-input`), route = journal.get(`${goal.id}-route`), sweep = journal.get(`${goal.id}-sweep`);
  if (input?.status !== 'completed' || input.tx_hash !== expectedInput || route?.status !== 'completed' ||
      sweep?.status !== 'completed' || sweep.tx_hash !== expectedSweep || sweep.output_receipt_id !== expectedReceipt ||
      sweep.output_amount !== expectedAmount) throw new Error('original journal is not the expected completed swap and sweep');
  const readOnlyJournal = { get: id => journal.get(id), put: () => { throw new Error('read-only reinspection cannot modify the journal'); } };
  const readOnlyProvider = new Proxy(provider, { get(target, property) {
    if (property === 'sendTransactionUntil' || property === 'sendTransaction' || property === 'broadcastTransaction') {
      return () => { throw new Error('read-only reinspection cannot broadcast'); };
    }
    const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const result = await recoverRefSwap({ goal, provider: readOnlyProvider, journal: readOnlyJournal, log: () => {} });
  if (result.status !== 'COMPLETED' || result.swap.tx_hash !== expectedInput || result.swap.output_receipt_id !== expectedReceipt ||
      result.swap.output_amount !== expectedAmount || result.vault_credit.tx_hash !== expectedSweep || result.vault_credit.credited !== expectedAmount) {
    throw new Error('FINAL receipt graphs do not match the expected original swap and sweep');
  }
  const final = { finality: 'final' };
  const [ledger, vaultToken, routerToken] = await Promise.all([
    readOnlyProvider.callFunction(goal.contract_id, 'vault_balance', { token: REF_SWAP_OUTPUT }, final),
    readOnlyProvider.callFunction(REF_SWAP_OUTPUT, 'ft_balance_of', { account_id: goal.contract_id }, final),
    readOnlyProvider.callFunction(REF_SWAP_OUTPUT, 'ft_balance_of', { account_id: goal.router_id }, final),
  ]);
  if (ledger !== expectedAmount || vaultToken !== expectedAmount || routerToken !== '0') {
    throw new Error('current vault ledger and token balances differ; investigate later transfers without replaying');
  }
  return { status: 'COMPLETED', original_input: expectedInput, output_receipt: expectedReceipt, sweep: expectedSweep,
    deposit_receipt: result.vault_credit.deposit_receipt_id, output_micro: expectedAmount, vault_ledger: ledger,
    vault_token: vaultToken, router_token: routerToken, sends: 0, journal_writes: 0,
    scope: 'read-only testnet reinspection; trusted RPC, token and contracts; balances are point-in-time observations' };
}
