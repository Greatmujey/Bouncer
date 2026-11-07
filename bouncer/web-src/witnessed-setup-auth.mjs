/** Browser-only NEP-413 authentication for a reviewed testnet setup action.
 * This only signs an off-chain challenge. It never asks for a wallet
 * transaction, enables agent spending, opens a seller order or transfers funds.
 * The server must independently verify the signature, on-chain FullAccess key,
 * retained review and one-use challenge. */
import { isTestnetAccount } from './wallet-utils.mjs';
import { verifyCliLogin } from './cli-login.mjs';

const FORMAT = 'bouncer-wallet-prompt-auth-v1';
const STAGES = ['create_keyless_vault', 'register_vault_circle', 'fund_vault_circle'];
const HEX32 = /^[a-f0-9]{32}$/, HEX64 = /^[a-f0-9]{64}$/, TX = /^[1-9A-HJ-NP-Za-km-z]{32,50}$/;
const fail = () => new Error('SETUP_AUTHENTICATION_UNAVAILABLE');
const digestHex = bytes => [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join('');
const labels = { reserve: id => `Reserve setup prompt: ${id}`,
  claim_prompt: id => `Claim one setup prompt: ${id}`, claim_setup_stage: id => `Claim one setup prompt: ${id}`,
  record_original_hash: () => 'Record the original transaction hash', record_setup_stage_original: () => 'Record the original transaction hash',
  reconcile_setup_original: id => `Reconcile original: ${id}`, reconcile_setup_stage: id => `Reconcile original: ${id}`,
  verify_setup_funded: () => 'Verify funded vault state', inspect: () => 'Inspect the retained prompt' };

/** Constructs exactly the action fields expected by the backend; no arbitrary
 * message text, receiver, amount or other action can be supplied here. */
export function setupAuthAction({ purpose, owner, ownerPublicKey, identity, review, stageId, originalHash } = {}) {
  if (!Object.hasOwn(labels, purpose) || !isTestnetAccount(owner) || typeof ownerPublicKey !== 'string' ||
      !/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ownerPublicKey)) throw fail();
  const base = { format: FORMAT, network: 'testnet', purpose, owner, owner_public_key: ownerPublicKey };
  if (purpose === 'inspect') return base;
  if (purpose === 'reserve') {
    if (review?.owner !== owner || !HEX64.test(review.review_sha256 ?? '') || review.stages?.[0]?.id !== STAGES[0] ||
        !HEX64.test(review.stages[0].action_commitment_sha256 ?? '')) throw fail();
    return { ...base, review_sha256: review.review_sha256, stage_id: STAGES[0],
      action_commitment_sha256: review.stages[0].action_commitment_sha256 };
  }
  if (!identity || identity.owner !== owner || identity.owner_public_key !== ownerPublicKey || !HEX32.test(identity.operation_id ?? '') ||
      !HEX64.test(identity.review_sha256 ?? '') || !Array.isArray(identity.stages) || identity.stages.length !== 3 ||
      identity.stages.some((s, i) => s?.stage_id !== STAGES[i] || !HEX64.test(s.action_commitment_sha256 ?? ''))) throw fail();
  if (purpose === 'verify_setup_funded') return { ...base, operation_id: identity.operation_id, review_sha256: identity.review_sha256 };
  const i = STAGES.indexOf(stageId);
  if (i < 0 || (['claim_prompt','record_original_hash','reconcile_setup_original'].includes(purpose) ? i !== 0 : i === 0)) throw fail();
  if (purpose === 'record_original_hash') {
    if (!TX.test(originalHash ?? '')) throw fail();
    return { ...base, operation_id: identity.operation_id, original_hash: originalHash };
  }
  const action = { ...base, operation_id: identity.operation_id, review_sha256: identity.review_sha256,
    stage_id: stageId, action_commitment_sha256: identity.stages[i].action_commitment_sha256 };
  if (['record_setup_stage_original','reconcile_setup_original','reconcile_setup_stage'].includes(purpose)) {
    if (!TX.test(originalHash ?? '')) throw fail();
    action.original_hash = originalHash;
  }
  return action;
}

/** The expected action is generated locally from the reviewed data. Check the
 * full server message, site, digest, nonce and lifetime before opening a wallet
 * message prompt; verify the wallet's returned signature and key afterwards. */
export async function signReviewedSetupChallenge({ wallet, context, challenge, location, crypto, fetch, now = Date.now } = {}) {
  const action = setupAuthAction(context);
  if (!wallet || typeof wallet.signMessage !== 'function' || !crypto?.subtle || typeof fetch !== 'function' || typeof now !== 'function' ||
      !location || typeof location.origin !== 'string' || typeof location.host !== 'string' || !challenge ||
      !HEX32.test(challenge.challenge_id ?? '') || typeof challenge.message !== 'string' ||
      typeof challenge.nonce_base64 !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(challenge.nonce_base64) ||
      !Number.isSafeInteger(challenge.expires_at_ms)) throw fail();
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
