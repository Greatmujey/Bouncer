/**
 * EXPERIMENTAL, synthetic-tested one-stage V11 testnet setup coordinator.
 * The separate owner CLI is experimental; there are no automatic retries,
 * faucet, acquisition, seller request, payment, mainnet support or automatic
 * multi-stage execution.
 *
 * A caller must independently review the exact artifact, protect the owner
 * signer and back up the ORIGINAL encrypted journal and its separate key.
 * Keyless V11 vaults cannot be upgraded/deleted and storage deposits may be
 * locked. Boolean acknowledgements here are caller assertions, NOT proof of
 * any review, backup or human consent. A trusted, single-attempt sender and
 * an honest testnet RPC are required. State may change after any snapshot.
 * This module has NOT been used with a real V11 deployment or receipt.
 */
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import nearApi from 'near-api-js';
import { inspectSvalinSetupStage } from './svalin-setup-stage-preflight.mjs';
import { verifySvalinSetupPlan, verifySignedSvalinSetup } from './svalin-setup-evidence.mjs';
import { inspectSvalinSetupJournal, recordSvalinSetupSignedAttempt, reconcileSvalinSetupResult } from './svalin-setup-journal.mjs';
import { withExclusiveJournalOperation } from './journal-operation.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

const STAGES = ['create_keyless_vault', 'configure_locked_policy', 'install_restricted_agent_key',
  'register_vault_for_test_usdc', 'fund_vault_with_test_usdc'];
const APPROVAL_KEYS = ['network', 'stage_id', 'review_sha256', 'artifact_sha256', 'one_broadcast_approved',
  'independent_artifact_review_attested', 'journal_and_key_backups_attested', 'keyless_vault_storage_risk_accepted'];
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const digest = x => crypto.createHash('sha256').update(x).digest();

function checkApproval(approval, plan, trustedReviewHash, stageId) {
  if (!record(approval) || Object.keys(approval).length !== APPROVAL_KEYS.length ||
      APPROVAL_KEYS.some(k => !Object.hasOwn(approval, k)) || approval.network !== 'testnet' ||
      approval.stage_id !== stageId || approval.review_sha256 !== trustedReviewHash ||
      approval.artifact_sha256 !== plan.review.artifact.sha256 || approval.one_broadcast_approved !== true ||
      approval.independent_artifact_review_attested !== true || approval.journal_and_key_backups_attested !== true ||
      approval.keyless_vault_storage_risk_accepted !== true) {
    throw new Error('separate exact-stage, artifact-review, recovery-backup and irreversible-vault acknowledgments are required');
  }
}
function checkedTime(now) {
  const ms = now();
  if (!Number.isSafeInteger(ms) || ms < 1 || !Number.isFinite(new Date(ms).getTime())) throw new Error('invalid local time');
  return ms;
}
function fresh(profile, now) {
  const ms = Date.parse(profile.block_timestamp);
  if (!Number.isSafeInteger(ms)) throw new Error('invalid reviewed snapshot time');
  return assertFreshFinalBlock({ header: { hash: profile.block_hash, timestamp_nanosec: String(BigInt(ms) * 1_000_000n) } }, checkedTime(now));
}
function requireProvider(provider) {
  if (!provider || provider.enforcesSetupBeforeSubmitGuard !== true ||
      typeof provider.sendTransactionOnce !== 'function' || typeof provider.txStatusReceipts !== 'function') {
    throw new Error('a trusted one-shot testnet transport with a before-submit guard and receipt-inclusive recovery is required');
  }
}
async function exclusive(journal, operation) {
  if (!record(journal)) throw new Error('the original encrypted setup journal is required');
  // Share the same process-local fence as other participating payment and
  // seller-session operations. Only nested journal helpers receive the scope;
  // it is never passed to the signer or the RPC transport.
  return withExclusiveJournalOperation(journal, operation);
}
function unresolved(stageId, txHash, attempted) {
  return { status: 'ORIGINAL_HASH_NEEDS_RECONCILIATION', stage_id: stageId, tx_hash: txHash,
    broadcast_attempts: attempted ? 1 : 0, do_not_resend: true, current_state_verified: false,
    seller_contacted: false, owner_approval_verified: false, scope: 'original journal/hash retained; inspect the original, never retry automatically' };
}

