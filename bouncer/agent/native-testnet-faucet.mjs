#!/usr/bin/env node
/**
 * One-shot native-NEAR testnet funding, modeled on NEAR Docs' browser faucet:
 * create a temporary helper-funded account, transfer 5 test NEAR to an
 * existing named testnet account, then return the remainder to the public
 * faucet. No wallet key is requested or sent to the helper.
 *
 * This is NOT a Circle-USDC faucet and cannot create the Bouncer vault. The
 * temporary testnet key lives only in an encrypted local journal until its
 * deletion is confirmed. Retain that journal and its separate key. An unknown
 * helper result or transaction hash is inspected, never automatically resent.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { openConfiguredFileJournal } from './procurement.mjs';
import { ExperimentalSvalinSetupRpc } from './svalin-setup-rpc.mjs';
import { withExclusiveJournalOperation } from './journal-operation.mjs';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { hasPlainOwnerProfileAt } from '../shared/plain-owner-profile.mjs';
import { pinnedAccessKeyNonce } from '../shared/pinned-access-key-nonce.mjs';

export const HELPER_URL = 'https://helper.testnet.near.org/account';
export const FAUCET_RETURN = 'v2d.faucet.nonofficial.testnet';
export const FAUCET_TRANSFER_YOCTO = '5000000000000000000000000'; // 5 test NEAR
const GAS_RESERVE = 5n * 10n ** 22n; // 0.05 test NEAR, not a fee guarantee
const ID = 'native-testnet-faucet-v1';
const U128_MAX = (1n << 128n) - 1n;
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const sha = value => crypto.createHash('sha256').update(value).digest();
const numeric = value => {
  if (typeof value === 'bigint') return value >= 0n && value <= U128_MAX ? value : null;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,38})$/.test(value)) return null;
  const n = BigInt(value); return n <= U128_MAX ? n : null;
};
const noKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
const sameAction = (a, type, field, expected) => noKeys(a, [type]) && noKeys(a[type], [field]) && a[type][field] === expected;
const successValue = status => noKeys(status, ['SuccessValue']) && status.SuccessValue === '';
const fingerprint = (recipient, temporary, key) => sha(JSON.stringify({ version: 1, network: 'testnet', recipient,
  temporary_account: temporary, temporary_public_key: key, helper: HELPER_URL,
  amount_yocto: FAUCET_TRANSFER_YOCTO, delete_beneficiary: FAUCET_RETURN })).toString('hex');

function requireJournal(journal, recipient) {
  if (!journal || journal.encryptionEnabled !== true || typeof journal.get !== 'function' ||
      typeof journal.put !== 'function' || typeof journal.list !== 'function' ||
      journal.data?.owner_account_id !== recipient || journal.data?.contract_id !== recipient) {
    throw new Error('a dedicated encrypted faucet journal scoped to the recipient is required');
  }
  const entries = journal.list();
  if (entries.length > 1 || (entries.length === 1 && entries[0].id !== ID)) throw new Error('the faucet journal must not contain other operations');
}
function validateEntry(value, recipient) {
  if (!record(value) || value.id !== ID || value.kind !== ID || value.recipient !== recipient ||
      !/^[a-f0-9]{64}$/.test(value.fingerprint ?? '') ||
      !/^bouncer-faucet-[a-f0-9]{32}\.testnet$/.test(value.temporary_account ?? '') ||
      typeof value.temporary_public_key !== 'string' || value.helper_attempted !== true ||
      !['unknown', 'acknowledged'].includes(value.helper_response) ||
      value.fingerprint !== fingerprint(recipient, value.temporary_account, value.temporary_public_key) ||
      !['pending', 'completed'].includes(value.status)) throw new Error('invalid original faucet journal; stop and reconcile');
  let key;
  try { key = nearApi.utils.PublicKey.from(value.temporary_public_key); }
  catch { throw new Error('invalid original faucet journal; stop and reconcile'); }
  if (key.keyType !== 0 || String(key) !== value.temporary_public_key) throw new Error('invalid original faucet journal; stop and reconcile');
  for (const name of ['transfer', 'cleanup']) {
    const stage = value[name];
    if (stage !== null && (!record(stage) || !isTransactionHash(stage.tx_hash) ||
        typeof stage.nonce !== 'string' || !/^(?:0|[1-9][0-9]{0,15})$/.test(stage.nonce) ||
        BigInt(stage.nonce) > BigInt(Number.MAX_SAFE_INTEGER) ||
        !['pending', 'final'].includes(stage.state))) throw new Error('invalid original faucet journal; stop and reconcile');
  }
  if (value.cleanup && value.transfer?.state !== 'final') throw new Error('cleanup precedes the original verified transfer');
  if ((value.status === 'completed') !== (value.transfer?.state === 'final') ||
      (value.status === 'completed' && value.tx_hash !== value.transfer.tx_hash)) throw new Error('invalid faucet journal status');
  if (value.cleanup?.state === 'final') {
    if (value.temporary_secret !== undefined || typeof value.cleanup.refund_yocto !== 'string' ||
        numeric(value.cleanup.refund_yocto) === null || numeric(value.cleanup.refund_yocto) <= 0n ||
        typeof value.cleanup.gas_refund_burned !== 'boolean') throw new Error('invalid completed faucet journal');
  } else {
    try {
      if (typeof value.temporary_secret !== 'string' || String(nearApi.KeyPair.fromString(value.temporary_secret).getPublicKey()) !== value.temporary_public_key) throw new Error();
    } catch { throw new Error('original temporary faucet key is unavailable or mismatched'); }
  }
  return value;
}
function publicState(value, extra = {}) {
  return { recipient: value.recipient, temporary_account: value.temporary_account,
    helper_response: value.helper_response, transfer_tx_hash: value.transfer?.tx_hash ?? null,
    transfer_final: value.transfer?.state === 'final', cleanup_tx_hash: value.cleanup?.tx_hash ?? null,
    cleanup_final: value.cleanup?.state === 'final', faucet_return_yocto: value.cleanup?.refund_yocto ?? null,
    cleanup_gas_refund_burned: value.cleanup?.gas_refund_burned ?? null, network: 'testnet',
    amount_yocto: FAUCET_TRANSFER_YOCTO, circle_usdc_funded: false, seller_contacted: false,
    do_not_resend_recorded_attempts: true, ...extra };
}
function requireProvider(provider) {
  if (!provider || ['viewNodeStatus', 'viewBlock', 'viewAccount', 'viewAccessKey', 'viewAccessKeyList',
    'viewTestnetAccountPresenceAt', 'experimental_protocolConfig', 'sendTransactionOnce', 'txStatusReceipts']
    .some(key => typeof provider[key] !== 'function') || provider.enforcesSetupBeforeSubmitGuard !== true) {
    throw new Error('the guarded one-shot testnet RPC transport is required');
  }
}
async function blockAt(provider, now) {
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('faucet RPC must report testnet');
  const block = await provider.viewBlock({ finality: 'final' });
  assertFreshFinalBlock(block, now());
  return { header: { hash: block.header.hash, timestamp_nanosec: block.header.timestamp_nanosec } };
}
async function recipientAt(provider, recipient, block) {
  const at = { blockId: block.header.hash };
  const account = await provider.viewAccount(recipient, at);
  if (!record(account) || account.block_hash !== block.header.hash || numeric(account.amount) === null) {
    throw new Error('existing recipient was not established at the pinned FINAL block');
  }
  return numeric(account.amount).toString();
}

/** Current, single-block temporary account profile. A missing or incomplete
 * view is not proof the helper failed: callers retain the original attempt. */
