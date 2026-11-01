import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('contract build publishes an artifact for review without writing the branch', () => {
  const yaml = fs.readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const start = yaml.indexOf('\n  build-contract:'), end = yaml.indexOf('\n  ref-setup-inspection:', start);
  assert.ok(start >= 0 && end > start, 'contract build job must remain identifiable');
  const job = yaml.slice(start, end);
  assert.match(job, /contents:\s*read/);
  assert.match(job, /actions\/upload-artifact@v4/);
  assert.doesNotMatch(job, /\bgit\s+(?:add|commit|push)\b/);
});
