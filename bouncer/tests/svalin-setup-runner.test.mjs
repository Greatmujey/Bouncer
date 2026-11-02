/** Synthetic one-shot driver tests: all keys, accounts, receipts and RPC are fake. */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import nearApi from 'near-api-js';
import { runSvalinSetupStageOnce, recoverSvalinSetupStage } from '../agent/svalin-setup-runner.mjs';
import { prepareSvalinProSession } from '../agent/svalin-pro-session.mjs';
import { fixture, resultFor, STAGES, OWNER } from './fixtures/svalin-setup-fixture.mjs';
import { BLOCK, NOW, snapshot, providerFor } from './fixtures/svalin-setup-rpc-fixture.mjs';
import { readExactArtifact } from './fixtures/v11-synthetic-host.mjs';

function approval(f, index) {
  return { network: 'testnet', stage_id: STAGES[index], review_sha256: f.trustedReviewHash,
    artifact_sha256: f.plan.review.artifact.sha256, one_broadcast_approved: true,
    independent_artifact_review_attested: true, journal_and_key_backups_attested: true,
    keyless_vault_storage_risk_accepted: true };
}
function transactionHash(signed) {
  return nearApi.utils.serialize.base_encode(crypto.createHash('sha256')
    .update(nearApi.transactions.encodeTransaction(signed.transaction)).digest());
}
function harness(f, index, { sign = null, send = null, receipt = null, now = () => NOW } = {}) {
  const s = snapshot(f, index), provider = providerFor(f, s), events = [];
  s.ownerKey.nonce = BigInt(index + 2);
  const real = new nearApi.KeyPairSigner(f.ownerPair);
  const signer = {
    async getPublicKey() { events.push('public-key'); return real.getPublicKey(); },
    async signTransaction(tx) { events.push('sign'); return sign ? sign(tx, real) : real.signTransaction(tx); },
  };
  let sends = 0, receipts = 0;
  provider.enforcesSetupBeforeSubmitGuard = true;
  provider.sendTransactionOnce = async (signed, finality, { beforeSubmit }) => {
    assert.equal(typeof beforeSubmit, 'function'); beforeSubmit();
    sends++; events.push('send'); assert.equal(finality, 'FINAL');
    assert.equal(signed.transaction.nonce, BigInt(index + 3), 'uses the pinned owner access-key nonce plus one');
    assert.equal(nearApi.utils.serialize.base_encode(signed.transaction.blockHash), BLOCK);
    const hash = transactionHash(signed);
    // This test-only direct read observes the fsynced entry; regular protocol
    // inspection is excluded while the shared operation lock is held.
    await assert.rejects(f.status(), /another payment operation/);
    const entry = f.journal.list().find(item => item.id === `svalin-setup-v1-${STAGES[index]}`);
    assert.equal(entry.status, 'pending', 'hash is durably journaled before send');
    assert.equal(entry.tx_hash, hash);
    return send ? send(signed, hash) : { transaction_outcome: { id: hash } };
  };
  provider.txStatusReceipts = async (hash, owner, finality) => {
    receipts++; events.push('receipt'); assert.equal(owner, OWNER); assert.equal(finality, 'FINAL');
    return receipt ? receipt(hash) : resultFor(f, index, hash);
  };
  const options = { ...f.base(), stageId: STAGES[index], signer, provider, approval: approval(f, index), now };
  return { s, events, options, provider, signer, get sends() { return sends; }, get receipts() { return receipts; } };
}

test('each synthetic setup stage uses a pinned nonce, original journal, one send and matching receipts', async () => {
  const f = fixture();
  try {
    await f.init();
    for (let i = 0; i < STAGES.length; i++) {
      const h = harness(f, i), result = await runSvalinSetupStageOnce(h.options);
      assert.equal(result.status, i === 4 ? 'FINAL_FUNDING_RECEIPTS_MATCH' : 'FINAL_SETUP_RECEIPT_MATCH');
      assert.equal(result.stage_id, STAGES[i]); assert.equal(result.broadcast_attempts, 1); assert.equal(h.sends, 1); assert.equal(h.receipts, 1);
      assert.deepEqual(h.events, ['public-key', 'sign', 'send', 'receipt']);
      assert.equal(result.do_not_resend, true); assert.equal(result.post_stage_snapshot_required, true);
      assert.equal(result.current_state_verified, false); assert.equal(result.owner_approval_verified, false); assert.equal(result.seller_contacted, false);
      const state = await f.status(); assert.equal(state.stages[i].state, 'FINAL_RECEIPTS_MATCH');
      assert.equal(state.stages[i].tx_hash, result.tx_hash);
      assert.equal(fs.readFileSync(f.file, 'utf8').includes(result.tx_hash), false, 'journal is encrypted');
      assert.equal(fs.readFileSync(f.file, 'utf8').includes(f.ownerPair.toString()), false, 'no private signer material in journal');
      await assert.rejects(runSvalinSetupStageOnce(h.options), /journal is not ready/);
      assert.equal(h.sends, 1, 'the completed original cannot be broadcast again');
    }
  } finally { f.close(); }
});