async function temporaryAt(provider, entry, block, { forTransfer }) {
  const hash = block.header.hash, at = { blockId: hash };
  const presence = await provider.viewTestnetAccountPresenceAt(entry.temporary_account, hash);
  if (presence?.block_hash !== hash) throw new Error('temporary account presence is unavailable');
  if (presence.exists === false) return null;
  if (presence.exists !== true) throw new Error('temporary account presence is unavailable');
  const [account, list, access, protocol] = await Promise.all([
    provider.viewAccount(entry.temporary_account, at), provider.viewAccessKeyList(entry.temporary_account, at),
    provider.viewAccessKey(entry.temporary_account, entry.temporary_public_key, at), provider.experimental_protocolConfig(at),
  ]);
  const keys = list?.keys, nonce = pinnedAccessKeyNonce(access?.nonce);
  const balance = numeric(account?.amount), locked = numeric(account?.locked), bytes = numeric(account?.storage_usage);
  const storageCost = numeric(protocol?.runtime_config?.storage_amount_per_byte);
  if (!hasPlainOwnerProfileAt(account, hash) || list?.block_hash !== hash || access?.block_hash !== hash ||
      !Array.isArray(keys) || keys.length !== 1 || keys[0]?.public_key !== entry.temporary_public_key ||
      keys[0]?.access_key?.permission !== 'FullAccess' || access.permission !== 'FullAccess' || nonce === null ||
      pinnedAccessKeyNonce(keys[0]?.access_key?.nonce) !== nonce ||
      protocol?.chain_id !== 'testnet' || balance === null || locked !== 0n || bytes === null || storageCost === null || storageCost === 0n) {
    throw new Error('temporary account, key or testnet storage profile does not match');
  }
  // The temporary account must retain storage and a conservative fee reserve
  // after the transfer; the current snapshot cannot guarantee future fees.
  if (forTransfer && balance < BigInt(FAUCET_TRANSFER_YOCTO) + bytes * storageCost + GAS_RESERVE) {
    throw new Error('temporary account cannot safely cover the transfer, storage and fee reserve');
  }
  return { nonce, balance: balance.toString() };
}

