/** Local-only journal-before-export for the single testnet Circle owner
 * registration. A signed envelope is a bearer item, not a private key. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import nearApi from 'near-api-js';
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { signCircleOwnerRegistration, verifySignedCircleRegistration } from './circle-owner-registration.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

export function readBoundedPrivate(file, limit = 16_384) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > limit || (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('invalid or exposed local private file');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}
export function syncWrite(file, content, flags, permissions) {
  const fd = fs.openSync(file, flags, permissions);
  try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const parent = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}
export function keyFrom(plan, value) {
  if (!value || value.network_id !== 'testnet' || value.account_id !== plan.account_id || value.public_key !== plan.public_key ||
      typeof value.private_key !== 'string') throw new Error('local testnet credential does not match the public plan');
  const key = nearApi.KeyPair.fromString(value.private_key);
  if (String(key.getPublicKey()) !== plan.public_key) throw new Error('local testnet credential does not match the public plan');
  return key;
}
function publishOriginal(envelope, plan, evidencePath) {
  verifySignedCircleRegistration(envelope, plan);
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  const data = JSON.stringify(envelope, null, 2) + '\n';
  try { syncWrite(evidencePath, data, 'wx', 0o644); }
  catch (error) {
    if (error?.code !== 'EEXIST' || fs.readFileSync(evidencePath, 'utf8') !== data) throw error;
  }
  return { tx_hash: envelope.tx_hash, owner: envelope.owner, token: envelope.token,
    deposit_yocto: envelope.deposit_yocto, nonce: envelope.nonce, original_envelope_exported: true,
    signed_tx_is_public_bearer: true, private_key_exported: false, do_not_blindly_resend: true };
}

/** The paths are operator-local. Journal creation is exclusive and fsynced
 * before export. An existing journal cannot cause a new signature. If export
 * was interrupted, restore writes only the exact original journaled bytes. */
export async function signAndJournalCircleRegistration({ plan: raw, paths, restore = false, nowMs = Date.now() } = {}) {
  const plan = validateOwnerBootstrapPlan(raw), names = ['primary', 'backup', 'snapshot', 'journal', 'evidence', 'lock'];
  if (!paths || typeof paths !== 'object' || names.some(name => typeof paths[name] !== 'string' || !path.isAbsolute(paths[name])) ||
      new Set(names.map(name => paths[name])).size !== names.length || typeof restore !== 'boolean') {
    throw new Error('distinct absolute local paths are required');
  }
  fs.mkdirSync(paths.lock, { mode: 0o700 }); // exclusive; stale lock requires manual inspection
  try {
    if (restore) {
      const existing = readBoundedPrivate(paths.journal);
      if (existing?.version !== 1 || !['ORIGINAL_SIGNED_NOT_CONFIRMED', 'ORIGINAL_FINAL_VERIFIED'].includes(existing.status)) {
        throw new Error('invalid original registration journal');
      }
      return publishOriginal(existing.envelope, plan, paths.evidence);
    }
    if (fs.existsSync(paths.journal)) throw new Error('original registration already journaled; inspect it, never sign a replacement');
    const snapshot = readBoundedPrivate(paths.snapshot), primary = keyFrom(plan, readBoundedPrivate(paths.primary)),
      backup = keyFrom(plan, readBoundedPrivate(paths.backup));
    if (String(primary.getPublicKey()) !== String(backup.getPublicKey())) throw new Error('local testnet recovery copy does not match');
    const envelope = await signCircleOwnerRegistration({ plan, snapshot, keyPair: primary, nowMs });
    verifySignedCircleRegistration(envelope, plan);
    syncWrite(paths.journal, JSON.stringify({ version: 1, status: 'ORIGINAL_SIGNED_NOT_CONFIRMED',
      created_at: new Date().toISOString(), envelope }, null, 2) + '\n', 'wx', 0o600);
    return publishOriginal(envelope, plan, paths.evidence);
  } finally { fs.rmdirSync(paths.lock); }
}

