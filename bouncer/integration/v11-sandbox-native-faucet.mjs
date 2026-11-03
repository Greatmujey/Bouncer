/**
 * TEST ONLY: exercise the real faucet coordinator against a disposable
 * loopback nearcore chain. The helper is an in-process stub backed by the local
 * genesis account; it never calls the public NEAR helper. The test adapter
 * aliases the named sandbox chain as testnet only inside this harness.
 * Synthetic approvals and funds are not user consent or testnet evidence.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import nearApi from 'near-api-js';
import { FileJournal } from '../agent/procurement.mjs';
import { FAUCET_RETURN, FAUCET_TRANSFER_YOCTO, HELPER_URL, runNativeTestnetFaucet,
  verifyFaucetTransfer } from '../agent/native-testnet-faucet.mjs';
import { SandboxSetupRpc, withSandboxOnlyFetch } from './v11-sandbox-setup-rpc.mjs';
import { requireFinalSuccess } from './v11-sandbox-support.mjs';

const NEAR = 10n ** 24n;
const { transactions: tx } = nearApi;

/** The caller must first create owner.testnet and the local faucet beneficiary.
 * All environment inputs and node identities are constrained by the enclosing
 * integration harness; the global fetch fence prevents accidental external RPC. */
export async function exerciseSandboxNativeFaucet({ rpcUrl, directory, root, checkpoint = () => {} }) {
  if (root?.accountId !== 'testnet' || typeof root.signAndSendTransaction !== 'function' ||
      typeof directory !== 'string' || !path.isAbsolute(directory) || typeof checkpoint !== 'function') {
    throw new Error('disposable sandbox root and local directory are required');
  }
  return withSandboxOnlyFetch(rpcUrl, () => exercise({ rpcUrl, directory, root, checkpoint }));
}

