import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { createSweepHandoffRequest, validateSweepHandoffRequest, encodeSweepHandoffRequest, decodeSweepHandoffRequest,
  decodeSweepHandoffFile, sealSweepHandoff, openSweepHandoff } from '../agent/ref-sweep-handoff.mjs';

const pair = nearApi.KeyPair.fromRandom('ed25519'), other = nearApi.KeyPair.fromRandom('ed25519');
const context = { owner_account_id: 'owner.testnet', contract_id: 'vault.testnet', router_id: 'router.testnet',
  original_hash: nearApi.utils.serialize.base_encode(Buffer.alloc(32, 1)), output_receipt_id: nearApi.utils.serialize.base_encode(Buffer.alloc(32, 2)),
  expected_output: '6926', sweep_public_key: pair.getPublicKey().toString() };
const credentials = { account_id: context.owner_account_id, private_key: pair.toString() };
const { request, privateKey } = createSweepHandoffRequest({ runId: '123456', context });
const encrypt = () => sealSweepHandoff({ request, expected: context, credentials });

test('a one-use handoff encrypts only the reviewed scoped testnet key', () => {
  const first = encrypt(), second = encrypt();
  assert(!JSON.stringify(first).includes(credentials.private_key));
  assert.notEqual(first.envelope.ciphertext, second.envelope.ciphertext);
  assert.equal(String(openSweepHandoff({ request, expected: context, response: first, privateKey }).getPublicKey()), context.sweep_public_key);
});

test('job annotation request is bounded, canonical and contains no secret', () => {
  const encoded = encodeSweepHandoffRequest(request);
  assert.deepEqual(decodeSweepHandoffRequest(encoded), request);
  assert(!encoded.includes('\n')); assert(!encoded.includes(credentials.private_key));
  for (const bad of ['', 'a=', `${encoded}\n`, 'a'.repeat(6001), Buffer.from('not-json').toString('base64url'), 'A']) {
    assert.throws(() => decodeSweepHandoffRequest(bad));
  }
});

test('ciphertext-only GitHub file parsing rejects wrong paths, oversized and noncanonical content', () => {
  const data = Buffer.from(JSON.stringify(encrypt())), filepath = 'bouncer/recovery/ref-sweep-123456.json';
  const file = { type: 'file', path: filepath, encoding: 'base64', size: data.length,
    content: data.toString('base64').replace(/.{64}/g, '$&\n') };
  assert.equal(decodeSweepHandoffFile(file, filepath).challenge, request.challenge);
  for (const bad of [{ ...file, path: 'elsewhere' }, { ...file, type: 'symlink' }, { ...file, size: 12_001 },
    { ...file, size: file.size + 1 }, { ...file, content: `${file.content} ` }, { ...file, content: `${file.content}=` }]) {
    assert.throws(() => decodeSweepHandoffFile(bad, filepath));
  }
});

test('changed trade, scope, key, challenge or unknown fields fail closed', () => {
  for (const bad of [
    { ...request, router_id: 'attacker.testnet' }, { ...request, original_hash: '3'.repeat(32) },
    { ...request, output_receipt_id: '4'.repeat(32) }, { ...request, expected_output: '6927' },
    { ...request, challenge: 'x'.repeat(64) }, { ...request, run_id: '01' }, { ...request, owner_account_id: 'owner.near' },
    { ...request, rsa_key_id: '0'.repeat(64) }, { ...request, extra: true },
  ]) assert.throws(() => validateSweepHandoffRequest(bad, context));
  assert.throws(() => sealSweepHandoff({ request, expected: context, credentials: { ...credentials, private_key: other.toString() } }));
  assert.throws(() => sealSweepHandoff({ request, expected: context, credentials: { ...credentials, owner_key: pair.toString() } }));
});

test('tampering and a response replayed into another worker challenge fail authentication', () => {
  const response = encrypt();
  const bytes = Buffer.from(response.envelope.ciphertext, 'base64'); bytes[0] ^= 1;
  assert.throws(() => openSweepHandoff({ request, expected: context, privateKey,
    response: { ...response, envelope: { ...response.envelope, ciphertext: bytes.toString('base64') } } }));
  assert.throws(() => openSweepHandoff({ request: { ...request, challenge: 'b'.repeat(64) }, expected: context, response, privateKey }));
  assert.throws(() => openSweepHandoff({ request, expected: context, response: { ...response, run_id: '999' }, privateKey }));
});

