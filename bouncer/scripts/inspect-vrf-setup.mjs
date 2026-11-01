#!/usr/bin/env node
// READ ONLY: inspect the retained first VRF setup attempt. No keys, journal
// mutations, transactions, token funding, provider orders or retries.
import fs from 'node:fs';
import path from 'node:path';
import { PaymentRpcProvider } from '../agent/near-account.mjs';
import { openConfiguredFileJournal } from '../agent/procurement.mjs';
import { inspectOwnerSetupResult } from '../agent/testnet-owner-setup-evidence.mjs';

const VAULT = 'bouncer-ft-26ab535c.testnet', OWNER = 'owner.bouncer-ft-26ab535c.testnet';
const FAKE = 'usdc.fakes.testnet', WRAP = 'wrap.testnet', REF = 'ref-finance-101.testnet', OUTLAYER = 'outlayer.testnet';
const dir = process.argv[2];
if (!dir || process.argv.length !== 3) throw new Error('usage: node inspect-vrf-setup.mjs RETAINED_ARTIFACT_DIRECTORY');
function find(name, required = true) {
  const found = [];
  function visit(root, level) {
    if (level > 3) return;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) visit(file, level + 1);
      else if (entry.isFile() && entry.name === name) found.push(file);
    }
  }
  visit(dir, 0);
  if (found.length > 1 || (required && found.length !== 1)) throw new Error(`unexpected retained ${name} count`);
  return found[0];
}
const stages = [
  { id: 'owner-ref-acquisition', hash: '8i7kbWMcNSeKpnLCSP3vD3z9Dskczuzyvq58e3czAvWy', token: WRAP,
    receiver: REF, amount: '1000000000000000', status: 'completed' },
  { id: 'owner-fake-token-funding', hash: '6ugd3rKMSydqbBn4p44jgNzzjr1QNQKb9Fy8Yc8iqCwS', token: FAKE,
    receiver: VAULT, amount: '10000', status: 'completed', msg: 'fund' },
  { id: 'owner-wrap-refund-funding', hash: 'HUW8m6dQjyhBEr1KihELt6qXA92cuWzjSJ84q7AbRy3D', token: WRAP,
    receiver: VAULT, amount: '100000000000000000000', status: 'pending', msg: 'fund' },
];
async function main() {
  const identity = JSON.parse(fs.readFileSync(find('identity.json'), 'utf8'));
  if (identity.contract !== VAULT || identity.owner !== OWNER || typeof identity.owner_key !== 'string' ||
      typeof identity.contract_key !== 'string' || find('journal.json', false) || find('project-goal.json', false)) {
    throw new Error('retained identity or pre-provider-payment artifact differs from the reviewed run');
  }
  const journal = openConfiguredFileJournal(find('setup-journal.json'), VAULT, OWNER, { requireExisting: true });
  try {
    if (journal.data.entries.length !== stages.length) throw new Error('unexpected number of original setup stages');
    for (const stage of stages) {
      const entry = journal.get(stage.id), call = entry?.call;
      if (entry?.tx_hash !== stage.hash || entry.status !== stage.status || call?.signer_id !== OWNER ||
          call.public_key !== identity.owner_key || call.token !== stage.token || call.args?.receiver_id !== stage.receiver ||
          call.args?.amount !== stage.amount || (stage.msg !== undefined && call.args?.msg !== stage.msg)) {
        throw new Error(`retained ${stage.id} does not match its reviewed call`);
      }
    }
    const provider = new PaymentRpcProvider(process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com');
    if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
    const final = { finality: 'final' };
    const view = (account, method, args = {}) => provider.callFunction(account, method, args, final);
    const [ownerAccess, vaultAccess, tokenLedger, tokenVault, wrapLedger, ownerWrap, providerCredit, ...settlements] = await Promise.all([
      provider.viewAccessKey(OWNER, identity.owner_key, final), provider.viewAccessKey(VAULT, identity.contract_key, final),
      view(VAULT, 'vault_balance', { token: FAKE }), view(FAKE, 'ft_balance_of', { account_id: VAULT }),
      view(VAULT, 'vault_balance', { token: WRAP }), view(WRAP, 'ft_balance_of', { account_id: OWNER }),
      view(OUTLAYER, 'get_user_stablecoin_balance', { account_id: VAULT }),
      ...stages.map(async stage => {
        let result;
        try { result = await provider.txStatusReceipts(stage.hash, OWNER, 'FINAL'); }
        catch { return { tx_hash: stage.hash, status: 'UNRESOLVED_OR_UNAVAILABLE', do_not_resend: true }; }
        if (result?.final_execution_status !== 'FINAL') return { tx_hash: stage.hash, status: 'UNRESOLVED_OR_UNAVAILABLE', do_not_resend: true };
        return { ...inspectOwnerSetupResult(journal.get(stage.id), result), do_not_resend: true };
      }),
    ]);
    if (ownerAccess?.permission !== 'FullAccess' || vaultAccess?.permission !== 'FullAccess') throw new Error('retained public keys do not match FINAL account permissions');
    const result = { vault: VAULT, owner: OWNER, stages: settlements, fake_vault_ledger: tokenLedger, fake_vault_token: tokenVault,
      wrap_vault_ledger: wrapLedger, owner_wrap_balance: ownerWrap, outlayer_prepaid_balance: providerCredit,
      owner_and_deploy_public_keys_match: true, sends: 0, journal_writes: 0,
      scope: 'read-only original setup inspection; unknown/expired hash is not proof of non-payment; no provider order or new payment' };
    console.log(`::notice title=Original VRF setup reinspection::${JSON.stringify(result)}`);
  } finally { journal.close(); }
}
main().catch(error => {
  const text = String(error.message).slice(0, 2000).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.error(`[vrf-setup-reinspection] ${error.message}`);
  console.log(`::error title=VRF setup reinspection failed::${text}`); process.exitCode = 1;
});
