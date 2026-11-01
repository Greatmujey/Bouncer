import test from 'node:test';
import assert from 'node:assert/strict';
import { HISTORICAL_FT_CALL, verifyHistoricalFtCall } from '../scripts/verify-ft-call-history.mjs';

const { goal, tx_hash, public_key } = HISTORICAL_FT_CALL;
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
function action(id, predecessor_id, receiver_id, method_name, args, deposit) {
  return { receipt_id: id, predecessor_id, receiver_id,
    receipt: { Action: { actions: [{ FunctionCall: { method_name, args: encode(args), deposit } }] } } };
}
function syntheticHistory() {
  const result = encode(goal.amount);
  return { final_execution_status: 'FINAL', status: { SuccessValue: result },
    transaction_outcome: { id: tx_hash, outcome: { receipt_ids: ['init'] } },
    transaction: { hash: tx_hash, signer_id: goal.owner_account_id, receiver_id: goal.contract_id, public_key,
      actions: [{ FunctionCall: { method_name: 'execute_ft_call', deposit: '0', gas: '300000000000000',
        args: encode({ policy_id: goal.policy_id, payee: goal.payee, amount: goal.amount, expected_token: goal.token,
          expected_msg: goal.msg, expected_policy_revision: goal.policy_revision, expected_route_revision: goal.route_revision }) } }] },
    receipts_outcome: [
      { id: 'init', outcome: { executor_id: goal.contract_id, status: { SuccessReceiptId: 'callback' },
        logs: ['BOUNCER guarded ft_transfer_call initiated; full amount reserved'], receipt_ids: ['transfer', 'callback'] } },
      { id: 'transfer', outcome: { executor_id: goal.token, status: { SuccessReceiptId: 'resolver' } } },
      { id: 'callback', outcome: { executor_id: goal.contract_id, status: { SuccessValue: result },
        logs: ['BOUNCER ft_transfer_call settled; used=10000; unused=0'] } },
    ],
    receipts: [action('transfer', goal.contract_id, goal.token, 'ft_transfer_call',
      { receiver_id: goal.payee, amount: goal.amount, memo: 'bouncer:guarded-ft-call', msg: goal.msg }, '1'),
    action('callback', goal.contract_id, goal.contract_id, 'after_execute_ft_call',
      { policy_id: goal.policy_id, token: goal.token, amount: goal.amount, bucket: 24,
        policy_revision: goal.policy_revision, payee: goal.payee, msg: goal.msg }, '0')],
  };
}

test('historical FT-call inspector makes only bounded reads and rejects substituted graphs', async () => {
  let reads = 0, sends = 0;
  const provider = { async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async txStatusReceipts(hash, owner, finality) {
      reads++; assert.equal(hash, tx_hash); assert.equal(owner, goal.owner_account_id); assert.equal(finality, 'FINAL'); return syntheticHistory();
    },
    async sendTransactionUntil() { sends++; throw new Error('must not send'); } };
  const result = await verifyHistoricalFtCall({ provider });
  assert.equal(reads, 1); assert.equal(sends, 0); assert.equal(result.tx_hash, tx_hash);
  assert.equal(result.used, '10000'); assert.equal(result.graph_mutations_rejected, true);
  assert.equal(result.substituted_payee_rejected, true); assert.match(result.scope, /not Circle USDC/);
});

test('historical inspection fails closed on the wrong network or incomplete receipts', async () => {
  let reads = 0;
  const provider = { async viewNodeStatus() { return { chain_id: 'mainnet' }; },
    async txStatusReceipts() { reads++; return syntheticHistory(); } };
  await assert.rejects(verifyHistoricalFtCall({ provider }), /testnet/); assert.equal(reads, 0);
  provider.viewNodeStatus = async () => ({ chain_id: 'testnet' });
  provider.txStatusReceipts = async () => { const raw = syntheticHistory(); raw.receipts = []; return raw; };
  await assert.rejects(verifyHistoricalFtCall({ provider }), /missing raw receipts/);
});
