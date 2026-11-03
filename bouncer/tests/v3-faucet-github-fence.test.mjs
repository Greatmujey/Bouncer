import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { checkFaucetSignedOriginal, createGithubFaucetFence, guardFaucetProvider, V3_OWNER, V3_PUBLIC_KEY, fixedV3Plan }
  from '../agent/v3-faucet-github-fence.mjs';
import { FAUCET_RETURN, FAUCET_TRANSFER_YOCTO } from '../agent/native-testnet-faucet.mjs';

const TEMP = `bouncer-faucet-${'a'.repeat(32)}.testnet`;
async function signed(stage = 'transfer') {
  const pair = nearApi.KeyPair.fromRandom('ed25519'), nonce = stage === 'transfer' ? 123n : 124n;
  const receiver = stage === 'transfer' ? V3_OWNER : TEMP;
  const action = stage === 'transfer' ? nearApi.transactions.transfer(BigInt(FAUCET_TRANSFER_YOCTO)) : nearApi.transactions.deleteAccount(FAUCET_RETURN);
  const tx = nearApi.transactions.createTransaction(TEMP, pair.getPublicKey(), receiver, nonce, [action], Buffer.alloc(32, 1));
  const [hash, original] = await new nearApi.KeyPairSigner(pair).signTransaction(tx);
  const pending = { state: 'pending', tx_hash: nearApi.utils.serialize.base_encode(hash), nonce: String(nonce) };
  const entry = { recipient: V3_OWNER, temporary_account: TEMP, temporary_public_key: String(pair.getPublicKey()),
    transfer: stage === 'transfer' ? pending : { state: 'final', tx_hash: 'x', nonce: '123' },
    cleanup: stage === 'cleanup' ? pending : null };
  return { original, entry, pending };
}
const context = { token: 'g'.repeat(30), runId: '123', artifactId: '456', headSha: 'a'.repeat(40), bundleDigest: 'b'.repeat(64) };
function mockGithub({ exists = false, mismatch = false, postFail = false } = {}) {
  const calls = [], checks = new Map(); let id = 100;
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: opts.method });
    if (url.includes('/commits/')) return Response.json({ check_runs: exists ? [{ name: 'V3 native faucet: sole helper reservation' }] : [] });
    if (url.endsWith('/check-runs') && opts.method === 'POST') {
      if (postFail) return new Response('', { status: 403 });
      const body = JSON.parse(opts.body), result = { ...body, id: ++id, app: { slug: 'github-actions' } };
      checks.set(id, result); return Response.json(result);
    }
    const found = checks.get(Number(url.split('/').pop()));
    return Response.json(mismatch ? { ...found, output: { summary: 'different' } } : found);
  };
  return { calls, fetchImpl };
}

test('fixed owner is V3 only', () => {
  const p = { version: 1, purpose: 'new-bouncer-testnet-owner', network: 'testnet', account_id: V3_OWNER, public_key: V3_PUBLIC_KEY };
  assert.equal(fixedV3Plan(p), p);
  assert.throws(() => fixedV3Plan({ ...p, account_id: 'someone.testnet' }));
  assert.throws(() => fixedV3Plan({ ...p, network: 'mainnet' }));
});

test('signed hash guard accepts only exact five-NEAR transfer and faucet cleanup', async () => {
  const t = await signed(), d = checkFaucetSignedOriginal(t.original, t.entry, 'transfer');
  assert.equal(d.tx_hash, t.pending.tx_hash); assert.equal(d.amount_yocto, FAUCET_TRANSFER_YOCTO);
  const c = await signed('cleanup');
  assert.equal(checkFaucetSignedOriginal(c.original, c.entry, 'cleanup').beneficiary, FAUCET_RETURN);
  assert.throws(() => checkFaucetSignedOriginal(t.original, { ...t.entry, recipient: 'another.testnet' }, 'transfer'));
  assert.throws(() => checkFaucetSignedOriginal(t.original, { ...t.entry, transfer: { ...t.pending, nonce: '124' } }, 'transfer'));
  assert.throws(() => checkFaucetSignedOriginal(c.original, { ...c.entry, transfer: { state: 'pending' } }, 'cleanup'));
  const mutated = structuredClone(t.entry); mutated.transfer.tx_hash = nearApi.utils.serialize.base_encode(crypto.randomBytes(32));
  assert.throws(() => checkFaucetSignedOriginal(t.original, mutated, 'transfer'));
});

test('GitHub fence must enumerate, publish, and read back the exact completed check', async () => {
  const m = mockGithub(), fence = createGithubFaucetFence({ ...context, fetchImpl: m.fetchImpl });
  assert.equal(await fence('helper', { recipient: V3_OWNER }), 101);
  assert.deepEqual(m.calls.map(c => c.method), ['GET', 'POST', 'GET']);
  for (const options of [{ exists: true }, { mismatch: true }, { postFail: true }]) {
    const g = mockGithub(options), blocked = createGithubFaucetFence({ ...context, fetchImpl: g.fetchImpl });
    await assert.rejects(() => blocked('helper', { recipient: V3_OWNER }));
    if (options.exists) assert.deepEqual(g.calls.map(c => c.method), ['GET']);
  }
});

test('sender cannot run until public original fence is acknowledged; never repeats the same stage', async () => {
  const t = await signed(), calls = [], journal = { get: () => t.entry };
  const provider = { async sendTransactionOnce() { calls.push('send'); return 'sent'; }, chain: 'testnet' };
  const guarded = guardFaucetProvider(provider, journal, async (stage, details) => {
    calls.push('fence'); assert.equal(stage, 'transfer'); assert.equal(details.tx_hash, t.pending.tx_hash);
  });
  assert.equal(guarded.chain, 'testnet');
  assert.equal(await guarded.sendTransactionOnce(t.original, 'FINAL', {}), 'sent');
  assert.deepEqual(calls, ['fence', 'send']);
  await assert.rejects(() => guarded.sendTransactionOnce(t.original, 'FINAL', {}));
  assert.deepEqual(calls, ['fence', 'send']);
  const failed = guardFaucetProvider(provider, journal, async () => { throw new Error('lost acknowledgement'); });
  await assert.rejects(() => failed.sendTransactionOnce(t.original, 'FINAL', {}));
  await assert.rejects(() => failed.sendTransactionOnce(t.original, 'FINAL', {}));
  assert.deepEqual(calls, ['fence', 'send']);
});
