#!/usr/bin/env node
/** READ ONLY: inspect the original VRF2 setup, never sign, send, create an
 * account, mutate a journal or infer non-payment from an unavailable hash. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { PaymentRpcProvider } from '../agent/near-account.mjs';
import { inspectOwnerSetupResult } from '../agent/testnet-owner-setup-evidence.mjs';
import { verifyTestnetProbeSetupResult } from '../agent/testnet-probe-submit.mjs';

const VAULT = 'bouncer-vrf2-3a0af45958.testnet', OWNER = 'owner-vrf2-3a0af45958.testnet';
const TOKEN = 'usdc.fakes.testnet', WRAP = 'wrap.testnet', OUTLAYER = 'outlayer.testnet';
const OWNER_KEY = 'ed25519:52oq2ywGuL3QCPf8huZNxkXoxyWpLr1HN4JLQ3cLayMt';
const VAULT_KEY = 'ed25519:97ajBHdm3CKq69r5e5Hh92m31MZv8dgf9Mnn4x1CnMoF';
const CODE_HASH = '9qpU6d6MHZZXC2ivtQt3k3scGkiHLkkMnaTAiZWbaL6y';
const ORIGINAL_FUNDING = 'uhtVNNJewFmpTSVzZ7fr8ReZnvmVenjWcm92XafQRHn';
const STAGES = [
  { id: 'deployment', hash: 'HVjXdBKJuf7xAyM3ngW6pwmDQagzJKCj73ZPtTFznTBD', signer: VAULT, receiver: VAULT, key: VAULT_KEY },
  { id: 'register-wrap', hash: 'HDZwmZoLe8idGHJbUY6C6xjWtBHchVWASoe5Ds1DURns', signer: OWNER, receiver: WRAP, key: OWNER_KEY },
  { id: 'register-fake', hash: 'HYx2mgFhnHicLbgGm9qLtLnk2ESKevfhEkPefcJTwwHd', signer: OWNER, receiver: TOKEN, key: OWNER_KEY },
  { id: 'wrap-owner', hash: 'EmeBtEciR6KF6FMpuGVp7zqnDxntEuTtB4fGohXE4iPQ', signer: OWNER, receiver: WRAP, key: OWNER_KEY },
  { id: 'owner-ref-acquisition', hash: '7e98XZEL8XNEZbNGpfDEPu2A2QAXxeKScR6C1jipCzqW', signer: OWNER, receiver: WRAP, key: OWNER_KEY },
  { id: 'owner-fake-funding', hash: ORIGINAL_FUNDING, signer: OWNER, receiver: TOKEN, key: OWNER_KEY },
];
const equal = isDeepStrictEqual;
function decode(value) {
  if (typeof value !== 'string' || value.length > 16384) throw new Error('missing bounded base64 receipt value');
  const raw = Buffer.from(value, 'base64');
  if (raw.toString('base64') !== value) throw new Error('noncanonical receipt value');
  try { return JSON.parse(raw.toString('utf8')); } catch { throw new Error('invalid receipt JSON'); }
}

/** Verify exact owner funding action and linked token-to-vault callback. */
export function inspectVrf2OriginalFunding(result) {
  const call = { signer_id: OWNER, public_key: OWNER_KEY, token: TOKEN, method: 'ft_transfer_call',
    args: { receiver_id: VAULT, amount: '10000', msg: 'fund' }, gas: '200000000000000', deposit: '1' };
  const entry = { kind: 'testnet-owner-setup-v1', status: 'pending', tx_hash: ORIGINAL_FUNDING, call,
    fingerprint: crypto.createHash('sha256').update(JSON.stringify(call)).digest('hex') };
  const proof = inspectOwnerSetupResult(entry, result);
  if (proof.status !== 'FINAL_SUCCESS') return { ...proof, vault_callback_verified: false, used: null };
  if (decode(result.status.SuccessValue) !== '10000' || !Array.isArray(result.receipts)) throw new Error('original FT setup did not establish full used amount');
  const received = result.receipts.flatMap(receipt => {
    const action = receipt?.receipt?.Action?.actions;
    if (receipt.predecessor_id !== TOKEN || receipt.receiver_id !== VAULT || !Array.isArray(action) || action.length !== 1 ||
        action[0]?.FunctionCall?.method_name !== 'ft_on_transfer') return [];
    const value = action[0].FunctionCall;
    if (String(value.deposit) !== '0' || !equal(decode(value.args), { sender_id: OWNER, amount: '10000', msg: 'fund' })) return [];
    return [receipt];
  });
  if (received.length !== 1) throw new Error('missing unique token-to-vault funding receipt');
  const roots = result.receipts_outcome.filter(item => result.transaction_outcome?.outcome?.receipt_ids?.includes(item.id) &&
    item.outcome?.executor_id === TOKEN && item.outcome?.receipt_ids?.includes(received[0].receipt_id));
  if (roots.length !== 1) throw new Error('token-to-vault funding is not linked to the original transaction');
  const outcome = result.receipts_outcome.filter(item => item.id === received[0].receipt_id && item.outcome?.executor_id === VAULT);
  if (outcome.length !== 1 || !outcome[0].outcome.logs?.includes('BOUNCER deposit received') ||
      decode(outcome[0].outcome.status?.SuccessValue) !== '0') throw new Error('vault funding callback is missing or mismatched');
  return { ...proof, used: '10000', vault_callback_verified: true, vault_callback_receipt: received[0].receipt_id };
}

