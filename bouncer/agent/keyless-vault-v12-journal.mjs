/** Local-only write-ahead original-hash journal for the one fixed testnet V12
 * keyless vault deployment. No RPC, provider, CI key or broadcast. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { readBoundedPrivate, syncWrite, keyFrom } from './circle-owner-offline-journal.mjs';
import { verifySignedOwnerAcquisition } from './circle-owner-acquisition.mjs';
import { signVaultBootstrap, verifySignedVaultBootstrap, V12_NEAR_CODE_HASH } from './keyless-vault-v12.mjs';
import { V12_EXPECTED_BYTES } from './keyless-vault-v12-readiness.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

function artifact(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size !== V12_EXPECTED_BYTES) throw new Error();
    const bytes = Buffer.alloc(stat.size); let offset = 0;
    while (offset < bytes.length) { const n = fs.readSync(fd, bytes, offset, bytes.length - offset, null); if (!n) throw new Error(); offset += n; }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, null) || fs.fstatSync(fd).size !== stat.size) throw new Error();
    return bytes;
  } catch { throw new Error('cannot read the exact bounded V12 artifact'); }
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

/** Atomically record an already verified FINAL result for the exact original.
 * Caller authenticates the workflow, run and retained fence; this local check
 * does not query the chain or turn a trusted-RPC result into consensus proof. */
export function recordFinalV12Bootstrap({ plan: raw, paths, result } = {}) {
  const plan = validateOwnerBootstrapPlan(raw), names = ['journal', 'evidence', 'lock'];
  if (!paths || names.some(n => typeof paths[n] !== 'string' || !path.isAbsolute(paths[n])) ||
      new Set(names.map(n => paths[n])).size !== names.length) throw new Error('distinct V12 record paths required');
  fs.mkdirSync(paths.lock, { mode: 0o700 });
  try {
    const journal = readBoundedPrivate(paths.journal, 1_000_000), e = journal?.envelope;
    if (journal?.version !== 1 || !['ORIGINAL_SIGNED_NOT_CONFIRMED', 'ORIGINAL_FINAL_VERIFIED'].includes(journal.status)) {
      throw new Error('invalid original V12 journal');
    }
    verifySignedVaultBootstrap(e, plan);
    const stat = fs.lstatSync(paths.evidence);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 1_000_000) throw new Error('invalid public V12 original');
    const bytes = fs.readFileSync(paths.evidence), exported = JSON.parse(bytes.toString('utf8'));
    verifySignedVaultBootstrap(exported, plan);
    if (JSON.stringify(exported) !== JSON.stringify(e)) throw new Error('public V12 original differs from the local journal');
    const r = result, state = r?.state, receipt = r?.receipt;
    const decimal = x => typeof x === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(x);
    if (!r || r.status !== 'ORIGINAL_VAULT_FINAL_VERIFIED' || r.network !== 'testnet' || r.owner !== plan.account_id ||
        r.vault !== e.vault || r.tx_hash !== e.tx_hash || receipt?.tx_hash !== e.tx_hash ||
        !isTransactionHash(receipt?.root_receipt_id) || receipt.code_hash !== V12_NEAR_CODE_HASH ||
        ![0, 1].includes(receipt.protocol_gas_refund_receipts) || receipt.trusted_rpc_not_consensus_proof !== true ||
        state?.status !== 'KEYLESS_V12_VAULT_AT_FINAL' || state.network !== 'testnet' || state.owner !== plan.account_id ||
        state.vault !== e.vault || state.code_hash !== V12_NEAR_CODE_HASH || !isTransactionHash(state.block_hash) ||
        !decimal(state.owner_key_nonce) || BigInt(state.owner_key_nonce) < BigInt(e.nonce) ||
        state.circle_code_hash !== e.expected_circle_code_hash || state.owner_circle_balance_atoms !== e.expected_owner_circle_atoms ||
        !decimal(state.vault_native_balance_yocto) || BigInt(state.vault_native_balance_yocto) === 0n || state.vault_key_count !== 0 ||
        state.vault_circle_registration !== null || state.vault_tracked_circle_atoms !== '0' || state.seller_contacted !== false ||
        r.vault_deployed !== true || r.circle_funding_verified !== false || r.seller_contacted !== false || r.do_not_resend !== true ||
        r.signed_envelope_sha256 !== crypto.createHash('sha256').update(bytes).digest('hex') ||
        !/^[1-9][0-9]{0,19}$/.test(r.run_id ?? '') || !/^[1-9][0-9]{0,19}$/.test(r.fence_artifact_id ?? '') ||
        !/^[a-f0-9]{40}$/.test(r.commit ?? '')) throw new Error('final V12 result does not match the original');
    if (journal.status === 'ORIGINAL_FINAL_VERIFIED') {
      if (JSON.stringify(journal.final_verification) !== JSON.stringify(r)) throw new Error('verified V12 result already differs');
      return { tx_hash: e.tx_hash, vault: e.vault, journal_status: journal.status, already_recorded: true };
    }
    const next = { ...journal, status: 'ORIGINAL_FINAL_VERIFIED', final_verification: r }, temp = `${paths.journal}.verified.tmp`;
    syncWrite(temp, JSON.stringify(next, null, 2) + '\n', 'wx', 0o600);
    fs.renameSync(temp, paths.journal);
    const parent = fs.openSync(path.dirname(paths.journal), fs.constants.O_RDONLY);
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    return { tx_hash: e.tx_hash, vault: e.vault, journal_status: next.status, already_recorded: false };
  } finally { fs.rmdirSync(paths.lock); }
}
