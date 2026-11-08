/**
 * Submit the phone's ONE already-witnessed, already-signed native trial.
 * No owner private key or signed transaction is uploaded to Bouncer's setup
 * service. The original is retained by the independent witness and locally
 * before signing; a separate local submission claim is committed before the
 * single testnet RPC fetch. No application-level resend occurs on any result.
 *
 * This is deliberately limited to the pinned oracle call. It requires a fresh
 * authenticated setup snapshot, the same key/nonce/witness and exact reviewed
 * transaction bytes. The setup service, independent anchor, wallet, same-origin
 * scripts, browser storage and testnet RPC remain trust boundaries. Local
 * storage does not protect against rollback, another device or bypassing code.
 * An RPC acknowledgement is NOT proof of delivery; verify the original receipts.
 */
import { assertNativeOracleCompletion } from './native-oracle-completion.mjs';
import { verifyNativeOracleSetupReview } from './native-oracle-setup-wallet-prompt.mjs';
import { buildNativeOracleTrialBytes, decodeNativeHash32, encodeBase58 } from './native-oracle-transaction.mjs';
import { retainLocalNativeSubmission } from './native-oracle-local-submission.mjs';

const RPC = 'https://rpc.testnet.near.org';
const RPC_ID = 'bouncer-native-oracle-trial';
const fail = () => new Error('native trial submission unavailable or uncertain; stop and reconcile the original, never resend');
const equalBytes = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
const base64 = bytes => {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
};
async function responseJson(response) {
  const length = response.headers?.get?.('content-length');
  if (length != null && (!/^\d+$/.test(length) || Number(length) > 1_000_000)) throw fail();
  if (!response.body?.getReader) throw fail();
  const reader = response.body.getReader(), parts = []; let count = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      count += value.length;
      if (count > 1_000_000) { await reader.cancel(); throw fail(); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(count); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

/** Check browser reachability, CORS and chain identity BEFORE claiming or
 * signing the original. This read never includes a signed transaction. */
export async function probeNativeTestnetRpc({fetch:fetchImpl=globalThis.fetch,isCurrent,timeoutMs=10_000}={}) {
  if(typeof fetchImpl!=='function' || typeof isCurrent!=='function' || isCurrent()!==true ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs<100 || timeoutMs>30_000)throw fail();
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),timeoutMs);timer.unref?.();
  try {
    const id='bouncer-native-testnet-status';
    const response=await fetchImpl(RPC,{method:'POST',mode:'cors',credentials:'omit',redirect:'error',
      referrerPolicy:'no-referrer',cache:'no-store',signal:controller.signal,
      headers:{'content-type':'application/json',accept:'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id,method:'status',params:[]})});
    const body=await responseJson(response);
    if(isCurrent()!==true || !response.ok || body?.jsonrpc!=='2.0' || body.id!==id || body.error || body.result?.chain_id!=='testnet')throw fail();
    return true;
  } catch { throw fail(); } finally { clearTimeout(timer); }
}

/**
 * The caller has already captured consent for the exact displayed terms and
 * invoked prepareWitnessedNativeOracleTrial.sign() exactly once. This function
 * also needs a newly authenticated completion; neither a boolean nor this
 * function establishes human consent. Throws BEFORE the fetch on any mismatch.
 * After the fetch starts, returns an unknown/acknowledged status only and never
 * interprets the response as fulfillment.
 */
export async function submitWitnessedNativeOracleTrialOnce({ signedResult: rawSigned, review: rawReview, identity: rawIdentity,
  completion: rawCompletion, deviceStore, indexedDB, origin, isTopLevel, crypto, isCurrent,
  fetch: fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 100_000 } = {}) {
  if (!rawSigned || !(rawSigned.signed_transaction instanceof Uint8Array) ||
      rawSigned.signed_transaction.length < 66 || rawSigned.signed_transaction.length > 16_384 ||
      !deviceStore || typeof deviceStore.inspect !== 'function' || typeof deviceStore.inspectNativeOracleOriginal !== 'function' ||
      !indexedDB || typeof origin !== 'string' || isTopLevel !== true || !crypto?.subtle ||
      typeof isCurrent !== 'function' || typeof fetchImpl !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw fail();
  const current = () => { if (isCurrent() !== true) throw fail(); };
  const bytes = Uint8Array.from(rawSigned.signed_transaction);
  const signed = { ...rawSigned, signed_transaction: bytes, setup_original_hashes: structuredClone(rawSigned.setup_original_hashes) };
  const review = structuredClone(rawReview), identity = structuredClone(rawIdentity), completion = structuredClone(rawCompletion);
  let started = false;
  try {
    current();
    if (signed.status !== 'SIGNED_NOT_BROADCAST' || signed.owner !== review?.owner || signed.vault !== review?.vault ||
        signed.review_sha256 !== review?.review_sha256 || signed.maximum_native_yocto !== review?.per_tx_cap_yocto ||
        signed.attached_deposit_yocto !== '0' || signed.witnessed_original_matched !== true ||
        signed.local_original_retained !== true || signed.do_not_retry !== true || signed.broadcast_authorized !== false ||
        signed.transaction_sent !== false || !/^[a-f0-9]{40}$/.test(signed.witness_head ?? '') ||
        !Array.isArray(signed.setup_original_hashes) || signed.setup_original_hashes.length !== 4) throw fail();
    const device = await deviceStore.inspect({ owner: review.owner, vault: review.vault, expected_public_key: review.agent_public_key }); current();
    const canonical = await verifyNativeOracleSetupReview({ review, identity, deviceKey: device, origin, crypto }); current();
    assertNativeOracleCompletion(completion, review, now());
    if (completion.witness_head !== signed.witness_head ||
        JSON.stringify(completion.prior_original_hashes) !== JSON.stringify(signed.setup_original_hashes)) throw fail();
    const local = await deviceStore.inspectNativeOracleOriginal({ reviewSha256: review.review_sha256 }); current();
    const record = local?.record;
    if (local?.status !== 'LOCAL_ORIGINAL_RETAINED' || local.do_not_retry !== true || !record ||
        record.owner !== canonical.owner || record.vault !== canonical.vault || record.agent_public_key !== canonical.agent_public_key ||
        record.review_sha256 !== review.review_sha256 || record.operation_id !== identity.operation_id || record.tx_hash !== signed.tx_hash ||
        record.nonce !== (BigInt(completion.agent_key_nonce) + 1n).toString()) throw fail();
    const built = buildNativeOracleTrialBytes(canonical, { block_hash: record.block_hash, agent_key_nonce: completion.agent_key_nonce });
    const unsigned = bytes.slice(0, -65), signature = bytes.slice(-64);
    if (bytes[bytes.length - 65] !== 0 || built.nonce !== record.nonce || !equalBytes(unsigned, built.unsigned)) throw fail();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', unsigned)); current();
    if (encodeBase58(digest) !== signed.tx_hash) throw fail();
    const publicKey = await crypto.subtle.importKey('raw', decodeNativeHash32(canonical.agent_public_key.slice(8)),
      { name: 'Ed25519' }, false, ['verify']); current();
    if (!await crypto.subtle.verify('Ed25519', publicKey, signature, digest)) throw fail();
    current(); assertNativeOracleCompletion(completion, review, now());
    await retainLocalNativeSubmission(indexedDB, { review_sha256: review.review_sha256,
      operation_id: identity.operation_id, owner: canonical.owner, original_hash: signed.tx_hash });
    current(); assertNativeOracleCompletion(completion, review, now());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
    try {
      // Mark the attempt before invoking fetch. No redirects or retries; a
      // dropped response is not evidence that the original did not execute.
      started = true;
      const response = await fetchImpl(RPC, { method: 'POST', mode: 'cors', credentials: 'omit', redirect: 'error',
        referrerPolicy: 'no-referrer', cache: 'no-store', signal: controller.signal,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: RPC_ID, method: 'send_tx',
          params: { signed_tx_base64: base64(bytes), wait_until: 'FINAL' } }) });
      const body = await responseJson(response);
      const acknowledged = response.ok && body?.jsonrpc === '2.0' && body.id === RPC_ID && !body.error &&
        body.result?.transaction?.hash === signed.tx_hash && body.result?.transaction_outcome?.id === signed.tx_hash;
      return { status: acknowledged ? 'ORIGINAL_RPC_ACKNOWLEDGED' : 'ORIGINAL_SUBMISSION_UNKNOWN',
        original_hash: signed.tx_hash, do_not_retry: true, provider_delivery_verified: false };
    } catch {
      return { status: 'ORIGINAL_SUBMISSION_UNKNOWN', original_hash: signed.tx_hash,
        do_not_retry: true, provider_delivery_verified: false };
    } finally { clearTimeout(timer); }
  } finally {
    // Copies of a signed transaction are bearer material. Never log or persist
    // them. The caller is responsible for clearing its own original array.
    bytes.fill(0);
    if (started) rawSigned.signed_transaction.fill(0);
  }
}
