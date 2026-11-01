/** Experimental, testnet-only MultiAgency wallet-deposit research adapter.
 * The seller's deployed code, current staffing and refund terms are NOT
 * established. Provider JSON and GitHub are trusted only within the explicit
 * checks below; neither payment nor a hash proves the quality of a report.
 * No key or network operation is performed in this module. */
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { isTransactionHash, verifyDirectPayment } from '../shared/direct-payment-settlement.mjs';
import { CIRCLE_TESTNET_USDC } from '../scripts/circle-testnet-setup.mjs';
import { validatePlan } from './procurement.mjs';
import { MULTIAGENCY_BOARD, MULTIAGENCY_TREASURY } from './multiagency-readiness.mjs';

const BOT_ID = 334725530;
const API_ISSUES = 'https://api.github.com/repos/MultiAgency/kanban-sandbox/issues';
const GOAL_FIELDS = ['version', 'id', 'vault', 'owner', 'vault_code_hash', 'policy_id', 'title', 'brief', 'amount',
  'accept_public_brief', 'accept_stalled_deposit_risk', 'accept_unsigned_quote_and_memo_risk'];
const record = v => v && typeof v === 'object' && !Array.isArray(v);
const hasFields = (v, fields, optional = []) => record(v) && fields.every(k => Object.hasOwn(v, k)) &&
  Object.keys(v).every(k => fields.includes(k) || optional.includes(k));
