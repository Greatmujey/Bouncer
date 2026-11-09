/** Phone-friendly client for an explicitly configured same-origin testnet
 * mission backend. The static site has no backend by default. This client
 * never receives agent keys and never sends directly to a provider. */
import { isTestnetAccount } from './wallet-utils.mjs';
import { MARKET_SUMMARY_SHA256 } from '../shared/market-summary-constants.mjs';
import { missionSha256, signReviewedMissionChallenge } from './native-mission-auth.mjs';

const fail = () => new Error('NATIVE_MISSION_UNAVAILABLE');
const plain = x => x && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
const exact = (x, fields) => plain(x) && Object.keys(x).length === fields.length && fields.every(k => Object.hasOwn(x, k));
const amount = x => typeof x === 'string' && /^[1-9][0-9]{0,38}$/.test(x) && BigInt(x) <= (1n << 128n) - 1n;
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

export async function validatePublicNativeMissionReview(raw, { accountId, crypto } = {}) {
  const value = structuredClone(raw), mission = value?.mission;
  if (!exact(value, ['format','network','mission','mission_sha256']) || value.format !== 'bouncer-native-mission-review-v1' || value.network !== 'testnet' ||
      !/^[a-f0-9]{64}$/.test(value.mission_sha256 ?? '') || !plain(mission) || mission.version !== 1 || mission.owner_account_id !== accountId ||
      !isTestnetAccount(accountId) || !isTestnetAccount(mission.contract_id) || !/^[A-Za-z0-9_-]{1,64}$/.test(mission.id ?? '') ||
      !amount(mission.max_native_amount) || !Array.isArray(mission.required_resources) ||
      !['compute','storage','api'].every(r => mission.required_resources.includes(r)) || !Array.isArray(mission.goals) ||
      mission.goals.length < 3 || mission.goals.length > 10 ||
      !['storage','oracle'].every(k => mission.goals.some(item => item?.kind === k)) ||
      !['random','market'].some(k => mission.goals.some(item => item?.kind === k))) throw fail();
  let maximum = 0n; const ids = new Set(), kindsById = new Map();
  for (const item of mission.goals) {
    if (!exact(item, ['kind','goal']) || !['random','market','oracle','storage'].includes(item.kind) || !plain(item.goal) ||
        item.goal.contract_id !== mission.contract_id || item.goal.owner_account_id !== accountId || !amount(item.goal.amount) ||
        typeof item.goal.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(item.goal.id) || ids.has(item.goal.id)) throw fail();
    if (item.kind === 'market' && (!exact(item.goal.input, ['from_goal_id','quantity']) ||
        kindsById.get(item.goal.input.from_goal_id) !== 'oracle' || !Number.isSafeInteger(item.goal.input.quantity) ||
        item.goal.input.quantity < 1 || item.goal.input.quantity > 1000 ||
        item.goal.program?.sha256 !== MARKET_SUMMARY_SHA256 || item.goal.program?.build_target !== 'wasm32-wasip1')) throw fail();
    ids.add(item.goal.id); kindsById.set(item.goal.id, item.kind); maximum += BigInt(item.goal.amount);
  }
  if (maximum > BigInt(mission.max_native_amount) || await missionSha256(mission, crypto) !== value.mission_sha256) throw fail();
  return freeze(value);
}

