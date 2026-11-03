/** LOCAL ONLY. Journal one distinct zero-yocto control before its public
 * export. Neither this module nor its signed bearer resends the uncertain
 * registration. The caller authenticates the previous run and fence. */
import fs from 'node:fs';
import path from 'node:path';
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { readBoundedPrivate, syncWrite } from './circle-owner-offline-journal.mjs';
import { readTestnetOwnerKeyring } from './testnet-owner-local-keyring.mjs';
import { validateOutlayerBurnPlan } from './outlayer-v12-burn-plan.mjs';
import { verifySignedOutlayerBurnStage } from './outlayer-v12-burn-signed.mjs';
import { signOutlayerRegistrationControl, verifySignedOutlayerRegistrationControl } from './outlayer-v12-registration-control.mjs';

function publish(envelope, original, plan, owner, file) {
  verifySignedOutlayerRegistrationControl(envelope, original, plan, owner);
  const bytes = JSON.stringify(envelope, null, 2) + '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { syncWrite(file, bytes, 'wx', 0o644); }
  catch (error) { if (error?.code !== 'EEXIST' || fs.readFileSync(file, 'utf8') !== bytes) throw error; }
  return { original_tx_hash: original.tx_hash, control_tx_hash: envelope.tx_hash, nonce: envelope.nonce,
    original_nonce: original.nonce, original_history_proven: false, signed_tx_is_public_bearer: true,
    private_key_exported: false, seller_contacted: false, do_not_resend_original: true, do_not_resend_control: true };
}

export async function signAndJournalV12RegistrationControl({ ownerPlan: rawOwner, plan: rawPlan, original, paths, restore = false, nowMs = Date.now() } = {}) {
  const owner = validateOwnerBootstrapPlan(rawOwner), plan = validateOutlayerBurnPlan(rawPlan, owner);
  const names = ['ownerKeyring','originalJournal','snapshot','journal','evidence','lock'];
  if (!paths || names.some(n => typeof paths[n] !== 'string' || !path.isAbsolute(paths[n])) ||
      new Set(names.map(n => paths[n])).size !== names.length || typeof restore !== 'boolean') throw new Error('distinct absolute paths required');
  verifySignedOutlayerBurnStage(original, plan, owner);
  fs.mkdirSync(paths.lock, { mode: 0o700 });
  try {
    const prior = readBoundedPrivate(paths.originalJournal);
    if (prior?.version !== 1 || prior.status !== 'ORIGINAL_SIGNED_NOT_CONFIRMED' ||
        JSON.stringify(prior.envelope) !== JSON.stringify(original)) throw new Error('original private journal differs or is already resolved');
    if (restore) {
      const j = readBoundedPrivate(paths.journal);
      if (j?.version !== 1 || j.status !== 'CONTROL_SIGNED_NOT_CONFIRMED' || j.original_tx_hash !== original.tx_hash) throw new Error('invalid original control journal');
      return publish(j.envelope, original, plan, owner, paths.evidence);
    }
    if (fs.existsSync(paths.journal)) throw new Error('control already journaled; never sign a replacement');
    const snapshot = readBoundedPrivate(paths.snapshot), keyPair = readTestnetOwnerKeyring({ dir: paths.ownerKeyring, plan: owner });
    const envelope = await signOutlayerRegistrationControl({ ownerPlan: owner, plan, original, snapshot, keyPair, nowMs });
    syncWrite(paths.journal, JSON.stringify({ version: 1, status: 'CONTROL_SIGNED_NOT_CONFIRMED',
      original_tx_hash: original.tx_hash, created_at: new Date().toISOString(), envelope }, null, 2) + '\n', 'wx', 0o600);
    return publish(envelope, original, plan, owner, paths.evidence);
  } finally { fs.rmdirSync(paths.lock); }
}
