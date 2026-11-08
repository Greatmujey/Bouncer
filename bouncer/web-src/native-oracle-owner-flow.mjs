/**
 * Phone-facing state machine for the experimental native-NEAR setup.
 * Every reservation and wallet transaction is a separate user action. A
 * claimed stage is never retried after an unknown result; only its original
 * hash may be inspected/recovered. Receipt checks are reads, not delivery.
 * The authenticated backend, paired witness, wallet and trusted RPC remain
 * independent trust boundaries. This module does not authorize a trial.
 */
import { verifyNativeOracleSetupReview } from './native-oracle-setup-wallet-prompt.mjs';
import { decodeNativeHash32 } from './native-oracle-transaction.mjs';
import { assertNativeOracleCompletion } from './native-oracle-completion.mjs';

const OWNER = 'great_mujey.testnet';
const STAGES = ['create_keyless_native_vault', 'configure_native_oracle_policy', 'fund_native_vault', 'install_native_oracle_agent'];
const VERIFIED_RECEIPTS = new Set(['FINAL_NATIVE_SETUP_RECEIPT_MATCH', 'FINAL_LOCAL_ADD_KEY_OUTCOME_MATCH']);
const fail = code => Object.assign(new Error(code), { code });
const validHash = value => { try { decodeNativeHash32(value); return true; } catch { return false; } };

export function formatNativeNear(amount) {
  if (typeof amount !== 'string' || !/^(0|[1-9][0-9]*)$/.test(amount)) throw fail('NATIVE_AMOUNT_INVALID');
  const units = BigInt(amount), scale = 10n ** 24n, fraction = (units % scale).toString().padStart(24, '0').replace(/0+$/, '');
  return `${units / scale}${fraction ? `.${fraction}` : ''}`;
}

function publicTerms(review) {
  return Object.freeze({ owner: review.owner, vault: review.vault, payee: review.payee, project: review.project.project_id,
    storageNear: formatNativeNear(review.vault_storage_funding_yocto), depositNear: formatNativeNear(review.vault_deposit_yocto),
    capNear: formatNativeNear(review.per_tx_cap_yocto), dailyNear: formatNativeNear(review.daily_cap_yocto),
    gasAllowanceNear: formatNativeNear(review.agent_gas_allowance_yocto), reviewHash: review.review_sha256 });
}

function matchesReceipt(receipt, stageId, originalHash, recorded) {
  return receipt && VERIFIED_RECEIPTS.has(receipt.status) && receipt.stage_id === stageId &&
    receipt.tx_hash === originalHash && receipt.original_recorded === recorded && receipt.execution_authorized === false &&
    (receipt.status !== 'FINAL_LOCAL_ADD_KEY_OUTCOME_MATCH' || stageId === STAGES[3]);
}

