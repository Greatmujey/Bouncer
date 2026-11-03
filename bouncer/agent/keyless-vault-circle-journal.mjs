/** Local-only write-ahead journals for the two fixed Circle testnet vault
 * actions. The original signed bearer is fsynced before any public export. */
import fs from 'node:fs';
import path from 'node:path';
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { readBoundedPrivate, syncWrite, keyFrom } from './circle-owner-offline-journal.mjs';
import { verifySignedOwnerAcquisition } from './circle-owner-acquisition.mjs';
import { verifySignedVaultBootstrap, V11_NEAR_CODE_HASH } from './keyless-vault-bootstrap.mjs';
import { signVaultCircle, verifySignedVaultCircle } from './keyless-vault-circle.mjs';

function publishOriginal(e, plan, file) {
  verifySignedVaultCircle(e, plan);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = JSON.stringify(e, null, 2) + '\n';
  try { syncWrite(file, data, 'wx', 0o644); }
  catch (error) { if (error?.code !== 'EEXIST' || fs.readFileSync(file, 'utf8') !== data) throw error; }
  return { kind: e.kind, tx_hash: e.tx_hash, vault: e.vault, token: e.token, amount_atoms: e.amount_atoms,
    nonce: e.nonce, original_envelope_exported: true, signed_tx_is_public_bearer: true,
    private_key_exported: false, do_not_blindly_resend: true };
}
export async function signAndJournalVaultCircle({ plan: raw, paths, kind, restore = false, nowMs = Date.now() } = {}) {
  const plan = validateOwnerBootstrapPlan(raw), names = ['primary','backup','snapshot','bootstrapJournal','swapJournal','journal','evidence','lock',
    ...(kind === 'fund' ? ['registrationJournal'] : [])];
  if (!['register','fund'].includes(kind) || !paths || names.some(n => typeof paths[n] !== 'string' || !path.isAbsolute(paths[n])) ||
      new Set(names.map(n => paths[n])).size !== names.length || typeof restore !== 'boolean') throw new Error('distinct Circle vault journal paths required');
  fs.mkdirSync(paths.lock, { mode: 0o700 });
  try {
    if (restore) {
      const j = readBoundedPrivate(paths.journal);
      if (j?.version !== 1 || !['ORIGINAL_SIGNED_NOT_CONFIRMED','ORIGINAL_FINAL_VERIFIED'].includes(j.status) || j.envelope?.kind !== kind) {
        throw new Error('invalid original Circle vault journal');
      }
      return publishOriginal(j.envelope, plan, paths.evidence);
    }
    if (fs.existsSync(paths.journal)) throw new Error('original Circle vault action already journaled; inspect it, never sign a replacement');
    const bootstrap = readBoundedPrivate(paths.bootstrapJournal, 1_000_000), bp = bootstrap?.final_verification;
    if (bootstrap?.version !== 1 || bootstrap.status !== 'ORIGINAL_FINAL_VERIFIED' || bp?.status !== 'ORIGINAL_VAULT_FINAL_VERIFIED' ||
        bp.tx_hash !== bootstrap.envelope?.tx_hash || bp.receipt?.tx_hash !== bp.tx_hash || bp.owner !== plan.account_id ||
        bp.state?.code_hash !== V11_NEAR_CODE_HASH || bp.state?.vault_key_count !== 0 || bp.vault_deployed !== true) {
      throw new Error('original keyless vault deployment is not verified');
    }
    verifySignedVaultBootstrap(bootstrap.envelope, plan);
    const swap = readBoundedPrivate(paths.swapJournal), sp = swap?.final_verification, amount = sp?.receipt?.circle_transfer?.amount_atoms;
    if (swap?.version !== 1 || swap.status !== 'ORIGINAL_FINAL_VERIFIED' || swap.envelope?.kind !== 'swap' ||
        sp?.status !== 'OWNER_FUNDED_CIRCLE_TEST_USDC_AT_FINAL' || sp.tx_hash !== swap.envelope.tx_hash || sp.receipt?.tx_hash !== sp.tx_hash ||
        sp.owner !== plan.account_id || sp.circle_funding_verified !== true || sp.receipt?.circle_transfer?.transfer_event_verified !== true ||
        typeof amount !== 'string' || amount !== sp.owner_circle_balance_atoms) throw new Error('original owner test-USDC funding is not verified');
    verifySignedOwnerAcquisition(swap.envelope, plan);
    if (kind === 'fund') {
      const reg = readBoundedPrivate(paths.registrationJournal), rp = reg?.final_verification;
      if (reg?.version !== 1 || reg.status !== 'ORIGINAL_FINAL_VERIFIED' || reg.envelope?.kind !== 'register' ||
          rp?.status !== 'VAULT_CIRCLE_REGISTERED_AT_FINAL' || rp.tx_hash !== reg.envelope.tx_hash || rp.receipt?.tx_hash !== rp.tx_hash ||
          rp.owner !== plan.account_id || rp.vault !== bootstrap.envelope.vault || reg.envelope.amount_atoms !== amount ||
          rp.state?.vault_circle_registration !== 'REGISTERED_AT_VIEW') throw new Error('original Circle vault registration is not verified');
      verifySignedVaultCircle(reg.envelope, plan);
    }
    const snapshot = readBoundedPrivate(paths.snapshot), primary = keyFrom(plan, readBoundedPrivate(paths.primary)),
      backup = keyFrom(plan, readBoundedPrivate(paths.backup));
    if (String(primary.getPublicKey()) !== String(backup.getPublicKey()) || snapshot.vault !== bootstrap.envelope.vault ||
        snapshot.circle_code_hash !== swap.envelope.expected_circle_code_hash || snapshot.owner_circle_atoms !== amount) {
      throw new Error('local keys or fresh owner/vault funding state differ from the original proof');
    }
    const e = await signVaultCircle({ plan, snapshot, kind, amountAtoms: amount, keyPair: primary, nowMs });
    syncWrite(paths.journal, JSON.stringify({ version: 1, status: 'ORIGINAL_SIGNED_NOT_CONFIRMED',
      created_at: new Date().toISOString(), envelope: e }, null, 2) + '\n', 'wx', 0o600);
    return publishOriginal(e, plan, paths.evidence);
  } finally { fs.rmdirSync(paths.lock); }
}
