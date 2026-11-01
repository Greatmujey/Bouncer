/** Pure evidence checks for the separately labeled, no-purchase testnet
 * authorization diagnostic. A hypothetical job must never be passed off as a
 * paid publication or resource fulfillment. All chain data is trusted. */
import { isDeepStrictEqual } from 'node:util';
import nearApi from 'near-api-js';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { YOUTICK_MARKET, YOUTICK_ACCESS } from './youtick-capabilities.mjs';
import { YOUTICK_V1_CODE_HASH } from './youtick-quote.mjs';
import { YOUTICK_ACCESS_CODE_HASH } from './youtick-grant-runner.mjs';
import { verifyYoutickPlayGrantArgs, YOUTICK_PLAY_ORIGIN_HASH } from './youtick-play-proof.mjs';
import { YOUTICK_PLAY_GRANT_GAS, verifyYoutickPlayGrantBinding, verifyYoutickPlayGrantTransaction,
  verifyYoutickPlayGrantView } from './youtick-playback.mjs';

const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === expected.length && expected.every(k => Object.hasOwn(value, k));
function decode(value) {
  if (typeof value !== 'string' || value.length > 16_384 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('invalid diagnostic transaction arguments');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('invalid diagnostic transaction arguments');
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error('invalid diagnostic transaction arguments'); }
}

export function validateYoutickGrantProbe(probe) {
  if (!keys(probe, ['version', 'purpose', 'vault', 'owner', 'vault_code_hash', 'market_code_hash', 'access_code_hash',
    'owner_public_key', 'prepared']) || probe.version !== 1 || probe.purpose !== 'hypothetical-job-no-payment-testnet' ||
      !isTestnetAccount(probe.vault) || !isTestnetAccount(probe.owner) || probe.vault === probe.owner ||
      !isTransactionHash(probe.vault_code_hash) || probe.market_code_hash !== YOUTICK_V1_CODE_HASH ||
      probe.access_code_hash !== YOUTICK_ACCESS_CODE_HASH ||
      !keys(probe.prepared, ['owner_id', 'vault', 'method', 'deposit', 'gas', 'args']) ||
      probe.prepared.owner_id !== probe.owner || probe.prepared.vault !== probe.vault ||
      probe.prepared.method !== 'issue_youtick_play_grant' || probe.prepared.deposit !== '1' || probe.prepared.gas !== YOUTICK_PLAY_GRANT_GAS ||
      typeof probe.prepared.args?.job_id !== 'string' || !probe.prepared.args.job_id.startsWith('bouncer-probe-')) {
    throw new Error('invalid hypothetical no-payment testnet grant diagnostic');
  }
  let key;
  try { key = nearApi.utils.PublicKey.fromString(probe.owner_public_key); } catch { throw new Error('invalid diagnostic owner public key'); }
  if (key.keyType !== 0 || String(key) !== probe.owner_public_key) throw new Error('invalid diagnostic owner public key');
  verifyYoutickPlayGrantArgs({ vault: probe.vault, args: probe.prepared.args });
  return probe;
}

/** The zero-yocto owner call must have actually failed on the vault. A missing
 * transaction, arbitrary failure or outer status alone is not guard proof. */
export function verifyYoutickZeroGrantProbe({ probe: raw, result, txHash }) {
  const probe = validateYoutickGrantProbe(raw), tx = result?.transaction, status = result?.status;
  if (!isTransactionHash(txHash) || result?.final_execution_status !== 'FINAL' || result?.transaction_outcome?.id !== txHash ||
      !status?.Failure || status.SuccessValue !== undefined || status.SuccessReceiptId !== undefined ||
      !tx || tx.hash !== txHash || tx.signer_id !== probe.owner || tx.receiver_id !== probe.vault || tx.public_key !== probe.owner_public_key ||
      !Array.isArray(tx.actions) || tx.actions.length !== 1 || !Array.isArray(result.receipts) || !Array.isArray(result.receipts_outcome)) {
    throw new Error('zero-yocto diagnostic is not the original failed FINAL owner transaction');
  }
  const call = tx.actions[0]?.FunctionCall;
  if (call?.method_name !== probe.prepared.method || String(call.deposit) !== '0' || String(call.gas) !== probe.prepared.gas ||
      !isDeepStrictEqual(decode(call.args), probe.prepared.args)) throw new Error('zero-yocto diagnostic action differs from review');
  const root = result.transaction_outcome?.outcome, child = root?.status?.SuccessReceiptId;
  const failed = result.receipts_outcome.filter(r => r.id === child && r.outcome?.executor_id === probe.vault &&
    isDeepStrictEqual(r.outcome.status?.Failure, status.Failure) && r.outcome.status?.SuccessValue === undefined &&
    r.outcome.status?.SuccessReceiptId === undefined && JSON.stringify(r.outcome.status.Failure).includes('owner-only method requires exactly 1 yoctoNEAR'));
  if (typeof child !== 'string' || root.status.Failure !== undefined || root.status.SuccessValue !== undefined ||
      !Array.isArray(root.receipt_ids) || !root.receipt_ids.includes(child) || failed.length !== 1 ||
      result.receipts.some(r => r.predecessor_id === probe.vault && r.receiver_id === YOUTICK_ACCESS)) {
    throw new Error('zero-yocto diagnostic lacks the linked owner-guard failure or unexpectedly called access');
  }
  return { tx_hash: txHash, vault_receipt_id: child, rejected_by_one_yocto_guard: true };
}

