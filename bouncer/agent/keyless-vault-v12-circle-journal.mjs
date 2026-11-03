/** Local-only write-ahead journals for the two fixed Circle testnet V12 vault
 * actions. The original signed bearer is fsynced before any public export. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { readBoundedPrivate, syncWrite, keyFrom } from './circle-owner-offline-journal.mjs';
import { verifySignedOwnerAcquisition } from './circle-owner-acquisition.mjs';
import { verifySignedVaultBootstrap, V12_NEAR_CODE_HASH } from './keyless-vault-v12.mjs';
import { signVaultCircle, verifySignedVaultCircle } from './keyless-vault-v12-circle.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

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
        bp.state?.code_hash !== V12_NEAR_CODE_HASH || bp.state?.vault_key_count !== 0 || bp.vault_deployed !== true) {
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

/** Record a verified original-hash result after the caller authenticates its
 * workflow, run and retained fence. This does not itself query the chain. */
export function recordFinalV12CircleVault({ plan: raw, paths, kind, result } = {}) {
  const plan = validateOwnerBootstrapPlan(raw), names = ['journal', 'evidence', 'lock'];
  if (!['register', 'fund'].includes(kind) || !paths || names.some(n => typeof paths[n] !== 'string' || !path.isAbsolute(paths[n])) ||
      new Set(names.map(n => paths[n])).size !== names.length) throw new Error('distinct V12 Circle record paths and kind required');
  fs.mkdirSync(paths.lock, { mode: 0o700 });
  try {
    const journal = readBoundedPrivate(paths.journal), e = journal?.envelope;
    if (journal?.version !== 1 || !['ORIGINAL_SIGNED_NOT_CONFIRMED', 'ORIGINAL_FINAL_VERIFIED'].includes(journal.status) || e?.kind !== kind) {
      throw new Error('invalid V12 Circle vault journal');
    }
    verifySignedVaultCircle(e, plan);
    const stat = fs.lstatSync(paths.evidence);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 16_384) throw new Error('invalid public V12 Circle original');
    const bytes = fs.readFileSync(paths.evidence), exported = JSON.parse(bytes.toString('utf8'));
    verifySignedVaultCircle(exported, plan);
    if (JSON.stringify(exported) !== JSON.stringify(e)) throw new Error('public V12 Circle original differs from local journal');
    const r = result, receipt = r?.receipt, state = r?.state;
    const decimal = x => typeof x === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(x);
    if (!r || r.status !== (kind === 'register' ? 'VAULT_CIRCLE_REGISTERED_AT_FINAL' : 'VAULT_FUNDED_CIRCLE_TEST_USDC_AT_FINAL') ||
        r.kind !== kind || r.network !== 'testnet' || r.owner !== plan.account_id || r.vault !== e.vault || r.tx_hash !== e.tx_hash ||
        receipt?.tx_hash !== e.tx_hash || !isTransactionHash(receipt.root_receipt_id) || receipt.trusted_rpc_not_consensus_proof !== true ||
        !Number.isSafeInteger(receipt.linked_successful_outcomes) || receipt.linked_successful_outcomes < 1 || receipt.linked_successful_outcomes > 100 ||
        state?.network !== 'testnet' || state.owner !== plan.account_id || state.vault !== e.vault || !isTransactionHash(state.block_hash) ||
        state.circle_code_hash !== e.expected_circle_code_hash || state.vault_code_hash !== e.expected_vault_code_hash || state.vault_key_count !== 0 ||
        state.vault_circle_registration !== 'REGISTERED_AT_VIEW' || !decimal(state.owner_key_nonce) || BigInt(state.owner_key_nonce) < BigInt(e.nonce) ||
        !decimal(state.owner_circle_atoms) || !decimal(state.vault_actual_circle_atoms) || !decimal(state.vault_tracked_circle_atoms) ||
        state.seller_contacted !== false || r.seller_contacted !== false || r.do_not_resend !== true ||
        r.circle_funding_verified !== (kind === 'fund') ||
        r.signed_envelope_sha256 !== crypto.createHash('sha256').update(bytes).digest('hex') ||
        !/^[1-9][0-9]{0,19}$/.test(r.run_id ?? '') || !/^[1-9][0-9]{0,19}$/.test(r.fence_artifact_id ?? '') ||
        !/^[a-f0-9]{40}$/.test(r.commit ?? '')) throw new Error('final V12 Circle result does not match the original');
    if (kind === 'register') {
      if (receipt.funding !== null || state.owner_circle_atoms !== e.expected_owner_atoms || state.vault_actual_circle_atoms !== '0' ||
          state.vault_tracked_circle_atoms !== '0') throw new Error('final V12 Circle registration balances differ');
    } else {
      const funding = receipt.funding;
      if (!funding || funding.amount_atoms !== e.amount_atoms || !isTransactionHash(funding.vault_hook_receipt) ||
          !isTransactionHash(funding.token_resolver_receipt) || funding.transfer_event_verified !== true || funding.full_amount_accepted !== true ||
          BigInt(state.owner_circle_atoms) !== BigInt(e.expected_owner_atoms) - BigInt(e.amount_atoms) ||
          state.vault_actual_circle_atoms !== e.amount_atoms || state.vault_tracked_circle_atoms !== e.amount_atoms) {
        throw new Error('final V12 Circle funding event or balances differ');
      }
    }
    if (journal.status === 'ORIGINAL_FINAL_VERIFIED') {
      if (JSON.stringify(journal.final_verification) !== JSON.stringify(r)) throw new Error('verified V12 Circle result already differs');
      return { kind, tx_hash: e.tx_hash, journal_status: journal.status, already_recorded: true };
    }
    const next = { ...journal, status: 'ORIGINAL_FINAL_VERIFIED', final_verification: r }, temp = `${paths.journal}.verified.tmp`;
    syncWrite(temp, JSON.stringify(next, null, 2) + '\n', 'wx', 0o600);
    fs.renameSync(temp, paths.journal);
    const parent = fs.openSync(path.dirname(paths.journal), fs.constants.O_RDONLY);
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    return { kind, tx_hash: e.tx_hash, journal_status: next.status, already_recorded: false };
  } finally { fs.rmdirSync(paths.lock); }
}
