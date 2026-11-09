/** Browser/server shared action for one explicit, reviewed testnet mission.
 * The wallet signs an off-chain spending authorization, NOT a transaction. The
 * separately installed restricted agent keys can then submit the reviewed
 * non-atomic Bouncer calls. No wallet seed or private key enters the website. */
import { isTestnetAccount } from './wallet-utils.mjs';
import { verifyCliLogin } from './cli-login.mjs';

const fail = () => new Error('NATIVE_MISSION_AUTH_UNAVAILABLE');
const keyPattern = /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const digestHex = bytes => [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join('');
export function nativeMissionAction({ owner, ownerPublicKey, vault, missionId, missionSha256, maxNativeYocto, goalId, goalMaxNativeYocto } = {}) {
  if (!isTestnetAccount(owner) || !owner.endsWith('.testnet') || owner === 'bouncer-owner-12f343b795633e357ae5560d.testnet' ||
      !isTestnetAccount(vault) || !keyPattern.test(ownerPublicKey ?? '') || !/^[A-Za-z0-9_-]{1,64}$/.test(missionId ?? '') ||
      !/^[a-f0-9]{64}$/.test(missionSha256 ?? '') || typeof maxNativeYocto !== 'string' ||
      !/^[1-9][0-9]{0,38}$/.test(maxNativeYocto) || BigInt(maxNativeYocto) > (1n << 128n) - 1n) throw fail();
  const leg = goalId !== undefined || goalMaxNativeYocto !== undefined;
  if (leg && (typeof goalId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(goalId) ||
      typeof goalMaxNativeYocto !== 'string' || !/^[1-9][0-9]{0,38}$/.test(goalMaxNativeYocto) ||
      BigInt(goalMaxNativeYocto) > BigInt(maxNativeYocto))) throw fail();
  return Object.freeze({ format: 'bouncer-wallet-prompt-auth-v1', network: 'testnet',
    purpose: leg ? 'authorize_native_mission_leg' : 'authorize_native_mission',
    owner, owner_public_key: ownerPublicKey, vault, mission_id: missionId, mission_sha256: missionSha256,
    max_native_yocto: maxNativeYocto, ...(leg ? { goal_id: goalId, goal_max_native_yocto: goalMaxNativeYocto } : {}) });
}
export function nativeMissionApprovalMessage(action, digest, origin, issued, expires) {
  const leg = action.purpose === 'authorize_native_mission_leg';
  return `Bouncer TESTNET ${leg ? 'mission step' : 'mission'} approval\nAccount: ${action.owner}\nPublic key: ${action.owner_public_key}\n` +
    `Vault: ${action.vault}\nMission: ${action.mission_id}\nMission SHA-256: ${action.mission_sha256}\n` +
    (leg ? `Step: ${action.goal_id}\nStep maximum: ${action.goal_max_native_yocto} yoctoNEAR plus gas\n` : '') +
    `Maximum: ${action.max_native_yocto} yoctoNEAR plus gas\nAction SHA-256: ${digest}\nSite: ${origin}\n` +
    `Issued: ${new Date(issued).toISOString()}\nExpires: ${new Date(expires).toISOString()}\n` +
    (leg ? 'I approve only this one Bouncer testnet mission step. ' : 'I approve this one Bouncer testnet mission. ') +
    'Steps are non-atomic; storage is public; uncertain transactions must not be resent.';
}
export async function missionSha256(mission, crypto) {
  if (!crypto?.subtle || !mission || typeof mission !== 'object') throw fail();
  return digestHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(mission))));
}
/** Verify the exact action, site, expiry and wallet signature before submitting
 * the single-use approval. Owner consent is explicit in the signed message. */
export async function signReviewedMissionChallenge({ wallet, context, challenge, location, crypto, fetch, now = Date.now,
  allowLoopbackForTests = false } = {}) {
  const action = nativeMissionAction(context);
  if (!wallet || typeof wallet.signMessage !== 'function' || !crypto?.subtle || typeof fetch !== 'function' || typeof now !== 'function' ||
      !location || typeof location.origin !== 'string' || typeof location.host !== 'string' ||
      !/^[a-f0-9]{32}$/.test(challenge?.challenge_id ?? '') || typeof challenge.message !== 'string' ||
      !/^[A-Za-z0-9+/]{43}=$/.test(challenge.nonce_base64 ?? '') || !Number.isSafeInteger(challenge.expires_at_ms)) throw fail();
  let site;
  try { site = new URL(location.origin); } catch { throw fail(); }
  if (site.origin !== location.origin || site.host !== location.host || challenge.recipient !== site.host ||
      !(site.protocol === 'https:' || (allowLoopbackForTests && site.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(site.hostname)))) throw fail();
  let nonce;
  try {
    const binary = atob(challenge.nonce_base64);
    if (binary.length !== 32 || btoa(binary) !== challenge.nonce_base64) throw fail();
    nonce = Uint8Array.from(binary, c => c.charCodeAt(0));
  } catch { throw fail(); }
  const digest = digestHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(action))));
  const expires = challenge.expires_at_ms, issued = expires - 120_000, clock = now();
  if (!Number.isSafeInteger(clock) || clock < issued - 30_000 || clock >= expires ||
      challenge.message !== nativeMissionApprovalMessage(action, digest, site.origin, issued, expires)) throw fail();
  const mobile = wallet.manifest?.id === 'near-mobile' ? { accountId: action.owner } : {};
  const signed = await wallet.signMessage({ network: 'testnet', signerId: action.owner, ...mobile,
    message: challenge.message, nonce: new Uint8Array(nonce), recipient: site.host });
  if (now() >= expires || signed?.accountId !== action.owner || signed.publicKey !== action.owner_public_key) throw fail();
  await verifyCliLogin({ account: { accountId: action.owner, publicKey: action.owner_public_key, signedMessage: signed },
    message: challenge.message, nonce, recipient: site.host, crypto, fetch });
  if (now() >= expires) throw fail();
  return { challenge_id: challenge.challenge_id, accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature };
}
