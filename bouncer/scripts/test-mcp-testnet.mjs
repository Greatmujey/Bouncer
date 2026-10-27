// Opt-in live read-only MCP check. This submits no transaction and needs no key.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { RUN } from '../web/evidence.mjs';

const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../mcp/server.mjs', import.meta.url))] });
const client = new Client({ name: 'bouncer-testnet-check', version: '1.0.0' });
try {
  await client.connect(transport);
  const out = await client.callTool({ name: 'bouncer_inspect_policy', arguments: { contract_id: RUN.account, policy_id: RUN.resources[0].policy } });
  if (out.isError) throw new Error(out.content?.[0]?.text || 'MCP policy view failed');
  assert.equal(out.structuredContent.contract_version, 'bouncer-agent-v4');
  assert.equal(out.structuredContent.policy.token, 'wrap.testnet');
  assert.match(out.structuredContent.rolling_spent, /^\d+$/);
  assert.match(out.structuredContent.vault_balance, /^\d+$/);
  console.log(`MCP read-only testnet policy view passed: ${RUN.account}, ${RUN.resources[0].policy}. No transaction sent.`);
  console.log(`::notice title=Bouncer live MCP check::Read-only stdio MCP queried the existing v4 testnet policy; no key or transaction was used.`);
} finally { await client.close(); }
