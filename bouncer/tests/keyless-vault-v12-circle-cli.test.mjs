import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('..', import.meta.url));
function denied(file, args, pattern) {
  const result = spawnSync(process.execPath, [`scripts/${file}.mjs`, ...args],
    { cwd, encoding: 'utf8', timeout: 10_000, env: { ...process.env, BOUNCER_VAULT_CIRCLE_KIND: '' } });
  assert.equal(result.status, 1); assert.match(result.stderr, pattern);
  assert.doesNotMatch(result.stderr, /does not provide an export/); assert.equal(result.stdout, '');
}
test('V12 Circle CLI imports and rejects invalid input without reading credentials or sending', () => {
  denied('sign-vault-circle-v3-v12-offline', ['invalid'], /usage:/);
  denied('broadcast-vault-circle-v3-v12-once', [], /fixed Circle vault action is required/);
  denied('reconcile-vault-circle-v3-v12', ['invalid'], /usage:/);
});
