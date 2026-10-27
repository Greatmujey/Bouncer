import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import nodeHttp from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nearApi from 'near-api-js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createBouncerMcpServer, createBouncerHttpApp } from '../mcp/server.mjs';
import { orderMemo } from '../services/resource-provider.mjs';

const publicKey = nearApi.KeyPair.fromRandom('ed25519').getPublicKey().toString();
const exampleGoal = () => ({ id: 'one', resource: 'compute', policy_id: 'compute', token: 'wrap.testnet', payee: 'vendor.testnet', max_amount: '100', input: { text: 'test', rounds: 2 } });
const args = () => ({ contract_id: 'bouncer.testnet', owner_account_id: 'bouncer.testnet', agent_public_key: publicKey, goals: [exampleGoal()] });
const quote = ({ resource, input }) => ({ resource, policy_id: 'compute', token: 'wrap.testnet', payee: 'vendor.testnet', amount: '80', memo: orderMemo(resource, input) });
function mockProvider(options = {}) {
  return {
    async viewNodeStatus() { return { chain_id: options.chain || 'testnet' }; },
    async viewAccessKey(_account, key, final) {
      assert.equal(key.toString(), publicKey); assert.deepEqual(final, { finality: 'final' });
      return { permission: { FunctionCall: { receiver_id: 'bouncer.testnet', method_names: options.keyMethods || ['execute'] } } };
    },
    async callFunction(contract, method, _args, final) {
      assert.equal(contract, 'bouncer.testnet'); assert.deepEqual(final, { finality: 'final' });
      if (method === 'contract_version') return options.version || 'bouncer-agent-v4';
      if (method === 'get_policy') return { token: 'wrap.testnet', per_tx_cap: '100', daily_cap: '1000' };
      if (method === 'daily_spent') return '200';
      if (method === 'vault_balance') return '800';
      if (method === 'is_agent_key_allowed') return options.allowed !== false;
      if (method === 'check') return options.blocked ? [false, 'BLOCKED: payee not in allowlist'] : [true, 'ok'];
      throw new Error(`unexpected view ${method}`);
    },
  };
}
async function memoryClient(options = {}) {
  const server = createBouncerMcpServer(options);
  const client = new Client({ name: 'bouncer-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test('MCP handshake lists read-only tools, actual context and no spending tools', async () => {
  const { client, close } = await memoryClient({ provider: mockProvider() });
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name), ['bouncer_about', 'bouncer_inspect_policy', 'bouncer_preview_goals']);
    assert.ok(tools.every(t => t.annotations.readOnlyHint));
    assert.equal(tools.some(t => /pay|execute|redeem|withdraw|key_file/.test(t.name)), false);
    const about = await client.callTool({ name: 'bouncer_about', arguments: {} });
    assert.match(about.structuredContent.purpose, /compute, storage and API/);
    assert.match(about.structuredContent.evidence.type, /historical/);
    assert.ok(about.structuredContent.mcp_cannot.includes('spend or redeem'));
  } finally { await close(); }
});

test('policy inspection uses final views and refuses wrong network, versions and bad IDs', async () => {
  const { client, close } = await memoryClient({ provider: mockProvider() });
  try {
    const out = await client.callTool({ name: 'bouncer_inspect_policy', arguments: { contract_id: 'bouncer.testnet', policy_id: 'compute' } });
    assert.equal(out.structuredContent.rolling_spent, '200');
    assert.equal(out.structuredContent.vault_balance, '800');
    assert.equal(out.structuredContent.policy.per_tx_cap, '100');
    const bad = await client.callTool({ name: 'bouncer_inspect_policy', arguments: { contract_id: 'bouncer.near', policy_id: 'compute' } });
    assert.equal(bad.isError, true);
  } finally { await close(); }
  for (const options of [{ chain: 'mainnet' }, { version: 'wrong' }]) {
    const pair = await memoryClient({ provider: mockProvider(options) });
    try {
      const out = await pair.client.callTool({ name: 'bouncer_inspect_policy', arguments: { contract_id: 'bouncer.testnet', policy_id: 'compute' } });
      assert.equal(out.isError, true);
    } finally { await pair.close(); }
  }
});

test('goal preview invokes the real quote and preflight path without a signer or fulfillment', async () => {
  let quotes = 0;
  const { client, close } = await memoryClient({ provider: mockProvider(), getQuote: async order => { quotes++; return quote(order); } });
  try {
    const out = await client.callTool({ name: 'bouncer_preview_goals', arguments: args() });
    assert.equal(quotes, 1);
    assert.equal(out.structuredContent.mode, 'dry-run only; nothing paid or delivered');
    assert.deepEqual(out.structuredContent.summary, { paid: 0, blocked: 0, skipped: 0, ready: 1 });
    assert.deepEqual(out.structuredContent.checks, [{ id: 'one', status: 'READY' }]);
    assert.equal(out.structuredContent.plan.requests[0].memo, orderMemo('compute', exampleGoal().input));
    assert.match(out.structuredContent.warning, /not owner approval/);
  } finally { await close(); }
});