/**
 * Sign, journal and attempt at most ONE reviewed stage. Initial and post-record
 * read-only snapshots must match; a signed hash is fsynced BEFORE the single
 * transport call. A crash, stale post-record state, uncertain send or missing
 * receipts remains fenced; there is no rebroadcast or replacement path. The
 * injected provider must itself implement a true single-attempt send.
 */
export async function runSvalinSetupStageOnce({ plan, trustedReviewHash, ownerPublicKey, journal, stageId,
  signer, provider, approval, now = Date.now }) {
  const identity = verifySvalinSetupPlan({ plan, trustedReviewHash, ownerPublicKey });
  const index = STAGES.indexOf(stageId);
  if (index < 0) throw new Error('a single executable setup stage is required');
  if (typeof now !== 'function' || !signer || typeof signer.getPublicKey !== 'function' || typeof signer.signTransaction !== 'function') {
    throw new Error('a testnet owner signer and local clock are required');
  }
  checkApproval(approval, plan, trustedReviewHash, stageId);
  const approved = structuredClone(approval);
  requireProvider(provider);
  return exclusive(journal, async exclusiveScope => {
    const args = { plan, trustedReviewHash, ownerPublicKey, journal, stageId, provider, now, exclusiveScope };
    const initial = await inspectSvalinSetupStage(args);
    if (initial.status !== 'READ_ONLY_STAGE_PROFILE_MATCH') {
      return { status: 'BLOCKED_BEFORE_SIGNING', stage_id: stageId, blockers: initial.blockers,
        transaction_signed: false, broadcast_attempts: 0, seller_contacted: false };
    }
    let signerKey;
    try { signerKey = String(await signer.getPublicKey()); } catch { throw new Error('owner signer is unavailable; no broadcast was attempted'); }
    if (signerKey !== identity.owner_public_key) throw new Error('owner signer differs from the reviewed public key; no broadcast was attempted');
    if (!isDeepStrictEqual(approval, approved)) throw new Error('stage acknowledgments changed during preparation; no broadcast was attempted');
    fresh(initial, now);
    if (!/^(?:0|[1-9][0-9]*)$/.test(initial.observed_owner_nonce ?? '')) throw new Error('safe owner nonce is unavailable');
    const key = nearApi.utils.PublicKey.from(identity.owner_public_key);
    const block = Buffer.from(nearApi.utils.serialize.base_decode(initial.block_hash));
    const batch = plan.batches[index];
    const tx = nearApi.transactions.createTransaction(identity.owner, key, batch.receiverId,
      BigInt(initial.observed_owner_nonce) + 1n, batch.actions, block);
    const unsignedBytes = Buffer.from(nearApi.transactions.encodeTransaction(tx));
    const txDigest = digest(unsignedBytes);
    // The SDK constructor retains action references. Decode a separate copy so
    // a signer cannot mutate the retained plan through its transaction argument.
    const signerTx = nearApi.transactions.Transaction.decode(unsignedBytes);
    signerTx.publicKey = nearApi.utils.PublicKey.from(identity.owner_public_key);
    signerTx.blockHash = Uint8Array.from(signerTx.blockHash);
    let returned, signed;
    try { [returned, signed] = await signer.signTransaction(signerTx); }
    catch { throw new Error('owner signing failed; no broadcast was attempted'); }
    let signedPayloadMatches = false;
    try { signedPayloadMatches = Buffer.from(nearApi.transactions.encodeTransaction(signed.transaction)).equals(unsignedBytes); }
    catch { /* malformed signer output fails closed */ }
    if (!(returned instanceof Uint8Array) || !Buffer.from(returned).equals(txDigest) || !signedPayloadMatches) {
      throw new Error('signed setup transaction differs from the reviewed payload; no broadcast was attempted');
    }
    const checked = verifySignedSvalinSetup({ plan, trustedReviewHash, stageId, ownerPublicKey, signed });
    const txHash = checked.attempt.tx_hash;
    if (!isTransactionHash(txHash) || txHash !== nearApi.utils.serialize.base_encode(txDigest)) {
      throw new Error('signed setup transaction hash differs; no broadcast was attempted');
    }
    if (!isDeepStrictEqual(approval, approved)) throw new Error('stage acknowledgments changed during signing; no broadcast was attempted');
    fresh(initial, now);
    // A lost acknowledgement after this write is ambiguous: do not send and
    // do not create a replacement; inspect/reopen the same original journal.
    try {
      const saved = await recordSvalinSetupSignedAttempt({ ...args, signed, acknowledgeRecovery: true });
      if (saved.tx_hash !== txHash) throw new Error('wrong recorded hash');
    } catch {
      throw new Error(`${stageId}: journal write outcome unknown for original tx ${txHash}; no broadcast attempted; preserve and reconcile the original`);
    }

    let attempted = false;
    try {
      // A pending hash is NOT permission to send. This recheck is usable here
      // only because this invocation just signed and recorded it without a send.
      const recheck = await inspectSvalinSetupStage({ ...args, pendingOriginalHash: txHash });
      if (recheck.status !== 'READ_ONLY_STAGE_PROFILE_MATCH' || recheck.observed_owner_nonce !== initial.observed_owner_nonce ||
          !isDeepStrictEqual(approval, approved)) return unresolved(stageId, txHash, false);
      // The trusted transport must invoke this synchronously immediately before
      // its ONE HTTP send, after any asynchronous network-status check.
      const beforeSubmit = () => {
        fresh(initial, now); fresh(recheck, now);
        if (!isDeepStrictEqual(approval, approved) ||
            !Buffer.from(nearApi.transactions.encodeTransaction(signed.transaction)).equals(unsignedBytes) ||
            verifySignedSvalinSetup({ plan, trustedReviewHash, stageId, ownerPublicKey, signed }).attempt.tx_hash !== txHash) {
          throw new Error('setup prerequisites or signed transaction changed');
        }
      };
      beforeSubmit();
      attempted = true;
      const sent = await provider.sendTransactionOnce(signed, 'FINAL', { beforeSubmit });
      if (sent?.transaction_outcome?.id !== txHash) return unresolved(stageId, txHash, true);
      const result = await provider.txStatusReceipts(txHash, identity.owner, 'FINAL');
      const settled = await reconcileSvalinSetupResult({ ...args, result, update: true });
      const success = ['FINAL_SETUP_RECEIPT_MATCH', 'FINAL_LOCAL_ADD_KEY_OUTCOME_MATCH',
        'FINAL_FUNDING_RECEIPTS_MATCH'].includes(settled.status);
      return { status: settled.status, stage_id: stageId, tx_hash: txHash, broadcast_attempts: 1,
        do_not_resend: true, current_state_verified: false, post_stage_snapshot_required: success,
        owner_approval_verified: false, seller_contacted: false,
        scope: settled.status === 'FINAL_LOCAL_ADD_KEY_OUTCOME_MATCH' ?
          'trusted-RPC original transaction and local outcome matched; root receipt body omitted; verify current state before any separately approved next stage' :
          success ? 'trusted-RPC original receipts matched only; verify current state before any separately approved next stage' :
            'original did not establish successful setup; preserve and reconcile the journal, never resend automatically' };
    } catch {
      return unresolved(stageId, txHash, attempted);
    }
  });
}

