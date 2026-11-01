/**
 * Local-only write-ahead fence for the four reviewed Svalin testnet setup
 * batches. It verifies an already-signed transaction and fsyncs only its public
 * original hash; it has no signer, RPC client, broadcaster or retry path.
 *
 * This is NOT a setup executor, owner approval, fresh-state check, or proof
 * that any signed bytes were sent. The same trusted encrypted FileJournal and
 * independently retained review/key anchors must be preserved. Deleted,
 * rolled-back, bypassed or different journals can defeat this local fence.
 */
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { FileJournal } from './procurement.mjs';
import { withExclusiveJournalOperation } from './journal-operation.mjs';
import { verifySvalinSetupPlan, prepareSvalinSetupAttempt, verifySignedSvalinSetup,
  inspectSvalinSetupAttempt } from './svalin-setup-evidence.mjs';
import { CIRCLE_TESTNET_USDC } from '../scripts/circle-testnet-setup.mjs';
import { SVALIN_TRIAL_MAX_ATOMS } from './svalin-pro-preflight.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

const PREFIX = 'svalin-setup-v1-';
const MANIFEST = `${PREFIX}manifest`;
const STAGES = ['create_keyless_vault', 'configure_locked_policy', 'install_restricted_agent_key',
  'register_vault_for_test_usdc', 'fund_vault_with_test_usdc'];
const stageKey = stage => `${PREFIX}${stage}`;
const STAGE_IDS = new Set(STAGES.map(stageKey));
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const fields = (value, names) => record(value) && Object.keys(value).length === names.length && names.every(k => Object.hasOwn(value, k));
const equal = isDeepStrictEqual;
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const manifestFor = identity => ({ id: MANIFEST, status: 'pending', fingerprint: identity.review_sha256,
  svalin_setup_manifest: { kind: 'svalin-setup-manifest-v1', network: 'testnet', ...identity } });

