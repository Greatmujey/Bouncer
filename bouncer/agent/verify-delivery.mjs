/**
 * Client-side checks for Bouncer's bounded development resource protocols.
 * These checks happen AFTER payment and do not ensure future availability,
 * provider honesty, generic compute correctness, or third-party data truth.
 */
import crypto from 'node:crypto';
import { normalizeOrder } from '../services/resource-provider.mjs';
import { fetchPublicRepository, normalizeRepository } from '../services/github-data.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const bytes = value => Buffer.byteLength(value, 'utf8');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exactKeys = (value, keys) => plain(value) && Object.keys(value).length === keys.length &&
  Object.keys(value).every(key => keys.includes(key));
const safeCount = value => Number.isSafeInteger(value) && value >= 0;
const validTimestamp = value => {
  if (typeof value !== 'string' || value.length !== 24) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
};

export function verificationSpec(resource, input) {
  const normalized = normalizeOrder(resource, input);
  if (resource === 'compute') return { method: 'local-recompute', scope: 'iterated-sha256' };
  if (resource === 'storage') return { method: 'provider-readback', scope: 'single-read-content' };
  if (Object.hasOwn(normalized, 'repo')) return { method: 'github-independent-read', scope: 'repository-identity-only' };
  return { method: 'local-recompute', scope: 'text-statistics' };
}

/** Validate fields and locally check all deterministic values; never echo extras. */
export function canonicalDelivery({ resource, input, result, txHash }) {
  const order = normalizeOrder(resource, input);
  if (typeof txHash !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(txHash)) throw new Error('invalid payment transaction hash');
  if (resource === 'compute') {
    if (!exactKeys(result, ['type', 'algorithm', 'rounds', 'result']) || result.type !== 'compute' ||
        result.algorithm !== 'sha256-iterated' || result.rounds !== order.rounds || typeof result.result !== 'string' || !/^[a-f0-9]{64}$/.test(result.result)) {
      throw new Error('invalid compute delivery');
    }
    let value = Buffer.from(order.text, 'utf8');
    for (let i = 0; i < order.rounds; i++) value = crypto.createHash('sha256').update(value).digest();
    if (result.result !== value.toString('hex')) throw new Error('compute result does not match independent recomputation');
    return { type: 'compute', algorithm: 'sha256-iterated', rounds: order.rounds, result: result.result };
  }
  if (resource === 'storage') {
    const objectId = hash(`${txHash}:${order.name}`);
    const contentHash = hash(Buffer.from(order.content, 'utf8'));
    if (!exactKeys(result, ['type', 'object_id', 'sha256', 'bytes']) || result.type !== 'storage' ||
        result.object_id !== objectId || result.sha256 !== contentHash || result.bytes !== bytes(order.content)) {
      throw new Error('storage delivery metadata does not match the paid order');
    }
    return { type: 'storage', object_id: objectId, sha256: contentHash, bytes: bytes(order.content) };
  }
  if (!Object.hasOwn(order, 'repo')) {
    const words = order.text.trim() ? order.text.trim().split(/\s+/u).length : 0;
    const size = bytes(order.text);
    if (!exactKeys(result, ['type', 'operation', 'words', 'bytes']) || result.type !== 'api' ||
        result.operation !== 'text-statistics' || result.words !== words || result.bytes !== size) {
      throw new Error('API text statistics do not match independent recomputation');
    }
    return { type: 'api', operation: 'text-statistics', words, bytes: size };
  }
  const keys = ['type', 'operation', 'repository', 'repository_id', 'description', 'stars', 'forks', 'open_issues', 'license', 'retrieved_at'];
  if (!exactKeys(result, keys) || result.type !== 'api' || result.operation !== 'github-repository' ||
      typeof result.repository !== 'string' || normalizeRepository(result.repository).toLowerCase() !== order.repo.toLowerCase() ||
      !safeCount(result.repository_id) || result.repository_id === 0 || !safeCount(result.stars) || !safeCount(result.forks) || !safeCount(result.open_issues) ||
      !(result.description === null || (typeof result.description === 'string' && bytes(result.description) <= 2048)) ||
      !(result.license === null || (typeof result.license === 'string' && bytes(result.license) <= 40)) || !validTimestamp(result.retrieved_at)) {
    throw new Error('invalid public repository delivery');
  }
  return { type: 'api', operation: 'github-repository', repository: result.repository, repository_id: result.repository_id,
    description: result.description, stars: result.stars, forks: result.forks, open_issues: result.open_issues,
    license: result.license, retrieved_at: result.retrieved_at };
}

