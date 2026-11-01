// Read-only inspection of two PUBLIC, already-finalized testnet transactions
// from the previous self-hosted seller-v3 proof. No signer or payment path.
import { PaymentRpcProvider } from '../agent/near-account.mjs';

const OWNER = 'owner.bouncer-oracle-1ab0b52f.testnet';
const TRANSACTIONS = [
  ['historical-unguarded-owner-ref-swap', 'Eb12GAnB1ZNxF3d2zTmoTEKJ4FrZuCbccEJuCKYtDwE7'],
  ['historical-owner-vault-funding', '2y15D2wLxjwRxXegskCcRGMLMVyxtwoP5EdXuA7XviP4'],
];
const provider = new PaymentRpcProvider(process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com', { receiptTimeoutMs: 60_000 });
const notice = (title, payload) => {
  const encoded = JSON.stringify(payload).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::notice title=${title}::${encoded.slice(0, 3800)}`);
};
async function main() {
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  for (const [label, hash] of TRANSACTIONS) {
    const result = await provider.txStatusReceipts(hash, OWNER, 'FINAL');
    if (result?.final_execution_status !== 'FINAL' || result?.transaction_outcome?.id !== hash ||
        !Array.isArray(result.receipts) || !Array.isArray(result.receipts_outcome) || result.receipts.length > 100) {
      throw new Error(`${label}: missing bounded FINAL receipt graph`);
    }
    const outcomes = new Map(result.receipts_outcome.map(o => [o.id, o.outcome]));
    notice(`${label} transaction`, { hash, transaction: result.transaction, status: result.status, transaction_outcome: result.transaction_outcome?.outcome });
    for (const receipt of result.receipts) {
      const actions = receipt.receipt?.Action?.actions;
      if (!Array.isArray(actions)) continue;
      const functions = actions.flatMap(a => {
        if (!a.FunctionCall) return [];
        const f = a.FunctionCall; let args;
        try { args = JSON.parse(Buffer.from(f.args, 'base64').toString('utf8')); } catch { args = '<not JSON>'; }
        return [{ method: f.method_name, gas: f.gas, deposit: f.deposit, args }];
      });
      if (!functions.length) continue;
      const out = outcomes.get(receipt.receipt_id);
      notice(`${label} receipt`, { id: receipt.receipt_id, predecessor: receipt.predecessor_id, receiver: receipt.receiver_id,
        functions, outcome: out ? { executor: out.executor_id, status: out.status, gas_burnt: out.gas_burnt,
          children: out.receipt_ids, logs: out.logs } : null });
    }
  }
  console.log('Read-only historical receipt inspection; the first swap was NOT Bouncer-guarded. No transaction submitted.');
}
main().catch(error => { console.error(`[ref-receipt-inspection] ${error.message}`); process.exitCode = 1; });