const digest = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
function safeBrief(s, max, newline = false) {
  return typeof s === 'string' && s === s.trim() && Buffer.byteLength(s) <= max &&
    !(newline ? /[\x00-\x08\x0b-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(s);
}

/** Owner-reviewed public request and explicit non-guarantees, not a quote. */
export function validateMultiAgencyGoal(input) {
  if (!hasFields(input, GOAL_FIELDS) || input.version !== 1 || !/^[A-Za-z0-9_-]{1,48}$/.test(input.id ?? '') ||
      !isTestnetAccount(input.vault) || !isTestnetAccount(input.owner) || input.vault === input.owner || !isTransactionHash(input.vault_code_hash) ||
      typeof input.policy_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.policy_id) ||
      !safeBrief(input.title, 120) || input.title.length < 4 || !safeBrief(input.brief, 8000, true) || input.brief.length < 20 ||
      /```(?:engagement|team|job-request)\n/.test(input.brief) || input.amount !== '3000000' ||
      input.accept_public_brief !== true || input.accept_stalled_deposit_risk !== true ||
      input.accept_unsigned_quote_and_memo_risk !== true) throw new Error('invalid or unacknowledged testnet research goal');
  return Object.fromEntries(GOAL_FIELDS.map(k => [k, input[k]]));
}

/** Strict provider response profile. The provider quote has no signature and
 * does not echo the brief; only later job publication can corroborate it. */
export function validateMultiAgencyQuote(rawGoal, quote, { nowMs = Date.now(), allowExpired = false } = {}) {
  const goal = validateMultiAgencyGoal(rawGoal);
  if (!hasFields(quote, ['code', 'title', 'status', 'channel', 'expires_at', 'payment']) ||
      !/^ma-[0-9a-f]{10}$/.test(quote.code ?? '') || quote.title !== goal.title || quote.status !== 'awaiting_deposit' ||
      quote.channel !== 'wallet' || !hasFields(quote.payment, ['network', 'token', 'receiver', 'amount', 'memo']) ||
      quote.payment.network !== 'testnet' || quote.payment.token !== CIRCLE_TESTNET_USDC ||
      quote.payment.receiver !== MULTIAGENCY_TREASURY || quote.payment.amount !== goal.amount || quote.payment.memo !== quote.code ||
      !Number.isSafeInteger(nowMs)) throw new Error('quote differs from the owner-reviewed testnet research goal');
  const expires = Date.parse(quote.expires_at);
  if (!Number.isFinite(expires) || new Date(expires).toISOString() !== quote.expires_at ||
      (!allowExpired && (expires < nowMs + 5 * 60_000 || expires > nowMs + 73 * 3600_000))) throw new Error('quote is stale or has an invalid expiry');
  return structuredClone(quote);
}

export function multiAgencyPaymentPlan(rawGoal, quote, options) {
  const goal = validateMultiAgencyGoal(rawGoal), reviewed = validateMultiAgencyQuote(goal, quote, options);
  return validatePlan({ contract_id: goal.vault, owner_account_id: goal.owner, requests: [{ id: goal.id,
    resource: 'api', policy_id: goal.policy_id, token: CIRCLE_TESTNET_USDC, payee: MULTIAGENCY_TREASURY,
    amount: goal.amount, memo: reviewed.code }] });
}

/** Block at which the transaction-linked guarded execution was processed.
 * The direct-payment verifier separately checks its transfer/callback graph. */
export function multiAgencyExecutionBlock(result, vault) {
  const children = result?.transaction_outcome?.outcome?.receipt_ids;
  if (!Array.isArray(children) || !Array.isArray(result?.receipts_outcome)) throw new Error('guarded execution block is unavailable');
  const init = result.receipts_outcome.filter(item => children.includes(item?.id) && item?.outcome?.executor_id === vault &&
    item.outcome.logs?.includes('BOUNCER payment initiated'));
  if (init.length !== 1 || !isTransactionHash(init[0].block_hash)) throw new Error('guarded execution block is unavailable or ambiguous');
  return init[0].block_hash;
}

/** Confirm the nested guarded transfer and the exact token event a source-
 * reviewed MultiAgency watcher looks for. Neither the watcher nor delivery is
 * proven by this function. */
export function verifyMultiAgencyPayment({ goal: rawGoal, quote, result, publicKey, txHash, vaultState }) {
  const goal = validateMultiAgencyGoal(rawGoal), plan = multiAgencyPaymentPlan(goal, quote, { allowExpired: true });
  const request = plan.requests[0];
  const settlement = verifyDirectPayment({ result, contractId: goal.vault, ownerAccountId: goal.owner, request, publicKey, txHash });
  const executionBlock = multiAgencyExecutionBlock(result, goal.vault), txBlock = result.transaction_outcome?.block_hash;
  const reviewedState = (state, block) => record(state) && state.block_hash === block && state.code_hash === goal.vault_code_hash &&
    Array.isArray(state.keys) && state.keys.length === 0;
  if (!isTransactionHash(txBlock) || !reviewedState(vaultState, txBlock) || !reviewedState(vaultState.execution, executionBlock)) {
    throw new Error('transaction/guarded-execution block vault code or access keys differ from the reviewed keyless deployment');
  }
  const transfers = result.receipts.filter(r => r?.predecessor_id === goal.vault && r.receiver_id === CIRCLE_TESTNET_USDC &&
    Array.isArray(r.receipt?.Action?.actions) && r.receipt.Action.actions.length === 1 &&
    r.receipt.Action.actions[0]?.FunctionCall?.method_name === 'ft_transfer');
  if (transfers.length !== 1) throw new Error('missing unique nested Circle transfer');
  const outcome = result.receipts_outcome.find(r => r.id === transfers[0].receipt_id && r.outcome?.executor_id === CIRCLE_TESTNET_USDC);
  let matches = 0;
  for (const line of outcome?.outcome?.logs ?? []) {
    if (typeof line !== 'string' || !line.startsWith('EVENT_JSON:') || Buffer.byteLength(line) > 16_384) continue;
    let event; try { event = JSON.parse(line.slice(11)); } catch { continue; }
    if (event?.standard !== 'nep141' || event.version !== '1.0.0' || event.event !== 'ft_transfer' || !Array.isArray(event.data)) continue;
    matches += event.data.filter(item => item?.old_owner_id === goal.vault && item.new_owner_id === MULTIAGENCY_TREASURY &&
      item.amount === goal.amount && item.memo === quote.code).length;
  }
  if (matches !== 1) throw new Error('missing unique Circle event for the exact deposit memo; do not repay');
  return { ...settlement, event: 'unique Circle transfer event and reviewed quote memo',
    scope: 'FINAL payment only; seller attribution, opening and delivery not established' };
}

function singleFence(body, name) {
  if (typeof body !== 'string' || Buffer.byteLength(body) > 262_144) throw new Error(`invalid ${name} body`);
  const matches = [...body.matchAll(new RegExp('^```' + name + '\\n([\\s\\S]*?)\\n```[ \\t]*$', 'gm'))];
  if (matches.length !== 1) throw new Error(`missing or ambiguous ${name} block`);
  let value; try { value = JSON.parse(matches[0][1]); } catch { throw new Error(`invalid ${name} block JSON`); }
  if (!record(value)) throw new Error(`invalid ${name} block`);
  return value;
}
const issueUrl = n => `${MULTIAGENCY_BOARD}/issues/${n}`;
function issueNumber(value) { return Number.isSafeInteger(value) && value > 0; }
function verifyEpic({ goal, quote, txHash, epic, jobNumber }) {
  if (!issueNumber(jobNumber) || !record(epic) || epic.number !== jobNumber || epic.html_url !== issueUrl(jobNumber) ||
      epic.user?.id !== BOT_ID || epic.title !== `Job: ${goal.title}` || typeof epic.body !== 'string' ||
      !epic.body.includes(`\n\n${goal.brief}\n\n\`\`\`engagement\n`)) throw new Error('provider job identity or public brief does not match');
  const block = singleFence(epic.body, 'engagement'), deposit = block.deposit;
  if (block.engagement_id !== quote.code || block.channel !== 'wallet' || block.org !== goal.vault || !record(deposit) ||
      deposit.amount !== goal.amount || deposit.asset !== CIRCLE_TESTNET_USDC || deposit.treasury !== MULTIAGENCY_TREASURY ||
      deposit.transaction !== txHash || deposit.network !== 'testnet') throw new Error('provider job is not bound to the original deposit');
  return block;
}

