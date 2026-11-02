import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('renamed repository cannot reactivate the already-completed original Ref sweep', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-retired-sweep-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const out = path.join(root, 'output');
  const env = { ...process.env,
    GITHUB_TOKEN: 'offline-test-only', GITHUB_RUN_ID: '123456',
    GITHUB_REPOSITORY: 'Greatmujey/Bouncer', GITHUB_REF: 'refs/heads/arena/88d70c7c-near-hub',
    GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'a'.repeat(40),
    BOUNCER_REF_SWEEP_ACK: 'testnet-original-sweep-only',
    BOUNCER_REF_SWEEP_ARTIFACT_CHECK_ONLY: '1', NEAR_TESTNET_RPC: 'http://127.0.0.1:1',
  };
  const result = spawnSync(process.execPath,
    ['scripts/resume-original-ref-sweep.mjs', path.join(root, 'original'), path.join(root, 'prior'), out],
    { cwd, env, encoding: 'utf8', timeout: 5000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /private first-attempt GitHub Actions context required/);
  assert.equal(fs.existsSync(out), false, 'the old sweep must fail before creating output or contacting a service');
});
