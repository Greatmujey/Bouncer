/** All helper, RPC, accounts, transactions and receipts here are synthetic. */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import { FileJournal } from '../agent/procurement.mjs';
import { FAUCET_RETURN, FAUCET_TRANSFER_YOCTO, HELPER_URL, runNativeTestnetFaucet,
  verifyFaucetTransfer } from '../agent/native-testnet-faucet.mjs';
import { NO_LOCAL_CONTRACT_HASH } from '../shared/plain-owner-profile.mjs';

const OWNER = 'funded-owner.testnet', NOW = 1_792_000_000_000;
const id = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n));
const BLOCK = id(7);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest();
function receiptFor(tx, hash, { omitLocal = false } = {}) {
  const action = tx.actions[0];
  const view = action.enum === 'transfer' ? { Transfer: { deposit: action.transfer.deposit.toString() } } :
    { DeleteAccount: { beneficiary_id: action.deleteAccount.beneficiaryId } };
  const root = id(action.enum === 'transfer' ? 12 : 13), isCleanup = action.enum === 'deleteAccount', payoutId = id(16);
  const body = { signer_id: tx.signerId, signer_public_key: String(tx.publicKey), gas_price: '100',
    input_data_ids: [], output_data_receivers: [], actions: [view] };
  const payout = { receipt_id: payoutId, predecessor_id: 'system', receiver_id: FAUCET_RETURN,
    receipt: { Action: { signer_id: 'system', signer_public_key: 'ed25519:11111111111111111111111111111111',
      gas_price: '0', input_data_ids: [], output_data_receivers: [], actions: [{ Transfer: { deposit: '4900000000000000000000000' } }] } } };
  return { final_execution_status: 'FINAL', status: { SuccessValue: '' },
    transaction: { hash, signer_id: tx.signerId, receiver_id: tx.receiverId, public_key: String(tx.publicKey),
      nonce: Number(tx.nonce), actions: [structuredClone(view)] },
    transaction_outcome: { id: hash, outcome: { executor_id: tx.signerId, receipt_ids: [root], status: { SuccessReceiptId: root } } },
    receipts: [...(omitLocal && tx.signerId === tx.receiverId ? [] : [{ receipt_id: root, predecessor_id: tx.signerId,
      receiver_id: tx.receiverId, receipt: { Action: body } }]), ...(isCleanup ? [payout] : [])],
    receipts_outcome: [{ id: root, outcome: { executor_id: tx.receiverId, receipt_ids: isCleanup ? [payoutId] : [], status: { SuccessValue: '' } } },
      ...(isCleanup ? [{ id: payoutId, outcome: { executor_id: FAUCET_RETURN, receipt_ids: [], status: { SuccessValue: '' } } }] : [])] };
}
function harness({ helper = 'ok', send = 'ok', omitLocal = false, encryption = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-faucet-test-'));
  const file = path.join(dir, 'journal.json'), key = crypto.randomBytes(32);
  let journal = new FileJournal(file, OWNER, OWNER, encryption ? { encryptionKey: key } : {});
  const state = { helper, send, omitLocal, network: 'testnet', keyPermission: 'FullAccess', extraKey: false, listNonceDelta: 0,
    tempCode: NO_LOCAL_CONTRACT_HASH, helperCalls: 0, sends: [], lookups: [], temp: null,
    stored: new Map(), ownerAmount: '2873000000000000000000000', availability: true, failLookup: false };
  const block = () => ({ header: { hash: BLOCK, timestamp_nanosec: String(BigInt(NOW) * 1_000_000n) } });
  const account = amount => ({ amount, locked: '0', storage_usage: 200, code_hash: NO_LOCAL_CONTRACT_HASH, block_hash: BLOCK });
  const provider = {
    enforcesSetupBeforeSubmitGuard: true,
    async viewNodeStatus() { return { chain_id: state.network }; },
    async viewBlock() { return block(); },
    async viewAccount(accountId, at) {
      assert.equal(at.blockId, BLOCK);
      if (accountId === OWNER) return account(state.ownerAmount);
      if (!state.temp || state.temp.deleted || accountId !== state.temp.id) throw new Error('account unavailable');
      return { ...account(state.temp.balance.toString()), code_hash: state.tempCode };
    },
    async viewTestnetAccountPresenceAt(accountId, hash) {
      assert.equal(hash, BLOCK);
      return { block_hash: hash, exists: Boolean(state.temp && !state.temp.deleted && state.temp.id === accountId) };
    },
    async viewAccessKey(accountId, keyText, at) {
      assert.equal(at.blockId, BLOCK); assert.equal(accountId, state.temp.id); assert.equal(keyText, state.temp.key);
      return { nonce: state.temp.nonce, permission: state.keyPermission, block_hash: BLOCK };
    },
    async viewAccessKeyList(accountId, at) {
      assert.equal(accountId, state.temp.id); assert.equal(at.blockId, BLOCK);
      const keys = [{ public_key: state.temp.key, access_key: { permission: state.keyPermission, nonce: state.temp.nonce + state.listNonceDelta } }];
      if (state.extraKey) keys.push({ public_key: 'ed25519:other', access_key: { permission: 'FullAccess' } });
      return { keys, block_hash: BLOCK };
    },
    async experimental_protocolConfig(at) {
      assert.equal(at.blockId, BLOCK);
      return { chain_id: state.network, runtime_config: { storage_amount_per_byte: '10000000000000000000' } };
    },
    async sendTransactionOnce(signed, finality, { beforeSubmit }) {
      assert.equal(finality, 'FINAL'); beforeSubmit();
      const tx = signed.transaction, bytes = Buffer.from(nearApi.transactions.encodeTransaction(tx)), hashBytes = digest(bytes);
      const txHash = nearApi.utils.serialize.base_encode(hashBytes), stage = tx.actions[0].enum === 'transfer' ? 'transfer' : 'cleanup';
      assert.ok(tx.publicKey.verify(hashBytes, signed.signature.data));
      const entry = journal.list()[0];
      assert.equal(entry[stage].tx_hash, txHash, 'original hash is durable before send');
      assert.equal(entry[stage].state, 'pending');
      assert.equal(fs.readFileSync(file, 'utf8').includes(entry.temporary_secret), false, 'testnet key is encrypted');
      state.sends.push({ stage, txHash, receiver: tx.receiverId, action: tx.actions[0].enum });
      const result = receiptFor(tx, txHash, { omitLocal: state.omitLocal });
      state.stored.set(txHash, result);
      state.temp.nonce = Number(tx.nonce);
      if (stage === 'transfer') {
        assert.equal(tx.receiverId, OWNER); assert.equal(tx.actions[0].transfer.deposit.toString(), FAUCET_TRANSFER_YOCTO);
        state.temp.balance -= BigInt(FAUCET_TRANSFER_YOCTO);
      } else {
        assert.equal(tx.receiverId, state.temp.id); assert.equal(tx.actions[0].deleteAccount.beneficiaryId, FAUCET_RETURN);
        state.temp.deleted = true;
      }
      if (state.send === stage || state.send === 'all') throw new Error('synthetic lost acknowledgment');
      return result;
    },
    async txStatusReceipts(hash, signer, finality) {
      state.lookups.push(hash); assert.equal(signer, state.temp.id); assert.equal(finality, 'FINAL');
      if (state.failLookup || !state.stored.has(hash)) throw new Error('synthetic unavailable receipt');
      return structuredClone(state.stored.get(hash));
    },
  };
  const fetchImpl = async (url, options) => {
    state.helperCalls++; assert.equal(url, HELPER_URL); assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    const body = JSON.parse(options.body);
    assert.deepEqual(Object.keys(body).sort(), ['newAccountId', 'newAccountPublicKey']);
    const entry = journal.list()[0];
    assert.equal(entry.temporary_account, body.newAccountId); assert.equal(entry.temporary_public_key, body.newAccountPublicKey);
    assert.equal(entry.helper_attempted, true, 'helper-attempt fence precedes helper contact');
    assert.equal(options.body.includes(entry.temporary_secret), false, 'only the public key leaves the process');
    if (state.helper !== 'timeout-before') state.temp = { id: body.newAccountId, key: body.newAccountPublicKey,
      nonce: 0, balance: 10n ** 25n, deleted: false };
    if (state.helper !== 'ok') throw new Error('synthetic helper timeout');
    return new Response('{}', { status: 200 });
  };
  return {
    state, provider, fetchImpl, file, key,
    get journal() { return journal; },
    options(extra = {}) { return { recipient: OWNER, journal, provider, fetchImpl, now: () => NOW, ...extra }; },
    reopen() { journal.close(); journal = new FileJournal(file, OWNER, OWNER, { encryptionKey: key, requireExisting: true }); },
    close() { journal.close(); key.fill(0); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('dry run is read-only: no helper, signature, transfer or journal entry', async () => {
  const h = harness();
  try {
    const value = await runNativeTestnetFaucet(h.options());
    assert.equal(value.status, 'READ_ONLY_READY'); assert.equal(value.sent, false); assert.equal(value.helper_contacted, false);
    assert.equal(h.state.helperCalls, 0); assert.deepEqual(h.state.sends, []); assert.deepEqual(h.journal.list(), []);
    assert.equal(fs.existsSync(h.file), false);
  } finally { h.close(); }
});

test('one helper request, one exact transfer and one return-to-faucet deletion complete with encrypted recovery', async () => {
  const h = harness({ omitLocal: true });
  try {
    const result = await runNativeTestnetFaucet(h.options({ execute: true }));
    assert.equal(result.status, 'FUNDED_AND_CLEANED'); assert.equal(result.transfer_final, true); assert.equal(result.cleanup_final, true);
    assert.equal(result.circle_usdc_funded, false); assert.equal(result.seller_contacted, false);
    assert.equal(h.state.helperCalls, 1); assert.deepEqual(h.state.sends.map(x => x.stage), ['transfer', 'cleanup']);
    assert.equal(h.state.sends[1].receiver, result.temporary_account);
    assert.equal(h.journal.list()[0].temporary_secret, undefined, 'confirmed deletion removes the temporary key from the journal');
    assert.equal(JSON.stringify(result).includes('temporary_secret'), false);
    h.reopen();
    const resumed = await runNativeTestnetFaucet(h.options({ execute: true, resume: true }));
    assert.equal(resumed.status, 'FUNDED_AND_CLEANED'); assert.equal(h.state.helperCalls, 1); assert.equal(h.state.sends.length, 2);
  } finally { h.close(); }
});

test('a lost helper acknowledgement never repeats the request; a later matching account can be resumed', async () => {
  const h = harness({ helper: 'timeout-before' });
  try {
    const first = await runNativeTestnetFaucet(h.options({ execute: true }));
    assert.equal(first.status, 'TEMPORARY_ACCOUNT_UNCONFIRMED'); assert.equal(h.state.helperCalls, 1); assert.equal(h.state.sends.length, 0);
    const entry = h.journal.list()[0], secret = entry.temporary_secret;
    assert.equal(fs.readFileSync(h.file, 'utf8').includes(secret), false); assert.equal(JSON.stringify(first).includes(secret), false);
    h.reopen();
    const readOnly = await runNativeTestnetFaucet(h.options({ resume: true }));
    assert.equal(readOnly.status, 'ORIGINAL_HELPER_ATTEMPT_RECORDED'); assert.equal(h.state.helperCalls, 1);
    h.state.temp = { id: entry.temporary_account, key: entry.temporary_public_key, nonce: 0, balance: 10n ** 25n, deleted: false };
    const finished = await runNativeTestnetFaucet(h.options({ execute: true, resume: true }));
    assert.equal(finished.status, 'FUNDED_AND_CLEANED'); assert.equal(h.state.helperCalls, 1);
    assert.deepEqual(h.state.sends.map(x => x.stage), ['transfer', 'cleanup']);
  } finally { h.close(); }
});

test('an ambiguous helper response can continue only from the matching FINAL temporary-account profile', async () => {
  const h = harness({ helper: 'timeout-after' });
  try {
    const result = await runNativeTestnetFaucet(h.options({ execute: true }));
    assert.equal(result.helper_response, 'unknown'); assert.equal(result.status, 'FUNDED_AND_CLEANED');
    assert.equal(h.state.helperCalls, 1); assert.equal(h.state.sends.length, 2);
  } finally { h.close(); }
});

test('lost transfer acknowledgement and unavailable receipt keep the exact original hash fenced', async () => {
  const h = harness({ send: 'transfer' });
  try {
    h.state.failLookup = true;
    const first = await runNativeTestnetFaucet(h.options({ execute: true }));
    assert.equal(first.status, 'ORIGINAL_TRANSFER_UNRESOLVED'); assert.equal(h.state.sends.length, 1);
    assert.equal(first.transfer_tx_hash, h.state.sends[0].txHash);
    h.reopen();
    const second = await runNativeTestnetFaucet(h.options({ execute: true, resume: true }));
    assert.equal(second.status, 'ORIGINAL_TRANSFER_UNRESOLVED'); assert.equal(h.state.sends.length, 1); assert.equal(h.state.helperCalls, 1);
    h.state.failLookup = false;
    const finish = await runNativeTestnetFaucet(h.options({ execute: true, resume: true }));
    assert.equal(finish.status, 'FUNDED_AND_CLEANED'); assert.deepEqual(h.state.sends.map(x => x.stage), ['transfer', 'cleanup']);
    assert.equal(finish.transfer_tx_hash, first.transfer_tx_hash);
  } finally { h.close(); }
});

test('cleanup is never repeated after a lost result; recovering it does not re-transfer', async () => {
  const h = harness({ send: 'cleanup' });
  try {
    let lookupCount = 0; const original = h.provider.txStatusReceipts;
    h.provider.txStatusReceipts = async (...args) => { lookupCount++; if (lookupCount === 2) throw new Error('lost cleanup response'); return original(...args); };
    const first = await runNativeTestnetFaucet(h.options({ execute: true }));
    assert.equal(first.status, 'FUNDED_CLEANUP_UNRESOLVED'); assert.equal(h.state.sends.length, 2);
    assert.ok(h.journal.list()[0].temporary_secret, 'retain encrypted temporary key while cleanup is unresolved');
    h.reopen();
    const recovered = await runNativeTestnetFaucet(h.options({ resume: true, execute: true }));
    assert.equal(recovered.status, 'FUNDED_AND_CLEANED'); assert.equal(h.state.sends.length, 2); assert.equal(h.state.helperCalls, 1);
    assert.equal(h.journal.list()[0].temporary_secret, undefined);
  } finally { h.close(); }
});

test('mismatched key, extra key, deployed code, too little balance or wrong chain blocks transfers', async () => {
  for (const mutation of [
    h => { h.state.keyPermission = { FunctionCall: {} }; },
    h => { h.state.extraKey = true; },
    h => { h.state.listNonceDelta = 1; },
    h => { h.state.tempCode = BLOCK; },
    h => { h.state.temp.balance = BigInt(FAUCET_TRANSFER_YOCTO); },
  ]) {
    const h = harness({ helper: 'timeout-before' });
    try {
      await runNativeTestnetFaucet(h.options({ execute: true }));
      const entry = h.journal.list()[0];
      h.state.temp = { id: entry.temporary_account, key: entry.temporary_public_key, nonce: 0, balance: 10n ** 25n, deleted: false };
      mutation(h);
      await assert.rejects(runNativeTestnetFaucet(h.options({ execute: true, resume: true })), /profile|cover/);
      assert.equal(h.state.sends.length, 0); assert.equal(h.state.helperCalls, 1); assert.equal(h.journal.list()[0].transfer, null);
    } finally { h.close(); }
  }
  const h = harness();
  try {
    h.state.network = 'mainnet';
    await assert.rejects(runNativeTestnetFaucet(h.options({ execute: true })), /testnet/);
    assert.equal(h.state.helperCalls, 0); assert.equal(h.state.sends.length, 0); assert.deepEqual(h.journal.list(), []);
  } finally { h.close(); }
});

test('stale FINAL blocks, invalid recipients and unencrypted or mismatched journals stop before helper contact', async () => {
  const h = harness();
  try {
    await assert.rejects(runNativeTestnetFaucet(h.options({ recipient: 'owner.near', execute: true })), /testnet recipient/);
    await assert.rejects(runNativeTestnetFaucet(h.options({ now: () => NOW + 500_000, execute: true })), /stale/);
    assert.equal(h.state.helperCalls, 0); assert.equal(h.state.sends.length, 0); assert.deepEqual(h.journal.list(), []);
  } finally { h.close(); }
  const plain = harness({ encryption: false });
  try {
    await assert.rejects(runNativeTestnetFaucet(plain.options({ execute: true })), /encrypted faucet journal/);
    assert.equal(plain.state.helperCalls, 0);
  } finally { plain.close(); }
});

test('forged or incomplete FINAL transfers do not trigger deletion', async () => {
  const h = harness();
  try {
    h.state.failLookup = true;
    const first = await runNativeTestnetFaucet(h.options({ execute: true }));
    const entry = h.journal.list()[0], good = h.state.stored.get(first.transfer_tx_hash);
    for (const change of [
      r => { r.final_execution_status = 'EXECUTED'; },
      r => { r.transaction.receiver_id = 'attacker.testnet'; },
      r => { r.transaction.actions[0].Transfer.deposit = '1'; },
      r => { r.receipts[0].receipt.Action.actions[0].Transfer.deposit = '1'; },
      r => { r.receipts = []; },
      r => { r.receipts_outcome[0].outcome.status = { Failure: {} }; },
      r => { r.receipts_outcome[0].outcome.executor_id = 'attacker.testnet'; },
    ]) {
      const forged = structuredClone(good); change(forged);
      assert.throws(() => verifyFaucetTransfer(forged, entry));
      h.state.stored.set(first.transfer_tx_hash, forged); h.state.failLookup = false;
      const result = await runNativeTestnetFaucet(h.options({ execute: true, resume: true }));
      assert.equal(result.status, 'ORIGINAL_TRANSFER_UNRESOLVED'); assert.equal(h.state.sends.length, 1);
    }
  } finally { h.close(); }
});

test('concurrent callers sharing one journal cannot both request the helper', async () => {
  const h = harness();
  let release; const wait = new Promise(resolve => { release = resolve; });
  try {
    const fetchImpl = async (...args) => { await wait; return h.fetchImpl(...args); };
    const first = runNativeTestnetFaucet(h.options({ execute: true, fetchImpl }));
    // The operation reserves the weak-map lock before the first await.
    await assert.rejects(runNativeTestnetFaucet(h.options({ execute: true })), /another payment operation/);
    release();
    assert.equal((await first).status, 'FUNDED_AND_CLEANED'); assert.equal(h.state.helperCalls, 1);
  } finally { release(); h.close(); }
});

test('a failed durable journal reservation prevents helper contact', async () => {
  const h = harness();
  try {
    h.journal.put = () => { throw new Error('synthetic disk failure'); };
    await assert.rejects(runNativeTestnetFaucet(h.options({ execute: true })), /disk failure/);
    assert.equal(h.state.helperCalls, 0); assert.equal(h.state.sends.length, 0);
  } finally { h.close(); }
});

test('post-record network drift retains the signed original without sending or replacing it', async () => {
  const h = harness({ helper: 'timeout-before' });
  try {
    await runNativeTestnetFaucet(h.options({ execute: true }));
    const entry = h.journal.list()[0];
    h.state.temp = { id: entry.temporary_account, key: entry.temporary_public_key, nonce: 0, balance: 10n ** 25n, deleted: false };
    let views = 0; const original = h.provider.viewNodeStatus;
    h.provider.viewNodeStatus = async () => { views++; return views >= 2 ? { chain_id: 'mainnet' } : original(); };
    const pending = await runNativeTestnetFaucet(h.options({ resume: true, execute: true }));
    assert.equal(pending.status, 'ORIGINAL_TRANSFER_UNRESOLVED'); assert.ok(pending.transfer_tx_hash);
    assert.equal(h.state.sends.length, 0);
    h.provider.viewNodeStatus = original;
    const resumed = await runNativeTestnetFaucet(h.options({ resume: true, execute: true }));
    assert.equal(resumed.status, 'ORIGINAL_TRANSFER_UNRESOLVED'); assert.equal(resumed.transfer_tx_hash, pending.transfer_tx_hash);
    assert.equal(h.state.sends.length, 0); assert.equal(h.state.helperCalls, 1);
  } finally { h.close(); }
});

test('read-only recovery can inspect confirmed cleanup without changing the retained journal', async () => {
  const h = harness();
  try {
    let lookup = 0; const original = h.provider.txStatusReceipts;
    h.provider.txStatusReceipts = async (...args) => { lookup++; if (lookup === 2) throw new Error('synthetic missing response'); return original(...args); };
    assert.equal((await runNativeTestnetFaucet(h.options({ execute: true }))).status, 'FUNDED_CLEANUP_UNRESOLVED');
    const before = fs.readFileSync(h.file, 'utf8');
    const inspected = await runNativeTestnetFaucet(h.options({ resume: true }));
    assert.equal(inspected.status, 'FUNDED_AND_CLEANED'); assert.equal(fs.readFileSync(h.file, 'utf8'), before);
    assert.ok(h.journal.list()[0].temporary_secret);
    assert.equal((await runNativeTestnetFaucet(h.options({ resume: true, execute: true }))).status, 'FUNDED_AND_CLEANED');
    assert.equal(h.journal.list()[0].temporary_secret, undefined);
    assert.equal(h.state.sends.length, 2);
  } finally { h.close(); }
});

test('the transfer verifier accepts a linked system gas refund but rejects an unrelated receipt', async () => {
  const h = harness();
  try {
    h.state.failLookup = true;
    const first = await runNativeTestnetFaucet(h.options({ execute: true }));
    const entry = h.journal.list()[0], good = structuredClone(h.state.stored.get(first.transfer_tx_hash));
    const refundId = id(14);
    good.receipts_outcome[0].outcome.receipt_ids = [refundId];
    good.receipts.push({ receipt_id: refundId, predecessor_id: 'system', receiver_id: entry.temporary_account,
      receipt: { Action: { signer_id: entry.temporary_account, signer_public_key: entry.temporary_public_key,
        gas_price: '0', input_data_ids: [], output_data_receivers: [], actions: [{ Transfer: { deposit: '1000' } }] } } });
    good.receipts_outcome.push({ id: refundId, outcome: { executor_id: entry.temporary_account, receipt_ids: [], status: { SuccessValue: '' } } });
    assert.equal(verifyFaucetTransfer(good, entry).tx_hash, first.transfer_tx_hash);
    const forged = structuredClone(good); forged.receipts[1].receiver_id = 'attacker.testnet';
    assert.throws(() => verifyFaucetTransfer(forged, entry), /refund/);
    const extra = structuredClone(good); extra.receipts.push({ receipt_id: id(15) });
    assert.throws(() => verifyFaucetTransfer(extra, entry), /graph/);
  } finally { h.close(); }
});

test('cleanup is not declared final without the linked successful refund and FINAL account absence', async () => {
  const h = harness();
  try {
    let count = 0; const original = h.provider.txStatusReceipts;
    h.provider.txStatusReceipts = async (...args) => { count++; if (count === 2) throw new Error('synthetic cleanup uncertainty'); return original(...args); };
    const first = await runNativeTestnetFaucet(h.options({ execute: true }));
    assert.equal(first.status, 'FUNDED_CLEANUP_UNRESOLVED');
    const good = h.state.stored.get(first.cleanup_tx_hash);
    for (const change of [
      r => { r.receipts = []; },
      r => { r.receipts.at(-1).receiver_id = 'attacker.testnet'; },
      r => { r.receipts.at(-1).receipt.Action.signer_id = h.state.temp.id; },
      r => { r.receipts.at(-1).receipt.Action.actions[0].Transfer.deposit = '0'; },
      r => { r.receipts_outcome.at(-1).outcome.status = { Failure: {} }; },
      r => { r.receipts_outcome[0].outcome.receipt_ids = []; },
    ]) {
      const forged = structuredClone(good); change(forged); h.state.stored.set(first.cleanup_tx_hash, forged);
      const value = await runNativeTestnetFaucet(h.options({ resume: true, execute: true }));
      assert.equal(value.status, 'FUNDED_CLEANUP_UNRESOLVED'); assert.equal(h.state.sends.length, 2);
      assert.ok(h.journal.list()[0].temporary_secret);
    }
    h.state.stored.set(first.cleanup_tx_hash, good); h.state.temp.deleted = false;
    assert.equal((await runNativeTestnetFaucet(h.options({ resume: true, execute: true }))).status, 'FUNDED_CLEANUP_UNRESOLVED');
    h.state.temp.deleted = true;
    const finish = await runNativeTestnetFaucet(h.options({ resume: true, execute: true }));
    assert.equal(finish.status, 'FUNDED_AND_CLEANED'); assert.equal(finish.faucet_return_yocto, '4900000000000000000000000');
    assert.equal(finish.cleanup_gas_refund_burned, false); assert.equal(h.state.sends.length, 2);
  } finally { h.close(); }
});

test('a separately linked gas refund to a deleted account may burn without hiding it', async () => {
  const h = harness();
  try {
    let count = 0; const original = h.provider.txStatusReceipts;
    h.provider.txStatusReceipts = async (...args) => { count++; if (count === 2) throw new Error('synthetic cleanup uncertainty'); return original(...args); };
    const first = await runNativeTestnetFaucet(h.options({ execute: true })), entry = h.journal.list()[0];
    const result = structuredClone(h.state.stored.get(first.cleanup_tx_hash)), refund = id(17);
    result.receipts_outcome[0].outcome.receipt_ids.push(refund);
    result.receipts.push({ receipt_id: refund, predecessor_id: 'system', receiver_id: entry.temporary_account,
      receipt: { Action: { signer_id: entry.temporary_account, signer_public_key: entry.temporary_public_key,
        gas_price: '0', input_data_ids: [], output_data_receivers: [], actions: [{ Transfer: { deposit: '1000' } }] } } });
    result.receipts_outcome.push({ id: refund, outcome: { executor_id: entry.temporary_account, receipt_ids: [],
      status: { Failure: { ActionError: { index: 0, kind: { AccountDoesNotExist: { account_id: entry.temporary_account } } } } } } });
    const forged = structuredClone(result); forged.receipts_outcome.at(-1).outcome.status.Failure.ActionError.kind.AccountDoesNotExist.account_id = 'attacker.testnet';
    h.state.stored.set(first.cleanup_tx_hash, forged);
    assert.equal((await runNativeTestnetFaucet(h.options({ resume: true, execute: true }))).status, 'FUNDED_CLEANUP_UNRESOLVED');
    h.state.stored.set(first.cleanup_tx_hash, result);
    const finish = await runNativeTestnetFaucet(h.options({ resume: true, execute: true }));
    assert.equal(finish.status, 'FUNDED_AND_CLEANED'); assert.equal(finish.cleanup_gas_refund_burned, true);
    assert.equal(h.state.sends.length, 2);
  } finally { h.close(); }
});