test('live handoff commands fail before network without the explicit recovery context', async () => {
  const { spawnSync } = await import('node:child_process'), path = await import('node:path'), { fileURLToPath } = await import('node:url');
  const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const env = { ...process.env }; delete env.BOUNCER_REF_SWEEP_ACK;
  const worker = spawnSync(process.execPath, ['scripts/resume-original-ref-sweep.mjs', '/tmp/original', '/tmp/out'],
    { cwd, env, encoding: 'utf8', timeout: 5000 });
  assert.notEqual(worker.status, 0); assert.match(worker.stderr, /explicit testnet sweep-only acknowledgement/);
  const response = spawnSync(process.execPath, ['scripts/respond-original-ref-sweep.mjs'],
    { cwd, env, encoding: 'utf8', timeout: 5000 });
  assert.notEqual(response.status, 0); assert.match(response.stderr, /usage/);
});

test('operator authenticates the run-bound Actions check before encrypting its scoped key', async () => {
  const fs = await import('node:fs'), path = await import('node:path'), os = await import('node:os');
  const { spawnSync, execFileSync } = await import('node:child_process'), { fileURLToPath } = await import('node:url');
  const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-handoff-test-'));
  try {
    const bin = path.join(home, 'bin'), keys = path.join(home, '.near-credentials/testnet/bouncer-ref-v3-20261101');
    fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(keys, { recursive: true });
    const operatorContext = { owner_account_id: 'owner.bouncer-ref-44f619d9.testnet', contract_id: 'bouncer-ref-44f619d9.testnet',
      router_id: 'ref-router-44f619d9.testnet', original_hash: 'DzWVHLp51KuoUoy8oaYNQTgLNAMgSRcegYT4mjuXCXrz',
      output_receipt_id: '7KEWv6Ux5EHX6R1F7ipdZmvFZKp7p6iQkpRsynXieSSX', expected_output: '6926',
      sweep_public_key: pair.getPublicKey().toString() };
    fs.writeFileSync(path.join(keys, 'sweep.json'), JSON.stringify({ account_id: operatorContext.owner_account_id, private_key: pair.toString() }), { mode: 0o600 });
    const { request: operatorRequest, privateKey: operatorPrivate } = createSweepHandoffRequest({ runId: '123456', context: operatorContext });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    const dataFile = path.join(home, 'gh-data.json'), worktree = path.join(home, 'mock-worktree');
    const posted = path.join(worktree, 'bouncer/recovery/ref-sweep-123456.json'), gitLog = path.join(home, 'git-ops.jsonl');
    fs.mkdirSync(worktree);
    const mock = { run: { id: 123456, event: 'push', run_attempt: 1, status: 'in_progress', path: '.github/workflows/ci.yml',
      head_branch: 'arena/88d70c7c-near-hub', head_sha: head, repository: { private: true } },
    job: { id: 987654, run_id: 123456, run_attempt: 1, head_sha: head, name: 'Resume original Ref output sweep (testnet)',
      status: 'in_progress', started_at: '2026-11-01T10:00:00Z',
      steps: [{ name: 'Recover original receipts and perform one scoped sweep', status: 'in_progress' }] },
    check: { id: 111222, name: 'Scoped Ref sweep handoff 123456', head_sha: head, status: 'completed', conclusion: 'success',
      app: { id: 15368, slug: 'github-actions' }, external_id: 'bouncer-ref-sweep-123456',
      details_url: 'https://github.com/abdullahimujeeb0505-stack/Bouncer/runs/111222', started_at: '2026-11-01T10:00:01Z',
      output: { title: 'Scoped Ref sweep handoff request', summary: encodeSweepHandoffRequest(operatorRequest) } } };
    fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs'); const data = JSON.parse(fs.readFileSync(process.env.MOCK_DATA, 'utf8'));
const endpoint = process.argv[3] || '';
if (endpoint.includes('/actions/runs/123456')) console.log(JSON.stringify(data.run));
else if (endpoint.includes('/actions/jobs/987654')) console.log(JSON.stringify(data.job));
else if (endpoint.includes('/check-runs/111222')) console.log(JSON.stringify(data.check));
else { console.error('unexpected mock endpoint'); process.exit(1); }
`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env node
const fs = require('node:fs'), args = process.argv.slice(2);
if (args.join(' ') === 'rev-parse HEAD') console.log(process.env.MOCK_HEAD);
else if (args.join(' ') === 'rev-parse --show-toplevel') console.log(process.env.MOCK_WORKTREE);
else if (args.join(' ') === 'branch --show-current') console.log('arena/88d70c7c-near-hub');
else if (args.join(' ') === 'status --porcelain --untracked-files=all') {}
else if (['add', 'commit', 'push'].includes(args[0])) fs.appendFileSync(process.env.MOCK_GIT_LOG, JSON.stringify(args) + '\\n');
else { console.error('unexpected git operation'); process.exit(1); }
`, { mode: 0o755 });
    const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, MOCK_DATA: dataFile,
      MOCK_HEAD: head, MOCK_WORKTREE: worktree, MOCK_GIT_LOG: gitLog };
    const runOperator = () => spawnSync(process.execPath, ['scripts/respond-original-ref-sweep.mjs', '987654', '123456', '111222'],
      { cwd, env, encoding: 'utf8', timeout: 5000 });
    fs.writeFileSync(dataFile, JSON.stringify({ ...mock, job: { ...mock.job, head_sha: 'f'.repeat(40) } }));
    let child = runOperator(); assert.notEqual(child.status, 0); assert(!fs.existsSync(posted));
    fs.writeFileSync(dataFile, JSON.stringify({ ...mock, check: { ...mock.check, external_id: 'other-run' } }));
    child = runOperator(); assert.notEqual(child.status, 0); assert(!fs.existsSync(posted));
    fs.writeFileSync(dataFile, JSON.stringify({ ...mock, check: { ...mock.check, app: { id: 9, slug: 'other-app' } } }));
    child = runOperator(); assert.notEqual(child.status, 0); assert(!fs.existsSync(posted));
    fs.writeFileSync(dataFile, JSON.stringify(mock)); child = runOperator(); assert.equal(child.status, 0, child.stderr);
    const body = fs.readFileSync(posted, 'utf8');
    assert(!body.includes(pair.toString())); assert(!child.stdout.includes(pair.toString()));
    const operations = fs.readFileSync(gitLog, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(operations.map(args => args[0]), ['add', 'commit', 'push']);
    assert.deepEqual(operations[0], ['add', '--', 'bouncer/recovery/ref-sweep-123456.json']);
    assert(operations[1].includes('--only')); assert.deepEqual(operations[2], ['push', 'origin', 'arena/88d70c7c-near-hub']);
    const response = JSON.parse(body);
    assert.equal(String(openSweepHandoff({ request: operatorRequest, expected: operatorContext, response, privateKey: operatorPrivate }).getPublicKey()),
      operatorContext.sweep_public_key);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('artifact-only recovery check refuses any prior recorded sweep without contacting RPC', async () => {
  const fs = await import('node:fs'), path = await import('node:path'), os = await import('node:os');
  const { spawnSync } = await import('node:child_process'), { fileURLToPath } = await import('node:url');
  const { goal: sample } = await import('./ref-swap-fixture.mjs');
  const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-artifact-check-'));
  try {
    const original = path.join(root, 'original'), prior = path.join(root, 'prior'), out = path.join(root, 'out');
    fs.mkdirSync(original); fs.mkdirSync(prior);
    const vault = 'bouncer-ref-44f619d9.testnet', owner = 'owner.bouncer-ref-44f619d9.testnet', router = 'ref-router-44f619d9.testnet';
    const originalHash = 'DzWVHLp51KuoUoy8oaYNQTgLNAMgSRcegYT4mjuXCXrz';
    const goal = { ...sample, contract_id: vault, owner_account_id: owner, router_id: router };
    const input = { id: `${goal.id}-input`, status: 'pending', fingerprint: 'fixture', tx_hash: originalHash };
    const journal = { version: 1, contract_id: vault, owner_account_id: owner, entries: [input] };
    for (const dir of [original, prior]) {
      fs.writeFileSync(path.join(dir, 'goal.json'), JSON.stringify(goal));
      fs.writeFileSync(path.join(dir, 'journal.json'), JSON.stringify(journal));
    }
    fs.writeFileSync(path.join(original, 'identity.json'), JSON.stringify({ contract: vault, owner, router, sweep_key: context.sweep_public_key }));
    const env = { ...process.env, GITHUB_TOKEN: 'test-token', GITHUB_RUN_ID: '123456', NEAR_TESTNET_RPC: 'http://127.0.0.1:1',
      GITHUB_REPOSITORY: 'abdullahimujeeb0505-stack/Bouncer', GITHUB_REF: 'refs/heads/arena/88d70c7c-near-hub',
      GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'a'.repeat(40), BOUNCER_REF_SWEEP_ACK: 'testnet-original-sweep-only',
      BOUNCER_REF_SWEEP_ARTIFACT_CHECK_ONLY: '1' };
    delete env.BOUNCER_FILE_JOURNAL_KEY_FILE;
    const check = () => spawnSync(process.execPath, ['scripts/resume-original-ref-sweep.mjs', original, prior, out],
      { cwd, env, encoding: 'utf8', timeout: 5000 });
    let child = check(); assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /no sweep is recorded/);
    assert.deepEqual(fs.readdirSync(out), []);
    journal.entries.push({ id: `${goal.id}-sweep`, status: 'pending', fingerprint: 'fixture', tx_hash: context.original_hash });
    fs.writeFileSync(path.join(prior, 'journal.json'), JSON.stringify(journal));
    child = check(); assert.notEqual(child.status, 0); assert.match(child.stderr, /existing sweep; do not send/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