/** Record a result already verified by the one-shot CI runner. The caller must
 * independently authenticate its source (successful expected workflow, commit,
 * run and fence); this local check is not a new RPC or consensus proof. It
 * binds the result to BOTH the local journal and the exact exported bearer. */
export function recordFinalCircleRegistration({ plan: raw, paths, result } = {}) {
  const plan = validateOwnerBootstrapPlan(raw), names = ['journal', 'evidence', 'lock'];
  if (!paths || names.some(name => typeof paths[name] !== 'string' || !path.isAbsolute(paths[name])) ||
      new Set(names.map(name => paths[name])).size !== names.length) throw new Error('distinct registration record paths required');
  fs.mkdirSync(paths.lock, { mode: 0o700 });
  try {
    const journal = readBoundedPrivate(paths.journal);
    if (journal?.version !== 1 || !['ORIGINAL_SIGNED_NOT_CONFIRMED', 'ORIGINAL_FINAL_VERIFIED'].includes(journal.status)) {
      throw new Error('invalid original registration journal');
    }
    const original = journal.envelope; verifySignedCircleRegistration(original, plan);
    const stat = fs.lstatSync(paths.evidence);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 16_384) throw new Error('invalid public registration original');
    const bytes = fs.readFileSync(paths.evidence);
    const exported = JSON.parse(bytes.toString('utf8')); verifySignedCircleRegistration(exported, plan);
    if (JSON.stringify(exported) !== JSON.stringify(original)) throw new Error('public registration differs from local original');
    const r = result, receipt = r?.receipt;
    if (!r || r.status !== 'CIRCLE_OWNER_REGISTERED_AT_FINAL' || r.network !== 'testnet' ||
        r.owner !== plan.account_id || r.token !== original.token || r.tx_hash !== original.tx_hash ||
        receipt?.tx_hash !== original.tx_hash || !isTransactionHash(receipt?.root_receipt_id) ||
        typeof receipt?.circle_reported_total_yocto !== 'string' || !/^[1-9][0-9]{0,38}$/.test(receipt.circle_reported_total_yocto) ||
        BigInt(receipt.circle_reported_total_yocto) < BigInt(original.deposit_yocto) ||
        !Number.isSafeInteger(receipt?.linked_successful_outcomes) || receipt.linked_successful_outcomes < 1 || receipt.linked_successful_outcomes > 64 ||
        receipt.trusted_rpc_not_consensus_proof !== true || !isTransactionHash(r.registration_block_hash) ||
        r.storage_registration !== 'REGISTERED_AT_VIEW' || typeof r.owner_circle_balance_atoms !== 'string' ||
        !/^(0|[1-9][0-9]{0,38})$/.test(r.owner_circle_balance_atoms) || r.usdc_funding_verified !== false ||
        r.vault_deployed !== false || r.seller_contacted !== false || r.do_not_resend !== true ||
        r.signed_envelope_sha256 !== crypto.createHash('sha256').update(bytes).digest('hex') ||
        !/^[1-9][0-9]{0,19}$/.test(r.run_id ?? '') || !/^[1-9][0-9]{0,19}$/.test(r.fence_artifact_id ?? '') ||
        !/^[a-f0-9]{40}$/.test(r.commit ?? '')) throw new Error('final registration result does not match the original');
    if (journal.status === 'ORIGINAL_FINAL_VERIFIED') {
      if (JSON.stringify(journal.final_verification) !== JSON.stringify(r)) throw new Error('verified registration result already differs');
      return { tx_hash: original.tx_hash, journal_status: journal.status, already_recorded: true };
    }
    const next = { ...journal, status: 'ORIGINAL_FINAL_VERIFIED', final_verification: r };
    const temp = `${paths.journal}.verified.tmp`;
    syncWrite(temp, JSON.stringify(next, null, 2) + '\n', 'wx', 0o600);
    fs.renameSync(temp, paths.journal);
    const parent = fs.openSync(path.dirname(paths.journal), fs.constants.O_RDONLY);
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    return { tx_hash: original.tx_hash, journal_status: next.status, already_recorded: false };
  } finally { fs.rmdirSync(paths.lock); }
}