test('recovered exact V11 bytes can be signed and fenced with synthetic stage-zero RPC and receipts',
  { skip: process.env.BOUNCER_V11_WASM_PATH ? false : 'set BOUNCER_V11_WASM_PATH to the recovered V11 artifact' }, async () => {
    const f = fixture({ wasmBytes: readExactArtifact(process.env.BOUNCER_V11_WASM_PATH) });
    try {
      await f.init(); const h = harness(f, 0), result = await runSvalinSetupStageOnce(h.options);
      assert.equal(result.status, 'FINAL_SETUP_RECEIPT_MATCH');
      assert.equal(h.sends, 1); assert.equal(h.receipts, 1);
      assert.equal((await f.status()).stages[0].tx_hash, result.tx_hash);
    } finally { f.close(); }
  });

test('exact-stage acknowledgments, retained review and correct signer are required before any send', async () => {
  const f = fixture();
  try {
    await f.init();
    for (const mutate of [
      a => { a.network = 'mainnet'; }, a => { a.stage_id = STAGES[1]; }, a => { a.review_sha256 = '0'.repeat(64); },
      a => { a.artifact_sha256 = '0'.repeat(64); }, a => { a.one_broadcast_approved = false; },
      a => { a.independent_artifact_review_attested = false; }, a => { a.journal_and_key_backups_attested = false; },
      a => { a.keyless_vault_storage_risk_accepted = false; }, a => { a.unreviewed = true; }, a => { delete a.network; },
    ]) {
      const h = harness(f, 0); mutate(h.options.approval);
      await assert.rejects(runSvalinSetupStageOnce(h.options), /acknowledgments/);
      assert.deepEqual(h.s.calls, []); assert.deepEqual(h.events, []); assert.equal(h.sends, 0);
    }
    const unguarded = harness(f, 0); delete unguarded.provider.enforcesSetupBeforeSubmitGuard;
    await assert.rejects(runSvalinSetupStageOnce(unguarded.options), /before-submit guard/);
    assert.deepEqual(unguarded.events, []); assert.deepEqual(unguarded.s.calls, []);
    const wrong = harness(f, 0); wrong.signer.getPublicKey = async () => nearApi.KeyPair.fromRandom('ed25519').getPublicKey();
    await assert.rejects(runSvalinSetupStageOnce(wrong.options), /differs from the reviewed public key/);
    assert.equal(wrong.sends, 0); assert.equal((await f.status()).stages[0].state, 'NOT_RECORDED');
    const changed = harness(f, 0);
    changed.signer.getPublicKey = async () => { changed.options.approval.one_broadcast_approved = false; return f.ownerPair.getPublicKey(); };
    await assert.rejects(runSvalinSetupStageOnce(changed.options), /acknowledgments changed/);
    assert.equal(changed.sends, 0);
  } finally { f.close(); }
});

test('unsafe or unavailable snapshot blocks before signing; signer substitution and invalid signatures cannot reach the journal', async () => {
  const f = fixture();
  try {
    await f.init();
    for (const mutate of [s => { s.protocol.protocol_version = 87; }, s => { s.presence.exists = true; },
      s => { s.protocol.runtime_config.wasm_config.universal_accounts = false; },
      s => { s.ownerKey.permission = { FunctionCall: {} }; }, s => { s.ownerKey.nonce = BigInt(Number.MAX_SAFE_INTEGER); },
      s => { s.ownerUsdc = '1'; }, s => { s.failures.add('ownerKey'); }]) {
      const h = harness(f, 0); mutate(h.s);
      const result = await runSvalinSetupStageOnce(h.options);
      assert.equal(result.status, 'BLOCKED_BEFORE_SIGNING'); assert.equal(result.transaction_signed, false);
      assert.deepEqual(h.events, []); assert.equal(h.sends, 0);
    }
    const wrongNetwork = harness(f, 0); wrongNetwork.s.network = 'mainnet';
    await assert.rejects(runSvalinSetupStageOnce(wrongNetwork.options), /testnet/); assert.deepEqual(wrongNetwork.events, []);
    for (const alteration of ['payload', 'signature', 'hash']) {
      const h = harness(f, 0, { sign: async (tx, real) => {
        const [hash, signed] = await real.signTransaction(tx);
        if (alteration === 'payload') signed.transaction.actions[1].transfer.deposit = 1n;
        if (alteration === 'signature') signed.signature.data[0] ^= 1;
        if (alteration === 'hash') hash[0] ^= 1;
        return [hash, signed];
      } });
      await assert.rejects(runSvalinSetupStageOnce(h.options), /signed setup transaction/i);
      assert.equal(h.sends, 0); assert.equal((await f.status()).stages[0].state, 'NOT_RECORDED');
    }
  } finally { f.close(); }
});

