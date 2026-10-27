// Opt-in live, read-only MCP check. Public key only; no signing or transaction.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nearApi from 'near-api-js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startConfiguredProvider } from '../services/resource-provider.mjs';
import { RUN } from '../web/evidence.mjs';

const rpcUrl = process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com';
const rpc = new nearApi.providers.JsonRpcProvider({ url: rpcUrl }, { retries: 1 });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-mcp-testnet-'));
let devProvider, client;
try {
  assert.equal((await rpc.viewNodeStatus()).chain_id, 'testnet', 'refusing a non-testnet RPC');
  // Find the PUBLIC execute-only key still authorized to the historical
  // deployment's three policies. No private key is loaded or needed.
  const keyList = await rpc.viewAccessKeyList(RUN.account, { finality: 'final' });
  const candidates = keyList.keys.filter(({ access_key }) => {
    const permission = access_key.permission?.FunctionCall;
    return permission?.receiver_id === RUN.account && JSON.stringify(permission.method_names) === JSON.stringify(['execute']);
  });
  let publicKey;
  for (const item of candidates) {
    const allowed = await Promise.all(RUN.resources.map(r => rpc.callFunction(RUN.account, 'is_agent_key_allowed', {
      policy_id: r.policy, public_key: item.public_key,
    }, { finality: 'final' })));
    if (allowed.every(Boolean)) { publicKey = item.public_key; break; }
  }
  if (!publicKey) throw new Error('No public execute-only key is still authorized for all three recorded policies');

  const products = Object.fromEntries(RUN.resources.map(r => [r.id, {
    policy_id: r.policy, token: r.token, payee: r.vendor, amount: r.amount,
  }]));
  devProvider = await startConfiguredProvider({ contract_id: RUN.account, data_dir: temp, port: 0, products });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL('../mcp/server.mjs', import.meta.url))],
    env: { NEAR_TESTNET_RPC: rpcUrl, BOUNCER_MCP_PROVIDER_URL: devProvider.url },
  });
  client = new Client({ name: 'bouncer-testnet-check', version: '0.1.0' });
  await client.connect(transport);
  const out = await client.callTool({ name: 'bouncer_inspect_policy', arguments: { contract_id: RUN.account, policy_id: RUN.resources[0].policy } });
  if (out.isError) throw new Error(out.content?.[0]?.text || 'MCP policy view failed');
  assert.equal(out.structuredContent.contract_version, 'bouncer-agent-v4');
  assert.equal(out.structuredContent.policy.token, 'wrap.testnet');
  assert.match(out.structuredContent.rolling_spent, /^\d+$/);
  assert.match(out.structuredContent.vault_balance, /^\d+$/);

  const inputs = {
    compute: { text: 'MCP testnet preview', rounds: 2 },
    storage: { name: 'mcp-preview', content: 'read-only test' },
    api: { text: 'MCP read-only preview' },
  };
  const goals = RUN.resources.map(r => ({
    id: `preview-${r.id}`, resource: r.id, policy_id: r.policy, token: r.token,
    payee: r.vendor, max_amount: r.amount, input: inputs[r.id],
  }));
  const balancesBefore = await Promise.all(RUN.resources.map(r => rpc.callFunction(RUN.account, 'vault_balance', { token: r.token }, { finality: 'final' })));
  const args = { contract_id: RUN.account, owner_account_id: RUN.account, agent_public_key: publicKey, goals };
  const preview = await client.callTool({ name: 'bouncer_preview_goals', arguments: args });
  if (preview.isError) throw new Error(preview.content?.[0]?.text || 'MCP quote/preflight failed');
  assert.deepEqual(preview.structuredContent.summary, { paid: 0, blocked: 0, skipped: 0, ready: 3 });
  assert.deepEqual(preview.structuredContent.checks.map(c => c.status), ['READY', 'READY', 'READY']);
  assert.deepEqual(preview.structuredContent.plan.requests.map(r => r.resource), ['compute', 'storage', 'api']);

  // Quote one unit above the actual per-transaction cap; the same on-chain
  // check must block the preview instead of marking it ready.
  const overCap = (BigInt(RUN.resources[0].perTx) + 1n).toString();
  products.compute.amount = overCap;
  const blocked = await client.callTool({ name: 'bouncer_preview_goals', arguments: {
    ...args, goals: [{ ...goals[0], id: 'over-cap', max_amount: overCap }],
  } });
  if (blocked.isError) throw new Error(blocked.content?.[0]?.text || 'MCP over-cap preview failed');
  assert.equal(blocked.structuredContent.summary.blocked, 1);
  assert.deepEqual(blocked.structuredContent.checks.map(c => c.status), ['BLOCKED']);
  const balancesAfter = await Promise.all(RUN.resources.map(r => rpc.callFunction(RUN.account, 'vault_balance', { token: r.token }, { finality: 'final' })));
  assert.deepEqual(balancesAfter, balancesBefore, 'read-only previews must not change recorded vault balances');
  console.log('Live MCP policy read and three-resource quote/preflight passed; an over-cap quote was blocked. No transaction sent.');
  console.log('::notice title=Bouncer live MCP check::Testnet policy, three-resource quote/preflight and over-cap rejection passed; no transaction or private key was used.');
} finally {
  if (client) await client.close();
  if (devProvider) await new Promise((resolve, reject) => devProvider.server.close(error => error ? reject(error) : resolve()));
  fs.rmSync(temp, { recursive: true, force: true });
}