// Restrict the action-receipt fields to nearcore's ordinary, non-promise
// shape. New protocol fields or other receipts remain unresolved, not guessed.
function plainActionReceipt(body) {
  const allowed = ['signer_id', 'signer_public_key', 'gas_price', 'input_data_ids', 'output_data_receivers',
    'actions', 'is_promise_yield', 'refund_to'];
  return record(body) && Object.keys(body).every(key => allowed.includes(key)) && numeric(body.gas_price) !== null &&
    Array.isArray(body.input_data_ids) && body.input_data_ids.length === 0 &&
    Array.isArray(body.output_data_receivers) && body.output_data_receivers.length === 0 &&
    (body.is_promise_yield === undefined || body.is_promise_yield === false) &&
    (body.refund_to === undefined || body.refund_to === null);
}
function systemTransfer(receipt, receiver, signer, publicKey) {
  const body = receipt?.receipt?.Action, deposit = numeric(body?.actions?.[0]?.Transfer?.deposit);
  return receipt?.predecessor_id === 'system' && receipt.receiver_id === receiver && noKeys(receipt.receipt, ['Action']) &&
    plainActionReceipt(body) && body.signer_id === signer && body.signer_public_key === publicKey &&
    numeric(body.gas_price) === 0n && Array.isArray(body.actions) && body.actions.length === 1 &&
    noKeys(body.actions[0], ['Transfer']) && noKeys(body.actions[0].Transfer, ['deposit']) && deposit !== null && deposit > 0n
    ? deposit : null;
}
function commonTransaction(result, entry, stage, receiver, action) {
  const tx = result?.transaction, out = result?.transaction_outcome?.outcome;
  const txHash = entry[stage]?.tx_hash;
  if (result?.final_execution_status !== 'FINAL' || !successValue(result.status) ||
      tx?.hash !== txHash || tx.signer_id !== entry.temporary_account || tx.receiver_id !== receiver ||
      tx.public_key !== entry.temporary_public_key || numeric(tx.nonce) !== BigInt(entry[stage].nonce) ||
      !Array.isArray(tx.actions) || tx.actions.length !== 1 ||
      !action(tx.actions[0]) || result.transaction_outcome?.id !== txHash || out?.executor_id !== entry.temporary_account ||
      !isTransactionHash(out?.status?.SuccessReceiptId) || !Array.isArray(out.receipt_ids) ||
      out.receipt_ids.length !== 1 || out.receipt_ids[0] !== out.status.SuccessReceiptId ||
      !Array.isArray(result.receipts_outcome) || result.receipts_outcome.length < 1 || result.receipts_outcome.length > 64 ||
      !Array.isArray(result.receipts) || result.receipts.length > 64) throw new Error('original faucet transaction does not match the FINAL outcome');
  const id = out.status.SuccessReceiptId;
  const outcomes = result.receipts_outcome.filter(item => item?.id === id);
  if (outcomes.length !== 1 || outcomes[0].outcome?.executor_id !== receiver ||
      !successValue(outcomes[0].outcome?.status) || !Array.isArray(outcomes[0].outcome?.receipt_ids) ||
      new Set(result.receipts_outcome.map(item => item?.id)).size !== result.receipts_outcome.length ||
      result.receipts_outcome.some(item => !isTransactionHash(item?.id) || !record(item?.outcome?.status) ||
        !Array.isArray(item.outcome.receipt_ids) || item.outcome.receipt_ids.some(id => !isTransactionHash(id)) ||
        new Set(item.outcome.receipt_ids).size !== item.outcome.receipt_ids.length)) {
    throw new Error('original faucet action did not produce a matching successful FINAL outcome');
  }
  return { id, outcome: outcomes[0].outcome };
}

