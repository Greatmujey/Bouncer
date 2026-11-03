/** Local-only, original-hash journal for one of the two constrained testnet
 * owner funding actions. Nothing here broadcasts or contacts a provider. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { verifySignedCircleRegistration } from './circle-owner-registration.mjs';
import { readBoundedPrivate, syncWrite, keyFrom } from './circle-owner-offline-journal.mjs';
import { signOwnerAcquisition, verifySignedOwnerAcquisition } from './circle-owner-acquisition.mjs';
import { ACQUISITION_MAX_USDC_ATOMS } from './circle-owner-acquisition-readiness.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

function publishOriginal(envelope, plan, evidence) {
  verifySignedOwnerAcquisition(envelope, plan);
  fs.mkdirSync(path.dirname(evidence), { recursive: true });
  const data = JSON.stringify(envelope, null, 2) + '\n';
  try { syncWrite(evidence, data, 'wx', 0o644); }
  catch (error) { if (error?.code !== 'EEXIST' || fs.readFileSync(evidence, 'utf8') !== data) throw error; }
  return { kind: envelope.kind, tx_hash: envelope.tx_hash, owner: envelope.owner, input_yocto: envelope.input_yocto,
    nonce: envelope.nonce, original_envelope_exported: true, signed_tx_is_public_bearer: true,
    private_key_exported: false, do_not_blindly_resend: true };
}
function checkVerifiedPrior(journal, kind, plan) {
  if (journal?.version !== 1 || journal.status !== 'ORIGINAL_FINAL_VERIFIED' ||
      journal.final_verification?.tx_hash !== journal.envelope?.tx_hash) throw new Error(`prior ${kind} original hash is not verified`);
  if (kind === 'Circle registration') verifySignedCircleRegistration(journal.envelope, plan);
  else if (kind === 'wrap' && journal.envelope?.kind === 'wrap') verifySignedOwnerAcquisition(journal.envelope, plan);
  else throw new Error('unexpected prior acquisition kind');
}

/** Locally check both key copies and verified prior stages, then sign once.
 * Persist and fsync the original hash/bearer before public export. */
export async function signAndJournalOwnerAcquisition({ plan: raw, paths, kind, restore = false, nowMs = Date.now() } = {}) {
  const plan = validateOwnerBootstrapPlan(raw), names = ['primary', 'backup', 'snapshot', 'journal', 'evidence', 'lock', 'circleJournal',
    ...(kind === 'swap' ? ['wrapJournal'] : [])];
  if (!['wrap', 'swap'].includes(kind) || !paths || typeof paths !== 'object' ||
      names.some(n => typeof paths[n] !== 'string' || !path.isAbsolute(paths[n])) ||
      new Set(names.map(n => paths[n])).size !== names.length || typeof restore !== 'boolean') throw new Error('distinct acquisition paths and kind required');
  fs.mkdirSync(paths.lock, { mode: 0o700 });
  try {
    if (restore) {
      const existing = readBoundedPrivate(paths.journal);
      if (existing?.version !== 1 || !['ORIGINAL_SIGNED_NOT_CONFIRMED', 'ORIGINAL_FINAL_VERIFIED'].includes(existing.status) ||
          existing.envelope?.kind !== kind) throw new Error('invalid original acquisition journal');
      return publishOriginal(existing.envelope, plan, paths.evidence);
    }
    if (fs.existsSync(paths.journal)) throw new Error('original acquisition already journaled; inspect it, never sign a replacement');
    checkVerifiedPrior(readBoundedPrivate(paths.circleJournal), 'Circle registration', plan);
    if (kind === 'swap') checkVerifiedPrior(readBoundedPrivate(paths.wrapJournal), 'wrap', plan);
    const snapshot = readBoundedPrivate(paths.snapshot), primary = keyFrom(plan, readBoundedPrivate(paths.primary)),
      backup = keyFrom(plan, readBoundedPrivate(paths.backup));
    if (String(primary.getPublicKey()) !== String(backup.getPublicKey())) throw new Error('local testnet recovery copy does not match');
    const envelope = await signOwnerAcquisition({ plan, snapshot, kind, keyPair: primary, nowMs });
    verifySignedOwnerAcquisition(envelope, plan);
    syncWrite(paths.journal, JSON.stringify({ version: 1, status: 'ORIGINAL_SIGNED_NOT_CONFIRMED',
      created_at: new Date().toISOString(), envelope }, null, 2) + '\n', 'wx', 0o600);
    return publishOriginal(envelope, plan, paths.evidence);
  } finally { fs.rmdirSync(paths.lock); }
}

/** Record an already-verified one-shot CI result against the exact local and
 * exported original. The caller authenticates its workflow/run/fence source;
 * this check is not a new chain query or a consensus proof. */
