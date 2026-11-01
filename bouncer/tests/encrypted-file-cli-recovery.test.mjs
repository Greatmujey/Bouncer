// Actual recovery CLIs, mock loopback RPC/seller, synthetic FINAL receipts; no sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import nearApi from 'near-api-js';
import { FileJournal, requestFingerprint, validatePlan } from '../agent/procurement.mjs';
import { orderMemoV3 } from '../packages/provider-sdk/lib/resource-order.mjs';
import { signClaimAuthorization, verifyClaimAuthorization } from '../packages/provider-sdk/lib/resource-claim.mjs';
import { mockGuardedPayment, mockHash } from './mock-guarded-payment.mjs';
import { computeResult } from './mock-delivery.mjs';

const owner = 'owner.testnet', contract = 'bouncer.testnet', token = 'token.testnet', payee = 'seller.testnet';
const goal = { id: 'work', resource: 'compute', policy_id: 'resources', token, payee, max_amount: '1000',
  order_binding: 'seller-v3', input: { text: 'private synthetic work', rounds: 2 } };
async function runCli(script, args, env) {
  const child = spawn(process.execPath, [fileURLToPath(new URL(`../${script}`, import.meta.url)), ...args], {
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
  const [code, signal] = await once(child, 'exit'); clearTimeout(timer);
  if (signal) throw new Error(`CLI stopped by ${signal}: ${stderr}`);
  return { code, stdout, stderr };
}

test('encrypted original-hash payment and delivery recovery CLI uses no signing key or transaction send', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-encrypted-cli-recovery-'));
  const key = crypto.randomBytes(32), agent = nearApi.KeyPair.fromRandom('ed25519');
  const signer = new nearApi.KeyPairSigner(agent), publicKey = agent.getPublicKey();
  let sellerOrigin, entry, chain, rpcReads = 0, quotes = 0, broadcasts = 0, redemptions = 0;
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); res.setHeader('content-type', 'application/json');
      if (req.url === '/rpc') {
        if (body.method === 'status') return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { chain_id: 'testnet' } }));
        if (body.method === 'EXPERIMENTAL_tx_status') {
          rpcReads++; assert.equal(body.params.tx_hash, entry.tx_hash); assert.equal(body.params.sender_account_id, owner);
          return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: chain }));
        }
        broadcasts++; res.statusCode = 500; return res.end('{}');
      }
      if (req.url === '/quote') { quotes++; res.statusCode = 500; return res.end('{}'); }
      if (req.url === '/redeem') {
        redemptions++; assert.equal(body.tx_hash, entry.tx_hash); assert.deepEqual(body.input, goal.input);
        verifyClaimAuthorization({ network: 'near:testnet', contract_id: contract, owner_account_id: owner, seller_origin: sellerOrigin,
          resource: 'compute', policy_id: 'resources', token, payee, amount: '1000', memo: entry.request.memo, tx_hash: entry.tx_hash },
        body.authorization, String(publicKey));
        return res.end(JSON.stringify({ ok: true, result: computeResult(body.input) }));
      }
      res.statusCode = 404; res.end('{}');
    } catch { res.statusCode = 500; res.end('{}'); }
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    sellerOrigin = `http://127.0.0.1:${server.address().port}`;
    const memo = orderMemoV3(goal.resource, goal.input, crypto.randomBytes(16).toString('hex'));
    const request = validatePlan({ contract_id: contract, owner_account_id: owner, requests: [{ id: goal.id, resource: goal.resource,
      policy_id: goal.policy_id, token, payee, amount: '1000', memo }] }).requests[0];
    const hash = mockHash('encrypted-file-cli-synthetic'), terms = { network: 'near:testnet', contract_id: contract, owner_account_id: owner,
      seller_origin: sellerOrigin, resource: request.resource, policy_id: request.policy_id, token, payee, amount: request.amount, memo, tx_hash: hash };
    const authorization = await signClaimAuthorization({ terms, signer, publicKey });
    entry = { fingerprint: requestFingerprint(request), status: 'pending', request, provider_route: { provider_id: null, provider_origin: sellerOrigin },
      payment_version: 'direct-signed-v1', agent_public_key: String(publicKey), tx_hash: hash, resource_authorization: authorization };
    chain = mockGuardedPayment({ hash, owner, contract, publicKey: String(publicKey),
      args: { policy_id: request.policy_id, payee, amount: request.amount, memo, expected_token: token } });
    const state = path.join(root, 'original.json'), goals = path.join(root, 'goals.json'), keyFile = path.join(root, 'journal.key');
    fs.writeFileSync(keyFile, key, { mode: 0o600 });
    fs.writeFileSync(goals, JSON.stringify({ contract_id: contract, owner_account_id: owner, provider_url: sellerOrigin, goals: [goal] }));
    let journal = new FileJournal(state, contract, owner, { encryptionKey: key }); journal.put(goal.id, entry); journal.close();
    const raw = fs.readFileSync(state, 'utf8'); assert.ok(!raw.includes(hash)); assert.ok(!raw.includes(authorization.signature));
    const rpcUrl = `${sellerOrigin}/rpc`, args = ['--goals', goals, '--id', goal.id, '--state', state, '--rpc', rpcUrl];
    const missing = await runCli('agent/recover-direct-payment.mjs', args, { BOUNCER_FILE_JOURNAL_KEY_FILE: undefined });
    assert.equal(missing.code, 1); assert.match(missing.stderr, /requires its original key/); assert.equal(rpcReads, 0);
    const badFile = path.join(root, 'bad.key'); fs.writeFileSync(badFile, crypto.randomBytes(32), { mode: 0o600 });
    const bad = await runCli('agent/recover-direct-payment.mjs', args, { BOUNCER_FILE_JOURNAL_KEY_FILE: badFile });
    assert.equal(bad.code, 1); assert.match(bad.stderr, /failed authentication/); assert.equal(rpcReads, 0);
    const env = { BOUNCER_FILE_JOURNAL_KEY_FILE: keyFile };
    const payment = await runCli('agent/recover-direct-payment.mjs', args, env);
    assert.equal(payment.code, 0, payment.stderr); assert.ok(payment.stdout.includes(hash));
    const delivery = await runCli('agent/recover-direct-delivery.mjs', args, env);
    assert.equal(delivery.code, 0, delivery.stderr); assert.ok(delivery.stdout.includes(hash));
    assert.ok(!(payment.stdout + payment.stderr + delivery.stdout + delivery.stderr).includes(authorization.signature));
    assert.equal(rpcReads, 2); assert.equal(redemptions, 1); assert.equal(quotes, 0); assert.equal(broadcasts, 0);
    journal = new FileJournal(state, contract, owner, { encryptionKey: key });
    assert.equal(journal.get(goal.id).tx_hash, hash); assert.equal(journal.get(goal.id).delivery.status, 'verified'); journal.close();
  } finally {
    await new Promise(resolve => server.close(resolve)); key.fill(0); fs.rmSync(root, { recursive: true, force: true });
  }
});
