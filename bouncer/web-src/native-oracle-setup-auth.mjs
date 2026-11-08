/**
 * Browser NEP-413 authentication for exact, public native setup contexts.
 * This signs an off-chain challenge only, never a transaction. The backend
 * still needs a one-use challenge, current FullAccess-key check, separately
 * retained review, durable multi-system prompt fence and fresh stage preflight.
 * A successful signature is not owner transaction approval or spending consent.
 */
import { isTestnetAccount } from './wallet-utils.mjs';
import { verifyCliLogin } from './cli-login.mjs';

const FORMAT = 'bouncer-wallet-prompt-auth-v1';
const STAGES = ['create_keyless_native_vault', 'configure_native_oracle_policy', 'fund_native_vault', 'install_native_oracle_agent'];
const ATOMIC_STAGES = ['create_configure_fund_native_vault', 'install_native_oracle_agent'];
const COMPRESSED_STAGES = ['create_compressed_native_vault','configure_fund_native_oracle','install_native_oracle_agent'];
const PURPOSES = ['reserve_native_setup', 'claim_native_setup_stage', 'record_native_setup_original', 'inspect_native_setup',
  'verify_native_setup_completion', 'claim_native_oracle_trial'];
const HEX32 = /^[a-f0-9]{32}$/, HEX64 = /^[a-f0-9]{64}$/, BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const fail = () => new Error('NATIVE_SETUP_AUTHENTICATION_UNAVAILABLE');
const digestHex = bytes => [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join('');
function validHash(value) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) return false;
  let n = 0n;
  for (const char of value) { const digit = BASE58.indexOf(char); if (digit < 0) return false; n = n * 58n + BigInt(digit); }
  let bytes = 0; while (n) { n >>= 8n; bytes++; }
  let leading = 0; while (value[leading] === '1') leading++;
  return leading + bytes === 32;
}
function reviewStages(stages, field) {
  if (!Array.isArray(stages)) return null;
  const expected = stages.length === COMPRESSED_STAGES.length ? COMPRESSED_STAGES : stages.length === ATOMIC_STAGES.length ? ATOMIC_STAGES : STAGES;
  return stages.length === expected.length && stages.every((s, i) =>
    s?.[field] === expected[i] && HEX64.test(s.action_commitment_sha256 ?? '')) ? expected : null;
}
/** Fixed field order and stage list exactly match the server's action hash. */
export function nativeSetupAuthAction({ purpose, owner, ownerPublicKey, identity, review, stageId, originalHash,
  trial, expectedWitnessHead } = {}) {
  if (!PURPOSES.includes(purpose) || !isTestnetAccount(owner) || !owner.endsWith('.testnet') ||
      owner === 'bouncer-owner-12f343b795633e357ae5560d.testnet' || typeof ownerPublicKey !== 'string' ||
      !/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ownerPublicKey)) throw fail();
  const base = { format: FORMAT, network: 'testnet', purpose, owner, owner_public_key: ownerPublicKey };
  if (purpose === 'inspect_native_setup') return base;
  if (purpose === 'reserve_native_setup') {
    const stages = reviewStages(review?.stages, 'id');
    const validFormat = stages === STAGES ? review?.format === 'bouncer-native-oracle-wallet-review-v1' :
      stages === ATOMIC_STAGES ? review?.format === 'bouncer-atomic-native-oracle-wallet-review-v1' && review.owner_public_key === ownerPublicKey :
      stages === COMPRESSED_STAGES && review?.format === 'bouncer-research-compressed-native-oracle-wallet-review-v1' && review.owner_public_key === ownerPublicKey;
    if (!validFormat || review.owner !== owner || !HEX64.test(review.review_sha256 ?? '')) throw fail();
    return { ...base, review_sha256: review.review_sha256, stage_id: stages[0], action_commitment_sha256: review.stages[0].action_commitment_sha256 };
  }
  const stages = reviewStages(identity?.stages, 'stage_id');
  if (!identity || identity.owner !== owner || identity.owner_public_key !== ownerPublicKey || !HEX32.test(identity.operation_id ?? '') ||
      !HEX64.test(identity.review_sha256 ?? '') || !stages) throw fail();
  if (purpose === 'verify_native_setup_completion') return { ...base, operation_id: identity.operation_id, review_sha256: identity.review_sha256 };
  if (purpose === 'claim_native_oracle_trial') {
    const fields=['goal_id','goal_sha256','agent_public_key','original_hash'];
    if (!trial || ![Object.prototype,null].includes(Object.getPrototypeOf(trial)) || Reflect.ownKeys(trial).length!==fields.length ||
        fields.some(k=>!Object.hasOwn(Object.getOwnPropertyDescriptor(trial,k)??{},'value')) ||
        typeof trial.goal_id!=='string' || !/^[A-Za-z0-9_-]{1,64}$/.test(trial.goal_id) || !HEX64.test(trial.goal_sha256 ?? '') ||
        typeof trial.agent_public_key!=='string' || !trial.agent_public_key.startsWith('ed25519:') ||
        !validHash(trial.agent_public_key.slice(8)) || trial.agent_public_key===ownerPublicKey || !validHash(trial.original_hash) ||
        typeof expectedWitnessHead!=='string' || !/^[a-f0-9]{40}$/.test(expectedWitnessHead)) throw fail();
    return {...base,operation_id:identity.operation_id,review_sha256:identity.review_sha256,goal_id:trial.goal_id,
      goal_sha256:trial.goal_sha256,agent_public_key:trial.agent_public_key,original_hash:trial.original_hash,witness_head:expectedWitnessHead};
  }
  const index = stages.indexOf(stageId); if (index < 0) throw fail();
  const action = { ...base, operation_id: identity.operation_id, review_sha256: identity.review_sha256,
    stage_id: stageId, action_commitment_sha256: identity.stages[index].action_commitment_sha256 };
  if (purpose === 'record_native_setup_original') {
    if (!validHash(originalHash)) throw fail();
    action.original_hash = originalHash;
  }
  return action;
}
const labels = {
  reserve_native_setup: id => `Reserve native setup prompt: ${id}`,
  claim_native_setup_stage: id => `Claim one native setup prompt: ${id}`,
  record_native_setup_original: id => `Record native setup original: ${id}`,
  inspect_native_setup: () => 'Inspect retained native setup',
  verify_native_setup_completion: () => 'Verify native setup originals and state',
  claim_native_oracle_trial: () => 'Retain original native trial hash',
};