/** The `interact` hook presents the connected wallet; it must not retry work. */
export function createNativeOracleOwnerFlow({ client, deviceStore, ownerPublicKey, origin, crypto, isCurrent, interact = work => work(), onChange = () => {} } = {}) {
  if (!client || !deviceStore || typeof ownerPublicKey !== 'string' || typeof origin !== 'string' || !crypto?.subtle ||
      typeof isCurrent !== 'function' || typeof interact !== 'function' || typeof onChange !== 'function') throw fail('NATIVE_FLOW_UNAVAILABLE');
  const vault = `native.${OWNER}`;
  let state = { phase: 'initial', busy: false, message: 'Check the retained testnet setup before requesting any transaction.' };
  let disposed = false, review = null, identity = null, stageId = null, originalHash = null, taskId = null, originals = [], reservationStarted = false;
  const current = () => { if (disposed || !isCurrent()) throw fail('NATIVE_FLOW_SESSION_CHANGED'); };
  const emit = () => { if (!disposed) { try { onChange(Object.freeze({ ...state })); } catch { /* rendering must not change the fence */ } } };
  const set = patch => { state = { ...state, ...patch }; emit(); };
  const snapshot = () => Object.freeze({ ...state });
  const wallet = async (work, message) => { current(); const result = await interact(work, message); current(); return result; };
  const guarded = async (allowed, work) => {
    current();
    if (state.busy || !allowed.includes(state.phase)) throw fail('NATIVE_FLOW_ACTION_NOT_AVAILABLE');
    set({ busy: true });
    try { const result = await work(); current(); return result; }
    catch (error) {
      if (!disposed && isCurrent()) set({ phase: 'stopped', message: 'The setup needs recovery. Do not repeat a wallet transaction. Check the retained setup or original hash.',
        error: error?.code || 'NATIVE_FLOW_STOPPED' });
      throw error;
    } finally { if (!disposed && isCurrent()) set({ busy: false }); }
  };
  const device = async expected => {
    const found = await deviceStore.inspect({ owner: OWNER, vault, ...(expected ? { expected_public_key: expected } : {}) }); current();
    return found;
  };
  const validateReview = async (candidate, retainedIdentity, local) => {
    const temporary = retainedIdentity || { owner: OWNER, owner_public_key: ownerPublicKey, operation_id: '0'.repeat(32),
      review_sha256: candidate?.review_sha256, stages: candidate?.stages?.map(s => ({ stage_id: s.id, action_commitment_sha256: s.action_commitment_sha256 })) };
    if (temporary.owner_public_key !== ownerPublicKey) throw fail('NATIVE_OWNER_KEY_CHANGED');
    await verifyNativeOracleSetupReview({ review: candidate, identity: temporary, deviceKey: local, origin, crypto }); current();
    return publicTerms(candidate);
  };
  const makeReview = async local => {
    const made = await client.createReview({ agentPublicKey: local.public_key }); current();
    if (made?.task_id !== made?.review?.review_sha256 || made.signing_authorized !== false || made.transaction_sent !== false) throw fail('NATIVE_REVIEW_INVALID');
    const checked = await device(made.review.agent_public_key), terms = await validateReview(made.review, null, checked);
    review = made.review; taskId = made.task_id; identity = null; stageId = null; originalHash = null;
    set({ phase: 'review', terms, stageId: null, originalHash: null,
      message: 'Review the limits and storage cost. Reserving signs an identity message; it does not send a transaction.' });
  };
  const restore = async remote => {
    if (!remote || remote.execution_authorized !== false) throw fail('NATIVE_RETAINED_STATE_INVALID');
    if (remote.status === 'RECOVERY_REQUIRED') {
      set({ phase: 'blocked', message: 'The retained witnesses do not agree. Stop and recover the original setup; do not request another transaction.' }); return;
    }
    if (remote.status === 'NO_LOCAL_RECORD') {
      if (reservationStarted || identity || originals.length) {
        set({ phase: 'blocked', message: 'The retained setup is missing after a reservation attempt. Stop and investigate; do not reserve or prompt again.' }); return;
      }
      const local = await device();
      if (local.status === 'NO_LOCAL_DEVICE_KEY') {
        set({ phase: 'create_device', terms: null, stageId: null, originalHash: null,
          message: 'Create a non-exportable key on this phone. There is no phone backup or revocation flow yet; losing this browser or its storage can make the agent unavailable.' });
      } else if (local.status === 'LOCAL_DEVICE_KEY_AVAILABLE') await makeReview(local);
      else throw fail('NATIVE_DEVICE_KEY_UNAVAILABLE');
      return;
    }
    if (remote.status !== 'WITNESSED' || !remote.identity || !remote.review || !Array.isArray(remote.database_stages) ||
        !Array.isArray(remote.witnessed_records) || remote.database_stages.length !== STAGES.length) throw fail('NATIVE_RETAINED_STATE_INVALID');
    const local = await device(remote.review.agent_public_key);
    if (local.status !== 'LOCAL_DEVICE_KEY_AVAILABLE' || local.expected_public_key_matched !== true) {
      set({ phase: 'blocked', message: 'This phone does not have the retained agent key. Do not create a replacement or repeat a transaction; recover the existing setup first.' }); return;
    }
    const terms = await validateReview(remote.review, remote.identity, local);
    const rows = remote.database_stages;
    let gap = false, next = null, lastOriginal = null;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row?.stage_id !== STAGES[i] || row.action_commitment_sha256 !== remote.identity.stages[i].action_commitment_sha256 ||
          typeof row.claimed !== 'boolean' || !(row.original_hash === null || validHash(row.original_hash)) ||
          (!row.claimed && row.original_hash !== null) || (gap && row.claimed)) throw fail('NATIVE_RETAINED_STATE_INVALID');
      if (!row.claimed || row.original_hash === null) { gap = true; if (!next) next = row; }
      else lastOriginal = row;
    }
    const hashes = rows.map(row => row.original_hash).filter(Boolean);
    if (new Set(hashes).size !== hashes.length) throw fail('NATIVE_RETAINED_STATE_INVALID');
    review = remote.review; identity = remote.identity; taskId = review.review_sha256; originals = hashes;
    const last = remote.witnessed_records.at(-1);
    if (last?.event === 'trial_claim') {
      if (!validHash(last.original_hash)) throw fail('NATIVE_RETAINED_STATE_INVALID');
      set({ phase: 'trial_retained', terms, stageId: null, originalHash: last.original_hash,
        message: 'A trial original is already retained. Recover that original; do not request another payment.' }); return;
    }
    if (next?.claimed) {
      stageId = next.stage_id; originalHash = null;
      set({ phase: 'recover', terms, stageId, originalHash: null,
        message: 'A wallet prompt was already claimed and its result is unknown. Find its original transaction hash; do not repeat the prompt.' }); return;
    }
    if (lastOriginal) {
      stageId = lastOriginal.stage_id; originalHash = lastOriginal.original_hash;
      set({ phase: 'await_receipt', terms, stageId, originalHash,
        message: 'The original hash is retained. Check its FINAL receipt before another stage; do not resend it.' }); return;
    }
    stageId = STAGES[0]; originalHash = null;
    set({ phase: 'stage', terms, stageId, originalHash: null,
      message: 'The setup is reserved. Review this stage and approve it separately in your wallet.' });
  };
  const advance = () => {
    const index = STAGES.indexOf(stageId);
    if (index < 0) throw fail('NATIVE_RETAINED_STATE_INVALID');
    if (index === STAGES.length - 1) {
      set({ phase: 'verify_setup', stageId: null, originalHash,
        message: 'All four original receipts matched. Check the current setup state before any trial; no resource has been purchased yet.' });
    } else {
      stageId = STAGES[index + 1]; originalHash = null;
      set({ phase: 'stage', stageId, originalHash: null,
        message: 'The previous original receipt matched. Review and separately approve the next stage.' });
    }
  };
  const verifyRecorded = async () => {
    const result = await wallet(() => client.previewOriginal({ stageId, originalHash }), 'Check the original testnet receipt. No transaction is requested.');
    if (!matchesReceipt(result, stageId, originalHash, true)) {
      set({ phase: 'blocked', message: 'The original did not match a successful FINAL receipt. Do not resend; review its state and effects.' }); return;
    }
    advance();
  };
  return Object.freeze({
    getState: snapshot,
    destroy() { disposed = true; try { deviceStore.close?.(); } catch {} },
    async check() { return guarded(['initial', 'stopped', 'blocked', 'recover', 'await_receipt', 'verify_setup', 'trial_retained'], async () => {
      const remote = await wallet(() => client.inspect(), 'Check the retained setup. Approve an identity message; no transaction is requested.');
      await restore(remote); return snapshot();
    }); },
    async createDevice() { return guarded(['create_device'], async () => {
      const made = await deviceStore.create({ owner: OWNER, vault }); current();
      if (made?.status !== 'LOCAL_DEVICE_KEY_AVAILABLE') throw fail('NATIVE_DEVICE_KEY_UNAVAILABLE');
      await makeReview(made); return snapshot();
    }); },
    async reserve({ ownerConfirmed } = {}) {
      if (ownerConfirmed !== true) throw fail('NATIVE_OWNER_CONFIRMATION_REQUIRED');
      return guarded(['review'], async () => {
        reservationStarted = true; // an uncertain response must never authorize another reservation
        const result = await wallet(() => client.reserve({ taskId, review }), 'Reserve this reviewed setup with an identity message. No transaction is requested.');
        if (result?.status !== 'RESERVED_NOT_CLAIMED' || !/^[a-f0-9]{40}$/.test(result.witness_head ?? '') || result.execution_authorized !== false ||
            !result.identity) throw fail('NATIVE_RESERVATION_UNKNOWN');
        const local = await device(review.agent_public_key); await validateReview(review, result.identity, local);
        identity = result.identity; stageId = STAGES[0]; originalHash = null;
        set({ phase: 'stage', stageId, originalHash: null,
          message: 'The setup is reserved. Review this stage and approve it separately in your wallet.' }); return snapshot();
      });
    },
    async approveStage({ ownerConfirmed } = {}) {
      if (ownerConfirmed !== true) throw fail('NATIVE_OWNER_CONFIRMATION_REQUIRED');
      return guarded(['stage'], async () => {
        const result = await wallet(() => client.approveStage({ identity, review, stageId }), 'A wallet identity message and one testnet transaction will be requested. Approve only the displayed stage.');
        if (result?.status === 'WALLET_RESULT_UNKNOWN' && result.do_not_retry === true) {
          set({ phase: 'recover', originalHash: null, message: 'The wallet result is unknown. Find the original hash in wallet history; do not repeat this transaction.' }); return snapshot();
        }
        if (result?.status !== 'ORIGINAL_HASH_RETURNED' || result.do_not_retry !== true || !validHash(result.original_hash)) throw fail('NATIVE_ORIGINAL_UNKNOWN');
        originalHash = result.original_hash;
        set({ phase: 'stopped', originalHash, message: 'Saving the original hash. Do not request this transaction again.' });
        const recorded = await wallet(() => client.recordOriginal({ identity, stageId, originalHash }), 'Record the original hash with an identity message. No new transaction is requested.');
        if (recorded?.status !== 'ORIGINAL_RECORDED' || recorded.owner !== OWNER || recorded.operation_id !== identity.operation_id ||
            recorded.stage_id !== stageId || recorded.original_hash !== originalHash || recorded.do_not_retry !== true ||
            recorded.execution_authorized !== false || originals.includes(originalHash)) throw fail('NATIVE_ORIGINAL_RECORD_UNKNOWN');
        originals[STAGES.indexOf(stageId)] = originalHash;
        set({ phase: 'await_receipt', originalHash, message: 'The original hash is retained. Check its FINAL receipt; do not resend it.' });
        return snapshot();
      });
    },
    async checkReceipt() { return guarded(['await_receipt'], async () => { await verifyRecorded(); return snapshot(); }); },
    async recoverOriginal({ hash, ownerConfirmed } = {}) {
      if (ownerConfirmed !== true || !validHash(hash)) {
        if (!disposed && isCurrent()) set({ message: 'Enter the original transaction hash from wallet history. Do not repeat the wallet prompt.' });
        throw fail('NATIVE_ORIGINAL_REQUIRED');
      }
      return guarded(['recover'], async () => {
        const inspected = await wallet(() => client.previewOriginal({ stageId, originalHash: hash }), 'Check the original hash. No transaction is requested.');
        if (!matchesReceipt(inspected, stageId, hash, false)) {
          set({ phase: 'blocked', message: 'That hash is not a matching successful FINAL receipt. Do not resend; check wallet history and recover the original.' }); return snapshot();
        }
        originalHash = hash;
        set({ phase: 'stopped', originalHash, message: 'Recording the verified original hash. Do not repeat the transaction.' });
        const result = await wallet(() => client.recordOriginal({ identity, stageId, originalHash }), 'Record the verified original. No transaction is requested.');
        if (result?.status !== 'ORIGINAL_RECORDED' || result.owner !== OWNER || result.operation_id !== identity.operation_id ||
            result.stage_id !== stageId || result.original_hash !== originalHash || result.do_not_retry !== true ||
            result.execution_authorized !== false || originals.includes(originalHash)) throw fail('NATIVE_ORIGINAL_RECORD_UNKNOWN');
        originals[STAGES.indexOf(stageId)] = originalHash;
        set({ phase: 'await_receipt', originalHash, message: 'The original is retained. Check its recorded FINAL receipt before proceeding.' });
        return snapshot();
      });
    },
    async verifySetup() { return guarded(['verify_setup'], async () => {
      const result = await wallet(() => client.verifyCompletion({ identity }), 'Check the retained originals and current setup state. No transaction is requested.');
      try {
        assertNativeOracleCompletion(result, review, Date.now(), { maxAgeMs: 120_000 });
        if (originals.length !== STAGES.length || JSON.stringify(result.prior_original_hashes) !== JSON.stringify(originals)) throw fail('NATIVE_ORIGINALS_CHANGED');
      } catch {
        set({ phase: 'blocked', message: 'Current setup state did not match. Do not request another transaction; recover the original state.' }); return snapshot();
      }
      set({ phase: 'setup_verified', stageId: null, message: 'Setup receipts and current state matched. This check did not buy a resource or authorize a trial.' }); return snapshot();
    }); },
  });
}