test('post-sign state drift fences the original hash and cannot trigger a send or replacement', async () => {
  for (const drift of ['nonce', 'registration', 'protocol', 'wasm-feature']) {
    const f = fixture();
    try {
      await f.init(); let h;
      h = harness(f, 0, { sign: async (tx, real) => {
        const result = await real.signTransaction(tx);
        if (drift === 'nonce') h.s.ownerKey.nonce += 1n;
        if (drift === 'registration') h.s.vaultRegistration = { total: '1', available: '0' };
        if (drift === 'protocol') h.s.protocol.protocol_version = 87;
        if (drift === 'wasm-feature') h.s.protocol.runtime_config.wasm_config.universal_accounts = false;
        return result;
      } });
      const result = await runSvalinSetupStageOnce(h.options);
      assert.equal(result.status, 'ORIGINAL_HASH_NEEDS_RECONCILIATION'); assert.equal(result.broadcast_attempts, 0);
      assert.equal(result.do_not_resend, true); assert.equal(h.sends, 0);
      assert.equal((await f.status()).stages[0].tx_hash, result.tx_hash);
      await assert.rejects(runSvalinSetupStageOnce(h.options), /journal is not ready/);
      assert.equal(h.sends, 0);
    } finally { f.close(); }
  }
});

test('a snapshot that expires inside transport preparation cannot reach the HTTP submission', async () => {
  const f = fixture();
  try {
    await f.init(); let clock = NOW;
    const h = harness(f, 0, { now: () => clock });
    const original = h.provider.sendTransactionOnce;
    h.provider.sendTransactionOnce = async (...args) => { clock = NOW + 120_001; return original(...args); };
    const result = await runSvalinSetupStageOnce(h.options);
    assert.equal(result.status, 'ORIGINAL_HASH_NEEDS_RECONCILIATION');
    assert.equal(result.broadcast_attempts, 1, 'counts the transport invocation conservatively');
    assert.equal(h.sends, 0, 'the last-moment guard stopped the synthetic HTTP send');
    assert.equal((await f.status()).stages[0].tx_hash, result.tx_hash);
  } finally { f.close(); }
});

test('post-record mutation of signed bytes cannot reach the transport', async () => {
  const f = fixture();
  try {
    await f.init(); let signedRef, statusCalls = 0;
    const h = harness(f, 0, { sign: async (tx, real) => {
      const result = await real.signTransaction(tx); signedRef = result[1]; return result;
    } });
    const status = h.provider.viewNodeStatus;
    h.provider.viewNodeStatus = async () => {
      statusCalls++;
      if (statusCalls === 2) signedRef.signature.data[0] ^= 1;
      return status();
    };
    const result = await runSvalinSetupStageOnce(h.options);
    assert.equal(result.status, 'ORIGINAL_HASH_NEEDS_RECONCILIATION');
    assert.equal(result.broadcast_attempts, 0); assert.equal(h.sends, 0);
    assert.equal((await f.status()).stages[0].tx_hash, result.tx_hash);
  } finally { f.close(); }
});

test('an ambiguous send remains pending; key-free recovery reads only the original hash and never sends', async () => {
  const f = fixture();
  try {
    await f.init();
    const h = harness(f, 0, { send: async () => { throw new Error('raw signed bytes and token must not appear in the result'); } });
    const pending = await runSvalinSetupStageOnce(h.options);
    assert.equal(pending.status, 'ORIGINAL_HASH_NEEDS_RECONCILIATION'); assert.equal(pending.broadcast_attempts, 1);
    assert.equal(h.sends, 1); assert.equal(h.receipts, 0);
    assert.equal(JSON.stringify(pending).includes('token must not appear'), false);
    assert.equal((await f.status()).stages[0].state, 'ORIGINAL_HASH_PENDING');
    await assert.rejects(runSvalinSetupStageOnce(h.options), /journal is not ready/);
    assert.equal(h.sends, 1);
    const recovery = { ...f.base(), stageId: STAGES[0], provider: h.provider, update: false };
    h.s.network = 'mainnet';
    await assert.rejects(recoverSvalinSetupStage(recovery), /must report testnet/);
    assert.equal(h.receipts, 0); h.s.network = 'testnet';
    const originalReceipt = h.provider.txStatusReceipts;
    h.provider.txStatusReceipts = async () => { throw Error('sensitive network information'); };
    await assert.rejects(recoverSvalinSetupStage(recovery), error =>
      /original receipt unavailable/.test(error.message) && !error.message.includes('sensitive'));
    assert.equal((await f.status()).stages[0].tx_hash, pending.tx_hash);
    h.provider.txStatusReceipts = originalReceipt;
    const inspected = await recoverSvalinSetupStage(recovery);
    assert.equal(inspected.status, 'FINAL_SETUP_RECEIPT_MATCH'); assert.equal(inspected.journal_updated, false);
    assert.equal((await f.status()).stages[0].state, 'ORIGINAL_HASH_PENDING');
    const done = await recoverSvalinSetupStage({ ...recovery, update: true });
    assert.equal(done.status, 'FINAL_SETUP_RECEIPT_MATCH'); assert.equal(done.journal_updated, true);
    assert.equal((await f.status()).stages[0].state, 'FINAL_RECEIPTS_MATCH'); assert.equal(h.sends, 1);
  } finally { f.close(); }
});

