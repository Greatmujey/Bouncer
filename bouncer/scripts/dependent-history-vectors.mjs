// Public 1 Nov 2026 testnet run. Reconstruct the bounded inputs and memo
// vectors from the OutLayer result and transaction IDs; this is NOT a full
// receipt transcript or an assertion that future storage is available.
import crypto from 'node:crypto';
import { materializeWorkflowStep } from '../agent/workflow.mjs';
import { canonicalDelivery } from '../agent/verify-delivery.mjs';
import { orderMemo } from '../services/resource-provider.mjs';
import { ORACLE_TESTNET_PROJECT } from '../agent/oracle-outlayer.mjs';

export const HISTORICAL = Object.freeze({
  contract: 'bouncer-oracle-509314d1.testnet', owner: 'owner.bouncer-oracle-509314d1.testnet',
  vendor: 'vendor.bouncer-oracle-509314d1.testnet', token: '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af',
  source_tx: 'CMFUYVjguSqsnv65tFVnPA2uiTdvJGx4pssDTNBtFY7L',
  source_key: 'ed25519:4X28Mooi5Px39wzcWVsMpxddifwSX4oPo6jZ19ZxPVxw',
  compute_tx: '3Vc4fohkHLmkUXqyjp2DcVaxw9B792Wi9hCVK2K3zDF1',
  storage_tx: 'EDyE96KjV6csc8s4tLsRAnw4hMzsBVdzHj1dj4sDRp8W',
  api_tx: 'BGDy5nfZ9iBLZg7gpqbGuN3nox5MHEg59Du3uf5Ki37R',
});
export const OBSERVED_SOURCE = Object.freeze({ success: true, token_id: 'near', source: 'custom', price_usd: 4.425, timestamp: 1793494932 });
export const OBSERVED_MEMOS = Object.freeze({
  compute: 'bouncer-order-v1:compute:025feed00a49cb68c4d40c57ccb6728f31020e3ef5944b1cd6f314f1ea20c1bb',
  storage: 'bouncer-order-v1:storage:ef5453d94012fa0aa5b770783138198673a2908bcc8e7d7f73feb0045f0d0b4e',
  api: 'bouncer-order-v1:api:1ba2767fd1280e575340c22153f3aed151ea090e0eb545dd69d0983389e8b9c5',
});
export const historicalOracleGoal = () => ({ id: 'independent-near-price', contract_id: HISTORICAL.contract,
  owner_account_id: HISTORICAL.owner, policy_id: 'independent-price', amount: '100000000000000000000000',
  route: { project: { ...ORACLE_TESTNET_PROJECT }, route_revision: 1, policy_revision: 1, payee_revision: 1, active: true }, max_age_seconds: 900 });

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const artifact = (kind, goal_id, tx_hash, result) => JSON.stringify({ version: 1, kind, goal_id, tx_hash, result });
const template = (id, resource, input) => ({ id, resource, policy_id: 'circle-resources',
  token: HISTORICAL.token, payee: HISTORICAL.vendor, max_amount: '1000', input });

export function reconstructHistoricalOrders(observation) {
  if (!observation || observation.success !== true || observation.token_id !== 'near' || observation.source !== 'custom' ||
      typeof observation.price_usd !== 'number' || !Number.isFinite(observation.price_usd) || observation.price_usd <= 0 ||
      !Number.isSafeInteger(observation.timestamp) || observation.timestamp <= 0) throw new Error('invalid historical source observation');
  const data = new Map([['independent-near-price', artifact('oracle', 'independent-near-price', HISTORICAL.source_tx,
    { token_id: observation.token_id, source: observation.source, price_usd: observation.price_usd, timestamp: observation.timestamp })]]);
  const compute = materializeWorkflowStep(template('dependent-compute', 'compute',
    { text: { from: 'independent-near-price' }, rounds: 25 }), data);
  let digest = Buffer.from(compute.input.text, 'utf8');
  for (let i = 0; i < compute.input.rounds; i++) digest = crypto.createHash('sha256').update(digest).digest();
  const computed = canonicalDelivery({ resource: 'compute', input: compute.input, txHash: HISTORICAL.compute_tx,
    result: { type: 'compute', algorithm: 'sha256-iterated', rounds: compute.input.rounds, result: digest.toString('hex') } });
  data.set('dependent-compute', artifact('compute', 'dependent-compute', HISTORICAL.compute_tx, computed));
  const storage = materializeWorkflowStep(template('dependent-storage', 'storage',
    { name: 'dependent-oracle-report', content: { from: 'dependent-compute' } }), data);
  const stored = canonicalDelivery({ resource: 'storage', input: storage.input, txHash: HISTORICAL.storage_tx,
    result: { type: 'storage', object_id: hash(`${HISTORICAL.storage_tx}:${storage.input.name}`),
      sha256: hash(storage.input.content), bytes: Buffer.byteLength(storage.input.content) } });
  data.set('dependent-storage', artifact('storage', 'dependent-storage', HISTORICAL.storage_tx, stored));
  const api = materializeWorkflowStep(template('dependent-api', 'api', { text: { from: 'dependent-storage' } }), data);
  return { computed, stored, cases: [
    { resource: 'compute', tx_hash: HISTORICAL.compute_tx, input: compute.input, memo: orderMemo('compute', compute.input) },
    { resource: 'storage', tx_hash: HISTORICAL.storage_tx, input: storage.input, memo: orderMemo('storage', storage.input) },
    { resource: 'api', tx_hash: HISTORICAL.api_tx, input: api.input, memo: orderMemo('api', api.input) },
  ] };
}