test('quote mismatches, unauthorized keys and blocked policies do not turn into purchases', async () => {
  for (const options of [
    { provider: mockProvider(), getQuote: async order => ({ ...quote(order), payee: 'attacker.testnet' }) },
    { provider: mockProvider({ keyMethods: ['execute', 'set_policy'] }), getQuote: async order => quote(order) },
    { provider: mockProvider({ allowed: false }), getQuote: async order => quote(order) },
    { provider: mockProvider(), getQuote: undefined },
  ]) {
    const { client, close } = await memoryClient(options);
    try { assert.equal((await client.callTool({ name: 'bouncer_preview_goals', arguments: args() })).isError, true); }
    finally { await close(); }
  }
  const { client, close } = await memoryClient({ provider: mockProvider({ blocked: true }), getQuote: async order => quote(order) });
  try {
    const out = await client.callTool({ name: 'bouncer_preview_goals', arguments: args() });
    assert.equal(out.structuredContent.summary.blocked, 1);
    assert.deepEqual(out.structuredContent.checks, [{ id: 'one', status: 'BLOCKED' }]);
    assert.equal(out.structuredContent.summary.paid, 0);
  } finally { await close(); }
});

test('startup rejects credential-bearing operator URLs without leaking them', () => {
  const entry = fileURLToPath(new URL('../mcp/server.mjs', import.meta.url));
  for (const [name, value] of [
    ['NEAR_TESTNET_RPC', 'https://rpc.example/?key=supersecret'],
    ['NEAR_TESTNET_RPC', 'https://user:supersecret@rpc.example/'],
    ['BOUNCER_MCP_PROVIDER_URL', 'https://provider.example/?key=supersecret'],
    ['BOUNCER_MCP_PROVIDER_URL', 'http://remote.example/'],
  ]) {
    const result = spawnSync(process.execPath, [entry], { env: { PATH: process.env.PATH, [name]: value }, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /supersecret/);
    assert.equal(result.stdout, '');
  }
});

test('project client configurations use the read-only local server without auto-approval', async () => {
  const claude = JSON.parse(fs.readFileSync(new URL('../../.mcp.json', import.meta.url), 'utf8')).mcpServers.bouncer;
  const gemini = JSON.parse(fs.readFileSync(new URL('../../.gemini/settings.json', import.meta.url), 'utf8')).mcpServers.bouncer;
  assert.deepEqual(claude, { type: 'stdio', command: 'node', args: ['bouncer/mcp/server.mjs'] });
  assert.deepEqual(gemini, { command: 'node', args: ['bouncer/mcp/server.mjs'], trust: false });
});

test('actual stdio MCP client starts the server and talks JSON-RPC without private keys', async () => {
  const serverPath = fileURLToPath(new URL('../mcp/server.mjs', import.meta.url));
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], cwd: path.dirname(serverPath), stderr: 'pipe' });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 3);
    assert.equal((await client.callTool({ name: 'bouncer_about', arguments: {} })).structuredContent.network, 'NEAR testnet only');
  } finally { await client.close(); }
});

test('HTTP MCP requires a strong bearer token and rejects cross-origin and DNS rebinding', async () => {
  assert.throws(() => createBouncerHttpApp({ token: 'short' }), /randomly generated/);
  const token = 'a'.repeat(43); // Deterministic test value only; production tokens must be random.
  const app = createBouncerHttpApp({ token, serverFactory: () => createBouncerMcpServer({ provider: mockProvider() }) });
  const http = app.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const url = `http://127.0.0.1:${http.address().port}/mcp`;
  try {
    const request = (headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
    assert.equal((await request()).status, 401);
    assert.equal((await request({ authorization: `Bearer ${'b'.repeat(43)}` })).status, 401);
    assert.equal((await request({ authorization: `Bearer ${token}`, origin: 'https://attacker.example' })).status, 403);
    const rebindingStatus = await new Promise((resolve, reject) => {
      const req = nodeHttp.request(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, host: 'attacker.example', 'content-type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end('{}');
    });
    assert.equal(rebindingStatus, 403);
    const client = new Client({ name: 'http-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
    try {
      await client.connect(transport);
      assert.equal((await client.listTools()).tools.length, 3);
      const out = await client.callTool({ name: 'bouncer_about', arguments: {} });
      assert.equal(out.structuredContent.network, 'NEAR testnet only');
    } finally { await client.close(); }
  } finally { await new Promise(resolve => http.close(resolve)); }
});