/** Verify the original native transfer and its root receipt. This relies on the
 * selected RPC; it is not a consensus proof or a USDC/deployment assertion. */
export function verifyFaucetTransfer(result, entry) {
  const match = action => sameAction(action, 'Transfer', 'deposit', FAUCET_TRANSFER_YOCTO);
  const root = commonTransaction(result, entry, 'transfer', entry.recipient, match);
  const roots = result.receipts.filter(item => item?.receipt_id === root.id);
  const receipt = roots[0], body = receipt?.receipt?.Action;
  if (roots.length !== 1 || receipt.predecessor_id !== entry.temporary_account || receipt.receiver_id !== entry.recipient ||
      !noKeys(receipt.receipt, ['Action']) || !plainActionReceipt(body) ||
      body.signer_id !== entry.temporary_account || body.signer_public_key !== entry.temporary_public_key ||
      !Array.isArray(body.actions) || body.actions.length !== 1 || !match(body.actions[0])) {
    throw new Error('original transfer receipt is missing or mismatched');
  }
  // A plain transfer may produce a linked protocol gas refund. Accept no
  // unlinked or unknown receipts and only the system refund to this signer.
  const children = root.outcome.receipt_ids;
  if (children.length > 1 || new Set(children).size !== children.length ||
      result.receipts.length !== 1 + children.length || result.receipts_outcome.length !== 1 + children.length) {
    throw new Error('unexpected faucet transfer receipt graph');
  }
  if (children.length) {
    const id = children[0], r = result.receipts.find(item => item?.receipt_id === id),
      o = result.receipts_outcome.find(item => item?.id === id)?.outcome;
    if (!isTransactionHash(id) || systemTransfer(r, entry.temporary_account, entry.temporary_account, entry.temporary_public_key) === null ||
        o?.executor_id !== entry.temporary_account || !successValue(o.status) || !Array.isArray(o.receipt_ids) || o.receipt_ids.length) {
      throw new Error('unexpected faucet transfer gas refund');
    }
  }
  return { tx_hash: entry.transfer.tx_hash, root_receipt_id: root.id };
}

