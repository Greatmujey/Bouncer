import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { FileJournal } from '../agent/procurement.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { SVALIN_ORIGIN, SVALIN_PAYEE } from '../agent/svalin-pro-readiness.mjs';
import { prepareSvalinProSession, reserveSvalinProOnce } from '../agent/svalin-pro-session.mjs';

const nowMs = Date.parse('2026-11-01T19:25:00.000Z'), now = () => nowMs;
const goal = { version: 1, id: 'concurrency', vault: 'vault.testnet', owner: 'owner.testnet',
  vault_code_hash: nearApi.utils.serialize.base_encode(Buffer.alloc(32, 8)), policy_id: 'api',
  accept_unsigned_seller_risk: true, accept_exact_amount_matching_risk: true };
const offer = () => ({ plans: [{ id: 'month', usd: 5, days: 30 }], callsPerDay: 100,
  near: { network: 'near:testnet', environment: 'testnet', payTo: SVALIN_PAYEE, token: TOKEN } });
const checkout = () => ({ plan: 'month', network: 'near:testnet', payTo: SVALIN_PAYEE, token: TOKEN,
  amount: '5.000001', expiresAt: new Date(nowMs + 60 * 60_000).toISOString() });
const provider = {
  async viewNodeStatus() { return { chain_id: 'testnet' }; },
  async viewBlock() { return { header: { hash: goal.vault_code_hash, timestamp_nanosec: String(BigInt(nowMs) * 1_000_000n) } }; },
  async viewAccount(id, opts) { assert.equal(id, goal.owner); return { block_hash: opts.blockId, code_hash: '11111111111111111111111111111111' }; },
};

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svalin-race-')), key = crypto.randomBytes(32);
  const journal = new FileJournal(path.join(dir, 'journal'), goal.vault, goal.owner, { encryptionKey: key });
  return { journal, close() { journal.close(); key.fill(0); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('concurrent callers sharing the original journal cannot both issue a reservation POST', async () => {
  const f = fixture(); try {
    await prepareSvalinProSession({ goal, journal: f.journal, now });
    let release, entered; const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    let posts = 0, gets = 0;
    const fetchImpl = async (url, opts) => {
      if (opts.method === 'GET') { gets++; return new Response(JSON.stringify(offer())); }
      assert.equal(url, `${SVALIN_ORIGIN}/v1/pro/near`); posts++; entered(); await gate;
      return new Response(JSON.stringify(checkout()));
    };
    const options = { goal, journal: f.journal, provider, now, fetchImpl, execute: true, acknowledgeBackup: true };
    const first = reserveSvalinProOnce(options); await started;
    await assert.rejects(reserveSvalinProOnce(options), /another payment operation/);
    release(); const result = await first;
    assert.equal(result.phase, 'reserved'); assert.equal(posts, 1); assert.equal(gets, 1);
  } finally { f.close(); }
});

test('a changed public offer blocks before reservation state or any provider POST', async () => {
  const f = fixture(); try {
    await prepareSvalinProSession({ goal, journal: f.journal, now });
    let calls = 0;
    const changed = offer(); changed.near.environment = 'mainnet';
    const fetchImpl = async (_url, opts) => { calls++; assert.equal(opts.method, 'GET'); return new Response(JSON.stringify(changed)); };
    await assert.rejects(reserveSvalinProOnce({ goal, journal: f.journal, provider, now, fetchImpl, execute: true, acknowledgeBackup: true }), /no reservation was sent/);
    assert.equal(calls, 1); assert.equal(f.journal.get(`${goal.id}-svalin-pro`).svalin.phase, 'prepared');
  } finally { f.close(); }
});
