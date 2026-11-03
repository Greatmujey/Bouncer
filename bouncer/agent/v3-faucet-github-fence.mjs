/** GitHub check fences for ONE pre-reviewed V3 testnet faucet attempt. A check
 * is acknowledged and read back before helper contact and each transfer send.
 * The workflow additionally pins the one parent commit, first run attempt and
 * a concurrency group; this check-list test is not a distributed atomic lock. */
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { readBoundedJson } from '../shared/bounded-json.mjs';
import { FAUCET_RETURN, FAUCET_TRANSFER_YOCTO } from './native-testnet-faucet.mjs';

export const V3_OWNER = 'bouncer-owner-12f343b795633e357ae5560d.testnet';
export const V3_PUBLIC_KEY = 'ed25519:3FQ4vfUxvrWpfBgsxsiu9ER8jx71GeUHff5rUJx4zVog';
export const V3_FAUCET_REPO = 'Greatmujey/Bouncer';
export const V3_FAUCET_BRANCH = 'arena/25a7aaf6-near-hub';
const checks = { helper: 'V3 native faucet: sole helper reservation', transfer: 'V3 native faucet: original transfer',
  cleanup: 'V3 native faucet: original cleanup' };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest();
const b58 = nearApi.utils.serialize.base_encode;

export function fixedV3Plan(plan) {
  if (plan?.version !== 1 || plan?.purpose !== 'new-bouncer-testnet-owner' || plan?.network !== 'testnet' ||
      plan?.account_id !== V3_OWNER || plan?.public_key !== V3_PUBLIC_KEY || Object.keys(plan).length !== 5) {
    throw new Error('fixed V3 owner plan differs; stop');
  }
  return plan;
}
export function checkFaucetSignedOriginal(signed, entry, stage) {
  const t = signed?.transaction, a = t?.actions?.[0], pending = entry?.[stage];
  if (!['transfer', 'cleanup'].includes(stage) || !pending || pending.state !== 'pending' ||
      !/^bouncer-faucet-[a-f0-9]{32}\.testnet$/.test(entry.temporary_account ?? '') || entry.recipient !== V3_OWNER ||
      t?.signerId !== entry.temporary_account || String(t.publicKey) !== entry.temporary_public_key ||
      String(t.nonce) !== pending.nonce || !Array.isArray(t.actions) || t.actions.length !== 1 ||
      (stage === 'transfer' && (t.receiverId !== V3_OWNER || a?.enum !== 'transfer' ||
        String(a.transfer?.deposit) !== FAUCET_TRANSFER_YOCTO)) ||
      (stage === 'cleanup' && (entry.transfer?.state !== 'final' || t.receiverId !== entry.temporary_account ||
        a?.enum !== 'deleteAccount' || a.deleteAccount?.beneficiaryId !== FAUCET_RETURN))) {
    throw new Error('signed faucet original differs from the reviewed testnet action');
  }
  const txHash = hash(Buffer.from(nearApi.transactions.encodeTransaction(t)));
  const key = nearApi.utils.PublicKey.from(entry.temporary_public_key);
  if (b58(txHash) !== pending.tx_hash || !key.verify(txHash, signed.signature.data)) throw new Error('faucet original hash or signature differs');
  return { stage, tx_hash: pending.tx_hash, nonce: pending.nonce, signer: entry.temporary_account,
    signer_public_key: entry.temporary_public_key, receiver: t.receiverId,
    block_hash: b58(t.blockHash), action: stage === 'transfer' ? 'transfer' : 'delete_account',
    ...(stage === 'transfer' ? { amount_yocto: FAUCET_TRANSFER_YOCTO } : { beneficiary: FAUCET_RETURN }) };
}

export function createGithubFaucetFence({ token, runId, headSha, artifactId, bundleDigest, fetchImpl = globalThis.fetch }) {
  if (typeof token !== 'string' || token.length < 20 || !/^[1-9][0-9]{0,15}$/.test(runId ?? '') ||
      !/^[1-9][0-9]{0,15}$/.test(artifactId ?? '') || !/^[a-f0-9]{40}$/.test(headSha ?? '') ||
      !/^[a-f0-9]{64}$/.test(bundleDigest ?? '') || typeof fetchImpl !== 'function') throw new Error('invalid faucet check context');
  const api = async (method, path, body) => {
    const r = await fetchImpl(`https://api.github.com/repos/${V3_FAUCET_REPO}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28', 'user-agent': 'bouncer-v3-faucet',
        ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    try {
      if (!r.ok) throw new Error(`GitHub faucet check unavailable (${r.status}); no send`);
      return await readBoundedJson(r, { maxBytes: 512 * 1024, label: 'faucet check metadata' });
    } finally { await r.body?.cancel().catch(() => {}); }
  };
  return async function fence(stage, details) {
    const name = checks[stage];
    if (!name || !details || typeof details !== 'object' || Array.isArray(details)) throw new Error('invalid faucet check stage');
    // The workflow's fixed parent and concurrency prevent overlapping jobs.
    // If any earlier publication was ambiguous, an existing check stops us.
    const list = await api('GET', `/commits/${headSha}/check-runs?check_name=${encodeURIComponent(name)}&per_page=100`);
    if (!Array.isArray(list?.check_runs) || list.check_runs.some(c => c?.name === name)) throw new Error('faucet check already exists or cannot be enumerated; never retry');
    const summary = JSON.stringify({ version: 1, network: 'testnet', owner: V3_OWNER, run_id: runId,
      recovery_artifact_id: artifactId, recovery_bundle_sha256: bundleDigest, ...details,
      owner_key_accessed: false, do_not_resend: true });
    const published = await api('POST', '/check-runs', { name, head_sha: headSha,
      external_id: `bouncer-v3-faucet-${runId}-${stage}`, status: 'completed', conclusion: 'neutral',
      output: { title: 'Original testnet faucet fence', summary } });
    if (!Number.isSafeInteger(published?.id) || published.name !== name || published.head_sha !== headSha ||
        published.app?.slug !== 'github-actions') throw new Error('faucet check publication was not acknowledged; no send');
    const verified = await api('GET', `/check-runs/${published.id}`);
    if (verified?.id !== published.id || verified.name !== name || verified.head_sha !== headSha ||
        verified.app?.slug !== 'github-actions' || verified.external_id !== `bouncer-v3-faucet-${runId}-${stage}` ||
        verified.status !== 'completed' || verified.conclusion !== 'neutral' || verified.output?.summary !== summary) {
      throw new Error('faucet check read-back differs; no send');
    }
    return published.id;
  };
}

/** Wrap the existing one-shot sender; journal writes are local, but this
 * publishes and reads back the original public hash before the network send. */
export function guardFaucetProvider(provider, journal, fence) {
  const seen = new Set();
  if (!provider || !journal || typeof fence !== 'function') throw new Error('guarded faucet dependencies required');
  return new Proxy(provider, { get(target, property) {
    if (property === 'sendTransactionOnce') return async (signed, waitUntil, options) => {
      const e = journal.get('native-testnet-faucet-v1');
      const pending = ['transfer', 'cleanup'].filter(k => e?.[k]?.state === 'pending');
      if (waitUntil !== 'FINAL' || pending.length !== 1 || seen.has(pending[0])) throw new Error('unexpected or repeated faucet send');
      const stage = pending[0], details = checkFaucetSignedOriginal(signed, e, stage);
      seen.add(stage); // even a lost fence acknowledgement is not retried
      await fence(stage, details);
      return target.sendTransactionOnce(signed, waitUntil, options);
    };
    const v = Reflect.get(target, property, target);
    return typeof v === 'function' ? v.bind(target) : v;
  } });
}
