#!/usr/bin/env node
/** Read-only inspection of an already-recorded PayPerCall forwarder order.
 * The review is public data; do not put keys, signed transactions or secrets
 * into it. The separately supplied answer file is hashed locally and is never
 * printed or sent to the RPC. No seller request, signing, broadcast or retry. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ReadOnlyNearReceiptProvider } from '../agent/read-only-near-receipts.mjs';
import { inspectPayPerCallForwarderEvidence, preparePayPerCallEvidence } from '../agent/paypercall-forwarder-evidence.mjs';

const MANIFEST_MAX = 16 * 1024, ANSWER_MAX = 1024 * 1024;
const fields = (x, names) => x && typeof x === 'object' && !Array.isArray(x) &&
  Object.keys(x).sort().join(',') === [...names].sort().join(',');
const USAGE = `Read-only PayPerCall forwarder receipt verification (testnet only).

node scripts/inspect-paypercall-forwarder.mjs --rpc TESTNET_RPC --review PUBLIC_REVIEW.json --answer ANSWER_FILE

The review JSON must contain exactly: format, terms, offer, funding_hash,
opening_hash, fulfillment_hash, fulfillment_signer. The format is
"bouncer-paypercall-forwarder-evidence-v1". Use the original public forwarder
build terms, independently retained service/code pins and original hashes.
Do not include credentials, signed transactions or private material. The answer
is read as exact bytes and is not printed or sent to the RPC. No seller is
contacted; no signing, transaction submission or retry is performed.

A matched hash and payout are not proof of HTTP delivery, correctness, source
identity, an audit, or an independent provider purchase. Missing or pruned
historical state remains unknown. See docs/PAYPERCALL_INSPECTION.md.`;

/** Bound reads to a regular, non-symlink, single-link file. A file that changes
 * size during the read fails closed. Neither file content is logged. */
export function readBoundedEvidenceFile(file, maximum) {
  if (typeof file !== 'string' || !file || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > ANSWER_MAX) {
    throw new Error('invalid evidence file');
  }
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximum) throw new Error('unsafe or oversized evidence file');
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) {
      const n = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (n < 1) throw new Error('evidence file changed during read');
      offset += n;
    }
    const after = fs.fstatSync(fd);
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0 || after.size !== before.size || after.nlink !== 1 ||
        after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error('evidence file changed during read');
    }
    return bytes;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
export function parseEvidenceReview(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MANIFEST_MAX) throw new Error('invalid evidence review');
  let review;
  try { review = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('invalid evidence review'); }
  if (!fields(review, ['format', 'terms', 'offer', 'funding_hash', 'opening_hash', 'fulfillment_hash', 'fulfillment_signer']) ||
      review.format !== 'bouncer-paypercall-forwarder-evidence-v1' ||
      typeof review.funding_hash !== 'string' || typeof review.opening_hash !== 'string' ||
      typeof review.fulfillment_hash !== 'string' || typeof review.fulfillment_signer !== 'string') {
    throw new Error('invalid evidence review');
  }
  return review;
}
function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return null;
  const out = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]?.startsWith('--') ? args[i].slice(2) : '';
    if (!['rpc', 'review', 'answer'].includes(name) || Object.hasOwn(out, name) || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('unknown, duplicate or incomplete option; use --help');
    }
    out[name] = args[i + 1];
  }
  if (!out.rpc || !out.review || !out.answer) throw new Error('RPC, public review and answer file are required; use --help');
  return out;
}

export async function main(args = process.argv.slice(2), { createProvider = rpc => new ReadOnlyNearReceiptProvider(rpc),
  inspect = inspectPayPerCallForwarderEvidence, print = console.log } = {}) {
  const options = parseArgs([...args]);
  if (!options) { print(USAGE); return; }
  if (typeof createProvider !== 'function' || typeof inspect !== 'function' || typeof print !== 'function') throw new Error('invalid inspection dependencies');
  const review = parseEvidenceReview(readBoundedEvidenceFile(options.review, MANIFEST_MAX));
  const answerBytes = readBoundedEvidenceFile(options.answer, ANSWER_MAX);
  await preparePayPerCallEvidence(review.terms, review.offer);
  const provider = createProvider(options.rpc);
  const result = await inspect({ terms: review.terms, offer: review.offer, fundingHash: review.funding_hash,
    openingHash: review.opening_hash, fulfillmentHash: review.fulfillment_hash, fulfillmentSigner: review.fulfillment_signer,
    answerBytes, provider });
  print(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(); }
  catch (error) {
    console.error(`PayPerCall evidence inspection stopped: ${String(error?.message ?? 'unknown error').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 300)}`);
    process.exitCode = 1;
  }
}
