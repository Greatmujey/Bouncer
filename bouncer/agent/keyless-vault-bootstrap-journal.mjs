/** Local-only write-ahead original-hash journal for the one fixed testnet V11
 * keyless vault deployment. No RPC, provider, CI key or broadcast. */
import fs from 'node:fs';
import path from 'node:path';
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { readBoundedPrivate, syncWrite, keyFrom } from './circle-owner-offline-journal.mjs';
import { verifySignedOwnerAcquisition } from './circle-owner-acquisition.mjs';
import { signVaultBootstrap, verifySignedVaultBootstrap } from './keyless-vault-bootstrap.mjs';
import { V11_EXPECTED_BYTES } from './keyless-vault-bootstrap-readiness.mjs';

function artifact(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size !== V11_EXPECTED_BYTES) throw new Error();
    const bytes = Buffer.alloc(stat.size); let offset = 0;
    while (offset < bytes.length) { const n = fs.readSync(fd, bytes, offset, bytes.length - offset, null); if (!n) throw new Error(); offset += n; }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, null) || fs.fstatSync(fd).size !== stat.size) throw new Error();
    return bytes;
  } catch { throw new Error('cannot read the exact bounded V11 artifact'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function exportOriginal(e, plan, file) {
  verifySignedVaultBootstrap(e, plan);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = JSON.stringify(e, null, 2) + '\n';
  try { syncWrite(file, data, 'wx', 0o644); }
  catch (error) { if (error?.code !== 'EEXIST' || fs.readFileSync(file, 'utf8') !== data) throw error; }
  return { tx_hash: e.tx_hash, vault: e.vault, native_funding_yocto: e.vault_native_funding_yocto,
    nonce: e.nonce, original_envelope_exported: true, signed_tx_is_public_bearer: true, private_key_exported: false,
    keyless_storage_may_be_irreversible: true, do_not_blindly_resend: true };
}
export async function signAndJournalVaultBootstrap({ plan: raw, paths, restore = false, nowMs = Date.now() } = {}) {
  const plan = validateOwnerBootstrapPlan(raw), names = ['primary', 'backup', 'snapshot', 'swapJournal', 'wasm', 'journal', 'evidence', 'lock'];
  if (!paths || names.some(n => typeof paths[n] !== 'string' || !path.isAbsolute(paths[n])) ||
      new Set(names.map(n => paths[n])).size !== names.length || typeof restore !== 'boolean') throw new Error('distinct vault bootstrap paths required');
  fs.mkdirSync(paths.lock, { mode: 0o700 });
  try {
    if (restore) {
      const prior = readBoundedPrivate(paths.journal, 1_000_000);
      if (prior?.version !== 1 || !['ORIGINAL_SIGNED_NOT_CONFIRMED', 'ORIGINAL_FINAL_VERIFIED'].includes(prior.status)) {
        throw new Error('invalid original vault journal');
      }
      return exportOriginal(prior.envelope, plan, paths.evidence);
    }
    if (fs.existsSync(paths.journal)) throw new Error('original vault deployment already journaled; inspect it, never sign a replacement');
    const swap = readBoundedPrivate(paths.swapJournal), snapshot = readBoundedPrivate(paths.snapshot);
    const proof = swap?.final_verification;
    if (swap?.version !== 1 || swap.status !== 'ORIGINAL_FINAL_VERIFIED' || swap.envelope?.kind !== 'swap' ||
        proof?.status !== 'OWNER_FUNDED_CIRCLE_TEST_USDC_AT_FINAL' || proof.owner !== plan.account_id || proof.network !== 'testnet' ||
        proof.tx_hash !== swap.envelope?.tx_hash || proof.receipt?.tx_hash !== proof.tx_hash || proof.circle_funding_verified !== true ||
        proof.receipt?.circle_transfer?.transfer_event_verified !== true ||
        proof.receipt.circle_transfer.amount_atoms !== proof.owner_circle_balance_atoms ||
        proof.owner_circle_balance_atoms !== snapshot.owner_test_usdc_atoms) throw new Error('original test-USDC funding is not verified');
    verifySignedOwnerAcquisition(swap.envelope, plan);
    const primary = keyFrom(plan, readBoundedPrivate(paths.primary)), backup = keyFrom(plan, readBoundedPrivate(paths.backup));
    if (String(primary.getPublicKey()) !== String(backup.getPublicKey())) throw new Error('testnet recovery copy does not match');
    const envelope = await signVaultBootstrap({ plan, snapshot, wasmBytes: artifact(paths.wasm), keyPair: primary, nowMs });
    verifySignedVaultBootstrap(envelope, plan);
    syncWrite(paths.journal, JSON.stringify({ version: 1, status: 'ORIGINAL_SIGNED_NOT_CONFIRMED',
      created_at: new Date().toISOString(), envelope }, null, 2) + '\n', 'wx', 0o600);
    return exportOriginal(envelope, plan, paths.evidence);
  } finally { fs.rmdirSync(paths.lock); }
}