test('lost receipt, mismatched hash or FINAL failure cannot lead to a second send or later stage', async () => {
  for (const mode of ['bad-send-hash', 'missing-receipt', 'failure']) {
    const f = fixture();
    try {
      await f.init();
      const h = harness(f, 0, {
        send: async (_signed, hash) => ({ transaction_outcome: { id: mode === 'bad-send-hash' ? 'wrong' : hash } }),
        receipt: async hash => {
          if (mode === 'missing-receipt') throw Error('private-rpc-details');
          const r = resultFor(f, 0, hash);
          if (mode === 'failure') { r.status = { Failure: { ActionError: {} } }; r.receipts_outcome[0].outcome.status = { Failure: { ActionError: {} } }; }
          return r;
        },
      });
      const result = await runSvalinSetupStageOnce(h.options);
      assert.equal(result.status, mode === 'failure' ? 'FINAL_FAILURE_NEEDS_RECONCILIATION' : 'ORIGINAL_HASH_NEEDS_RECONCILIATION');
      assert.equal(h.sends, 1); assert.equal(result.do_not_resend, true);
      const state = await f.status(); assert.notEqual(state.stages[0].state, 'FINAL_RECEIPTS_MATCH');
      await assert.rejects(runSvalinSetupStageOnce(harness(f, 1).options), /journal is not ready/);
      await assert.rejects(runSvalinSetupStageOnce(h.options), /journal is not ready/);
      assert.equal(h.sends, 1);
    } finally { f.close(); }
  }
});

test('disk error or stale post-record snapshot never broadcasts and keeps any written original fenced', async () => {
  for (const mode of ['before-write', 'lost-ack', 'stale']) {
    const f = fixture();
    try {
      await f.init(); let clock = NOW;
      const h = harness(f, 0, { now: () => clock });
      const original = f.journal.put.bind(f.journal);
      f.journal.put = (...args) => {
        if (mode === 'before-write') throw Error('local disk failed');
        original(...args);
        if (mode === 'lost-ack') throw Error('lost acknowledgment');
        clock = NOW + 120_001;
      };
      if (mode === 'stale') {
        const result = await runSvalinSetupStageOnce(h.options);
        assert.equal(result.status, 'ORIGINAL_HASH_NEEDS_RECONCILIATION'); assert.equal(result.broadcast_attempts, 0);
      } else await assert.rejects(runSvalinSetupStageOnce(h.options), /journal write outcome unknown/);
      f.journal.put = original; assert.equal(h.sends, 0);
      const state = await f.status();
      assert.equal(state.stages[0].state, mode === 'before-write' ? 'NOT_RECORDED' : 'ORIGINAL_HASH_PENDING');
      if (mode !== 'before-write') await assert.rejects(runSvalinSetupStageOnce(h.options), /journal is not ready/);
    } finally { f.close(); }
  }
});

test('concurrent runners sharing a journal cannot both sign or send', async () => {
  const f = fixture();
  try {
    await f.init(); let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const waiting = new Promise(resolve => { release = resolve; });
    const first = harness(f, 0, { sign: async (tx, real) => { entered(); await waiting; return real.signTransaction(tx); } });
    const second = harness(f, 0);
    const pending = runSvalinSetupStageOnce(first.options); await started;
    await assert.rejects(runSvalinSetupStageOnce(second.options), /another payment operation/);
    await assert.rejects(prepareSvalinProSession({ goal: f.inputs.goal, journal: f.journal, now: () => NOW }), /another payment operation/);
    await assert.rejects(f.status(), /another payment operation/);
    release(); const result = await pending;
    assert.equal(result.status, 'FINAL_SETUP_RECEIPT_MATCH'); assert.equal(first.sends, 1); assert.equal(second.sends, 0);
    assert.deepEqual(second.events, []);
  } finally { f.close(); }
});
