import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// This checks the real script's imports and CLI gate without opening the
// keyring or producing a signature. Never point a test at a live signer path.
test('V12 offline signer imports correctly and rejects unknown options before credentials', () => {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync(process.execPath, ['scripts/sign-keyless-vault-v12-offline.mjs', '--invalid'],
    { cwd, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid offline V12 signer options/);
  assert.doesNotMatch(result.stderr, /does not provide an export/);
  assert.equal(result.stdout, '');
});
