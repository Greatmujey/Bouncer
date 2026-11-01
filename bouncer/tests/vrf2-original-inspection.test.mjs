import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { inspectVrf2OriginalFunding } from '../scripts/inspect-vrf2-setup.mjs';
import { encodeVrf2Journal } from '../scripts/emit-vrf2-recovery.mjs';
import { encryptFileJournal } from '../agent/file-journal-crypto.mjs';
const VAULT = 'bouncer-vrf2-3a0af45958.testnet', OWNER = 'owner-vrf2-3a0af45958.testnet';
const TOKEN = 'usdc.fakes.testnet', KEY = 'ed25519:52oq2ywGuL3QCPf8huZNxkXoxyWpLr1HN4JLQ3cLayMt';
const HASH = 'uhtVNNJewFmpTSVzZ7fr8ReZnvmVenjWcm92XafQRHn';
const enc = value => Buffer.from(JSON.stringify(value)).toString('base64');
function response() {
  const root = 'token-root', child = 'vault-child';
  return { final_execution_status: 'FINAL', status: { SuccessValue: enc('10000') },
    transaction_outcome: { id: HASH, outcome: { receipt_ids: [root], status: { SuccessReceiptId: root } } },
    transaction: { hash: HASH, signer_id: OWNER, public_key: KEY, receiver_id: TOKEN,
      actions: [{ FunctionCall: { method_name: 'ft_transfer_call', deposit: '1', gas: '200000000000000',
        args: enc({ receiver_id: VAULT, amount: '10000', msg: 'fund' }) } }] },
    receipts_outcome: [{ id: root, outcome: { executor_id: TOKEN, receipt_ids: [child], status: { SuccessReceiptId: 'resolver' } } },
      { id: child, outcome: { executor_id: VAULT, receipt_ids: [], logs: ['BOUNCER deposit received'], status: { SuccessValue: enc('0') } } }],
    receipts: [{ receipt_id: child, predecessor_id: TOKEN, receiver_id: VAULT,
      receipt: { Action: { actions: [{ FunctionCall: { method_name: 'ft_on_transfer', deposit: '0',
        args: enc({ sender_id: OWNER, amount: '10000', msg: 'fund' }) } }] } } }],
  };
}

test('original funding inspection binds the exact hash, FT call, used amount and linked vault callback', () => {
  const result = response(), proof = inspectVrf2OriginalFunding(result);
  assert.equal(proof.status, 'FINAL_SUCCESS'); assert.equal(proof.used, '10000');
  assert.equal(proof.vault_callback_verified, true); assert.equal(proof.tx_hash, HASH);
  for (const mutate of [
    r => { r.transaction_outcome.id = '2'.repeat(44); },
    r => { r.transaction.actions[0].FunctionCall.args = enc({ receiver_id: 'other.testnet', amount: '10000', msg: 'fund' }); },
    r => { r.status.SuccessValue = enc('0'); },
    r => { r.transaction_outcome.outcome.receipt_ids = ['other']; },
    r => { r.receipts_outcome[0].outcome.receipt_ids = []; },
    r => { r.receipts[0].predecessor_id = 'other.testnet'; },
    r => { r.receipts_outcome[1].outcome.logs = []; },
    r => { r.receipts_outcome[1].outcome.status.SuccessValue = enc('10000'); },
  ]) { const bad = response(); mutate(bad); assert.throws(() => inspectVrf2OriginalFunding(bad)); }
});

test('a FINAL failed setup remains explicitly failed, not a successful vault funding', () => {
  const result = response(); result.status = { Failure: { kind: 'failure' } };
  result.receipts_outcome[1].outcome.status = { Failure: { kind: 'failure' } };
  const proof = inspectVrf2OriginalFunding(result);
  assert.equal(proof.status, 'FINAL_FAILURE_OR_FAILED_RECEIPT'); assert.equal(proof.used, null);
  assert.equal(proof.vault_callback_verified, false);
});

test('the retained encrypted journal can be split and reconstructed without exposing plaintext', () => {
  const key = crypto.randomBytes(32), content = { version: 1, contract_id: VAULT, owner_account_id: OWNER,
    entries: [{ id: 'owner-fake-funding', tx_hash: HASH, status: 'pending', fingerprint: 'pinned' }] };
  const raw = Buffer.from(encryptFileJournal(content, key, VAULT, OWNER));
  const chunks = encodeVrf2Journal(raw), joined = chunks.map(chunk => chunk.gzip_base64).join('');
  assert.deepEqual(zlib.gunzipSync(Buffer.from(joined, 'base64')), raw);
  assert.equal(chunks[0].sha256, crypto.createHash('sha256').update(raw).digest('hex'));
  assert.ok(!joined.includes(HASH));
  assert.throws(() => encodeVrf2Journal(Buffer.from(JSON.stringify(content))), /not an encrypted envelope/);
  key.fill(0);
});
