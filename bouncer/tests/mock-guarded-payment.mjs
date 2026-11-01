// TEST ONLY: construct a receipt graph with the same shape as a finalized
// direct Bouncer FT payment. Synthetic receipts prove no on-chain activity.
import crypto from 'node:crypto';
import nearApi from 'near-api-js';

export const mockHash = label => nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(String(label)).digest());
export const MOCK_PUBLIC_KEY = nearApi.KeyPair.fromRandom('ed25519').getPublicKey().toString();
const enc = value => Buffer.from(JSON.stringify(value)).toString('base64');
const outcome = (id, executor_id, status, logs = [], receipt_ids = []) => ({ id, outcome: { executor_id, status, logs, receipt_ids } });
const receipt = (id, predecessor_id, receiver_id, method_name, args, deposit) => ({ receipt_id: id, predecessor_id, receiver_id,
  receipt: { Action: { actions: [{ FunctionCall: { method_name, args: enc(args), deposit } }] } } });

export function mockGuardedPayment({ hash, owner, contract, publicKey = MOCK_PUBLIC_KEY, args, gas = '200000000000000' }) {
  const request = { policy_id: args.policy_id, payee: args.payee, amount: args.amount, memo: args.memo, expected_token: args.expected_token };
  return { final_execution_status: 'FINAL', status: { SuccessValue: '' },
    transaction_outcome: { id: hash, outcome: { receipt_ids: ['init'] } },
    transaction: { hash, signer_id: owner, receiver_id: contract, public_key: publicKey,
      actions: [{ FunctionCall: { method_name: 'execute', deposit: '0', gas, args: enc(request) } }] },
    receipts_outcome: [outcome('init', contract, { SuccessReceiptId: 'callback' }, ['BOUNCER payment initiated'], ['transfer', 'callback']),
      outcome('transfer', args.expected_token, { SuccessValue: '' }), outcome('callback', contract, { SuccessValue: '' })],
    receipts: [receipt('transfer', contract, args.expected_token, 'ft_transfer',
      { receiver_id: args.payee, amount: args.amount, memo: args.memo }, '1'),
    receipt('callback', contract, contract, 'after_execute',
      { policy_id: args.policy_id, token: args.expected_token, amount: args.amount, bucket: 24 }, '0')],
  };
}