export function recordFinalOwnerAcquisition({ plan: raw, paths, kind, result } = {}) {
  const plan = validateOwnerBootstrapPlan(raw), names = ['journal', 'evidence', 'lock'];
  if (!['wrap', 'swap'].includes(kind) || !paths || names.some(n => typeof paths[n] !== 'string' || !path.isAbsolute(paths[n])) ||
      new Set(names.map(n => paths[n])).size !== names.length) throw new Error('distinct acquisition record paths and kind required');
  fs.mkdirSync(paths.lock, { mode: 0o700 });
  try {
    const journal = readBoundedPrivate(paths.journal), original = journal?.envelope;
    if (journal?.version !== 1 || !['ORIGINAL_SIGNED_NOT_CONFIRMED', 'ORIGINAL_FINAL_VERIFIED'].includes(journal.status) || original?.kind !== kind) {
      throw new Error('invalid original acquisition journal');
    }
    verifySignedOwnerAcquisition(original, plan);
    const stat = fs.lstatSync(paths.evidence);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 16_384) throw new Error('invalid public acquisition original');
    const bytes = fs.readFileSync(paths.evidence), exported = JSON.parse(bytes.toString('utf8'));
    verifySignedOwnerAcquisition(exported, plan);
    if (JSON.stringify(exported) !== JSON.stringify(original)) throw new Error('public acquisition differs from local original');
    const r = result, receipt = r?.receipt, decimal = x => typeof x === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(x);
    if (!r || r.status !== (kind === 'wrap' ? 'OWNER_WRAPPED_TEST_NEAR_AT_FINAL' : 'OWNER_FUNDED_CIRCLE_TEST_USDC_AT_FINAL') ||
        r.kind !== kind || r.network !== 'testnet' || r.owner !== plan.account_id || r.tx_hash !== original.tx_hash ||
        receipt?.tx_hash !== original.tx_hash || !isTransactionHash(receipt?.root_receipt_id) ||
        !Number.isSafeInteger(receipt?.linked_successful_outcomes) || receipt.linked_successful_outcomes < 1 || receipt.linked_successful_outcomes > 100 ||
        receipt.trusted_rpc_not_consensus_proof !== true || !isTransactionHash(r.after_block_hash) ||
        !decimal(r.owner_wrap_balance_yocto) || !decimal(r.owner_circle_balance_atoms) ||
        r.vault_deployed !== false || r.seller_contacted !== false || r.do_not_resend !== true ||
        r.signed_envelope_sha256 !== crypto.createHash('sha256').update(bytes).digest('hex') ||
        !/^[1-9][0-9]{0,19}$/.test(r.run_id ?? '') || !/^[1-9][0-9]{0,19}$/.test(r.fence_artifact_id ?? '') ||
        !/^[a-f0-9]{40}$/.test(r.commit ?? '')) throw new Error('final acquisition result does not match the original');
    const beforeWrap = BigInt(original.expected_wrap_before), beforeCircle = BigInt(original.expected_circle_before), input = BigInt(original.input_yocto);
    if (kind === 'wrap') {
      if (receipt.circle_transfer !== null || r.circle_funding_verified !== false ||
          BigInt(r.owner_wrap_balance_yocto) !== beforeWrap + input || BigInt(r.owner_circle_balance_atoms) !== beforeCircle) {
        throw new Error('final acquisition result does not match the original wrap');
      }
    } else {
      const transfer = receipt.circle_transfer;
      if (!transfer || !isTransactionHash(transfer.receipt_id) || !decimal(transfer.amount_atoms) ||
          BigInt(transfer.amount_atoms) < BigInt(original.min_output_atoms) || BigInt(transfer.amount_atoms) > BigInt(ACQUISITION_MAX_USDC_ATOMS) ||
          transfer.transfer_event_verified !== true || r.circle_funding_verified !== true ||
          BigInt(r.owner_wrap_balance_yocto) !== beforeWrap - input ||
          BigInt(r.owner_circle_balance_atoms) !== beforeCircle + BigInt(transfer.amount_atoms)) {
        throw new Error('final acquisition result does not match the original swap');
      }
    }
    if (journal.status === 'ORIGINAL_FINAL_VERIFIED') {
      if (JSON.stringify(journal.final_verification) !== JSON.stringify(r)) throw new Error('verified acquisition result already differs');
      return { kind, tx_hash: original.tx_hash, journal_status: journal.status, already_recorded: true };
    }
    const next = { ...journal, status: 'ORIGINAL_FINAL_VERIFIED', final_verification: r }, temp = `${paths.journal}.verified.tmp`;
    syncWrite(temp, JSON.stringify(next, null, 2) + '\n', 'wx', 0o600);
    fs.renameSync(temp, paths.journal);
    const parent = fs.openSync(path.dirname(paths.journal), fs.constants.O_RDONLY);
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    return { kind, tx_hash: original.tx_hash, journal_status: next.status, already_recorded: false };
  } finally { fs.rmdirSync(paths.lock); }
}