/**
 * Read storage at the already-approved provider origin, or independently read
 * the fixed GitHub origin. Only GitHub identity is checked; counters and text
 * remain untrusted and may change between reads.
 */
export async function verifyDelivery({ resource, input, result, txHash, readStorage, repositoryLookup = fetchPublicRepository }) {
  const order = normalizeOrder(resource, input);
  const canonical = canonicalDelivery({ resource, input: order, result, txHash });
  if (resource === 'storage') {
    if (typeof readStorage !== 'function') throw new Error('storage readback is required');
    const content = await readStorage(canonical.object_id);
    if (!(content instanceof Uint8Array) || content.byteLength > 4096 || !Buffer.from(content).equals(Buffer.from(order.content, 'utf8'))) {
      throw new Error('storage readback does not match the ordered content');
    }
  } else if (resource === 'api' && Object.hasOwn(order, 'repo')) {
    if (typeof repositoryLookup !== 'function') throw new Error('independent GitHub reference is required');
    const reference = await repositoryLookup(order.repo);
    const referenceResult = canonicalDelivery({ resource, input: order, result: reference, txHash });
    if (referenceResult.repository_id !== canonical.repository_id) throw new Error('public repository identity does not match independent GitHub read');
  }
  return { result: canonical, verification: verificationSpec(resource, order) };
}

/** Domain-separated hash of the fixed-order canonical result, not a signature. */
export function deliveryResultHash(result) {
  return hash(`bouncer-delivery-result-v1\0${JSON.stringify(result)}`);
}

function receiptFields({ contractId, ownerAccountId, request, txHash, providerId, providerOrigin, result, verification }) {
  return { version: 1, goal_id: request.id, contract_id: contractId, owner_account_id: ownerAccountId,
    provider_id: providerId ?? null, provider_origin: providerOrigin ?? null, request, tx_hash: txHash,
    result, result_sha256: deliveryResultHash(result), verification };
}

export function createDeliveryReceipt(details) {
  return { ...receiptFields(details), verified_at: new Date().toISOString() };
}

/** Validate stored evidence before any new batch payment, then on replay. */
export function checkDeliveryRecord({ delivery, contractId, ownerAccountId, request, txHash, providerId, providerOrigin, input }) {
  if (delivery === undefined) return;
  if (!plain(delivery)) throw new Error('invalid delivery journal record');
  if (delivery.status === 'unverified') {
    if (!exactKeys(delivery, ['status', 'stage', 'attempted_at']) || !['fulfillment', 'verification'].includes(delivery.stage) || !validTimestamp(delivery.attempted_at)) {
      throw new Error('invalid unverified delivery record');
    }
    return;
  }
  if (!exactKeys(delivery, ['status', 'receipt']) || delivery.status !== 'verified') throw new Error('invalid delivery journal record');
  const receipt = delivery.receipt;
  const keys = ['version', 'goal_id', 'contract_id', 'owner_account_id', 'provider_id', 'provider_origin', 'request', 'tx_hash', 'result', 'result_sha256', 'verification', 'verified_at'];
  if (!exactKeys(receipt, keys) || !validTimestamp(receipt.verified_at)) throw new Error('invalid delivery receipt');
  const canonical = canonicalDelivery({ resource: request.resource, input, result: receipt.result, txHash });
  const verification = verificationSpec(request.resource, input);
  const expected = receiptFields({ contractId, ownerAccountId, request, txHash, providerId, providerOrigin, result: canonical, verification });
  for (const key of Object.keys(expected)) {
    if (JSON.stringify(receipt[key]) !== JSON.stringify(expected[key])) throw new Error('delivery receipt does not match the paid request and verified result');
  }
}