function missingDeletedAccount(status, account) {
  const failure = status?.Failure, action = failure?.ActionError, missing = action?.kind?.AccountDoesNotExist;
  return noKeys(status, ['Failure']) && noKeys(failure, ['ActionError']) && record(action) &&
    Object.keys(action).every(key => ['index', 'kind'].includes(key)) && (action.index === null || action.index === 0) &&
    noKeys(action.kind, ['AccountDoesNotExist']) && noKeys(missing, ['account_id']) && missing.account_id === account;
}
function verifyCleanup(result, entry) {
  const match = action => sameAction(action, 'DeleteAccount', 'beneficiary_id', FAUCET_RETURN);
  const root = commonTransaction(result, entry, 'cleanup', entry.temporary_account, match);
  // nearcore may omit a self-directed root receipt body. Its matching
  // transaction and outcome are retained, and account absence is checked at a
  // separate fresh FINAL block. Require the linked system balance-refund
  // receipt to the actual faucet beneficiary; deletion alone is not payout.
  const roots = result.receipts.filter(item => item?.receipt_id === root.id), children = root.outcome.receipt_ids;
  if (roots.length > 1 || children.length < 1 || children.length > 2 || children.includes(root.id) ||
      result.receipts.length !== roots.length + children.length || result.receipts_outcome.length !== 1 + children.length) {
    throw new Error('unexpected cleanup receipt graph');
  }
  if (roots.length) {
    const r = roots[0], b = r.receipt?.Action;
    if (r.predecessor_id !== entry.temporary_account || r.receiver_id !== entry.temporary_account ||
        !noKeys(r.receipt, ['Action']) || !plainActionReceipt(b) || b.signer_id !== entry.temporary_account ||
        b.signer_public_key !== entry.temporary_public_key || !Array.isArray(b.actions) ||
        b.actions.length !== 1 || !match(b.actions[0])) throw new Error('cleanup receipt mismatched');
  }
  let beneficiaryAmount = null, gasRefundSeen = false, gasRefundBurned = false;
  const emptyPublicKey = 'ed25519:11111111111111111111111111111111';
  for (const id of children) {
    const r = result.receipts.find(item => item?.receipt_id === id),
      o = result.receipts_outcome.find(item => item?.id === id)?.outcome;
    if (!r || !o || !Array.isArray(o.receipt_ids) || o.receipt_ids.length) throw new Error('missing cleanup child');
    const payout = systemTransfer(r, FAUCET_RETURN, 'system', emptyPublicKey);
    const gas = systemTransfer(r, entry.temporary_account, entry.temporary_account, entry.temporary_public_key);
    if (payout !== null && beneficiaryAmount === null && o.executor_id === FAUCET_RETURN && successValue(o.status)) {
      beneficiaryAmount = payout;
    } else if (gas !== null && !gasRefundSeen && o.executor_id === entry.temporary_account &&
        (successValue(o.status) || missingDeletedAccount(o.status, entry.temporary_account))) {
      gasRefundSeen = true;
      gasRefundBurned = !successValue(o.status);
    } else throw new Error('unexpected cleanup refund');
  }
  if (beneficiaryAmount === null) throw new Error('faucet beneficiary refund is not verified');
  return { refund_yocto: beneficiaryAmount.toString(), gas_refund_burned: gasRefundBurned };
}

async function helperOnce(entry, journal, fetchImpl) {
  let acknowledged = false;
  try {
    const response = await fetchImpl(HELPER_URL, { method: 'POST', redirect: 'error', credentials: 'omit',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ newAccountId: entry.temporary_account, newAccountPublicKey: entry.temporary_public_key }),
      signal: AbortSignal.timeout(60_000) });
    acknowledged = response?.ok === true;
    try { await response?.body?.cancel(); } catch { /* ignore an untrusted response body */ }
  } catch { /* A lost helper response can still have created the account. */ }
  const next = { ...entry, helper_response: acknowledged ? 'acknowledged' : 'unknown' };
  journal.put(ID, next); // failure stops before any transfer
  return next;
}