/** Prove only the hypothetical access grant, never a paid job or retrieval. */
export function verifyYoutickGrantProbe({ probe: raw, result, txHash, grant, verification, nowMs = Date.now() }) {
  const probe = validateYoutickGrantProbe(raw);
  const proof = verifyYoutickPlayGrantTransaction({ prepared: probe.prepared, result, txHash, ownerPublicKey: probe.owner_public_key, grant });
  const bound = verifyYoutickPlayGrantBinding(probe.prepared, grant);
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error('invalid diagnostic clock');
  let status = 'EXPIRED';
  if (bound.expires_at_ms > nowMs) { verifyYoutickPlayGrantView(probe.prepared, grant, verification, nowMs); status = 'GRANTED'; }
  return { status, tx_hash: proof.tx_hash, access_receipt_id: proof.access_receipt_id, vault: probe.vault,
    job_id: bound.job_id, expires_at_ms: bound.expires_at_ms, market: YOUTICK_MARKET, access: YOUTICK_ACCESS,
    scope: 'hypothetical job only: no quote, FT payment, upload, publication, token, playback or delivery' };
}

/** Reinspect original public hashes, same-block code/owner views and FINAL
 * receipts. It never creates an account, signs, sends or needs private keys. */
export async function inspectYoutickGrantProbe({ probe: raw, provider, zeroHash, grantHash, nowMs = Date.now() }) {
  const probe = validateYoutickGrantProbe(raw);
  if (!provider || typeof provider.viewNodeStatus !== 'function' || typeof provider.query !== 'function' ||
      typeof provider.callFunction !== 'function' || typeof provider.txStatusReceipts !== 'function' ||
      (zeroHash !== undefined && !isTransactionHash(zeroHash)) || (grantHash !== undefined && !isTransactionHash(grantHash)) ||
      (zeroHash !== undefined && zeroHash === grantHash)) throw new Error('invalid key-free diagnostic inspection options');
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('diagnostic RPC must report testnet');
  const vault = await provider.query({ request_type: 'view_account', account_id: probe.vault, finality: 'final' });
  if (!isTransactionHash(vault?.block_hash) || vault?.code_hash !== probe.vault_code_hash) throw new Error('diagnostic vault code changed or is unavailable');
  const block = { blockId: vault.block_hash };
  const [access, market, owner, version] = await Promise.all([
    provider.query({ request_type: 'view_account', account_id: YOUTICK_ACCESS, ...block }),
    provider.query({ request_type: 'view_account', account_id: YOUTICK_MARKET, ...block }),
    provider.callFunction(probe.vault, 'get_owner', {}, block),
    provider.callFunction(probe.vault, 'contract_version', {}, block),
  ]);
  if (access?.block_hash !== vault.block_hash || market?.block_hash !== vault.block_hash ||
      access?.code_hash !== probe.access_code_hash || market?.code_hash !== probe.market_code_hash ||
      owner !== probe.owner || version !== 'bouncer-agent-v10-youtick-testnet') {
    throw new Error('diagnostic FINAL code, block, version or owner changed');
  }
  const report = { zero_guard: null, grant: null, block_hash: vault.block_hash,
    scope: 'read-only original hashes; unknown or absent evidence is not proof a transaction was never sent' };
  if (zeroHash !== undefined) {
    const result = await provider.txStatusReceipts(zeroHash, probe.owner, 'FINAL');
    report.zero_guard = verifyYoutickZeroGrantProbe({ probe, result, txHash: zeroHash });
  }
  if (grantHash !== undefined) {
    const args = probe.prepared.args;
    const [result, grant, verification] = await Promise.all([
      provider.txStatusReceipts(grantHash, probe.owner, 'FINAL'),
      provider.callFunction(YOUTICK_ACCESS, 'get_session_grant', { session_pk: args.session_pk }, block),
      provider.callFunction(YOUTICK_ACCESS, 'verify_session_grant', { session_pk: args.session_pk, scope: 'Play', resource_id: args.job_id,
        origin_hash: YOUTICK_PLAY_ORIGIN_HASH, device_hash: args.device_hash }, block),
    ]);
    report.grant = verifyYoutickGrantProbe({ probe, result, txHash: grantHash, grant, verification, nowMs });
  }
  return report;
}
