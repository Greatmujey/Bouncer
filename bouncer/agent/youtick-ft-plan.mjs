/** Build an exact owner-reviewable YouTick V1 FT-call goal and inspect a
 * corresponding provider job. This module performs no network I/O, key
 * storage, approval, payment, upload, or delivery verification. */
import { validateFtCallGoal } from './ft-call.mjs';
import { verifyYoutickQuote } from './youtick-quote.mjs';
import { TESTNET_CIRCLE_USDC, YOUTICK_MARKET } from './youtick-capabilities.mjs';

const messageFields = ['action', 'job_id', 'title', 'price_usdc', 'expected_source_bytes', 'profile_id',
  'profile_config_sha256', 'upload_public_key', 'upload_key_expires_at_ms', 'sponsor_quote', 'sponsor_quote_signature'];
function exactKeys(obj, keys) {
  return obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).length === keys.length && keys.every(key => Object.hasOwn(obj, key));
}

/** An expiring offer alone cannot authorize spending. The owner must separately
 * approve the exact resulting route with the 1-yocto policy guard; the normal
 * FT-call runner checks policy, route, revisions, key permissions and journal. */
export function prepareYoutickFtCall({ offer, id, ownerAccountId, policyId, policyRevision, routeRevision }) {
  if (!offer || Object.hasOwn(offer, 'market')) throw new Error('quote must target the fixed reviewed market');
  const verified = verifyYoutickQuote(offer), { request, quote, signature } = offer;
  const msg = JSON.stringify({ action: 'create_paid_job', job_id: request.job_id, title: request.title,
    price_usdc: request.price_usdc, expected_source_bytes: request.expected_source_bytes, profile_id: request.profile_id,
    profile_config_sha256: request.profile_config_sha256, upload_public_key: request.upload_public_key,
    upload_key_expires_at_ms: request.upload_key_expires_at_ms, sponsor_quote: quote, sponsor_quote_signature: signature });
  const goal = validateFtCallGoal({ id, contract_id: request.creator_id, owner_account_id: ownerAccountId, policy_id: policyId,
    payee: YOUTICK_MARKET, token: TESTNET_CIRCLE_USDC, amount: verified.fee_micro, msg,
    policy_revision: policyRevision, route_revision: routeRevision });
  return { goal, quote_id: verified.quote_id, expires_at_ms: verified.expires_at_ms,
    warning: 'owner must approve exact route with 1 yocto; preserve upload key and journal; no payment or delivery verified' };
}

/** Match a trusted FINAL market view to the exact reviewed call. This does not
 * verify payment receipts, the authenticity of the view, upload or retrieval. */
export function matchYoutickJob(goalInput, job) {
  const goal = validateFtCallGoal(goalInput);
  if (goal.payee !== YOUTICK_MARKET || goal.token !== TESTNET_CIRCLE_USDC) throw new Error('unexpected YouTick route');
  let msg;
  try { msg = JSON.parse(goal.msg); } catch { throw new Error('invalid YouTick route message'); }
  if (!exactKeys(msg, messageFields) || msg.action !== 'create_paid_job' || !msg.sponsor_quote ||
      typeof msg.sponsor_quote.quote_id !== 'string' || !/^[0-9a-f]{64}$/.test(msg.sponsor_quote.quote_id) ||
      msg.sponsor_quote.creator_id !== goal.contract_id || msg.sponsor_quote.job_id !== msg.job_id ||
      msg.sponsor_quote.total_fee_usdc !== goal.amount || typeof msg.sponsor_quote_signature !== 'string') {
    throw new Error('reviewed route does not bind the vault and quote');
  }
  if (!job || typeof job !== 'object' || Array.isArray(job) || job.job_id !== msg.job_id || job.creator_id !== goal.contract_id ||
      job.title !== msg.title || job.price_usdc !== msg.price_usdc || job.expected_source_bytes !== msg.expected_source_bytes ||
      job.profile_id !== msg.profile_id || job.profile_config_sha256 !== msg.profile_config_sha256 ||
      job.upload_public_key !== msg.upload_public_key || job.upload_key_expires_at_ms !== msg.upload_key_expires_at_ms ||
      job.generation !== 1 || job.fee_asset !== 'USDC' || job.fee_amount !== goal.amount || job.fee_usd_micro !== goal.amount ||
      job.fee_quote_hash !== msg.sponsor_quote.quote_id || !['Authorized', 'Published'].includes(job.status) ||
      (job.status === 'Authorized' && job.published_at_ms !== null) ||
      (job.status === 'Published' && (!Number.isSafeInteger(job.published_at_ms) || job.published_at_ms <= 0))) {
    throw new Error('market job does not match the reviewed Bouncer order');
  }
  return { status: job.status === 'Authorized' ? 'MATCHING_AUTHORIZED_JOB' : 'MATCHING_PUBLISHED_JOB',
    vault: goal.contract_id, job_id: job.job_id, quote_id: job.fee_quote_hash, fee_micro: goal.amount,
    scope: 'trusted market job snapshot only; not payment-receipt, uploaded-content or retrieval verification' };
}
