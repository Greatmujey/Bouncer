import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { makeYoutickPlayGrantArgs, YOUTICK_PLAY_ORIGIN_HASH, YOUTICK_PLAY_TTL_MS } from '../agent/youtick-play-proof.mjs';
import { YOUTICK_ACCESS, YOUTICK_MARKET } from '../agent/youtick-capabilities.mjs';
import { YOUTICK_V1_CODE_HASH } from '../agent/youtick-quote.mjs';
import { YOUTICK_ACCESS_CODE_HASH } from '../agent/youtick-grant-runner.mjs';
import { validateYoutickGrantProbe, verifyYoutickZeroGrantProbe, verifyYoutickGrantProbe,
  inspectYoutickGrantProbe } from '../agent/youtick-grant-probe-evidence.mjs';

const hash = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n));
const enc = value => Buffer.from(JSON.stringify(value)).toString('base64');
const now = 1_770_000_000_000;
function evidence() {
  const vault = 'probe-vault.testnet', owner = 'probe-owner.testnet', key = nearApi.KeyPair.fromRandom('ed25519');
  const args = makeYoutickPlayGrantArgs({ vault, jobId: 'bouncer-probe-hypothetical', deviceHash: 'a'.repeat(64), key });
  const ownerKey = nearApi.KeyPair.fromRandom('ed25519').getPublicKey().toString(), zeroHash = hash(1), grantHash = hash(2), init = hash(3), access = hash(4);
  const prepared = { owner_id: owner, vault, method: 'issue_youtick_play_grant', deposit: '1', gas: '100000000000000', args };
  const probe = { version: 1, purpose: 'hypothetical-job-no-payment-testnet', vault, owner, vault_code_hash: hash(5),
    market_code_hash: YOUTICK_V1_CODE_HASH, access_code_hash: YOUTICK_ACCESS_CODE_HASH, owner_public_key: ownerKey, prepared };
  const failure = { ActionError: { kind: { FunctionCallError: { ExecutionError: 'ESCALATION BLOCKED: owner-only method requires exactly 1 yoctoNEAR' } } } };
  const zero = { final_execution_status: 'FINAL', status: { Failure: failure },
    transaction_outcome: { id: zeroHash, outcome: { status: { SuccessReceiptId: init }, receipt_ids: [init] } },
    transaction: { hash: zeroHash, signer_id: owner, receiver_id: vault, public_key: ownerKey,
      actions: [{ FunctionCall: { method_name: prepared.method, gas: prepared.gas, deposit: '0', args: enc(args) } }] },
    receipts: [], receipts_outcome: [{ id: init, outcome: { executor_id: vault, status: { Failure: failure }, receipt_ids: [] } }] };
  const grant = { owner_id: vault, session_pk: args.session_pk, scope: 'Play', resource_id: args.job_id,
    expires_at_ms: now + 500_000, origin_hash: YOUTICK_PLAY_ORIGIN_HASH, device_hash: args.device_hash, revoked: false };
  const request = { target_owner_id: vault, session_pk: args.session_pk, scope: 'Play', resource_id: args.job_id,
    ttl_ms: YOUTICK_PLAY_TTL_MS, origin_hash: YOUTICK_PLAY_ORIGIN_HASH, device_hash: args.device_hash, session_pok: args.session_pok };
  const issued = { final_execution_status: 'FINAL', status: { SuccessValue: enc(grant) },
    transaction_outcome: { id: grantHash, outcome: { status: { SuccessReceiptId: init }, receipt_ids: [init] } },
    transaction: { hash: grantHash, signer_id: owner, receiver_id: vault, public_key: ownerKey,
      actions: [{ FunctionCall: { method_name: prepared.method, gas: prepared.gas, deposit: '1', args: enc(args) } }] },
    receipts: [{ receipt_id: access, predecessor_id: vault, receiver_id: YOUTICK_ACCESS,
      receipt: { Action: { actions: [{ FunctionCall: { method_name: 'issue_session_grant', gas: '70000000000000', deposit: '0', args: enc({ request }) } }] } } }],
    receipts_outcome: [{ id: init, outcome: { executor_id: vault, status: { SuccessReceiptId: access }, receipt_ids: [access] } },
      { id: access, outcome: { executor_id: YOUTICK_ACCESS, status: { SuccessValue: enc(grant) }, receipt_ids: [] } }] };
  return { probe, zero, zeroHash, issued, grantHash, grant, verification: { valid: true, owner_id: vault, reason: null } };
}

