import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = 'bouncer/services/resource-provider.mjs';
const preload = '--import=./bouncer/tests/mock-provider-status.mjs';
function config(dir) {
  return { contract_id: 'bouncer.testnet', data_dir: path.join(dir, 'data'), port: 0, products: Object.fromEntries(
    ['compute', 'storage', 'api'].map(type => [type, { policy_id: type, token: 'wrap.testnet', payee: `${type}.testnet`, amount: '80' }]),
  ) };
}
test('provider CLI binds only to loopback and serves quotes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-cli-test-'));
  const file = path.join(dir, 'provider.json'); fs.writeFileSync(file, JSON.stringify(config(dir)));
  const child = spawn(process.execPath, [preload, cli, '--config', file], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  try {
    const output = await Promise.race([
      once(child.stdout, 'data').then(([data]) => data.toString()),
      once(child, 'exit').then(([code]) => { throw new Error(`provider exited ${code}: ${stderr}`); }),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('provider startup timeout')), 10_000); timer.unref(); }),
    ]);
    const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    assert.ok(match, output);
    const response = await fetch(`http://127.0.0.1:${match[1]}/quote`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resource: 'compute', input: { text: 'hello', rounds: 2 } }),
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.quote.payee, 'compute.testnet');
    assert.equal(result.quote.amount, '80');
    assert.match(result.quote.memo, /^bouncer-order-v1:compute:/);
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('provider CLI refuses public binding and non-testnet accounts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-cli-invalid-'));
  const file = path.join(dir, 'provider.json');
  try {
    const bad = { ...config(dir), host: '0.0.0.0' }; fs.writeFileSync(file, JSON.stringify(bad));
    const result = spawnSync(process.execPath, [preload, cli, '--config', file], { cwd: repo, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1); assert.match(result.stderr, /only binds/);
    bad.host = '127.0.0.1'; bad.contract_id = 'real.near'; fs.writeFileSync(file, JSON.stringify(bad));
    const mainnet = spawnSync(process.execPath, [preload, cli, '--config', file], { cwd: repo, encoding: 'utf8', timeout: 5000 });
    assert.equal(mainnet.status, 1); assert.match(mainnet.stderr, /testnet/);
    fs.writeFileSync(file, JSON.stringify(config(dir)));
    const wrongChain = spawnSync(process.execPath, [preload, cli, '--config', file], {
      cwd: repo, env: { ...process.env, MOCK_CHAIN: 'mainnet' }, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(wrongChain.status, 1); assert.match(wrongChain.stderr, /provider RPC must report.*testnet/);
    assert.doesNotMatch(wrongChain.stdout, /Listening/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
