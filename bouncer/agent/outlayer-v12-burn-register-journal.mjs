/** Local-only, journal-before-export for one V3/V12 fake-token registration.
 * No seller payment, live provider request, or private key is sent to CI. The
 * caller must separately authenticate any GitHub run and fence before recording
 * its result. A public signed envelope is a bearer; never replace its hash. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { readBoundedPrivate, syncWrite } from './circle-owner-offline-journal.mjs';
import { readTestnetOwnerKeyring } from './testnet-owner-local-keyring.mjs';
import { readOutlayerBurnKeyring } from './outlayer-v12-burn-keyring.mjs';
import { validateOutlayerBurnPlan } from './outlayer-v12-burn-plan.mjs';
import { signOutlayerBurnStage, verifySignedOutlayerBurnStage } from './outlayer-v12-burn-signed.mjs';
import { verifySignedVaultCircle } from './keyless-vault-v12-circle.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

const FAKE = 'usdc.fakes.testnet';
const amount = '6898';
function checkedPaths(paths, names) {
  if (!paths || names.some(n => typeof paths[n] !== 'string' || !path.isAbsolute(paths[n])) ||
      new Set(names.map(n => paths[n])).size !== names.length) throw new Error('distinct absolute journal paths required');
}
function publish(envelope, plan, owner, file) {
  verifySignedOutlayerBurnStage(envelope, plan, owner);
  if (envelope.stage !== 'register-fake') throw new Error('original is not fake-token registration');
  const bytes = JSON.stringify(envelope, null, 2) + '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { syncWrite(file, bytes, 'wx', 0o644); }
  catch (e) { if (e?.code !== 'EEXIST' || fs.readFileSync(file, 'utf8') !== bytes) throw e; }
  return { stage: envelope.stage, owner: envelope.owner, vault: envelope.vault, tx_hash: envelope.tx_hash,
    nonce: envelope.nonce, original_envelope_exported: true, signed_tx_is_public_bearer: true,
    private_key_exported: false, seller_contacted: false, do_not_blindly_resend: true };
}
function verifiedCircleFunding(journal, owner, plan) {
  const e = journal?.envelope, r = journal?.final_verification, s = r?.state, f = r?.receipt?.funding;
  if (journal?.version !== 1 || journal.status !== 'ORIGINAL_FINAL_VERIFIED') throw new Error('Circle funding journal not final');
  verifySignedVaultCircle(e, owner);
  if (e.kind !== 'fund' || e.owner !== owner.account_id || e.vault !== plan.vault || e.amount_atoms !== amount ||
      r?.status !== 'VAULT_FUNDED_CIRCLE_TEST_USDC_AT_FINAL' || r.kind !== 'fund' || r.network !== 'testnet' ||
      r.owner !== owner.account_id || r.vault !== plan.vault || r.tx_hash !== e.tx_hash ||
      r.receipt?.tx_hash !== e.tx_hash || r.receipt.trusted_rpc_not_consensus_proof !== true ||
      f?.amount_atoms !== amount || f.transfer_event_verified !== true || f.full_amount_accepted !== true ||
      s?.owner_circle_atoms !== '0' || s.vault_actual_circle_atoms !== amount || s.vault_tracked_circle_atoms !== amount ||
      s.vault_key_count !== 0 || s.vault_code_hash !== plan.vault_code_hash || r.circle_funding_verified !== true ||
      r.seller_contacted !== false || r.do_not_resend !== true) throw new Error('verified V12 Circle funding differs');
  return e;
}

/** Sign exactly one registration original; exclusive journal creation and
 * fsync precede public export. Restoring can export only the original bytes. */
export async function signAndJournalOutlayerV12Registration({ ownerPlan: rawOwner, plan: raw, paths, restore = false, nowMs = Date.now() } = {}) {
  const owner = validateOwnerBootstrapPlan(rawOwner), plan = validateOutlayerBurnPlan(raw, owner);
  checkedPaths(paths, ['ownerKeyring','agentKeyring','circleFundJournal','snapshot','journal','evidence','lock']);
  if (typeof restore !== 'boolean') throw new Error('invalid restore option');
  fs.mkdirSync(paths.lock, { mode: 0o700 });
  try {
    if (restore) {
      const j = readBoundedPrivate(paths.journal);
      if (j?.version !== 1 || !['ORIGINAL_SIGNED_NOT_CONFIRMED','ORIGINAL_FINAL_VERIFIED'].includes(j.status)) throw new Error('invalid original registration journal');
      return publish(j.envelope, plan, owner, paths.evidence);
    }
    if (fs.existsSync(paths.journal)) throw new Error('original already journaled; inspect it, never sign a replacement');
    const circle = verifiedCircleFunding(readBoundedPrivate(paths.circleFundJournal), owner, plan);
    const snapshot = readBoundedPrivate(paths.snapshot);
    if (snapshot?.signer_key_nonce !== circle.nonce) throw new Error('owner nonce changed since verified Circle funding');
    // Both encrypted copies are authenticated locally. Agent keys are not
    // installed; only the owner signs the two fixed storage registrations.
    readOutlayerBurnKeyring({ dir: paths.agentKeyring, plan, ownerPlan: owner });
    const keyPair = readTestnetOwnerKeyring({ dir: paths.ownerKeyring, plan: owner });
    const e = await signOutlayerBurnStage({ ownerPlan: owner, plan, snapshot, stage: 'register-fake', keyPair, nowMs });
    syncWrite(paths.journal, JSON.stringify({ version: 1, status: 'ORIGINAL_SIGNED_NOT_CONFIRMED',
      created_at: new Date().toISOString(), envelope: e }, null, 2) + '\n', 'wx', 0o600);
    return publish(e, plan, owner, paths.evidence);
  } finally { fs.rmdirSync(paths.lock); }
}

