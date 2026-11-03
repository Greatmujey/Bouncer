import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../agent/native-testnet-faucet.mjs');
const cli = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, BOUNCER_FILE_JOURNAL_KEY_FILE: '' } });
test('faucet CLI advertises explicit execution, original recovery and native-only scope', () => {
  const result = cli('--help');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--execute/); assert.match(result.stdout, /--resume/);
  assert.match(result.stdout, /does not fund Circle USDC/); assert.match(result.stdout, /never repeats/);
  assert.equal(result.stderr, '');
});
test('faucet CLI rejects missing key, mainnet and unknown or duplicate flags without network', () => {
  for (const args of [
    ['--owner', 'owner.testnet', '--state', 'x', '--rpc', 'https://rpc.testnet.near.org'],
    ['--owner', 'owner.near', '--state', 'x', '--rpc', 'https://rpc.testnet.near.org'],
    ['--owner', 'owner.testnet', '--owner', 'other.testnet'],
    ['--unknown'],
  ]) {
    const result = cli(...args);
    assert.equal(result.status, 1); assert.match(result.stderr, /stopped/); assert.equal(result.stdout, '');
  }
});
