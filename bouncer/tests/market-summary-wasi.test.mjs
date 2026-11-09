import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const wasm = fileURLToPath(new URL('../programs/market-summary/market-summary.wasm', import.meta.url));
const expectedSha256 = '0016209450769d4a03ee802e4dcbca854f14ca54f9185bed03333924e31b5ef6';
const hash = '11111111111111111111111111111111';
const run = input => spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
  import fs from 'node:fs';
  import { WASI } from 'node:wasi';
  const wasi = new WASI({ version: 'preview1', args: [], env: {}, returnOnExit: true });
  const module = await WebAssembly.compile(fs.readFileSync(process.argv[1]));
  const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
  process.exitCode = wasi.start(instance);
`, wasm], { input, encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
const input = (price, quantity, source = hash) => JSON.stringify({ price_usd_micros: price, quantity, oracle_tx_hash: source });

test('the checked-in provider artifact has a pinned hash and only the intended WASI imports', () => {
  const bytes = fs.readFileSync(wasm);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), expectedSha256);
  const module = new WebAssembly.Module(bytes);
  assert.deepEqual(WebAssembly.Module.imports(module).map(({module,name,kind}) => [module,name,kind]), [
    ['wasi_snapshot_preview1','fd_read','function'], ['wasi_snapshot_preview1','proc_exit','function'],
    ['wasi_snapshot_preview1','fd_write','function'],
  ]);
  assert.deepEqual(WebAssembly.Module.exports(module).map(({name,kind}) => [name,kind]), [['_start','function'],['memory','memory']]);
});

test('actual WASI executable multiplies valid derived prices exactly', () => {
  for (const [price, quantity] of [[2750000,10],[1,1],[1000000000000,1000],[87654321,37]]) {
    const result = run(input(price, quantity));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { value_usd_micros: price * quantity });
  }
});

test('actual WASI executable rejects malformed, noncanonical and out-of-range requests', () => {
  const invalid = [input(0,1), input(1,0), input(1000000000001,1), input(1,1001), input(1,1,'0'.repeat(32)),
    input(1,1,'1'.repeat(31)), input(1,1,'1'.repeat(61)),
    input(-1,1), input(1.5,1), input(1,1).replace(':1,', ':01,'),
    `${input(1,1)}\n`, `${input(1,1)}garbage`, 'x'.repeat(513),
    JSON.stringify({quantity:1,price_usd_micros:1,oracle_tx_hash:hash}),
    JSON.stringify({price_usd_micros:1,quantity:1,oracle_tx_hash:hash,extra:true})];
  for (const example of invalid) {
    const result = run(example);
    assert.equal(result.status, 1, `unexpected status ${result.status}: ${example.slice(0,100)} ${result.stderr}`);
    assert.equal(result.stdout, '');
  }
});
