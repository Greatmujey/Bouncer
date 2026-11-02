/** Local-only, original-hash journal for one of the two constrained testnet
 * owner funding actions. Nothing here broadcasts or contacts a provider. */
import fs from 'node:fs';
import path from 'node:path';
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { verifySignedCircleRegistration } from './circle-owner-registration.mjs';
import { readBoundedPrivate, syncWrite, keyFrom } from './circle-owner-offline-journal.mjs';
import { signOwnerAcquisition, verifySignedOwnerAcquisition } from './circle-owner-acquisition.mjs';

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
