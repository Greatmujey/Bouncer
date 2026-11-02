/**
 * Helpers for the opt-in nearcore sandbox test. These operate on local files or
 * already-received data; they do not connect to a chain or approve a payment.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import nearApi from 'near-api-js';

// V11 was recovered from the original public Git blob, not rebuilt here.
export const V11_SHA256 = '1acf931c07a530257999478c121193863ecf7201d357812a44b4d61c16a77921';
// nearcore 2.14.0's own test FT (NOT Circle's deployed contract).
export const MOCK_FT_SHA256 = 'b10ed11ac6d60698c6809ef7e96b578f2e5768354fe4b15d044843c2b6ab8a04';
// Independently reported by the pinned third-party source in V11_SANDBOX.md;
// a digest pin is not a NEAR Foundation signature or a reproducible build.
export const SANDBOX_SHA256 = '797b9d7a9a23907048d68a427e86a55c94f1de232dbfb8b8a1eec09ecef3bf13';
export const SANDBOX_CHAIN_ID = 'bouncer-v11-isolated-sandbox';
export const MOCK_TOKEN_GENESIS_BALANCE = 100n * 10n ** 24n;

export function readVerifiedFile(path, expectedHash, { maxBytes = 400 * 1024 * 1024 } = {}) {
  if (typeof path !== 'string' || path.length === 0 || !/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new Error('an explicit file and SHA-256 pin are required');
  }
  const stat = fs.statSync(path);
  if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) throw new Error('invalid or oversized sandbox input');
  const data = fs.readFileSync(path);
  const actual = crypto.createHash('sha256').update(data).digest('hex');
  if (actual !== expectedHash) throw new Error(`sandbox input SHA-256 mismatch: expected ${expectedHash}, got ${actual}`);
  return data;
}

/** Add a deliberately artificial FT account to a disposable sandbox genesis.
 * This permits the production setup planner's hard-coded Circle address to be
 * exercised against the upstream test FT. It must NOT be confused with Circle
 * registration, code or balance on NEAR testnet. No secret key is serialized. */
export function withMockTokenInGenesis(genesis, accountId, publicKey) {
  if (!genesis || typeof genesis !== 'object' || Array.isArray(genesis) ||
      genesis.chain_id !== SANDBOX_CHAIN_ID || !Array.isArray(genesis.records) ||
      typeof genesis.total_supply !== 'string' || !/^(0|[1-9][0-9]*)$/.test(genesis.total_supply) ||
      typeof accountId !== 'string' || !/^[a-f0-9]{64}$/.test(accountId)) {
    throw new Error('expected a fresh, named local sandbox genesis and implicit test-token account');
  }
  let canonicalKey;
  try { canonicalKey = String(nearApi.utils.PublicKey.from(publicKey)); } catch { throw new Error('invalid mock-token public key'); }
  if (canonicalKey !== publicKey || !publicKey.startsWith('ed25519:')) throw new Error('invalid mock-token public key');
  if (genesis.records.some(record => record?.Account?.account_id === accountId || record?.AccessKey?.account_id === accountId)) {
    throw new Error('mock-token account already exists in sandbox genesis');
  }
  const result = structuredClone(genesis);
  result.total_supply = (BigInt(result.total_supply) + MOCK_TOKEN_GENESIS_BALANCE).toString();
  result.records.push({ Account: { account_id: accountId, account: {
    amount: MOCK_TOKEN_GENESIS_BALANCE.toString(), locked: '0',
    code_hash: '11111111111111111111111111111111', storage_usage: 182,
  } } });
  result.records.push({ AccessKey: { account_id: accountId, public_key: publicKey,
    access_key: { nonce: 0, permission: 'FullAccess' } } });
  return result;
}

export function assertSandboxStatus(status) {
  if (!status || status.chain_id !== SANDBOX_CHAIN_ID || status.sync_info?.syncing !== false) {
    throw new Error('refusing to use an RPC that is not the ready, named local sandbox');
  }
}

export function requireFinalSuccess(result, label, { allowReceiptFailure = false } = {}) {
  assert.equal(result?.final_execution_status, 'FINAL', `${label}: result must be FINAL`);
  assert.ok(result?.status && typeof result.status.SuccessValue === 'string', `${label}: transaction must resolve successfully`);
  assert.ok(Array.isArray(result.receipts_outcome) && result.receipts_outcome.length > 0, `${label}: missing receipt outcomes`);
  let failures = 0;
  for (const item of result.receipts_outcome) {
    const status = item?.outcome?.status;
    assert.ok(status && typeof status === 'object', `${label}: missing receipt status`);
    if (status.Failure) failures++;
    else assert.ok(typeof status.SuccessValue === 'string' || typeof status.SuccessReceiptId === 'string',
      `${label}: receipt not terminal`);
  }
  if (!allowReceiptFailure) assert.equal(failures, 0, `${label}: a receipt failed`);
  return failures;
}

export function requireReceiptLog(result, executorId, text) {
  const matches = (result?.receipts_outcome ?? []).filter(item => item?.outcome?.executor_id === executorId &&
    Array.isArray(item.outcome.logs) && item.outcome.logs.some(log => typeof log === 'string' && log.includes(text)));
  assert.equal(matches.length, 1, `expected one ${executorId} receipt containing ${text}`);
  return matches[0];
}
