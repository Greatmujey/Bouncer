import test from 'node:test';
import assert from 'node:assert/strict';
import { githubOriginalFence } from '../agent/github-original-fence.mjs';
const args = { artifactId: '1234', runId: '5678', headSha: 'a'.repeat(40), digest: 'b'.repeat(64),
  token: 'not-a-real-token-for-a-test', maxArtifactBytes: 1_100_000 };
const metadata = () => ({ id: 1234, name: `vault-v2-bootstrap-fence-5678-${args.digest}`, expired: false, size_in_bytes: 700_000,
  workflow_run: { id: 5678, head_sha: args.headSha, head_branch: 'arena/25a7aaf6-near-hub' } });
const response = data => new Response(JSON.stringify(data), { status: 200 });

test('original-hash fence checks the exact artifact and run with a bounded metadata GET', async () => {
  let seen;
  const ok = await githubOriginalFence({ ...args, fetchImpl: async (url, opts) => { seen = { url, opts }; return response(metadata()); } });
  assert.equal(ok, true);
  assert.equal(seen.url, 'https://api.github.com/repos/Greatmujey/Bouncer/actions/artifacts/1234');
  assert.equal(seen.opts.method, 'GET'); assert.equal(seen.opts.redirect, 'error');
  assert.equal(seen.opts.body, undefined);
});

test('changed, expired, oversized, wrong-branch or unavailable fences prevent a send', async () => {
  const mutations = [m => { m.id++; }, m => { m.name += '-other'; }, m => { m.expired = true; },
    m => { m.size_in_bytes = 0; }, m => { m.size_in_bytes = args.maxArtifactBytes; },
    m => { m.workflow_run.id++; }, m => { m.workflow_run.head_sha = 'c'.repeat(40); },
    m => { m.workflow_run.head_branch = 'main'; }];
  for (const mutate of mutations) {
    const m = metadata(); mutate(m);
    assert.equal(await githubOriginalFence({ ...args, fetchImpl: async () => response(m) }), false);
  }
  assert.equal(await githubOriginalFence({ ...args, fetchImpl: async () => new Response('', { status: 404 }) }), false);
  await assert.rejects(githubOriginalFence({ ...args, digest: 'wrong', fetchImpl: async () => response(metadata()) }), /invalid original-hash/);
  await assert.rejects(githubOriginalFence({ ...args, fetchImpl: async () => new Response('{') }));
});