async function reconcileTransfer(entry, journal, provider, update) {
  let proof;
  try { proof = verifyFaucetTransfer(await provider.txStatusReceipts(entry.transfer.tx_hash, entry.temporary_account, 'FINAL'), entry); }
  catch { return { entry, proof: null }; }
  const next = { ...entry, status: 'completed', tx_hash: entry.transfer.tx_hash,
    transfer: { ...entry.transfer, state: 'final' } };
  if (update && entry.transfer.state !== 'final') journal.put(ID, next);
  return { entry: next, proof };
}
async function reconcileCleanup(entry, journal, provider, now, update) {
  let proof;
  try {
    proof = verifyCleanup(await provider.txStatusReceipts(entry.cleanup.tx_hash, entry.temporary_account, 'FINAL'), entry);
    const block = await blockAt(provider, now);
    const presence = await provider.viewTestnetAccountPresenceAt(entry.temporary_account, block.header.hash);
    if (presence?.block_hash !== block.header.hash || presence.exists !== false) return { entry, final: false };
  } catch { return { entry, final: false }; }
  const next = { ...entry, cleanup: { ...entry.cleanup, state: 'final', ...proof } };
  delete next.temporary_secret;
  if (update && entry.cleanup.state !== 'final') journal.put(ID, next);
  return { entry: next, final: true };
}

async function signAndSend(entry, journal, provider, now, stage) {
  const isTransfer = stage === 'transfer';
  const initialBlock = await blockAt(provider, now);
  if (isTransfer) await recipientAt(provider, entry.recipient, initialBlock);
  const profile = await temporaryAt(provider, entry, initialBlock, { forTransfer: isTransfer });
  if (!profile) return { entry, sent: false };
  if (!isTransfer && profile.nonce < BigInt(entry.transfer.nonce)) throw new Error('temporary key nonce has not advanced past the original transfer');
  const nonce = profile.nonce + 1n;
  // pinnedAccessKeyNonce has reserved room for this increment.
  const pair = nearApi.KeyPair.fromString(entry.temporary_secret), key = pair.getPublicKey();
  if (String(key) !== entry.temporary_public_key) throw new Error('temporary signing key changed');
  const receiver = isTransfer ? entry.recipient : entry.temporary_account;
  const actions = [isTransfer ? nearApi.transactions.transfer(BigInt(FAUCET_TRANSFER_YOCTO)) :
    nearApi.transactions.deleteAccount(FAUCET_RETURN)];
  const tx = nearApi.transactions.createTransaction(entry.temporary_account, key, receiver, nonce, actions,
    Buffer.from(nearApi.utils.serialize.base_decode(initialBlock.header.hash)));
  const bytes = Buffer.from(nearApi.transactions.encodeTransaction(tx)), hash = sha(bytes);
  const [signedHash, signed] = await new nearApi.KeyPairSigner(pair).signTransaction(tx);
  if (!Buffer.from(signedHash).equals(hash) || !Buffer.from(nearApi.transactions.encodeTransaction(signed.transaction)).equals(bytes) ||
      !key.verify(hash, signed.signature.data)) throw new Error('temporary faucet signature or transaction mismatch');
  const txHash = nearApi.utils.serialize.base_encode(hash);
  const pending = { ...entry, [stage]: { state: 'pending', tx_hash: txHash, nonce: nonce.toString() } };
  journal.put(ID, pending); // exact original hash is durable before any send
  let current;
  try {
    const nextBlock = await blockAt(provider, now);
    if (isTransfer) await recipientAt(provider, entry.recipient, nextBlock);
    current = await temporaryAt(provider, entry, nextBlock, { forTransfer: isTransfer });
    if (!current || current.nonce !== profile.nonce) return { entry: pending, sent: false };
    const expected = Buffer.from(nearApi.transactions.encodeTransaction(signed));
    const beforeSubmit = () => {
      assertFreshFinalBlock(initialBlock, now()); assertFreshFinalBlock(nextBlock, now());
      const stored = validateEntry(journal.get(ID), entry.recipient);
      if (stored[stage]?.tx_hash !== txHash || stored.fingerprint !== entry.fingerprint ||
          !Buffer.from(nearApi.transactions.encodeTransaction(signed)).equals(expected)) throw new Error('recorded faucet attempt changed');
    };
    await provider.sendTransactionOnce(signed, 'FINAL', { beforeSubmit });
  } catch { /* The original may have been sent. Reconcile by its hash only. */ }
  return { entry: pending, sent: true };
}

