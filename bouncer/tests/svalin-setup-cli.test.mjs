/** End-to-end owner CLI tests. Loopback RPC, credentials, receipts and state are all synthetic. */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import nearApi from 'near-api-js';
import { decryptFileJournal } from '../agent/file-journal-crypto.mjs';
import { fixture, resultFor, STAGES, OWNER, VAULT } from './fixtures/svalin-setup-fixture.mjs';
import { BLOCK, snapshot, providerFor } from './fixtures/svalin-setup-rpc-fixture.mjs';
import { readExactArtifact } from './fixtures/v11-synthetic-host.mjs';

const CLI = fileURLToPath(new URL('../agent/svalin-setup.mjs', import.meta.url));
const PLANNER = fileURLToPath(new URL('../agent/svalin-setup-plan.mjs', import.meta.url));
const stringify = value => JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v);
const successStatus = index => index === 4 ? 'FINAL_FUNDING_RECEIPTS_MATCH' : 'FINAL_SETUP_RECEIPT_MATCH';

function setup(options = {}) {
  const f = fixture(options), dir = f.dir, review = path.join(dir, 'review.json'), wasm = path.join(dir, 'reviewed.wasm');
  const state = path.join(dir, 'original-setup.enc'), key = path.join(dir, 'journal.key'), ownerKey = path.join(dir, 'owner.json');
  fs.writeFileSync(review, `${JSON.stringify(f.plan.review, null, 2)}\n`);
  fs.writeFileSync(wasm, f.inputs.wasmBytes);
  fs.writeFileSync(key, f.key, { mode: 0o600 });
  fs.writeFileSync(ownerKey, JSON.stringify({ account_id: OWNER, private_key: f.ownerPair.toString() }), { mode: 0o600 });
  const base = ['--review', review, '--review-sha256', f.trustedReviewHash, '--wasm', wasm,
    '--owner-public-key', f.ownerKey, '--state', state];
  return { f, dir, review, wasm, state, key, ownerKey, base,
    run(args, env = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env,
          BOUNCER_FILE_JOURNAL_KEY_FILE: key, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('synthetic CLI timed out')); }, 30_000);
        child.on('error', error => { clearTimeout(timeout); reject(error); });
        child.on('close', (status, signal) => { clearTimeout(timeout); resolve({ status, signal, stdout, stderr }); });
      });
    },
    async init() { return this.run([...base, '--init-journal', '--confirm-new-journal', '--ack-key-backup']); },
    async status() { return this.run([...base, '--journal-status']); },
    check(stage, rpc) { return this.run([...base, '--check-stage', stage, '--rpc', rpc]); },
    execute(stage, rpc, filename = ownerKey) { return this.run([...base, '--execute-stage', stage, '--rpc', rpc,
      '--owner-key', filename, '--execute', '--ack-backups', '--accept-unaudited-artifact', '--accept-keyless-lock']); },
    recover(stage, rpc, record = false) { return this.run([...base, '--recover-stage', stage, '--rpc', rpc,
      ...(record ? ['--record-evidence', '--ack-backups'] : [])]); },
    close() { f.close(); },
  };
}