function requireJournal(journal, identity) {
  if (!(journal instanceof FileJournal) || journal.encryptionEnabled !== true ||
      journal.data?.contract_id !== identity.vault || journal.data?.owner_account_id !== identity.owner) {
    throw new Error('the original encrypted owner/vault-scoped file journal is required');
  }
  journal.assertAvailable();
}
function checkedIdentity(plan, trustedReviewHash, ownerPublicKey, journal) {
  const identity = verifySvalinSetupPlan({ plan, trustedReviewHash, ownerPublicKey });
  requireJournal(journal, identity);
  return identity;
}
function expectedStage(plan, identity, stageId, hash) {
  return prepareSvalinSetupAttempt({ plan, trustedReviewHash: identity.review_sha256, stageId,
    ownerPublicKey: identity.owner_public_key, txHash: hash });
}
function validEvidence(proof, attempt) {
  if (!record(proof) || proof.stage_id !== attempt.stage_id || proof.tx_hash !== attempt.tx_hash ||
      proof.do_not_resend !== true || proof.current_state_verified !== false || typeof proof.scope !== 'string') return false;
  if (proof.status === 'FINAL_FAILURE_NEEDS_RECONCILIATION') {
    return fields(proof, ['stage_id', 'tx_hash', 'status', 'do_not_resend', 'current_state_verified', 'scope']);
  }
  if (!fields(proof, ['stage_id', 'tx_hash', 'status', 'root_receipt', 'funding', 'do_not_resend',
    'current_state_verified', 'deployed_code_at_execution_verified', 'owner_approval_verified', 'seller_delivery_verified', 'scope']) ||
      proof.deployed_code_at_execution_verified !== false || proof.owner_approval_verified !== false ||
      proof.seller_delivery_verified !== false || !isTransactionHash(proof.root_receipt)) return false;
  if (attempt.stage_id !== 'fund_vault_with_test_usdc') return proof.status === 'FINAL_SETUP_RECEIPT_MATCH' && proof.funding === null;
  const f = proof.funding;
  return proof.status === 'FINAL_FUNDING_RECEIPTS_MATCH' &&
    fields(f, ['token', 'amount_atoms', 'vault_callback_receipt', 'token_resolver_receipt']) &&
    f.token === CIRCLE_TESTNET_USDC && f.amount_atoms === SVALIN_TRIAL_MAX_ATOMS &&
    isTransactionHash(f.vault_callback_receipt) && isTransactionHash(f.token_resolver_receipt) &&
    f.vault_callback_receipt !== f.token_resolver_receipt && f.vault_callback_receipt !== proof.root_receipt &&
    f.token_resolver_receipt !== proof.root_receipt;
}
function checkedStage(entry, plan, identity, stageId) {
  if (!fields(entry, ['id', 'status', 'fingerprint', 'tx_hash', 'svalin_setup']) || entry.id !== stageKey(stageId) ||
      !['pending', 'completed'].includes(entry.status) || !fields(entry.svalin_setup, ['kind', 'attempt', 'evidence']) ||
      entry.svalin_setup.kind !== 'svalin-setup-stage-v1' || !isTransactionHash(entry.tx_hash)) {
    throw new Error('original setup stage record is malformed; stop and reconcile');
  }
  const attempt = expectedStage(plan, identity, stageId, entry.tx_hash);
  const proof = entry.svalin_setup.evidence;
  if (!equal(entry.svalin_setup.attempt, attempt) || entry.fingerprint !== fingerprint(attempt) ||
      !(proof === null || validEvidence(proof, attempt)) ||
      (entry.status === 'completed' && (!proof || proof.status === 'FINAL_FAILURE_NEEDS_RECONCILIATION')) ||
      (entry.status === 'pending' && proof !== null && proof.status !== 'FINAL_FAILURE_NEEDS_RECONCILIATION')) {
    throw new Error('original setup stage record differs from its reviewed attempt; stop and reconcile');
  }
  return entry;
}
function loadState(journal, plan, identity) {
  const entries = journal.list(), ids = new Set();
  for (const entry of entries) {
    if (!record(entry) || typeof entry.id !== 'string' || ids.has(entry.id)) throw new Error('journal entries are invalid or ambiguous');
    ids.add(entry.id);
    if ((entry.id.startsWith(PREFIX) && entry.id !== MANIFEST && !STAGE_IDS.has(entry.id)) ||
        (Object.hasOwn(entry, 'svalin_setup_manifest') && entry.id !== MANIFEST) ||
        (Object.hasOwn(entry, 'svalin_setup') && !STAGE_IDS.has(entry.id))) {
      throw new Error('unrecognized setup record in the original journal; stop and reconcile');
    }
  }
  const manifest = entries.find(entry => entry.id === MANIFEST);
  if (!manifest || !equal(manifest, manifestFor(identity))) {
    throw new Error('original setup manifest is missing or differs from the retained review; never recreate it to retry');
  }
  let gap = false;
  const stages = STAGES.map(stage => {
    const entry = entries.find(item => item.id === stageKey(stage));
    if (!entry) { gap = true; return null; }
    if (gap) throw new Error('setup journal has a missing or unresolved earlier stage');
    const checked = checkedStage(entry, plan, identity, stage);
    if (checked.status !== 'completed') gap = true;
    return checked;
  });
  const hashes = stages.filter(Boolean).map(entry => entry.tx_hash);
  if (new Set(hashes).size !== hashes.length) throw new Error('setup stages contain duplicate original transaction hashes');
  return stages;
}
function publicState(stages) {
  return { status: 'LOCAL_SETUP_JOURNAL_ONLY', stages: STAGES.map((stage_id, i) => {
    const entry = stages[i];
    return { stage_id, state: !entry ? 'NOT_RECORDED' : entry.status === 'completed' ? 'FINAL_RECEIPTS_MATCH' :
      entry.svalin_setup.evidence ? 'FINAL_FAILURE_NEEDS_RECONCILIATION' : 'ORIGINAL_HASH_PENDING',
    tx_hash: entry?.tx_hash ?? null, do_not_resend: Boolean(entry) };
  }), sends: 0, seller_requests: 0, current_state_verified: false, owner_approval_verified: false, broadcast_authorized: false,
  scope: 'local original-hash fence only; independent fresh-state, code, backup and owner-approval checks remain required' };
}

/** Initialize a NEW manifest explicitly. It is idempotent only for the same
 * protected original record; it cannot detect an erased/rolled-back journal. */
export async function initializeSvalinSetupJournal({ plan, trustedReviewHash, ownerPublicKey, journal, confirmNew = false }) {
  const identity = checkedIdentity(plan, trustedReviewHash, ownerPublicKey, journal);
  if (confirmNew !== true) throw new Error('explicit new setup-journal initialization is required');
  return withExclusiveJournalOperation(journal, () => {
    const entries = journal.list(), prior = entries.find(entry => entry.id === MANIFEST);
    if (prior) return publicState(loadState(journal, plan, identity));
    if (entries.some(entry => entry.id?.startsWith(PREFIX) || Object.hasOwn(entry, 'svalin_setup') ||
        Object.hasOwn(entry, 'svalin_setup_manifest'))) {
      throw new Error('partial setup records already exist; do not replace the original manifest');
    }
    journal.put(MANIFEST, manifestFor(identity));
    return publicState(loadState(journal, plan, identity));
  });
}