/** Run or inspect one bounded funding operation. execute is explicit; resume
 * never repeats helper creation or a previously recorded transaction. The
 * injected RPC, local clock, filesystem and journal key must be trusted. */
export async function runNativeTestnetFaucet({ recipient, journal, provider, fetchImpl = globalThis.fetch,
  execute = false, resume = false, now = Date.now }) {
  if (!isTestnetAccount(recipient) || recipient === FAUCET_RETURN || typeof fetchImpl !== 'function' ||
      typeof now !== 'function' || typeof execute !== 'boolean' || typeof resume !== 'boolean') throw new Error('a named testnet recipient and valid faucet options are required');
  requireJournal(journal, recipient); requireProvider(provider);
  return withExclusiveJournalOperation(journal, async () => {
    let entry = journal.get(ID);
    if (entry) entry = validateEntry(entry, recipient);
    if (resume !== Boolean(entry)) throw new Error(entry ? 'original faucet journal exists; use resume, never start a replacement' : 'no original faucet journal exists to resume');
    if (!entry && !execute) {
      const block = await blockAt(provider, now), balance = await recipientAt(provider, recipient, block);
      return { status: 'READ_ONLY_READY', network: 'testnet', recipient, recipient_balance_yocto: balance,
        amount_yocto: FAUCET_TRANSFER_YOCTO, helper_contacted: false, signed: false, sent: false,
        note: 'Preview only; account control, helper availability and later funding are not verified.' };
    }
    if (!entry) {
      const block = await blockAt(provider, now);
      await recipientAt(provider, recipient, block);
      const pair = nearApi.KeyPair.fromRandom('ed25519'), temporary = `bouncer-faucet-${crypto.randomBytes(16).toString('hex')}.testnet`;
      const presence = await provider.viewTestnetAccountPresenceAt(temporary, block.header.hash);
      if (presence?.block_hash !== block.header.hash || presence.exists !== false) throw new Error('new temporary account absence was not established');
      const publicKey = String(pair.getPublicKey());
      entry = { kind: ID, status: 'pending', recipient, temporary_account: temporary, temporary_public_key: publicKey,
        temporary_secret: pair.toString(), fingerprint: fingerprint(recipient, temporary, publicKey),
        helper_attempted: true, helper_response: 'unknown', transfer: null, cleanup: null };
      journal.put(ID, entry); // encrypted temp key and helper-attempt fence BEFORE contacting the helper
      entry = validateEntry(journal.get(ID), recipient);
      entry = await helperOnce(entry, journal, fetchImpl);
    }
    if (entry.transfer) {
      const reconciled = await reconcileTransfer(entry, journal, provider, execute);
      if (!reconciled.proof) return publicState(entry, { status: 'ORIGINAL_TRANSFER_UNRESOLVED' });
      entry = reconciled.entry;
    } else if (!execute) {
      return publicState(entry, { status: 'ORIGINAL_HELPER_ATTEMPT_RECORDED', note: 'No transfer has been signed; resume with execution only after inspecting the original.' });
    } else {
      const result = await signAndSend(entry, journal, provider, now, 'transfer');
      entry = result.entry;
      if (!entry.transfer) return publicState(entry, { status: 'TEMPORARY_ACCOUNT_UNCONFIRMED' });
      const reconciled = await reconcileTransfer(entry, journal, provider, true);
      if (!reconciled.proof) return publicState(entry, { status: 'ORIGINAL_TRANSFER_UNRESOLVED' });
      entry = reconciled.entry;
    }
    if (!execute) {
      if (entry.cleanup && entry.cleanup.state !== 'final') {
        const inspected = await reconcileCleanup(entry, journal, provider, now, false);
        entry = inspected.entry;
      }
      return publicState(entry, { status: entry.cleanup?.state === 'final' ? 'FUNDED_AND_CLEANED' : 'TRANSFER_FINAL',
        verification: 'trusted-RPC FINAL native transfer receipt; not Circle funding or vault deployment; inspection does not update the journal' });
    }
    if (entry.cleanup?.state === 'final') return publicState(entry, { status: 'FUNDED_AND_CLEANED' });
    if (!entry.cleanup) {
      const result = await signAndSend(entry, journal, provider, now, 'cleanup');
      entry = result.entry;
      if (!entry.cleanup) return publicState(entry, { status: 'FUNDED_CLEANUP_NOT_STARTED' });
    }
    const cleaned = await reconcileCleanup(entry, journal, provider, now, true);
    return publicState(cleaned.entry, { status: cleaned.final ? 'FUNDED_AND_CLEANED' : 'FUNDED_CLEANUP_UNRESOLVED',
      verification: 'trusted-RPC FINAL native transfer receipt; not Circle funding or vault deployment' });
  });
}