async function syntheticRpc(t) {
  let index = 0, state = snapshot(t.f, index), loseNextSend = false, nextSendGate = null;
  const sent = [], receipts = new Map(), errors = [], calls = [];
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const req = JSON.parse(Buffer.concat(chunks).toString('utf8')), p = req.params || {};
      calls.push(req.method);
      let result;
      if (req.method === 'status') result = { chain_id: state.network };
      else if (req.method === 'block') {
        state.block.header.timestamp_nanosec = String(BigInt(Date.now()) * 1_000_000n);
        result = state.block;
      } else if (req.method === 'EXPERIMENTAL_protocol_config') result = state.protocol;
      else if (req.method === 'query') {
        if (req.id === 'bouncer-pinned-presence') {
          assert.equal(p.account_id, VAULT); assert.equal(p.block_id, BLOCK);
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(stringify({ jsonrpc: '2.0', id: req.id,
            error: { cause: { name: 'UNKNOWN_ACCOUNT', info: { requested_account_id: VAULT, block_hash: BLOCK } } } }));
          return;
        }
        const provider = providerFor(t.f, state), ref = { blockId: p.block_id };
        if (p.request_type === 'view_account') result = { ...(await provider.viewAccount(p.account_id, ref)), locked: '0' };
        else if (p.request_type === 'view_access_key') result = await provider.viewAccessKey(p.account_id, p.public_key, ref);
        else if (p.request_type === 'view_access_key_list') result = await provider.viewAccessKeyList(p.account_id, ref);
        else if (p.request_type === 'call_function') result = await provider.callFunctionRaw(p.account_id, p.method_name,
          JSON.parse(Buffer.from(p.args_base64, 'base64').toString('utf8')), ref);
        else throw new Error('unexpected synthetic view');
      } else if (req.method === 'send_tx') {
        assert.equal(p.wait_until, 'FINAL');
        const signed = nearApi.transactions.SignedTransaction.decode(Buffer.from(p.signed_tx_base64, 'base64'));
        assert.equal(signed.transaction.nonce, BigInt(index + 3));
        const hash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256')
          .update(nearApi.transactions.encodeTransaction(signed.transaction)).digest());
        const stored = decryptFileJournal(JSON.parse(fs.readFileSync(t.state, 'utf8')), t.f.key, VAULT, OWNER);
        const pending = stored.entries.find(entry => entry.id === `svalin-setup-v1-${STAGES[index]}`);
        assert.equal(pending?.status, 'pending', 'original hash was persisted before HTTP submission');
        assert.equal(pending.tx_hash, hash);
        assert.equal(fs.readFileSync(t.state, 'utf8').includes(t.f.ownerPair.toString()), false);
        sent.push({ stage: STAGES[index], hash });
        receipts.set(hash, resultFor(t.f, index, hash));
        if (nextSendGate) {
          const gate = nextSendGate; nextSendGate = null;
          gate.reached(); await gate.resume;
        }
        if (loseNextSend) {
          loseNextSend = false;
          response.writeHead(503, { 'content-type': 'application/json' }); response.end('{}'); return;
        }
        result = { transaction_outcome: { id: hash } };
      } else if (req.method === 'EXPERIMENTAL_tx_status') {
        assert.equal(p.wait_until, 'FINAL'); assert.equal(p.sender_account_id, OWNER);
        result = receipts.get(p.tx_hash);
        if (!result) throw new Error('synthetic receipt unknown');
      } else throw new Error('unexpected synthetic RPC method');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(stringify({ jsonrpc: '2.0', id: req.id, result }));
    } catch (error) {
      errors.push(error);
      response.writeHead(500, { 'content-type': 'application/json' }); response.end('{}');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { rpc: `http://127.0.0.1:${server.address().port}`, sent, calls, errors,
    setStage(i) { index = i; state = snapshot(t.f, i); state.ownerKey.nonce = BigInt(i + 2); },
    blockProtocol() { state.protocol.protocol_version = 87; },
    blockWasmFeature() { state.protocol.runtime_config.wasm_config.universal_accounts = false; },
    loseSend() { loseNextSend = true; },
    holdNextSend() {
      let reached, release;
      const arrived = new Promise(resolve => { reached = resolve; });
      const resume = new Promise(resolve => { release = resolve; });
      nextSendGate = { reached, resume };
      return { arrived, release };
    },
    async close() { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}

function json(result) { assert.equal(result.signal, null); return JSON.parse(result.stdout); }

test('CLI refuses incomplete, duplicate or mixed authorizations before creating a journal', async () => {
  const t = setup();
  try {
    const help = await t.run(['--help']); assert.equal(help.status, 0); assert.match(help.stdout, /cannot be upgraded\/deleted/);
    const cases = [
      [...t.base, '--init-journal'], [...t.base, '--init-journal', '--confirm-new-journal'],
      [...t.base, '--init-journal', '--confirm-new-journal', '--ack-key-backup', '--execute'],
      [...t.base, '--journal-status', '--rpc', 'http://127.0.0.1:1'],
      [...t.base, '--check-stage', STAGES[0]], [...t.base, '--check-stage', 'unknown', '--rpc', 'http://127.0.0.1:1'],
      [...t.base, '--execute-stage', STAGES[0], '--rpc', 'http://127.0.0.1:1', '--owner-key', t.ownerKey, '--execute', '--ack-backups'],
      [...t.base, '--execute-stage', STAGES[0], '--rpc', 'http://127.0.0.1:1', '--owner-key', t.ownerKey,
        '--execute', '--ack-backups', '--ack-reviewed-artifact', '--accept-keyless-lock'],
      [...t.base, '--execute-stage', 'verify_funded_vault', '--rpc', 'http://127.0.0.1:1', '--owner-key', t.ownerKey,
        '--execute', '--ack-backups', '--accept-unaudited-artifact', '--accept-keyless-lock'],
      [...t.base, '--recover-stage', STAGES[0], '--rpc', 'http://127.0.0.1:1', '--record-evidence'],
      [...t.base, '--journal-status', '--record-evidence', '--ack-backups'],
      [...t.base, '--journal-status', '--journal-status'], [...t.base, '--journal-status', '--init-journal'],
      [...t.base, '--journal-status', '--owner-key', t.ownerKey], [...t.base, '--journal-status', '--unknown'],
    ];
    for (const args of cases) {
      const result = await t.run(args); assert.equal(result.status, 1, result.stderr); assert.equal(fs.existsSync(t.state), false);
    }
    assert.equal(fs.existsSync(`${t.state}.lock`), false);
  } finally { t.close(); }
});

test('owner CLI accepts the actual offline planner output without modification', async () => {
  const t = setup();
  try {
    const input = path.join(t.dir, 'goal.json'); fs.writeFileSync(input, JSON.stringify(t.f.inputs.goal));
    const planned = spawnSync(process.execPath, [PLANNER, '--goal', input, '--wasm', t.wasm,
      '--agent-public-key', t.f.inputs.agentPublicKey, '--vault-funding-yocto', t.f.inputs.initialVaultFundingYocto,
      '--agent-allowance-yocto', t.f.inputs.agentGasAllowanceYocto,
      '--vault-token-storage-yocto', t.f.inputs.vaultTokenStorageDepositYocto], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(planned.status, 0, planned.stderr);
    assert.equal(planned.stdout, `${JSON.stringify(t.f.plan.review, null, 2)}\n`);
    fs.writeFileSync(t.review, planned.stdout);
    const initialized = await t.init(); assert.equal(initialized.status, 0, initialized.stderr);
    assert.equal(json(initialized).status, 'LOCAL_SETUP_JOURNAL_ONLY');
  } finally { t.close(); }
});

test('CLI requires unchanged canonical review, independently retained digest, artifact and separate original journal', async () => {
  const t = setup();
  try {
    const originalReview = fs.readFileSync(t.review), originalWasm = fs.readFileSync(t.wasm);
    for (const replacement of [
      Buffer.from(`${JSON.stringify(t.f.plan.review)}\n`),
      Buffer.from(originalReview.toString('utf8').replace('UNSIGNED_OFFLINE_PLAN_ONLY', 'READY')),
      Buffer.from(originalReview.toString('utf8').replace('{\n', '{\n  "format": "misleading",\n')),
    ]) {
      fs.writeFileSync(t.review, replacement);
      const got = await t.init(); assert.equal(got.status, 1); assert.equal(fs.existsSync(t.state), false);
    }
    fs.writeFileSync(t.review, originalReview);
    fs.writeFileSync(t.wasm, Buffer.concat([originalWasm, Buffer.from('tampered')]));
    let got = await t.init(); assert.equal(got.status, 1); assert.equal(fs.existsSync(t.state), false);
    fs.writeFileSync(t.wasm, originalWasm);
    const badHash = t.base.slice(); badHash[3] = '0'.repeat(64);
    got = await t.run([...badHash, '--init-journal', '--confirm-new-journal', '--ack-key-backup']);
    assert.equal(got.status, 1); assert.equal(fs.existsSync(t.state), false);
    const sameFile = t.base.slice(); sameFile[sameFile.length - 1] = t.review;
    got = await t.run([...sameFile, '--init-journal', '--confirm-new-journal', '--ack-key-backup']);
    assert.equal(got.status, 1); assert.deepEqual(fs.readFileSync(t.review), originalReview);
    got = await t.status(); assert.equal(got.status, 1); assert.match(got.stderr, /original journal not found/i);
    got = await t.init(); assert.equal(got.status, 0, got.stderr); assert.equal(json(got).status, 'LOCAL_SETUP_JOURNAL_ONLY');
    const saved = fs.readFileSync(t.state);
    got = await t.init(); assert.equal(got.status, 1); assert.match(got.stderr, /journal already exists/i);
    assert.deepEqual(fs.readFileSync(t.state), saved);
    assert.equal((fs.statSync(t.state).mode & 0o077), 0);
    assert.equal(saved.toString('utf8').includes(t.f.ownerPair.toString()), false);
  } finally { t.close(); }
});

test('blocked checks do not open the owner key; unsafe, wrong or linked keys cannot sign or send', async () => {
  const t = setup(), rpc = await syntheticRpc(t);
  try {
    let got = await t.init(); assert.equal(got.status, 0, got.stderr);
    rpc.blockProtocol();
    got = await t.execute(STAGES[0], rpc.rpc, path.join(t.dir, 'does-not-exist.json'));
    assert.equal(got.status, 2, got.stderr); assert.equal(json(got).status, 'BLOCKED_BEFORE_SIGNING');
    assert.ok(json(got).blockers.some(x => x.check === 'v11_protocol_floor')); assert.equal(rpc.sent.length, 0);
    rpc.setStage(0); rpc.blockWasmFeature();
    got = await t.execute(STAGES[0], rpc.rpc, path.join(t.dir, 'does-not-exist.json'));
    assert.equal(got.status, 2); assert.equal(json(got).status, 'BLOCKED_BEFORE_SIGNING');
    assert.ok(json(got).blockers.some(x => x.check === 'v11_selected_wasm_features_enabled'));
    assert.equal(rpc.sent.length, 0);
    rpc.setStage(0);
    const unsafe = path.join(t.dir, 'unsafe.json'), linked = path.join(t.dir, 'link.json'), hard = path.join(t.dir, 'hard.json');
    const wrong = path.join(t.dir, 'wrong.json');
    fs.copyFileSync(t.ownerKey, unsafe); fs.chmodSync(unsafe, 0o644);
    fs.symlinkSync(t.ownerKey, linked); fs.linkSync(t.ownerKey, hard);
    fs.writeFileSync(wrong, JSON.stringify({ account_id: OWNER, private_key: nearApi.KeyPair.fromRandom('ed25519').toString() }), { mode: 0o600 });
    for (const filename of [unsafe, linked, hard, wrong, t.ownerKey]) {
      // ownerKey has an extra hard link until the last iteration.
      got = await t.execute(STAGES[0], rpc.rpc, filename); assert.equal(got.status, 1, `${got.stderr}\n${got.stdout}`);
      assert.equal(rpc.sent.length, 0); assert.equal(got.stderr.includes(t.f.ownerPair.toString()), false);
    }
    fs.unlinkSync(hard);
    assert.equal(json(await t.status()).stages[0].state, 'NOT_RECORDED');
    assert.deepEqual(rpc.errors, []);
  } finally { await rpc.close(); t.close(); }
});

test('two separate CLI processes cannot send the same stage through one locked journal', async () => {
  const t = setup(), rpc = await syntheticRpc(t);
  let gate;
  try {
    const init = await t.init(); assert.equal(init.status, 0, init.stderr);
    assert.deepEqual(rpc.calls, [], 'initialization is offline');
    assert.equal((await t.status()).status, 0); assert.deepEqual(rpc.calls, [], 'local status is offline');
    gate = rpc.holdNextSend();
    const first = t.execute(STAGES[0], rpc.rpc);
    let timer;
    try {
      await Promise.race([gate.arrived, new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('synthetic send did not reach the server')), 10_000);
      })]);
    } finally { clearTimeout(timer); }
    const second = await t.execute(STAGES[0], rpc.rpc);
    assert.equal(second.status, 1); assert.match(second.stderr, /EEXIST|lock/i);
    assert.equal(rpc.sent.length, 1); assert.equal(fs.existsSync(`${t.state}.lock`), true);
    assert.equal((await t.status()).status, 1, 'another process cannot inspect while the owner holds the lock');
    gate.release();
    const completed = await first;
    assert.equal(completed.status, 0, completed.stderr); assert.equal(json(completed).status, 'FINAL_SETUP_RECEIPT_MATCH');
    assert.equal(rpc.sent.length, 1); assert.equal(fs.existsSync(`${t.state}.lock`), false);
    assert.deepEqual(rpc.errors, []);
  } finally { gate?.release(); await rpc.close(); t.close(); }
});

