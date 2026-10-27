import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import nearApi from 'near-api-js';
import { RUN } from '../web/evidence.mjs';

const execFileAsync = promisify(execFile);

test('live MCP smoke exercises the real quote server and read-only protocol against a mock RPC', async () => {
  const publicKey = nearApi.KeyPair.fromRandom('ed25519').getPublicKey().toString();
  const permission = { FunctionCall: { receiver_id: RUN.account, method_names: ['execute'], allowance: '1000000000000000000000000' } };
  const methods = [];
  const metadata = { block_height: 1, block_hash: '11111111111111111111111111111111' };
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const call = JSON.parse(Buffer.concat(chunks).toString());
      methods.push(call.method);
      let result;
      if (call.method === 'status') result = { chain_id: 'testnet' };
      else if (call.method === 'query' && call.params.request_type === 'view_access_key_list') {
        result = { ...metadata, keys: [{ public_key: publicKey, access_key: { nonce: 0, permission } }] };
      } else if (call.method === 'query' && call.params.request_type === 'view_access_key') {
        result = { ...metadata, nonce: 0, permission };
      } else if (call.method === 'query' && call.params.request_type === 'call_function') {
        const { method_name: method, args_base64: encoded } = call.params;
        const args = JSON.parse(Buffer.from(encoded, 'base64').toString());
        const resource = RUN.resources.find(r => r.policy === args.policy_id || r.token === args.token);
        let value;
        if (method === 'contract_version') value = 'bouncer-agent-v4';
        else if (method === 'is_agent_key_allowed') value = args.public_key === publicKey;
        else if (method === 'get_policy') value = { token: resource.token, per_tx_cap: resource.perTx, daily_cap: resource.daily };
        else if (method === 'daily_spent') value = '0';
        else if (method === 'vault_balance') value = resource.vault;
        else if (method === 'check') value = [BigInt(args.amount) <= BigInt(resource.perTx) && args.payee === resource.vendor, 'mock verdict'];
        else throw new Error(`Unexpected view method ${method}`);
        result = { ...metadata, logs: [], result: [...Buffer.from(JSON.stringify(value))] };
      } else throw new Error(`Unexpected RPC method ${call.method}`);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
    } catch (error) {
      res.writeHead(500).end(error.message);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const rpc = `http://127.0.0.1:${server.address().port}`;
    const script = fileURLToPath(new URL('../scripts/test-mcp-testnet.mjs', import.meta.url));
    const { stdout } = await execFileAsync(process.execPath, [script], {
      env: { PATH: process.env.PATH, NEAR_TESTNET_RPC: rpc }, timeout: 25_000,
    });
    assert.match(stdout, /three-resource quote\/preflight passed; an over-cap quote was blocked/);
    assert.ok(methods.includes('status'));
    assert.ok(methods.includes('query'));
    assert.ok(methods.every(method => ['status', 'query'].includes(method)), 'no RPC transaction submission');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
