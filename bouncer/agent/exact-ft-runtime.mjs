/**
 * Shared, testnet-only V11 intent checks. Adapter code must first reconstruct
 * `prepared` from its original reviewed goal and durable seller reservation.
 * These helpers neither sign nor broadcast, and cannot authenticate a seller.
 */
import { isDeepStrictEqual } from 'node:util';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { readPinnedJsonView } from './read-only-near-rpc.mjs';
import { assertPreparedExactFt, assertMultiAgencyExactFtView, multiAgencyExactExecutionBlock,
  verifyPreparedExactFtPayment } from './multiagency-exact-ft.mjs';

/** A single FINAL snapshot, with the execute-only function-call key, keyless
 * reviewed vault, owner-pinned intent, policy revisions and payee registration.
 * A passing view is advisory; the contract enforces the policy again. */
export async function preflightExactFt({ prepared, publicKey, provider, now = Date.now }) {
  assertPreparedExactFt(prepared);
  const goal = prepared.review.goal, a = prepared.owner_call.args, agentKey = String(publicKey);
  if (agentKey !== prepared.review.agent_public_key || agentKey !== a.agent_public_key) {
    throw new Error('agent key differs from the owner-reviewed exact intent');
  }
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const block = await provider.viewBlock({ finality: 'final' });
  if (typeof now !== 'function') throw new Error('invalid local clock');
  assertFreshFinalBlock(block, now());
  const final = { blockId: block.header.hash };
  const pinnedQuery = (contract, method, args) => readPinnedJsonView(provider, block.header.hash, contract, method, args);
  const [vault, vaultKeys, owner, version, access, registration, locked, pairLocked, policy, granted, view, verdict] = await Promise.all([
    provider.viewAccount(goal.vault, final), provider.viewAccessKeyList(goal.vault, final),
    pinnedQuery(goal.vault, 'get_owner', {}), pinnedQuery(goal.vault, 'contract_version', {}),
    provider.viewAccessKey(goal.owner, publicKey, final),
    pinnedQuery(a.expected_token, 'storage_balance_of', { account_id: a.payee }),
    pinnedQuery(goal.vault, 'is_exact_ft_policy_locked', { policy_id: goal.policy_id }),
    pinnedQuery(goal.vault, 'is_exact_ft_payee_locked', { token: a.expected_token, payee: a.payee }),
    pinnedQuery(goal.vault, 'get_policy', { policy_id: goal.policy_id }),
    pinnedQuery(goal.vault, 'is_agent_key_allowed', { policy_id: goal.policy_id, public_key: agentKey }),
    pinnedQuery(goal.vault, 'get_exact_ft_intent', { intent_id: prepared.intent_id }),
    pinnedQuery(goal.vault, 'check', { policy_id: goal.policy_id, payee: a.payee, amount: a.amount }),
  ]);
  const permission = access?.permission?.FunctionCall;
  if (vault?.block_hash !== block.header.hash || vault?.code_hash !== goal.vault_code_hash ||
      vaultKeys?.block_hash !== block.header.hash || !Array.isArray(vaultKeys?.keys) || vaultKeys.keys.length !== 0 ||
      access?.block_hash !== block.header.hash || owner !== goal.owner || version !== 'bouncer-agent-v11-exact-ft-testnet' ||
      !permission || permission.receiver_id !== goal.vault || !isDeepStrictEqual(permission.method_names, ['execute_exact_ft']) ||
      !registration || typeof registration.total !== 'string' || !/^[1-9][0-9]*$/.test(registration.total) ||
      locked !== true || pairLocked !== true || policy?.token !== a.expected_token || granted !== true) {
    throw new Error('reviewed keyless V11 vault, scoped agent, policy or recipient registration differs; no payment sent');
  }
  const pinnedView = assertMultiAgencyExactFtView(prepared, view);
  if (!Array.isArray(verdict) || verdict.length !== 2 || typeof verdict[0] !== 'boolean' || typeof verdict[1] !== 'string') {
    throw new Error('invalid on-chain policy verdict');
  }
  return { pinnedView, allowed: verdict[0], reason: verdict[1].replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 200),
    finalBlock: { header: { hash: block.header.hash, timestamp_nanosec: block.header.timestamp_nanosec } } };
}

/** Read and verify the original transaction only. The historic vault and
 * intent are bound to both the original transaction and initiation blocks.
 * A missing receipt is not proof of non-payment and is never a retry signal. */
export async function readExactFtEvidence({ prepared, txHash, pinnedView, provider }) {
  assertPreparedExactFt(prepared);
  assertMultiAgencyExactFtView(prepared, pinnedView);
  if (!isTransactionHash(txHash) || typeof provider?.txStatusReceipts !== 'function') {
    throw new Error('original exact FT hash and receipt-inclusive RPC are required');
  }
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const goal = prepared.review.goal;
  const chain = await provider.txStatusReceipts(txHash, goal.owner, 'FINAL');
  const executionId = multiAgencyExactExecutionBlock(chain, goal.vault), transactionId = chain?.transaction_outcome?.block_hash;
  if (!isTransactionHash(transactionId)) throw new Error('original transaction block is unavailable');
  async function vaultAt(id) {
    const [account, keys] = await Promise.all([
      provider.viewAccount(goal.vault, { blockId: id }), provider.viewAccessKeyList(goal.vault, { blockId: id }),
    ]);
    if (account?.block_hash !== id || keys?.block_hash !== id) throw new Error('historical vault queries disagree');
    return { block_hash: id, code_hash: account.code_hash, keys: keys.keys };
  }
  const [transaction, execution, view] = await Promise.all([
    vaultAt(transactionId), vaultAt(executionId),
    readPinnedJsonView(provider, executionId, goal.vault, 'get_exact_ft_intent', { intent_id: prepared.intent_id }),
  ]);
  if (!isDeepStrictEqual(view, { ...pinnedView, consumed: true, active: false })) {
    throw new Error('historical consumed intent differs from the original pinned review');
  }
  return verifyPreparedExactFtPayment({ prepared, txHash, result: chain, vaultState: { ...transaction, execution },
    intentState: { block_hash: executionId, view } });
}
