#!/usr/bin/env node
// READ ONLY: inspect the already-broadcast guarded Ref input and the original
// artifact. No keys, signatures, journal writes, token sweeps or new payments.
import fs from 'node:fs';
import path from 'node:path';
import { PaymentRpcProvider } from '../agent/near-account.mjs';
import { validateRefSwapGoal, refSwapFtGoal, verifyRefSwapOutput, REF_SWAP_OUTPUT, REF_SWAP_INPUT, REF_SWAP_EXCHANGE } from '../agent/ref-swap-evidence.mjs';
import { verifyFtCallSettlement } from '../agent/ft-call.mjs';

const EXPECTED_HASH = 'DzWVHLp51KuoUoy8oaYNQTgLNAMgSRcegYT4mjuXCXrz';
const EXPECTED_OWNER = 'owner.bouncer-ref-44f619d9.testnet';
const EXPECTED_VAULT = 'bouncer-ref-44f619d9.testnet';
const EXPECTED_ROUTER = 'ref-router-44f619d9.testnet';
const dir = process.argv[2];
if (!dir || process.argv.length !== 3) throw new Error('usage: node inspect-original-ref-swap.mjs ORIGINAL_ARTIFACT_DIRECTORY');
function find(name) {
  const files = [];
  function visit(root, level) {
    if (level > 3) return;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) visit(file, level + 1);
      else if (entry.isFile() && entry.name === name) files.push(file);
    }
  }
  visit(dir, 0);
  if (files.length !== 1) throw new Error(`expected one original ${name}; found ${files.length}`);
  return JSON.parse(fs.readFileSync(files[0], 'utf8'));
}
const provider = new PaymentRpcProvider(process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com');
const view = (id, method, args = {}) => provider.callFunction(id, method, args, { finality: 'final' });
function decode(value) {
  if (typeof value !== 'string' || value.length > 16384) return '[invalid/oversized]';
  try { return Buffer.from(value, 'base64').toString('utf8').slice(0, 2000); } catch { return '[invalid]'; }
}
async function main() {
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const goal = validateRefSwapGoal(find('goal.json')), journal = find('journal.json');
  if (goal.contract_id !== EXPECTED_VAULT || goal.owner_account_id !== EXPECTED_OWNER || goal.router_id !== EXPECTED_ROUTER ||
      journal.contract_id !== EXPECTED_VAULT || journal.owner_account_id !== EXPECTED_OWNER || !Array.isArray(journal.entries)) {
    throw new Error('original reviewed goal/journal identity mismatch');
  }
  const input = journal.entries.find(entry => entry.id === `${goal.id}-input`);
  const sweep = journal.entries.find(entry => entry.id === `${goal.id}-sweep`);
  if (input?.tx_hash !== EXPECTED_HASH || typeof input.agent_public_key !== 'string' || sweep) throw new Error('unexpected original input or prior sweep; stop and reconcile manually');
  const result = await provider.txStatusReceipts(EXPECTED_HASH, EXPECTED_OWNER, 'FINAL');
  const settlement = verifyFtCallSettlement(refSwapFtGoal(goal), result, input.agent_public_key);
  const outcomeById = new Map((result.receipts_outcome || []).map(item => [item.id, item.outcome]));
  const relevant = (result.receipts || []).flatMap(receipt => (receipt.receipt?.Action?.actions || []).flatMap(action => {
    const call = action.FunctionCall;
    if (!call || !['ft_transfer_call', 'ft_on_transfer', 'after_ref_input', 'ft_transfer'].includes(call.method_name)) return [];
    const out = outcomeById.get(receipt.receipt_id);
    return [{ id: receipt.receipt_id, predecessor: receipt.predecessor_id, receiver: receipt.receiver_id,
      method: call.method_name, args_base64: call.args, decoded_args: decode(call.args), deposit: call.deposit,
      status: out?.status, children: out?.receipt_ids, logs: out?.logs }];
  }));
  const [route, inputVault, outputVault, routerOutput, refDeposits] = await Promise.all([
    view(EXPECTED_ROUTER, 'get_route'), view(EXPECTED_VAULT, 'vault_balance', { token: REF_SWAP_INPUT }),
    view(EXPECTED_VAULT, 'vault_balance', { token: REF_SWAP_OUTPUT }),
    view(REF_SWAP_OUTPUT, 'ft_balance_of', { account_id: EXPECTED_ROUTER }),
    view(REF_SWAP_EXCHANGE, 'get_deposits', { account_id: EXPECTED_ROUTER }).catch(error => ({ unavailable: error.message })),
  ]);
  let output;
  try { output = verifyRefSwapOutput(goal, result, input.agent_public_key); }
  catch (error) { output = { unverified: error.message }; }
  const report = { original_hash: EXPECTED_HASH, owner: EXPECTED_OWNER, vault: EXPECTED_VAULT, router: EXPECTED_ROUTER,
    journal_input_status: input.status, sweep_recorded: false, settlement, route, input_vault: inputVault,
    output_vault: outputVault, router_output_balance: routerOutput, ref_internal_deposits: refDeposits,
    verified_output: output, scope: 'read_only_original_transaction_no_new_sweep_or_payment' };
  console.log(`::notice title=Original guarded Ref input inspection::${JSON.stringify(report)}`);
  for (const [index, item] of relevant.entries()) {
    const brief = { ...item, logs: item.logs?.map(line => String(line).slice(0, 700)) };
    const text = JSON.stringify(brief);
    if (text.length > 3800) throw new Error(`inspection receipt ${index} too large`);
    console.log(`::notice title=Original Ref receipt ${index} ${item.method}::${text}`);
  }
}
main().catch(error => {
  const text = String(error.stack || error).slice(0, 3000).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.error(`[original-ref-inspection] ${error.message}`); console.log(`::error title=Original guarded Ref inspection failed::${text}`); process.exitCode = 1;
});