const USAGE = `Usage: node bouncer/agent/native-testnet-faucet.mjs --owner ACCOUNT.testnet --state FAUCET-JOURNAL --rpc TESTNET-RPC [--execute] [--resume]

Read-only by default. --execute creates one helper-funded temporary testnet
account, sends exactly 5 test NEAR to the existing owner, and attempts to return
remaining funds to the public faucet. --resume inspects the original journal;
--resume --execute may continue an unfinished original, but never repeats a
helper request or a recorded transaction. An unknown result is not retried.

Set BOUNCER_FILE_JOURNAL_KEY_FILE to an existing owner-only journal key and
securely back up the encrypted journal AND its key. It contains a temporary
TESTNET private key until cleanup is confirmed; never upload either file.
The recipient's wallet key is never requested. Requires network access to the
NEAR testnet helper and RPC. This does not fund Circle USDC, create a vault,
contact a seller, verify owner-key control, or establish independent review.
`;
function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return null;
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i]?.slice(2);
    if (!args[i]?.startsWith('--') || !name || Object.hasOwn(opts, name)) throw new Error('invalid or duplicate option; use --help');
    if (['execute', 'resume'].includes(name)) opts[name] = true;
    else if (['owner', 'state', 'rpc'].includes(name) && args[i + 1] && !args[i + 1].startsWith('--')) opts[name] = args[++i];
    else throw new Error('unknown or incomplete option; use --help');
  }
  if (!opts.owner || !opts.state || !opts.rpc || !isTestnetAccount(opts.owner)) throw new Error('named --owner, --state and --rpc are required');
  return opts;
}
const expand = file => path.resolve(file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file);
export async function main(args = process.argv.slice(2)) {
  const opts = parseArgs(args);
  if (!opts) { console.log(USAGE); return; }
  if (!process.env.BOUNCER_FILE_JOURNAL_KEY_FILE) throw new Error('BOUNCER_FILE_JOURNAL_KEY_FILE is required');
  const state = expand(opts.state);
  const key = expand(process.env.BOUNCER_FILE_JOURNAL_KEY_FILE);
  if (state === key) throw new Error('journal and key must be separate files');
  const exists = fs.existsSync(state);
  if (Boolean(opts.resume) !== exists) throw new Error(exists ? 'original journal exists; use --resume' : 'original journal is missing; never replace it during recovery');
  const journal = openConfiguredFileJournal(state, opts.owner, opts.owner, { requireExisting: Boolean(opts.resume) });
  try {
    const result = await runNativeTestnetFaucet({ recipient: opts.owner, journal,
      provider: new ExperimentalSvalinSetupRpc(opts.rpc), execute: Boolean(opts.execute), resume: Boolean(opts.resume) });
    console.log(JSON.stringify(result, null, 2));
    if (!['READ_ONLY_READY', 'FUNDED_AND_CLEANED', 'TRANSFER_FINAL'].includes(result.status)) process.exitCode = 2;
  } finally { journal.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(); } catch (error) { console.error(`Testnet faucet stopped: ${String(error.message).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 350)}`); process.exitCode = 1; }
}