test('real CLI completes five synthetic stages and reconciles one lost response by original hash only', async () => {
  const t = setup(), rpc = await syntheticRpc(t);
  try {
    let got = await t.init(); assert.equal(got.status, 0, got.stderr);
    for (let i = 0; i < STAGES.length; i++) {
      rpc.setStage(i);
      got = await t.check(STAGES[i], rpc.rpc); assert.equal(got.status, 0, `${got.stderr}\n${got.stdout}`);
      assert.equal(json(got).status, 'READ_ONLY_STAGE_PROFILE_MATCH');
      if (i === 2) rpc.loseSend();
      got = await t.execute(STAGES[i], rpc.rpc);
      assert.equal(got.status, i === 2 ? 2 : 0, got.stderr);
      const execution = json(got);
      assert.equal(execution.status, i === 2 ? 'ORIGINAL_HASH_NEEDS_RECONCILIATION' : successStatus(i));
      assert.equal(execution.broadcast_attempts, 1); assert.equal(execution.do_not_resend, true);
      assert.equal(execution.seller_contacted, false); assert.equal(got.stdout.includes(t.f.ownerPair.toString()), false);
      assert.equal(rpc.sent.length, i + 1); assert.equal(rpc.sent[i].hash, execution.tx_hash);
      got = await t.execute(STAGES[i], rpc.rpc);
      assert.equal(got.status, 1); assert.match(got.stderr, /journal is not ready/i); assert.equal(rpc.sent.length, i + 1);
      if (i === 2) {
        got = await t.recover(STAGES[i], rpc.rpc);
        assert.equal(got.status, 0, got.stderr); assert.equal(json(got).status, successStatus(i));
        assert.equal(json(got).journal_updated, false); assert.equal(json(got).sends, 0);
        assert.equal(json(await t.status()).stages[i].state, 'ORIGINAL_HASH_PENDING');
        got = await t.recover(STAGES[i], rpc.rpc, true);
        assert.equal(got.status, 0, got.stderr); assert.equal(json(got).journal_updated, true);
        assert.equal(json(got).tx_hash, execution.tx_hash); assert.equal(rpc.sent.length, i + 1);
      }
      assert.equal(json(await t.status()).stages[i].state, 'FINAL_RECEIPTS_MATCH');
    }
    rpc.setStage(5); got = await t.check('verify_funded_vault', rpc.rpc);
    assert.equal(got.status, 0, got.stderr); const final = json(got);
    assert.equal(final.status, 'READ_ONLY_FUNDED_VAULT_PROFILE_MATCH');
    assert.equal(final.seller_fulfillment_verified, false); assert.equal(final.owner_approval_verified, false);
    assert.equal(final.setup_or_funding_independently_verified, false);
    assert.deepEqual(rpc.sent.map(item => item.stage), STAGES);
    assert.deepEqual(rpc.errors, []);
  } finally { await rpc.close(); t.close(); }
});

test('CLI accepts the recovered V11 bytes only against a synthetic chain, with no artifact or private key leakage',
  { skip: process.env.BOUNCER_V11_WASM_PATH ? false : 'set BOUNCER_V11_WASM_PATH to the recovered V11 artifact' }, async () => {
    const t = setup({ wasmBytes: readExactArtifact(process.env.BOUNCER_V11_WASM_PATH) }), rpc = await syntheticRpc(t);
    try {
      let got = await t.init(); assert.equal(got.status, 0, got.stderr);
      got = await t.execute(STAGES[0], rpc.rpc); assert.equal(got.status, 0, `${got.stderr}\n${got.stdout}`);
      assert.equal(json(got).status, 'FINAL_SETUP_RECEIPT_MATCH'); assert.equal(rpc.sent.length, 1);
      assert.equal(got.stdout.includes(t.f.ownerPair.toString()), false);
      assert.equal(got.stdout.includes(t.f.inputs.wasmBytes.toString('base64')), false);
      assert.deepEqual(rpc.errors, []);
    } finally { await rpc.close(); t.close(); }
  });