export function createNativeMissionClient({ wallet, accountId, ownerPublicKey, location, crypto, fetch, isCurrent = () => true,
  allowLoopbackForTests = false } = {}) {
  if (!wallet || typeof wallet.signMessage !== 'function' || !isTestnetAccount(accountId) || typeof ownerPublicKey !== 'string' ||
      !crypto?.subtle || typeof fetch !== 'function' || typeof isCurrent !== 'function' || !location?.origin) throw fail();
  let origin; try { origin = new URL(location.origin); } catch { throw fail(); }
  if (origin.origin !== location.origin || origin.host !== location.host ||
      !(origin.protocol === 'https:' || (allowLoopbackForTests && origin.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(origin.hostname)))) throw fail();
  let reviewed = null, ready = false, started = false, nextGoal = null;
  const current = () => { if (!isCurrent()) throw fail(); };
  async function request(name, input) {
    current();
    const response = await fetch(`/api/native-mission/${name}`, { method: input === undefined ? 'GET' : 'POST', credentials: 'same-origin',
      cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(name === 'execute' ? 180_000 : name === 'recover' ? 120_000 : 30_000),
      headers: { 'x-bouncer-native-mission': 'v1', ...(input === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    current();
    if (!response.ok) throw fail();
    const text = await response.text(); if (text.length > 131_072) throw fail();
    let result; try { result = JSON.parse(text); } catch { throw fail(); }
    if (!plain(result)) throw fail(); return result;
  }
  async function checkReview(raw) { return validatePublicNativeMissionReview(raw, { accountId, crypto }); }
  async function getReview() {
    const config = await request('config');
    if (!exact(config, ['enabled','network','review']) || config.enabled !== true || config.network !== 'testnet') throw fail();
    return checkReview(config.review);
  }
  return Object.freeze({
    review: getReview,
    async preview() {
      if (started) throw fail();
      const review = await getReview();
      const response = await request('preview', { missionSha256: review.mission_sha256 });
      const returned = await checkReview(response.review);
      if (returned.mission_sha256 !== review.mission_sha256 || JSON.stringify(returned) !== JSON.stringify(review) || !plain(response.preview)) throw fail();
      const checkpoint = review.mission.goals.some(item => item.kind === 'market');
      nextGoal = checkpoint ? review.mission.goals.find(item => item.goal.id === response.preview.next_goal_id)?.goal ?? null : null;
      reviewed = review; ready = response.preview.status === 'READY' && (!checkpoint || nextGoal !== null);
      return { review, preview: structuredClone(response.preview) };
    },
    async approve(review) {
      current();
      if (started || !ready || !reviewed || JSON.stringify(review) !== JSON.stringify(reviewed) ||
          await missionSha256(reviewed.mission, crypto) !== reviewed.mission_sha256) throw fail();
      started = true; // an uncertain prompt or send never authorizes another attempt in this session
      const mission = reviewed.mission, reviewHash = reviewed.mission_sha256, checkpoint = mission.goals.some(item => item.kind === 'market');
      const context = { owner: accountId, ownerPublicKey, vault: mission.contract_id, missionId: mission.id,
        missionSha256: reviewHash, maxNativeYocto: mission.max_native_amount,
        ...(checkpoint ? { goalId: nextGoal.id, goalMaxNativeYocto: nextGoal.amount } : {}) };
      const selected = checkpoint ? { goalId: nextGoal.id } : {};
      const challenge = await request('challenge', { missionSha256: reviewHash, ownerPublicKey, ...selected });
      const evidence = await signReviewedMissionChallenge({ wallet, context, challenge, location, crypto, fetch, allowLoopbackForTests });
      current();
      const result = await request('execute', { missionSha256: reviewHash, ownerPublicKey, evidence, ...selected });
      // Only a definite checkpoint allows a new read-only preview. An unknown
      // response keeps started=true and can only be reconciled, never retried.
      if (checkpoint && result.status === 'CHECKPOINT') {
        const index = mission.goals.findIndex(item => item.goal.id === nextGoal.id);
        const remaining = mission.goals.slice(index + 1).map(item => item.goal.id);
        const completed = mission.goals.slice(0,index + 1).map(item => item.goal.id);
        if (result.new_payments !== 1 || !remaining.length || !Array.isArray(result.remaining_goal_ids) ||
            JSON.stringify(result.remaining_goal_ids) !== JSON.stringify(remaining) || !Array.isArray(result.deliveries) ||
            JSON.stringify(result.deliveries.map(item => item.goal_id)) !== JSON.stringify(completed) ||
            result.deliveries.some(item => typeof item.delivery?.tx_hash !== 'string' ||
              !/^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(item.delivery.tx_hash))) throw fail();
        started = false; ready = false; nextGoal = null;
      }
      return result;
    },
    async originals(review) {
      current();
      const verified = await checkReview(review);
      return request('originals', { missionSha256: verified.mission_sha256 });
    },
    async recover(review) {
      current();
      const verified = await checkReview(review);
      return request('recover', { missionSha256: verified.mission_sha256 });
    },
  });
}