async function inspectStage(providers, stage) {
  const responses = await Promise.all(providers.map(async ({ name, provider }) => {
    try { return { name, result: await provider.txStatusReceipts(stage.hash, stage.signer, 'FINAL') }; }
    catch { return { name, result: null }; }
  }));
  const available = responses.filter(item => item.result?.final_execution_status === 'FINAL');
  if (!available.length) return { id: stage.id, tx_hash: stage.hash, status: 'UNRESOLVED_OR_UNAVAILABLE',
    endpoints_queried: responses.map(x => x.name), do_not_resend: true };
  const details = available.map(({ name, result }) => {
    const proof = stage.id === 'owner-fake-funding' ? inspectVrf2OriginalFunding(result) :
      verifyTestnetProbeSetupResult({ result, txHash: stage.hash, signerId: stage.signer, receiverId: stage.receiver, publicKey: stage.key });
    return { name, proof };
  });
  if (details.length > 1 && !details.every(item => equal(item.proof, details[0].proof))) throw new Error(`${stage.id}: FINAL endpoint proofs disagree`);
  return { id: stage.id, tx_hash: stage.hash, status: details[0].proof.status || 'FINAL_SUCCESS', proof: details[0].proof,
    verified_by: details.map(x => x.name), do_not_resend: true };
}

async function main() {
  const dir = process.argv[2]; if (!dir || process.argv.length !== 3) throw new Error('usage: node inspect-vrf2-setup.mjs RETAINED-DIR');
  const read = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  const identity = read('identity.json');
  if (identity.vault !== VAULT || identity.owner !== OWNER || identity.vault_public_key !== VAULT_KEY || identity.owner_public_key !== OWNER_KEY ||
      identity.vault_code_hash !== CODE_HASH || identity.seed !== 'bouncer_vrf2_a268326b8e2c59f1d9446b3cffc0bfa5' ||
      identity.purpose !== 'fresh-testnet-fake-token-independent-vrf-diagnostic') throw new Error('retained public identity differs from original run');
  for (const stage of STAGES) {
    const intent = read(`${stage.id}-intent.json`);
    if (intent.id !== stage.id || intent.tx_hash !== stage.hash || intent.signer_id !== stage.signer ||
        intent.receiver_id !== stage.receiver || intent.public_key !== stage.key) throw new Error(`${stage.id}: retained intent differs from original hash`);
  }
  for (const absent of ['provider-prepaid-funding-intent.json', 'independent-vrf-diagnostic-intent.json']) {
    if (fs.existsSync(path.join(dir, absent))) throw new Error('unexpected provider payment intent in pre-provider artifact');
  }
  const providers = [
    { name: 'fastnear', provider: new PaymentRpcProvider('https://test.rpc.fastnear.com', { receiptTimeoutMs: 60_000 }) },
    { name: 'near-archival', provider: new PaymentRpcProvider('https://archival-rpc.testnet.near.org', { receiptTimeoutMs: 60_000 }) },
  ];
  for (const { provider } of providers) if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('inspection RPC did not report testnet');
  const primary = providers[0].provider;
  const [account, stages] = await Promise.all([
    primary.query({ request_type: 'view_account', account_id: VAULT, finality: 'final' }),
    Promise.all(STAGES.map(stage => inspectStage(providers, stage))),
  ]);
  if (account?.code_hash !== CODE_HASH || typeof account.block_hash !== 'string') throw new Error('vault code or FINAL block does not match original identity');
  const at = { blockId: account.block_hash }, view = (id, method, args = {}) => primary.callFunction(id, method, args, at);
  const [keys, ownerAccess, vaultLedger, vaultToken, ownerToken, providerCredit, fundingPolicy, projectPolicy, nativeBalance] = await Promise.all([
    primary.query({ request_type: 'view_access_key_list', account_id: VAULT, ...at }), primary.viewAccessKey(OWNER, OWNER_KEY, at),
    view(VAULT, 'vault_balance', { token: TOKEN }), view(TOKEN, 'ft_balance_of', { account_id: VAULT }),
    view(TOKEN, 'ft_balance_of', { account_id: OWNER }), view(OUTLAYER, 'get_user_stablecoin_balance', { account_id: VAULT }),
    view(VAULT, 'get_policy', { policy_id: 'provider-funding' }), view(VAULT, 'get_policy', { policy_id: 'project-token' }),
    view(VAULT, 'vault_balance', { token: 'native' }),
  ]);
  if (!Array.isArray(keys?.keys) || keys.keys.length || keys.block_hash !== account.block_hash || ownerAccess?.permission !== 'FullAccess') {
    throw new Error('original vault or owner access keys do not match FINAL views');
  }
  const report = { vault: VAULT, owner: OWNER, block_hash: account.block_hash, vault_code_hash: account.code_hash,
    vault_deployment_key_removed: true, owner_key_matches: true, stages, vault_ledger: vaultLedger, vault_fake_token: vaultToken,
    owner_fake_token: ownerToken, provider_prepaid: providerCredit, provider_funding_policy: fundingPolicy,
    project_token_policy: projectPolicy, vault_native_balance: nativeBalance, sends: 0, journal_writes: 0,
    scope: 'read-only original hashes and same-block state; unavailable hash is not proof of non-payment; no new provider deposit or project order' };
  console.log(`::notice title=Original VRF2 setup reinspection::${JSON.stringify(report).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { const text = String(error.message || error).slice(0, 2000).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    console.error(`[inspect-vrf2-setup] ${error.message}`); console.log(`::error title=Original VRF2 setup reinspection failed::${text}`); process.exitCode = 1; });
}