/** Read/reconcile the original hash only; never sign, send, retry or contact a
 * seller. An unknown result does not establish that the transaction failed. */
export async function recoverSvalinSetupStage({ plan, trustedReviewHash, ownerPublicKey, journal, stageId,
  provider, update = true }) {
  const identity = verifySvalinSetupPlan({ plan, trustedReviewHash, ownerPublicKey });
  if (!STAGES.includes(stageId) || typeof update !== 'boolean' || typeof provider?.viewNodeStatus !== 'function' ||
      typeof provider?.txStatusReceipts !== 'function') throw new Error('a reviewed original stage and read-only receipt provider are required');
  return exclusive(journal, async exclusiveScope => {
    const args = { plan, trustedReviewHash, ownerPublicKey, journal, stageId, exclusiveScope };
    const state = await inspectSvalinSetupJournal(args), entry = state.stages.find(s => s.stage_id === stageId);
    if (!entry || entry.state === 'NOT_RECORDED' || !isTransactionHash(entry.tx_hash)) {
      throw new Error('original stage hash is missing; never create a replacement to recover');
    }
    let network, result;
    try { network = await provider.viewNodeStatus(); } catch { throw new Error('testnet status unavailable; original remains unresolved'); }
    if (network?.chain_id !== 'testnet') throw new Error('recovery RPC must report testnet');
    try { result = await provider.txStatusReceipts(entry.tx_hash, identity.owner, 'FINAL'); }
    catch { throw new Error('original receipt unavailable; preserve the journal and never resend automatically'); }
    return reconcileSvalinSetupResult({ ...args, result, update });
  });
}