/** The caller authenticates run and fence metadata; this binds a verified
 * result to both the local journal and the exact public bearer bytes. */
export function recordFinalOutlayerV12Registration({ ownerPlan: rawOwner, plan: raw, paths, result: r } = {}) {
  const owner = validateOwnerBootstrapPlan(rawOwner), plan = validateOutlayerBurnPlan(raw, owner);
  checkedPaths(paths, ['journal','evidence','lock']);
  fs.mkdirSync(paths.lock, { mode: 0o700 });
  try {
    const j = readBoundedPrivate(paths.journal), e = j?.envelope;
    if (j?.version !== 1 || !['ORIGINAL_SIGNED_NOT_CONFIRMED','ORIGINAL_FINAL_VERIFIED'].includes(j.status)) throw new Error('invalid original registration journal');
    verifySignedOutlayerBurnStage(e, plan, owner);
    const stat = fs.lstatSync(paths.evidence);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 16_384) throw new Error('invalid public registration original');
    const bytes = fs.readFileSync(paths.evidence), exported = JSON.parse(bytes.toString('utf8'));
    verifySignedOutlayerBurnStage(exported, plan, owner);
    if (JSON.stringify(exported) !== JSON.stringify(e)) throw new Error('public original differs from journal');
    const receipt = r?.receipt, next = r?.next_stage;
    if (e.stage !== 'register-fake' || r?.status !== 'OUTLAYER_FAKE_TOKEN_REGISTRATIONS_FINAL' || r.network !== 'testnet' ||
        r.tx_hash !== e.tx_hash || receipt?.tx_hash !== e.tx_hash || !isTransactionHash(receipt.root_receipt_id) ||
        !Number.isSafeInteger(receipt.linked_successful_outcomes) || receipt.linked_successful_outcomes < 1 || receipt.linked_successful_outcomes > 16 ||
        receipt.trusted_rpc_not_consensus_proof !== true || receipt.asset !== FAKE ||
        JSON.stringify(receipt.registered_accounts) !== JSON.stringify([owner.account_id, plan.vault]) ||
        next?.version !== 1 || next.stage !== 'wrap' || next.network !== 'testnet' || next.owner !== owner.account_id || next.vault !== plan.vault ||
        !isTransactionHash(next.block_hash) || next.signer_public_key !== owner.public_key || next.signer_key_nonce !== e.nonce ||
        next.eligible !== true || !Array.isArray(next.blockers) || next.blockers.length !== 0 || next.signed !== false || next.sent !== false ||
        next.seller_contacted !== false || next.independent_fulfillment_verified !== false || r.seller_contacted !== false ||
        r.provider_paid !== false || r.independent_fulfillment_verified !== false || r.do_not_resend !== true ||
        r.signed_envelope_sha256 !== crypto.createHash('sha256').update(bytes).digest('hex') ||
        !/^[1-9][0-9]{0,19}$/.test(r.run_id ?? '') || !/^[1-9][0-9]{0,19}$/.test(r.fence_artifact_id ?? '') ||
        !/^[a-f0-9]{40}$/.test(r.commit ?? '')) throw new Error('final registration result differs from original');
    if (j.status === 'ORIGINAL_FINAL_VERIFIED') {
      if (JSON.stringify(j.final_verification) !== JSON.stringify(r)) throw new Error('verified registration result already differs');
      return { tx_hash: e.tx_hash, journal_status: j.status, already_recorded: true };
    }
    const nextJournal = { ...j, status: 'ORIGINAL_FINAL_VERIFIED', final_verification: r }, tmp = `${paths.journal}.verified.tmp`;
    syncWrite(tmp, JSON.stringify(nextJournal, null, 2) + '\n', 'wx', 0o600);
    fs.renameSync(tmp, paths.journal);
    const parent = fs.openSync(path.dirname(paths.journal), fs.constants.O_RDONLY);
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    return { tx_hash: e.tx_hash, journal_status: nextJournal.status, already_recorded: false };
  } finally { fs.rmdirSync(paths.lock); }
}
