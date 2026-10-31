// Read-only reconciliation of an already journaled paid-project transaction.
// No signer, send method, journal write, or automatic retry of a payment exists
// here. Unknown/expired is unresolved, NOT evidence that payment did not occur.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { validateProjectGoal, verifyProjectResult } from '../agent/outlayer-project.mjs';
import { validateRpcEndpoint } from '../shared/rpc-endpoint.mjs';
import { readBoundedJson } from '../shared/bounded-json.mjs';

const escapeAnnotation = value => String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
function validHash(hash) {
  try { return typeof hash === 'string' && nearApi.utils.serialize.base_decode(hash).length === 32; }
  catch { return false; }
}
export function selectJournalProject(rawGoal, journal) {
  const goal = validateProjectGoal(rawGoal);
  if (!journal || journal.version !== 1 || journal.contract_id !== goal.contract_id ||
      journal.owner_account_id !== goal.owner_account_id || !Array.isArray(journal.entries)) throw new Error('journal belongs to a different owner or contract');
  const entries = journal.entries.filter(entry => entry?.id === goal.id);
  if (entries.length !== 1 || !['pending', 'completed'].includes(entries[0].status)) throw new Error('journal has no unique pending or completed project');
  const entry = entries[0];
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(goal)).digest('hex');
  if (entry.fingerprint !== fingerprint || !isDeepStrictEqual(validateProjectGoal(entry.project_goal), goal)) throw new Error('journal does not match the reviewed project');
  if (!validHash(entry.tx_hash) || typeof entry.agent_public_key !== 'string') throw new Error('journal has no valid transaction hash or key');
  try { nearApi.utils.PublicKey.fromString(entry.agent_public_key); } catch { throw new Error('journal has an invalid signing key'); }
  return { goal, entry };
}
async function rpc(endpoint, method, params) {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'project-reconcile', method, params }), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${method}: RPC HTTP ${response.status}`);
  const body = await readBoundedJson(response, { maxBytes: 4_000_000, label: method });
  if (body?.error || !body || !Object.hasOwn(body, 'result')) throw new Error(`${method}: RPC error ${JSON.stringify(body?.error ?? 'missing result').slice(0, 400)}`);
  return body.result;
}
function confirmTransaction(goal, entry, result) {
  const tx = result?.transaction, action = tx?.actions?.[0]?.FunctionCall;
  if (result?.final_execution_status !== 'FINAL' || result?.transaction_outcome?.id !== entry.tx_hash || tx?.hash !== entry.tx_hash || tx?.signer_id !== goal.owner_account_id ||
      tx?.receiver_id !== goal.contract_id || tx?.public_key !== entry.agent_public_key || tx?.actions?.length !== 1 ||
      action?.method_name !== 'execute_outlayer_project' || String(action.deposit) !== '0') throw new Error('RPC returned a different project transaction');
  let args;
  try { args = JSON.parse(Buffer.from(action.args, 'base64').toString('utf8')); } catch { throw new Error('invalid project transaction arguments'); }
  if (!isDeepStrictEqual(args, { native_policy_id: goal.native_policy_id, amount: goal.amount, expected_route: goal.route })) {
    throw new Error('transaction arguments differ from the reviewed project');
  }
}
export async function reconcileProject({ goal, entry, endpoints }) {
  const failures = [];
  for (const rawEndpoint of endpoints) {
    const endpoint = validateRpcEndpoint(rawEndpoint);
    try {
      if ((await rpc(endpoint, 'status', []))?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
      const chain = await rpc(endpoint, 'EXPERIMENTAL_tx_status', { tx_hash: entry.tx_hash, sender_account_id: goal.owner_account_id, wait_until: 'FINAL' });
      confirmTransaction(goal, entry, chain);
      if (chain.status?.Failure) return { status: 'FINAL_FAILED', endpoint, tx_hash: entry.tx_hash,
        failure: JSON.stringify(chain.status.Failure).slice(0, 1000), warning: 'failure alone does not prove that no downstream payment occurred' };
      const delivery = verifyProjectResult(goal, chain, entry.agent_public_key);
      if (delivery.tx_hash !== entry.tx_hash) throw new Error('verified delivery hash differs from journal');
      if (entry.status === 'completed' && !isDeepStrictEqual(entry.delivery, delivery)) throw new Error('recorded delivery differs from chain');
      return { status: 'VERIFIED', endpoint, delivery };
    } catch (error) { failures.push(`${endpoint}: ${error.message}`); }
  }
  throw new Error(`transaction remains unresolved; never resend automatically: ${failures.join('; ')}`);
}
function readJson(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.length > 2_000_000) throw new Error('journal or goal file is too large');
  return JSON.parse(bytes.toString('utf8'));
}
async function main() {
  if (process.argv.length !== 4) throw new Error('usage: reconcile-project-journal.mjs JOURNAL.json PROJECT-GOAL.json');
  const { goal, entry } = selectJournalProject(readJson(process.argv[3]), readJson(process.argv[2]));
  console.log(`::notice title=Existing paid-project journal::${escapeAnnotation(JSON.stringify({ contract: goal.contract_id, owner: goal.owner_account_id,
    project: goal.route.project.project_id, goal: goal.id, tx_hash: entry.tx_hash, agent_public_key: entry.agent_public_key,
    status: entry.status, new_sends: 0, do_not_resend: true }))}`);
  const endpoints = process.env.NEAR_TESTNET_RPC ? [process.env.NEAR_TESTNET_RPC] : ['https://archival-rpc.testnet.near.org', 'https://test.rpc.fastnear.com'];
  const report = await reconcileProject({ goal, entry, endpoints });
  console.log(`::notice title=Read-only paid-project reconciliation::${escapeAnnotation(JSON.stringify(report))}`);
  if (report.status !== 'VERIFIED') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error(`[project-reconcile] ${error.message}`);
  console.log(`::error title=Paid-project remains unresolved::${escapeAnnotation(error.message)}`);
  process.exitCode = 1;
});
