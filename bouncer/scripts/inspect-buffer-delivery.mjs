#!/usr/bin/env node
/** Read-only inspection of already-recorded Buffer evidence. The public review
 * never contains credentials or signed transactions. The private order file
 * contains a report and brief and is never printed or sent to the RPC. No
 * seller request, transaction signing, submission, notification or retry. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readBoundedEvidenceFile } from './inspect-paypercall-forwarder.mjs';
import { ReadOnlyNearReceiptProvider } from '../agent/read-only-near-receipts.mjs';
import { prepareBufferDeliveryEvidence, inspectBufferDeliveryEvidence } from '../agent/buffer-delivery-evidence.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

const MANIFEST_MAX = 32 * 1024, PRIVATE_MAX = 1024 * 1024;
const fields = (x, names) => x && typeof x === 'object' && !Array.isArray(x) &&
  Object.keys(x).sort().join(',') === [...names].sort().join(',');
const USAGE = `Read-only Buffer delivery evidence inspection (testnet only).

node scripts/inspect-buffer-delivery.mjs --rpc TESTNET_RPC --review PUBLIC_REVIEW.json --private-order PRIVATE_ORDER.json

The public review JSON contains exactly: format, terms, pins, funding_hash,
opening_hash, fulfillment_hash. Its format is "bouncer-buffer-delivery-evidence-v1".
The separately supplied order file is the private JSON response retained from
Buffer. It contains a private brief and report; keep it out of Git. No token,
private key, signed transaction or other credential belongs in the review.

The inspector fetches only the original FINAL receipts and pinned historical
views. Missing evidence is unknown, not permission to retry. It never contacts
the seller, signs, pays or submits a transaction. A matched report hash is not
proof of HTTP provenance, accuracy, independent fulfillment or an audit.
See experiments/buffer-forwarder/README.md.`;
function parseJson(bytes, label) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error(`invalid ${label}`); }
}
export function parseBufferReview(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MANIFEST_MAX) throw new Error('invalid Buffer review');
  const review = parseJson(bytes, 'Buffer review');
  if (!fields(review, ['format', 'terms', 'pins', 'funding_hash', 'opening_hash', 'fulfillment_hash']) ||
      review.format !== 'bouncer-buffer-delivery-evidence-v1' ||
      ![review.funding_hash, review.opening_hash, review.fulfillment_hash].every(isTransactionHash) ||
      new Set([review.funding_hash, review.opening_hash, review.fulfillment_hash]).size !== 3) throw new Error('invalid Buffer review');
  return review;
}
function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return null;
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]?.startsWith('--') ? args[i].slice(2) : '';
    if (!['rpc', 'review', 'private-order'].includes(name) || Object.hasOwn(result, name) || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('unknown, duplicate or incomplete option; use --help');
    }
    result[name] = args[i + 1];
  }
  if (!result.rpc || !result.review || !result['private-order']) throw new Error('RPC, public review and private order are required; use --help');
  return result;
}
export async function main(args = process.argv.slice(2), { createProvider = rpc => new ReadOnlyNearReceiptProvider(rpc),
  inspect = inspectBufferDeliveryEvidence, print = console.log } = {}) {
  const options = parseArgs([...args]);
  if (!options) { print(USAGE); return; }
  if (typeof createProvider !== 'function' || typeof inspect !== 'function' || typeof print !== 'function') throw new Error('invalid inspection dependencies');
  const review = parseBufferReview(readBoundedEvidenceFile(options.review, MANIFEST_MAX));
  const privateOrder = parseJson(readBoundedEvidenceFile(options['private-order'], PRIVATE_MAX), 'private order');
  await prepareBufferDeliveryEvidence(review.terms, review.pins);
  const provider = createProvider(options.rpc);
  const result = await inspect({ terms: review.terms, pins: review.pins, fundingHash: review.funding_hash,
    openingHash: review.opening_hash, fulfillmentHash: review.fulfillment_hash, privateOrder, provider });
  print(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(); }
  catch (error) {
    console.error(`Buffer evidence inspection stopped: ${String(error?.message ?? 'unknown error').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 300)}`);
    process.exitCode = 1;
  }
}