async function exercise({ rpcUrl, directory, root, checkpoint }) {
  const recipient = 'owner.testnet', rpc = new SandboxSetupRpc(rpcUrl);
  const key = crypto.randomBytes(32), file = path.join(directory, 'sandbox-faucet-journal.json');
  let journal, helperCalls = 0, firstTransferLookup = true, firstCleanupLookup = true, journalChecks = 0;
  try {
    journal = new FileJournal(file, recipient, recipient, { encryptionKey: key });
    const recipientBefore = BigInt((await rpc.viewAccount(recipient, { finality: 'final' })).amount);
    const beneficiaryBefore = BigInt((await rpc.viewAccount(FAUCET_RETURN, { finality: 'final' })).amount);
    const localHelper = async (url, options) => {
      assert.equal(url, HELPER_URL); assert.equal(options.method, 'POST');
      const body = JSON.parse(options.body), entry = journal.list()[0];
      assert.deepEqual(Object.keys(body).sort(), ['newAccountId', 'newAccountPublicKey']);
      assert.equal(body.newAccountId, entry.temporary_account); assert.equal(body.newAccountPublicKey, entry.temporary_public_key);
      assert.equal(entry.helper_attempted, true);
      assert.equal(fs.readFileSync(file, 'utf8').includes(entry.temporary_secret), false);
      assert.equal(options.body.includes(entry.temporary_secret), false);
      helperCalls++;
      // Local fake helper: the sandbox genesis key creates and funds the
      // temporary account. Nothing is sent to a public helper or testnet.
      const result = await root.signAndSendTransaction({ receiverId: body.newAccountId,
        actions: [tx.createAccount(), tx.transfer(10n * NEAR),
          tx.addKey(nearApi.utils.PublicKey.from(body.newAccountPublicKey), tx.fullAccessKey())],
        waitUntil: 'FINAL', throwOnFailure: false });
      requireFinalSuccess(result, 'local fake faucet helper');
      return new Response('{}', { status: 200 });
    };
    const oneShot = rpc.sendTransactionOnce.bind(rpc);
    rpc.sendTransactionOnce = async (signed, finality, options) => {
      const entry = journal.list()[0], stage = signed.transaction.actions[0].enum === 'transfer' ? 'transfer' : 'cleanup';
      const hash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256')
        .update(nearApi.transactions.encodeTransaction(signed.transaction)).digest());
      assert.equal(entry[stage]?.tx_hash, hash, 'exact original must be journaled before transport');
      assert.equal(entry[stage].state, 'pending');
      assert.equal(fs.readFileSync(file, 'utf8').includes(hash), false, 'journal must be encrypted on disk');
      journalChecks++;
      return oneShot(signed, finality, options);
    };
    const lookup = rpc.txStatusReceipts.bind(rpc);
    rpc.txStatusReceipts = async (hash, ...rest) => {
      const entry = journal.list()[0];
      if (hash === entry?.transfer?.tx_hash && firstTransferLookup) {
        firstTransferLookup = false; throw new Error('sandbox-only unavailable original transfer lookup');
      }
      if (hash === entry?.cleanup?.tx_hash && firstCleanupLookup) {
        firstCleanupLookup = false; throw new Error('sandbox-only unavailable original cleanup lookup');
      }
      return lookup(hash, ...rest);
    };
    const options = extra => ({ recipient, journal, provider: rpc, fetchImpl: localHelper, ...extra });
    // Lose the production transport's acknowledgement only after the real
    // local send, then make the first receipt lookup unavailable as well.
    rpc.loseNextAcknowledgementForTest();
    const first = await runNativeTestnetFaucet(options({ execute: true }));
    assert.equal(first.status, 'ORIGINAL_TRANSFER_UNRESOLVED');
    assert.equal(rpc.transportCalls, 1); assert.equal(helperCalls, 1); assert.equal(journalChecks, 1);
    journal.close();
    journal = new FileJournal(file, recipient, recipient, { encryptionKey: key, requireExisting: true });
    // This diagnostic is still an actual local nearcore receipt, not a mocked
    // response; it reports only a verifier error, never key material.
    try {
      const entry = journal.list()[0];
      verifyFaucetTransfer(await lookup(entry.transfer.tx_hash, entry.temporary_account, 'FINAL'), entry);
    } catch (error) { checkpoint(`local faucet transfer verifier stopped: ${error.message}`); throw error; }
    rpc.loseNextAcknowledgementForTest();
    const second = await runNativeTestnetFaucet(options({ execute: true, resume: true }));
    assert.equal(second.status, 'FUNDED_CLEANUP_UNRESOLVED');
    assert.equal(rpc.transportCalls, 2); assert.equal(helperCalls, 1); assert.equal(journalChecks, 2);
    assert.equal(second.transfer_tx_hash, first.transfer_tx_hash);
    journal.close();
    journal = new FileJournal(file, recipient, recipient, { encryptionKey: key, requireExisting: true });
    const third = await runNativeTestnetFaucet(options({ execute: true, resume: true }));
    assert.equal(third.status, 'FUNDED_AND_CLEANED', `actual sandbox cleanup did not reconcile: ${third.status}`);
    assert.equal(third.transfer_tx_hash, first.transfer_tx_hash);
    assert.equal(third.cleanup_tx_hash, second.cleanup_tx_hash);
    assert.equal(journal.list()[0].temporary_secret, undefined);
    assert.equal(rpc.transportCalls, 2); assert.equal(helperCalls, 1);
    const recipientAfter = BigInt((await rpc.viewAccount(recipient, { finality: 'final' })).amount);
    const beneficiaryAfter = BigInt((await rpc.viewAccount(FAUCET_RETURN, { finality: 'final' })).amount);
    assert.equal(recipientAfter - recipientBefore, BigInt(FAUCET_TRANSFER_YOCTO));
    assert.equal(beneficiaryAfter - beneficiaryBefore, BigInt(third.faucet_return_yocto));
    checkpoint('actual local native transfer and beneficiary refund reconciled after two lost acknowledgements');
    return { scope: 'ONLY disposable local nearcore and an in-process fake helper; not public testnet or Circle',
      sandbox_transaction_hash: third.transfer_tx_hash, sandbox_cleanup_hash: third.cleanup_tx_hash,
      recipient_delta_yocto: (recipientAfter - recipientBefore).toString(),
      beneficiary_delta_yocto: (beneficiaryAfter - beneficiaryBefore).toString(),
      cleanup_gas_refund_burned: third.cleanup_gas_refund_burned,
      local_fake_helper_calls: helperCalls, one_shot_transport_calls: rpc.transportCalls,
      encrypted_original_journal_checks_before_transport: journalChecks,
      both_original_hashes_recovered_after_simulated_lost_ack: true,
      production_testnet_chain_check_not_exercised: true, public_helper_contacted: false, seller_contacted: false };
  } finally { journal?.close(); key.fill(0); }
}