/** Bind a recorded FINAL payment to the seller's own status and its bot-
 * authored public job. This still proves no completion or content quality. */
export function verifyMultiAgencyOpening({ goal: rawGoal, quote, result, publicKey, txHash, vaultState, sellerQuote, epic }) {
  const goal = validateMultiAgencyGoal(rawGoal);
  const payment = verifyMultiAgencyPayment({ goal, quote, result, publicKey, txHash, vaultState });
  if (!record(sellerQuote) || sellerQuote.code !== quote.code || sellerQuote.title !== quote.title ||
      sellerQuote.status !== 'open' || sellerQuote.channel !== 'wallet' || sellerQuote.expires_at !== quote.expires_at ||
      !isDeepStrictEqual(sellerQuote.payment, quote.payment) || !issueNumber(sellerQuote.issue) ||
      sellerQuote.issue_url !== issueUrl(sellerQuote.issue) || !record(sellerQuote.deposit) ||
      sellerQuote.deposit.transaction !== txHash || sellerQuote.deposit.org !== goal.vault ||
      sellerQuote.deposit.amount !== goal.amount || sellerQuote.deposit.memo !== quote.code) {
    throw new Error('seller status does not attribute the original deposit to this vault and quote');
  }
  verifyEpic({ goal, quote, txHash, epic, jobNumber: sellerQuote.issue });
  return { status: 'OPENED', job: sellerQuote.issue, job_url: issueUrl(sellerQuote.issue), tx_hash: payment.tx_hash,
    scope: 'verified payment and seller job attribution via trusted RPC, provider and GitHub; not delivery' };
}

/** Check one bot-linked task's complete GitHub thread and exact unedited
 * deliverable bytes. Public GitHub/issuer identities are trusted, the
 * returned text is untrusted, and the digest proves integrity, not quality. */