/** Verify an already-signed SDK transaction and fsync its original hash. The
 * caller must independently verify current chain prerequisites and secure
 * backups; signed transaction bytes remain a broadcastable capability and are
 * neither returned nor persisted here. Recording does NOT send the transaction. */
export async function recordSvalinSetupSignedAttempt({ plan, trustedReviewHash, ownerPublicKey, journal, stageId, signed,
  acknowledgeRecovery = false }) {
  const identity = checkedIdentity(plan, trustedReviewHash, ownerPublicKey, journal);
  if (acknowledgeRecovery !== true) throw new Error('explicit original-journal and recovery-backup acknowledgment is required');
  return withExclusiveJournalOperation(journal, () => {
    const stages = loadState(journal, plan, identity), index = STAGES.indexOf(stageId);
    if (index < 0) throw new Error('invalid reviewed setup stage');
    if (stages[index]) throw new Error('original setup transaction is already recorded; reconcile it and never resend automatically');
    if (stages.slice(0, index).some(entry => !entry || entry.status !== 'completed')) {
      throw new Error('an earlier original setup stage is missing or unresolved; do not send the next stage');
    }
    const verified = verifySignedSvalinSetup({ plan, trustedReviewHash, stageId, ownerPublicKey, signed });
    const attempt = verified.attempt;
    if (stages.some(entry => entry?.tx_hash === attempt.tx_hash)) throw new Error('original setup hash is already recorded');
    journal.put(stageKey(stageId), { status: 'pending', fingerprint: fingerprint(attempt), tx_hash: attempt.tx_hash,
      svalin_setup: { kind: 'svalin-setup-stage-v1', attempt, evidence: null } });
    return { status: 'ORIGINAL_SIGNED_HASH_RECORDED', stage_id: stageId, tx_hash: attempt.tx_hash,
      sends: 0, do_not_resend: true, current_state_verified: false, owner_approval_verified: false, broadcast_authorized: false,
      scope: 'public hash durably recorded; no broadcast, chain check, backup proof or owner approval' };
  });
}

/** Reconcile only the hash already in the protected journal, using a supplied
 * receipt-inclusive FINAL response. No signature, network request or retry is
 * performed. A FINAL failure stays pending and blocks later stages. */
export async function reconcileSvalinSetupResult({ plan, trustedReviewHash, ownerPublicKey, journal, stageId, result, update = true }) {
  const identity = checkedIdentity(plan, trustedReviewHash, ownerPublicKey, journal);
  if (typeof update !== 'boolean') throw new Error('invalid setup journal update option');
  return withExclusiveJournalOperation(journal, () => {
    const stages = loadState(journal, plan, identity), index = STAGES.indexOf(stageId);
    if (index < 0 || !stages[index]) throw new Error('original setup attempt is missing; never create a replacement to recover');
    const entry = stages[index], attempt = entry.svalin_setup.attempt;
    const evidence = inspectSvalinSetupAttempt({ plan, trustedReviewHash, trustedOriginalHash: entry.tx_hash,
      trustedOwnerPublicKey: identity.owner_public_key, attempt, result });
    if (entry.svalin_setup.evidence && !equal(entry.svalin_setup.evidence, evidence)) {
      throw new Error('new FINAL result contradicts original recorded evidence; stop and reconcile');
    }
    const canComplete = evidence.status !== 'FINAL_FAILURE_NEEDS_RECONCILIATION';
    if (update && !entry.svalin_setup.evidence) {
      journal.put(entry.id, { ...entry, status: canComplete ? 'completed' : 'pending',
        svalin_setup: { ...entry.svalin_setup, evidence } });
    }
    return { status: evidence.status, stage_id: stageId, tx_hash: entry.tx_hash, evidence,
      journal_updated: update && !entry.svalin_setup.evidence, sends: 0, do_not_resend: true, broadcast_authorized: false,
      scope: 'trusted-RPC original receipt match only; no current-state verification or seller delivery' };
  });
}

/** Read the protected local state without RPC, signing or writes. */
export async function inspectSvalinSetupJournal({ plan, trustedReviewHash, ownerPublicKey, journal }) {
  const identity = checkedIdentity(plan, trustedReviewHash, ownerPublicKey, journal);
  return withExclusiveJournalOperation(journal, () => publicState(loadState(journal, plan, identity)));
}
