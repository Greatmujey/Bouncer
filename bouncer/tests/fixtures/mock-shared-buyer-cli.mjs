// Test-only CLI preload: real database and signatures, synthetic NEAR RPC.
import crypto from 'node:crypto';
import fs from 'node:fs';
import pg from 'pg';
import nearApi from 'near-api-js';
import { MonotonicAccount, PaymentRpcProvider } from '../../agent/near-account.mjs';
import { mockGuardedPayment } from '../mock-guarded-payment.mjs';
import { readBuyerKeyFile } from '../../agent/shared-buyer-config.mjs';
import { verifyEncryptedBuyerSnapshot } from '../../agent/postgres-buyer-journal.mjs';

const owner = process.env.BOUNCER_TEST_OWNER || 'owner.testnet', contract = 'bouncer.testnet', token = 'token.testnet';
const stateFile = process.env.BOUNCER_TEST_BUYER_CLI_STATE;
function read() { return fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { sends: 0, balance: '0', transactions: {} }; }
function write(state) { fs.writeFileSync(stateFile, JSON.stringify(state)); }
PaymentRpcProvider.prototype.viewNodeStatus = async () => ({ chain_id: 'testnet' });
PaymentRpcProvider.prototype.viewAccessKey = async () => ({ permission: { FunctionCall: { receiver_id: contract, method_names: ['execute'] } } });
PaymentRpcProvider.prototype.callFunction = async (_id, method) => {
  const state = read();
  if (method === 'contract_version') return 'bouncer-agent-v9';
  if (method === 'get_policy') return { token, per_tx_cap: '1000', daily_cap: '10000' };
  if (method === 'is_agent_key_allowed') return true;
  if (method === 'check') return [true, 'ok'];
  if (method === 'ft_balance_of' || method === 'daily_spent') return state.balance;
  if (method === 'vault_balance') return String(10000n - BigInt(state.balance));
  throw new Error('unexpected synthetic RPC method');
};
MonotonicAccount.prototype.createTransaction = async function(receiver, actions, key) {
  return nearApi.transactions.createTransaction(owner, key, receiver, BigInt(read().sends + 1), actions, Buffer.alloc(32, 9));
};
PaymentRpcProvider.prototype.sendTransactionUntil = async signed => {
  const txHash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(nearApi.transactions.encodeTransaction(signed.transaction)).digest());
  const pool = new pg.Pool({ connectionString: process.env.BOUNCER_BUYER_DATABASE_URL, max: 1 });
  try {
    const found = await pool.query('SELECT status FROM bouncer_buyer_v1.entries WHERE tx_hash=$1', [txHash]);
    if (found.rowCount !== 1 || found.rows[0].status !== 'pending') throw new Error('hash was not committed before simulated broadcast');
  } finally { await pool.end(); }
  if (process.env.BOUNCER_TEST_CHECKPOINT_DIR) {
    const files = fs.readdirSync(process.env.BOUNCER_TEST_CHECKPOINT_DIR).filter(name => name.endsWith(`-${txHash}.json`));
    if (files.length !== 1) throw new Error('encrypted checkpoint was not persisted before synthetic broadcast');
    const key = readBuyerKeyFile(process.env.BOUNCER_BUYER_JOURNAL_KEY_FILE);
    try {
      const snapshot = verifyEncryptedBuyerSnapshot(fs.readFileSync(`${process.env.BOUNCER_TEST_CHECKPOINT_DIR}/${files[0]}`, 'utf8'), key);
      if (!snapshot.entries.some(entry => entry.tx_hash === txHash && entry.status === 'pending')) throw new Error('checkpoint does not include the original pending hash');
    } finally { key.fill(0); }
  }
  const args = JSON.parse(Buffer.from(signed.transaction.actions[0].functionCall.args).toString());
  const result = mockGuardedPayment({ hash: txHash, owner, contract, publicKey: String(signed.transaction.publicKey), args });
  const state = read(); state.sends++; state.balance = String(BigInt(state.balance) + BigInt(args.amount));
  state.transactions[txHash] = result; write(state);
  return { transaction_outcome: { id: txHash } };
};
PaymentRpcProvider.prototype.txStatusReceipts = async hash => {
  const result = read().transactions[hash];
  if (!result) throw new Error('unknown synthetic hash');
  return result;
};