export function verifyMultiAgencyPublishedHandoff({ epic, task, comments }) {
  if (!record(epic) || !issueNumber(epic.number) || epic.html_url !== issueUrl(epic.number) || epic.user?.id !== BOT_ID ||
      epic.state !== 'closed' || epic.state_reason !== 'completed' || !record(task) || !issueNumber(task.number) ||
      task.html_url !== issueUrl(task.number) || task.user?.id !== BOT_ID || task.state !== 'closed' || task.state_reason !== 'completed' ||
      !Array.isArray(task.assignees) || !task.assignees.length || !Array.isArray(comments) || comments.length > 100 ||
      !Number.isSafeInteger(task.comments) || task.comments !== comments.length) throw new Error('job/task not closed or complete thread unavailable');
  const team = singleFence(epic.body, 'team'), terms = singleFence(task.body, 'terms');
  if (!Array.isArray(team.members) || team.members.length > 100 || team.members.filter(m => m?.issue === task.number).length !== 1 ||
      !team.members.some(m => m?.issue === task.number && m.engagement === epic.number && m.asset === CIRCLE_TESTNET_USDC &&
        m.amount === terms.amount && m.key === terms.key) || terms.engagement !== epic.number || terms.asset !== CIRCLE_TESTNET_USDC) {
    throw new Error('task is not uniquely linked to the paid job');
  }
  const assignees = new Set(task.assignees.map(a => a?.id).filter(Number.isSafeInteger));
  const ids = new Set(); let lastTime = -Infinity, handoff = null;
  for (const comment of comments) {
    const time = Date.parse(comment?.created_at);
    if (!record(comment) || !Number.isSafeInteger(comment.id) || ids.has(comment.id) || !Number.isFinite(time) || time < lastTime ||
        comment.issue_url !== `${API_ISSUES}/${task.number}` || typeof comment.body !== 'string' || Buffer.byteLength(comment.body) > 262_144) {
      throw new Error('invalid, duplicate or incomplete task thread');
    }
    ids.add(comment.id); lastTime = time;
    if (assignees.has(comment.user?.id) && /^```handoff\n/m.test(comment.body)) handoff = comment;
  }
  const taskClosed = Date.parse(task.closed_at), epicClosed = Date.parse(epic.closed_at);
  if (!handoff || !Number.isFinite(taskClosed) || !Number.isFinite(epicClosed) ||
      Date.parse(handoff.created_at) > taskClosed || taskClosed > epicClosed) {
    throw new Error('no timely assignee handoff for the closed task');
  }
  const published = singleFence(handoff.body, 'handoff').deliverable;
  if (!record(published) || typeof published.url !== 'string' || !/^[a-f0-9]{64}$/.test(published.sha256 ?? '')) throw new Error('invalid published handoff');
  const match = new RegExp(`^${issueUrl(task.number).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}#issuecomment-([1-9][0-9]*)$`).exec(published.url);
  if (!match) throw new Error('handoff links outside the reviewed task');
  const id = Number(match[1]), deliverable = comments.find(c => c.id === id);
  if (!deliverable || deliverable.user?.id !== handoff.user?.id || deliverable.html_url !== published.url ||
      !deliverable.body.startsWith('**Deliverable**') || deliverable.updated_at !== deliverable.created_at ||
      handoff.updated_at !== handoff.created_at || Date.parse(deliverable.created_at) > Date.parse(handoff.created_at) ||
      digest(deliverable.body) !== published.sha256) throw new Error('deliverable content, author, timestamp or digest differs from the handoff');
  return { status: 'PUBLISHED', job: epic.number, task: task.number, url: published.url, sha256: published.sha256,
    text: deliverable.body, scope: 'trusted GitHub publication and digest only; no payment, truth or quality established' };
}

/** A task publication requires the exact original payment/job and its handoff.
 * One task is not necessarily the full brief. Report text is untrusted data,
 * never an instruction or verified fact; an owner must assess fulfillment. */
export function verifyMultiAgencyResearchDelivery({ goal, quote, result, publicKey, txHash, vaultState, sellerQuote, epic, task, comments }) {
  const opening = verifyMultiAgencyOpening({ goal, quote, result, publicKey, txHash, vaultState, sellerQuote, epic });
  const handoff = verifyMultiAgencyPublishedHandoff({ epic, task, comments });
  if (handoff.job !== opening.job) throw new Error('handoff belongs to a different job');
  return { status: 'PUBLISHED_TASK_AFTER_FINAL_PAYMENT', tx_hash: txHash, job_url: opening.job_url,
    task: handoff.task, deliverable_url: handoff.url, sha256: handoff.sha256, text: handoff.text,
    scope: 'one task under a paid job, not necessarily fulfillment of the complete brief; source quality, deployed watcher and future availability not established' };
}