/** Verify the full challenge, nonce, origin and exact action before opening an
 * off-chain wallet message prompt. Verify the returned signature/key afterward. */
export async function signReviewedNativeSetupChallenge({ wallet, context, challenge, location, crypto, fetch, now = Date.now } = {}) {
  const action = nativeSetupAuthAction(context);
  if (!wallet || typeof wallet.signMessage !== 'function' || !crypto?.subtle || typeof fetch !== 'function' || typeof now !== 'function' ||
      !location || typeof location.origin !== 'string' || typeof location.host !== 'string' || !challenge ||
      !HEX32.test(challenge.challenge_id ?? '') || typeof challenge.message !== 'string' || typeof challenge.nonce_base64 !== 'string' ||
      !/^[A-Za-z0-9+/]{43}=$/.test(challenge.nonce_base64) || !Number.isSafeInteger(challenge.expires_at_ms)) throw fail();
  let url; try { url = new URL(location.origin); } catch { throw fail(); }
  if (url.protocol !== 'https:' || url.origin !== location.origin || url.host !== location.host || challenge.recipient !== url.host) throw fail();
  let nonce;
  try {
    const binary = atob(challenge.nonce_base64);
    if (btoa(binary) !== challenge.nonce_base64 || binary.length !== 32) throw fail();
    nonce = Uint8Array.from(binary, c => c.charCodeAt(0));
  } catch { throw fail(); }
  const digest = digestHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(action))));
  const expires = challenge.expires_at_ms, issued = expires - 120_000, clock = now();
  if (!Number.isSafeInteger(clock) || !Number.isSafeInteger(issued) || clock < issued - 30_000 || clock >= expires) throw fail();
  const message = `Bouncer testnet owner authentication\n${labels[action.purpose](action.stage_id)}\nAccount: ${action.owner}\n` +
    `Public key: ${action.owner_public_key}\nAction SHA-256: ${digest}\nSite: ${url.origin}\n` +
    `Issued: ${new Date(issued).toISOString()}\nExpires: ${new Date(expires).toISOString()}\n` +
    'This message is not a transaction and does not itself approve spending.';
  if (challenge.message !== message) throw fail();
  const mobileAccount = wallet.manifest?.id === 'near-mobile' ? { accountId: action.owner } : {};
  const signed = await wallet.signMessage({ network: 'testnet', signerId: action.owner, ...mobileAccount,
    message, nonce: new Uint8Array(nonce), recipient: url.host });
  if (now() >= expires || signed?.accountId !== action.owner || signed.publicKey !== action.owner_public_key) throw fail();
  await verifyCliLogin({ account: { accountId: action.owner, publicKey: action.owner_public_key, signedMessage: signed },
    message, nonce, recipient: url.host, crypto, fetch });
  if (now() >= expires) throw fail();
  return { challenge_id: challenge.challenge_id, accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature };
}