test('hypothetical grant diagnostic validates linked zero-yocto rejection and separate one-yocto access receipt', () => {
  const e = evidence(); assert.equal(validateYoutickGrantProbe(e.probe), e.probe);
  assert.equal(verifyYoutickZeroGrantProbe({ probe: e.probe, result: e.zero, txHash: e.zeroHash }).rejected_by_one_yocto_guard, true);
  const result = verifyYoutickGrantProbe({ probe: e.probe, result: e.issued, txHash: e.grantHash, grant: e.grant, verification: e.verification, nowMs: now });
  assert.equal(result.status, 'GRANTED'); assert.equal(result.market, YOUTICK_MARKET); assert.match(result.scope, /no quote, FT payment/);
  const expired = verifyYoutickGrantProbe({ probe: e.probe, result: e.issued, txHash: e.grantHash, grant: e.grant, verification: { valid: false }, nowMs: now + 600_000 });
  assert.equal(expired.status, 'EXPIRED');
});

test('diagnostic does not accept a non-hypothetical job, a replayed proof or changed pins', () => {
  const original = evidence();
  for (const mutate of [
    e => { e.probe.purpose = 'paid'; }, e => { e.probe.vault = 'vault.near'; },
    e => { e.probe.access_code_hash = hash(8); }, e => { e.probe.market_code_hash = hash(8); },
    e => { e.probe.prepared.args.job_id = 'paid-job'; }, e => { e.probe.prepared.args.device_hash = 'b'.repeat(64); },
    e => { e.probe.prepared.deposit = '0'; }, e => { e.probe.prepared.args.extra = true; },
  ]) {
    const e = structuredClone(original); mutate(e); assert.throws(() => validateYoutickGrantProbe(e.probe), /invalid/);
  }
});

test('zero-yocto proof requires the exact guard failure on the linked vault receipt and no access call', () => {
  const original = evidence();
  for (const mutate of [
    e => { e.zero.status.Failure = { unrelated: 'failed' }; },
    e => { e.zero.final_execution_status = 'EXECUTED'; },
    e => { e.zero.transaction.actions[0].FunctionCall.deposit = '1'; },
    e => { e.zero.transaction_outcome.outcome.status.SuccessReceiptId = hash(8); },
    e => { e.zero.receipts_outcome[0].outcome.executor_id = 'other.testnet'; },
    e => { e.zero.receipts.push({ predecessor_id: e.probe.vault, receiver_id: YOUTICK_ACCESS }); },
  ]) {
    const e = structuredClone(original); mutate(e);
    assert.throws(() => verifyYoutickZeroGrantProbe({ probe: e.probe, result: e.zero, txHash: e.zeroHash }), /diagnostic/);
  }
});

test('key-free inspection reads only original FINAL hashes and same-block pinned views', async () => {
  const e = evidence(), calls = [], blockHash = hash(9);
  const provider = {
    async viewNodeStatus() { calls.push('chain'); return { chain_id: 'testnet' }; },
    async query({ account_id, blockId }) { calls.push(`account:${account_id}`);
      return { block_hash: blockId ?? blockHash, code_hash: account_id === e.probe.vault ? e.probe.vault_code_hash :
        account_id === YOUTICK_ACCESS ? YOUTICK_ACCESS_CODE_HASH : YOUTICK_V1_CODE_HASH }; },
    async callFunction(account, method, args, block) {
      calls.push(`view:${method}`); assert.equal(block.blockId, blockHash);
      if (method === 'get_owner') return e.probe.owner;
      if (method === 'contract_version') return 'bouncer-agent-v10-youtick-testnet';
      if (method === 'get_session_grant') return e.grant;
      if (method === 'verify_session_grant') return e.verification;
      throw new Error('unexpected view');
    },
    async txStatusReceipts(txHash, owner, wait) {
      calls.push(`tx:${txHash}`); assert.equal(owner, e.probe.owner); assert.equal(wait, 'FINAL');
      if (txHash === e.zeroHash) return e.zero;
      if (txHash === e.grantHash) return e.issued;
      throw new Error('unknown');
    },
  };
  const report = await inspectYoutickGrantProbe({ probe: e.probe, provider, zeroHash: e.zeroHash, grantHash: e.grantHash, nowMs: now });
  assert.equal(report.zero_guard.rejected_by_one_yocto_guard, true); assert.equal(report.grant.status, 'GRANTED');
  assert.equal(calls.filter(call => call.startsWith('tx:')).length, 2); assert.ok(!calls.some(call => /send|sign/.test(call)));
  await assert.rejects(inspectYoutickGrantProbe({ probe: e.probe, provider, zeroHash: e.zeroHash, grantHash: e.zeroHash }), /options/);
  provider.viewNodeStatus = async () => ({ chain_id: 'mainnet' });
  await assert.rejects(inspectYoutickGrantProbe({ probe: e.probe, provider, zeroHash: e.zeroHash }), /testnet/);
});
