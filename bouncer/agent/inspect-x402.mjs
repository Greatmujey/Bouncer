#!/usr/bin/env node
/**
 * Operator-selected x402 endpoint inspection. One unauthenticated GET; no
 * wallet, signing, transaction, seller redemption or policy change. This is a
 * diagnostic, not a registry, seller endorsement or purchase authorization.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CIRCLE_TESTNET_USDC } from '../scripts/circle-testnet-setup.mjs';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { selectOnchainProofOffer, validateOnchainProofResourceUrl } from './onchain-proof.mjs';

const MAX_HEADER = 8192, MAX_OFFERS = 16;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const label = v => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(v) ? v : '<invalid>';
const amount = v => typeof v === 'string' && /^(?:0|[1-9][0-9]{0,38})$/.test(v) ? v : '<invalid>';
function decode(value) {
  if (typeof value !== 'string' || value.length > MAX_HEADER || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('invalid x402 PAYMENT-REQUIRED header');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('noncanonical x402 PAYMENT-REQUIRED header');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('invalid x402 PAYMENT-REQUIRED JSON'); }
}
function inspectRail(rail, challenge, header, url) {
  const r = object(rail) ? rail : {};
  const reasons = [];
  if (r.scheme !== 'onchain-proof') reasons.push('scheme is not onchain-proof');
  if (r.network !== 'near:testnet') reasons.push('network is not NEAR testnet');
  if (r.asset !== CIRCLE_TESTNET_USDC) reasons.push('asset is not canonical Circle testnet USDC');
  if (!isTestnetAccount(r.payTo)) reasons.push('payee is not a valid testnet account');
  if (!reasons.length) {
    // The amount here only helps validate the wire shape; it does not approve
    // a price. A real owner must set their own maximum and policy separately.
    try {
      selectOnchainProofOffer({ version: 1, id: 'inspection', contract_id: 'bouncer.testnet', owner_account_id: 'owner.testnet',
        policy_id: 'inspection', token: CIRCLE_TESTNET_USDC, payee: r.payTo, max_amount: r.amount,
        resource_url: url, max_quote_age_seconds: 120, accept_public_proof_risk: true, accept_unbound_resource_risk: true }, header);
    } catch { reasons.push('offer, resource binding or challenge is unsupported or ambiguous'); }
  }
  return { scheme: label(r.scheme), network: label(r.network), asset: label(r.asset), payee: label(r.payTo), amount: amount(r.amount),
    wire_candidate: reasons.length === 0 && challenge.x402Version === 2, reasons };
}

/** Fetch a single explicitly chosen endpoint; never follow redirects. */
export async function inspectX402({ url, fetchImpl = globalThis.fetch, timeoutMs = 15_000 }) {
  url = validateOnchainProofResourceUrl(url);
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('invalid HTTP client');
  const response = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
  try {
    const base = { version: 1, url, mode: 'read-only', payment_enabled: false, owner_approval_required: true, http_status: response.status };
    if (response.status !== 402) return { ...base, offers: [], note: 'Endpoint did not return an x402 HTTP 402 challenge.' };
    const header = response.headers?.get('payment-required');
    if (!header) return { ...base, offers: [], note: 'No PAYMENT-REQUIRED header; this buyer does not consume challenge bodies.' };
    const challenge = decode(header);
    if (!object(challenge) || challenge.x402Version !== 2 || !Array.isArray(challenge.accepts) ||
        !challenge.accepts.length || challenge.accepts.length > MAX_OFFERS) throw new Error('invalid or unsupported x402 challenge');
    const offers = challenge.accepts.map(item => inspectRail(item, challenge, header, url));
    return { ...base, x402_version: 2, offers,
      note: 'Wire candidates are untrusted advertisements, not approval, a guarantee of nested-transfer acceptance, seller safety, or fulfillment. No payment or proof was sent.' };
  } finally { await response.body?.cancel().catch(() => {}); }
}

function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  if (args.length !== 2 || args[0] !== '--url') throw new Error('usage: inspect-x402.mjs --url CANONICAL_HTTPS_URL');
  return { url: args[1] };
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node bouncer/agent/inspect-x402.mjs --url CANONICAL_HTTPS_URL');
    console.log('One unauthenticated GET to an operator-selected endpoint. No key, payment, redemption or policy changes.'); return;
  }
  console.log(JSON.stringify(await inspectX402(options), null, 2));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`x402 inspection failed: ${String(error.message).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300)}`); process.exitCode = 1; });
}
