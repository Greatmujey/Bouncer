/** Fake fetch only; no live JSON-RPC traffic or broadcast. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ExperimentalSvalinSetupRpc } from '../agent/svalin-setup-rpc.mjs';
import { fixture, OWNER, hash } from './fixtures/svalin-setup-fixture.mjs';

const endpoint = 'https://rpc.example.test/';
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function withFakeFetch(handler, fn) {
  const original = globalThis.fetch; globalThis.fetch = handler;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

test('composed testnet transport sends one HTTP request and only performs FINAL original-receipt lookup', async () => {
  const f = fixture(), calls = [];
  try {
    const tx = await f.signed(0);
    await withFakeFetch(async (url, options) => {
      const body = JSON.parse(options.body); calls.push({ url, options, body });
      if (body.method === 'status') return response({ jsonrpc: '2.0', id: body.id, result: { chain_id: 'testnet' } });
      if (body.method === 'send_tx') return response({ result: { transaction_outcome: { id: tx.txHash } } });
      if (body.method === 'EXPERIMENTAL_tx_status') return response({ result: { transaction: { hash: tx.txHash } } });
      throw Error('unexpected method');
    }, async () => {
      const rpc = new ExperimentalSvalinSetupRpc(endpoint);
      let guardCalls = 0;
      const sent = await rpc.sendTransactionOnce(tx.signed, 'FINAL', { beforeSubmit: () => { guardCalls++; } });
      assert.equal(guardCalls, 1); assert.equal(rpc.enforcesSetupBeforeSubmitGuard, true);
      assert.equal(sent.transaction_outcome.id, tx.txHash);
      const result = await rpc.txStatusReceipts(tx.txHash, OWNER, 'FINAL');
      assert.equal(result.transaction.hash, tx.txHash);
      assert.deepEqual(calls.map(x => x.body.method), ['status', 'send_tx', 'EXPERIMENTAL_tx_status']);
      assert.ok(calls.every(x => x.url === endpoint));
      assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[1].options.redirect, 'error');
      assert.equal(calls[1].body.params.wait_until, 'FINAL');
      assert.deepEqual(calls[2].body.params, { tx_hash: tx.txHash, sender_account_id: OWNER, wait_until: 'FINAL' });
    });
  } finally { f.close(); }
});

test('HTTP errors and timeouts do not trigger a second submission', async () => {
  const f = fixture();
  try {
    const tx = await f.signed(0);
    for (const outcome of ['503', 'timeout']) {
      let status = 0, sends = 0;
      await withFakeFetch(async (_url, options) => {
        const body = JSON.parse(options.body);
        if (body.method === 'status') { status++; return response({ jsonrpc: '2.0', id: body.id, result: { chain_id: 'testnet' } }); }
        if (body.method === 'send_tx') { sends++; if (outcome === 'timeout') throw Error('synthetic timeout'); return response({}, 503); }
        throw Error('unexpected method');
      }, async () => {
        const rpc = new ExperimentalSvalinSetupRpc(endpoint);
        await assert.rejects(rpc.sendTransactionOnce(tx.signed, 'FINAL', { beforeSubmit: () => {} }), /transaction RPC HTTP 503|synthetic timeout/);
        assert.equal(status, 1); assert.equal(sends, 1);
      });
    }
  } finally { f.close(); }
});

test('wrong chain, signer, finality, endpoint drift or mutation stop before the single send', async () => {
  const f = fixture();
  try {
    for (const mode of ['chain', 'signer', 'finality', 'endpoint', 'mutation']) {
      const tx = await f.signed(0); let sends = 0, calls = 0;
      await withFakeFetch(async (_url, options) => {
        calls++; const body = JSON.parse(options.body);
        if (body.method === 'status') {
          if (mode === 'mutation') tx.signed.transaction.nonce += 1n;
          return response({ jsonrpc: '2.0', id: body.id, result: { chain_id: mode === 'chain' ? 'mainnet' : 'testnet' } });
        }
        sends++; throw Error('must not submit');
      }, async () => {
        const rpc = new ExperimentalSvalinSetupRpc(endpoint);
        if (mode === 'signer') tx.signed.transaction.signerId = 'some.near';
        if (mode === 'endpoint') rpc.connection.url = 'https://changed.example.test/';
        await assert.rejects(rpc.sendTransactionOnce(tx.signed, mode === 'finality' ? 'NONE' : 'FINAL', { beforeSubmit: () => {} }));
        assert.equal(sends, 0);
        assert.equal(calls, ['chain', 'mutation'].includes(mode) ? 1 : 0);
      });
    }
  } finally { f.close(); }
});

test('a missing, expired, asynchronous or mutating before-submit guard cannot reach the send', async () => {
  const f = fixture();
  try {
    for (const mode of ['missing', 'expired', 'async', 'async-reject', 'mutation']) {
      const tx = await f.signed(0); let sends = 0, status = 0;
      await withFakeFetch(async (_url, options) => {
        const body = JSON.parse(options.body);
        if (body.method === 'status') { status++; return response({ jsonrpc: '2.0', id: body.id, result: { chain_id: 'testnet' } }); }
        sends++; throw Error('must not submit');
      }, async () => {
        const rpc = new ExperimentalSvalinSetupRpc(endpoint);
        const beforeSubmit = mode === 'missing' ? undefined : mode === 'expired' ? () => { throw Error('stale snapshot'); } :
          mode === 'async' ? async () => {} : mode === 'async-reject' ? async () => { throw Error('do not leak'); } :
            () => { tx.signed.transaction.nonce += 1n; };
        await assert.rejects(rpc.sendTransactionOnce(tx.signed, 'FINAL', { beforeSubmit }));
        assert.equal(sends, 0); assert.equal(status, mode === 'missing' ? 0 : 1);
      });
    }
  } finally { f.close(); }
});

test('receipt recovery validates original hash, signer, finality and endpoint before network access', async () => {
  let calls = 0;
  await withFakeFetch(async () => { calls++; throw Error('must not fetch'); }, async () => {
    const rpc = new ExperimentalSvalinSetupRpc(endpoint);
    for (const args of [['not-a-hash', OWNER, 'FINAL'], [hash(5), 'owner.near', 'FINAL'], [hash(5), OWNER, 'NONE']]) {
      await assert.rejects(rpc.txStatusReceipts(...args), /original testnet hash and FINAL/);
    }
    rpc.connection.url = 'https://changed.example.test/';
    await assert.rejects(rpc.txStatusReceipts(hash(5), OWNER, 'FINAL'), /endpoints differ/);
    assert.equal(calls, 0);
  });
});

test('synthetic JSON-RPC connects the read-only adapter, signer, journal, one-shot transport and original receipt verifier', async () => {
  const { default: nearApi } = await import('near-api-js');
  const crypto = await import('node:crypto');
  const { runSvalinSetupStageOnce } = await import('../agent/svalin-setup-runner.mjs');
  const { resultFor, STAGES, VAULT } = await import('./fixtures/svalin-setup-fixture.mjs');
  const { BLOCK, NOW, snapshot, providerFor } = await import('./fixtures/svalin-setup-rpc-fixture.mjs');
  const f = fixture(); let sends = 0, chain = null;
  const stringify = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
  try {
    await f.init(); const s = snapshot(f, 0), fake = providerFor(f, s);
    await withFakeFetch(async (url, options) => {
      assert.equal(url, endpoint);
      const req = JSON.parse(options.body), p = req.params; let result;
      if (req.method === 'status') result = await fake.viewNodeStatus();
      else if (req.method === 'block') result = await fake.viewBlock({ finality: p.finality });
      else if (req.method === 'EXPERIMENTAL_protocol_config') {
        assert.deepEqual(p, { block_id: BLOCK }); result = await fake.experimental_protocolConfig({ blockId: p.block_id });
      } else if (req.method === 'query') {
        assert.equal(p.block_id, BLOCK);
        if (req.id === 'bouncer-pinned-presence') {
          assert.equal(p.account_id, VAULT); assert.equal(p.request_type, 'view_account');
          return response({ jsonrpc: '2.0', id: req.id, error: { cause: {
            name: 'UNKNOWN_ACCOUNT', info: { requested_account_id: VAULT, block_hash: BLOCK } } } });
        }
        if (p.request_type === 'view_account') result = { ...(await fake.viewAccount(p.account_id, { blockId: p.block_id })), locked: '0' };
        else if (p.request_type === 'view_access_key') result = { ...(await fake.viewAccessKey(p.account_id, p.public_key, { blockId: p.block_id })), nonce: 2 };
        else if (p.request_type === 'view_access_key_list') result = await fake.viewAccessKeyList(p.account_id, { blockId: p.block_id });
        else if (p.request_type === 'call_function') result = await fake.callFunctionRaw(p.account_id, p.method_name,
          JSON.parse(Buffer.from(p.args_base64, 'base64').toString()), { blockId: p.block_id });
        else throw Error('unexpected synthetic query');
      } else if (req.method === 'send_tx') {
        sends++; assert.equal(p.wait_until, 'FINAL'); assert.equal(options.redirect, 'error');
        const signed = nearApi.transactions.SignedTransaction.decode(Buffer.from(p.signed_tx_base64, 'base64'));
        assert.equal(signed.transaction.nonce, 3n);
        const txHash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256')
          .update(nearApi.transactions.encodeTransaction(signed.transaction)).digest());
        await assert.rejects(f.status(), /another payment operation/);
        const pending = f.journal.list().find(entry => entry.id === `svalin-setup-v1-${STAGES[0]}`);
        assert.equal(pending.status, 'pending'); assert.equal(pending.tx_hash, txHash);
        chain = resultFor(f, 0, txHash); result = { transaction_outcome: { id: txHash } };
      } else if (req.method === 'EXPERIMENTAL_tx_status') {
        assert.equal(p.wait_until, 'FINAL'); assert.equal(p.sender_account_id, OWNER);
        assert.equal(p.tx_hash, chain?.transaction.hash); result = chain;
      } else throw Error('unexpected synthetic RPC method');
      return new Response(stringify({ jsonrpc: '2.0', id: req.id, result }), { status: 200 });
    }, async () => {
      const rpc = new ExperimentalSvalinSetupRpc(endpoint);
      const result = await runSvalinSetupStageOnce({ ...f.base(), stageId: STAGES[0],
        signer: new nearApi.KeyPairSigner(f.ownerPair), provider: rpc, now: () => NOW,
        approval: { network: 'testnet', stage_id: STAGES[0], review_sha256: f.trustedReviewHash,
          artifact_sha256: f.plan.review.artifact.sha256, one_broadcast_approved: true,
          unaudited_artifact_risk_accepted: true, journal_and_key_backups_attested: true,
          keyless_vault_storage_risk_accepted: true } });
      assert.equal(result.status, 'FINAL_SETUP_RECEIPT_MATCH'); assert.equal(sends, 1);
      assert.equal((await f.status()).stages[0].tx_hash, result.tx_hash);
    });
  } finally { f.close(); }
});
