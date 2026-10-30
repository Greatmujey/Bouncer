import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/verify-project-history.mjs', import.meta.url));
async function execute(reply) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(reply(body)));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const child = spawn(process.execPath, [script], { env: { ...process.env, NEAR_TESTNET_RPC: `http://127.0.0.1:${server.address().port}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const [code, signal] = await once(child, 'close');
    return { requests, code, signal, stdout, stderr };
  } finally { await new Promise(resolve => server.close(resolve)); }
}

test('historical connector check uses read-only FINAL receipt RPC and reports unavailability, never broadcasts', async () => {
  const result = await execute(body => body.method === 'status' ? { jsonrpc: '2.0', id: body.id, result: { chain_id: 'testnet' } } :
    { jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'UNKNOWN_TRANSACTION' } });
  assert.equal(result.code, 1); assert.equal(result.signal, null);
  assert.deepEqual(result.requests.map(r => r.method), ['status', 'EXPERIMENTAL_tx_status']);
  assert.equal(result.requests[1].params.wait_until, 'FINAL');
  assert.equal(result.requests[1].params.tx_hash, '3WSS8Cma8SBqtnk9Krb6g7cNhSgpX2m7wpbKBdtiEuny');
  assert.match(result.stdout, /::error title=Historical connector check failed::/);
  assert.match(result.stderr, /historical receipt-inclusive RPC unavailable/);
});

test('historical connector check refuses a non-testnet RPC before querying a transaction', async () => {
  const result = await execute(body => ({ jsonrpc: '2.0', id: body.id, result: { chain_id: 'mainnet' } }));
  assert.equal(result.code, 1); assert.deepEqual(result.requests.map(r => r.method), ['status']);
  assert.match(result.stderr, /RPC must report testnet/);
});
