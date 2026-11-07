/**
 * Opt-in testnet wallet/setup client. Each wallet transaction is requested
 * only from an explicit caller action, after owner authentication, original
 * recovery, fresh backend preflight and an independently witnessed claim.
 * The backend still cannot sign or broadcast, and this does not purchase or
 * deliver anything. If a claimed prompt or wallet outcome is uncertain,
 * inspect/reconcile its original; never open the prompt again automatically.
 */
import { signReviewedSetupChallenge } from './witnessed-setup-auth.mjs';
import { prepareBufferSetupWalletPrompt } from './buffer-setup-wallet-prompt.mjs';
import { withReadOnlyRelay } from './buffer-readiness-preview.mjs';

const OWNER = 'great_mujey.testnet', HEADERS = { 'x-bouncer-preview':'witnessed-setup-v1' };
const fail = code => { const e = new Error(code); e.code = code; return e; };
const STAGES = ['create_keyless_vault','register_vault_circle','fund_vault_circle'];
const safeCodes = new Set(['UNAUTHENTICATED','OWNER_ALREADY_WITNESSED','OWNER_FENCED','ALREADY_CLAIMED',
  'WITNESS_NOT_CLAIMABLE','WITNESS_COMMIT_UNKNOWN','WITNESS_MISMATCH','SETUP_UNAVAILABLE','SETUP_PREFLIGHT_BLOCKED',
  'SETUP_PREFLIGHT_UNAVAILABLE','SETUP_PREFLIGHT_STALE','CLAIM_COMMITTED_PREFLIGHT_STALE','WITNESSED_CLAIM_STALE',
  'PRIOR_STAGE_UNRESOLVED','RECEIPT_UNAVAILABLE','RECEIPT_UNKNOWN','MISMATCH','DATABASE_UNKNOWN']);

export function createWitnessedSetupClient({ wallet, accountId, ownerPublicKey, location, crypto, fetch: fetchImpl = globalThis.fetch,
  isCurrent, now = Date.now, onProgress = () => {} } = {}) {
  if (accountId !== OWNER || !wallet || typeof wallet.signMessage !== 'function' ||
      typeof ownerPublicKey !== 'string' || !location || !crypto?.subtle || typeof fetchImpl !== 'function' ||
      typeof isCurrent !== 'function' || typeof now !== 'function' || typeof onProgress !== 'function') throw fail('SETUP_UNAVAILABLE');
  const session = () => { if (isCurrent() !== true) throw fail('SETUP_SESSION_CHANGED'); };
  async function request(route, data) {
    session(); let response, text, body;
    try {
      response = await fetchImpl(`/api/wallet-setup/${route}`, { method:'POST', credentials:'same-origin', cache:'no-store',
        headers:{ ...HEADERS, 'content-type':'application/json' }, body:JSON.stringify(data) });
      text = await response.text(); if (text.length > 64_000) throw Error(); body = JSON.parse(text);
    } catch { throw fail('SETUP_RESULT_UNKNOWN'); }
    if (!response.ok) throw fail(safeCodes.has(body?.error) ? body.error : 'SETUP_RESULT_UNKNOWN');
    return body;
  }
  const pump = work => withReadOnlyRelay({ fetch:fetchImpl, work, onProgress, now });
  const sign = (context, challenge) => { session(); return signReviewedSetupChallenge({ wallet, context, challenge,
    location, crypto, fetch:fetchImpl, now }); };
  const context = purpose => ({ purpose, owner:OWNER, ownerPublicKey });
  async function artifact() {
    session(); let response;
    try { response = await fetchImpl('/api/wallet-setup/artifact', { headers:HEADERS, credentials:'same-origin', cache:'no-store' }); }
    catch { throw fail('SETUP_UNAVAILABLE'); }
    if (!response.ok || !response.body?.getReader) throw fail('SETUP_UNAVAILABLE');
    const reader = response.body.getReader(), parts = []; let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        length += value.length; if (length > 536651) { await reader.cancel(); throw fail('SETUP_UNAVAILABLE'); }
        parts.push(value);
      }
    } finally { reader.releaseLock(); }
    if (length !== 536651) throw fail('SETUP_UNAVAILABLE');
    const out = new Uint8Array(length); let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
  }
  return Object.freeze({
    async enabled() {
      session();
      try {
        const response = await fetchImpl('/api/wallet-setup/config', { headers:HEADERS, credentials:'same-origin', cache:'no-store' });
        const config = await response.json();
        return response.ok && config?.enabled === true && config.network === 'testnet' && config.owner === OWNER;
      } catch { return false; }
    },
    async reserve({ taskId, review } = {}) {
      session(); if (review?.owner !== OWNER || !/^[a-f0-9]{32}$/.test(taskId ?? '')) throw fail('SETUP_UNAVAILABLE');
      const challenge = await request('reserve-challenge', { taskId, ownerPublicKey });
      const evidence = await sign({ ...context('reserve'), review }, challenge);
      return pump(() => request('reserve', { taskId, ownerPublicKey, evidence }));
    },
    /** This function invokes the actual wallet. Call it ONLY in direct response
     * to the owner's explicit review/approval of this individual testnet stage. */
    async approveStage({ identity, review, stageId } = {}) {
      session(); if (!STAGES.includes(stageId) || identity?.owner_public_key !== ownerPublicKey) throw fail('SETUP_UNAVAILABLE');
      onProgress(stageId === STAGES[0] ? 'Verifying the reviewed vault code…' : 'Preparing the reviewed testnet action…');
      const wasmBytes = stageId === STAGES[0] ? await artifact() : undefined;
      const prompt = await prepareBufferSetupWalletPrompt({ wallet, identity, review, stageId, wasmBytes, crypto, now });
      session();
      const challenge = await request('claim-challenge', { identity, stageId });
      const purpose = stageId === STAGES[0] ? 'claim_prompt' : 'claim_setup_stage';
      const evidence = await sign({ ...context(purpose), identity, stageId }, challenge);
      const claim = await pump(() => request('claim', { identity, stageId, evidence }));
      session();
      // Nothing asynchronous is done between receiving the witnessed claim and
      // invoking the prepared prompt except the prompt's own freshness check.
      return prompt.invoke(claim);
    },
    async recordOriginal({ identity, stageId, originalHash } = {}) {
      session();
      const challenge = await request('original-challenge', { identity, stageId, originalHash });
      const purpose = stageId === STAGES[0] ? 'record_original_hash' : 'record_setup_stage_original';
      const evidence = await sign({ ...context(purpose), identity, stageId, originalHash }, challenge);
      return pump(() => request('original', { identity, stageId, originalHash, evidence }));
    },
    async inspect() {
      session(); const challenge = await request('inspect-challenge', { ownerPublicKey });
      const evidence = await sign(context('inspect'), challenge);
      return pump(() => request('inspect', { ownerPublicKey, evidence }));
    },
    async previewOriginal({ stageId, originalHash } = {}) {
      session();
      const challenge = await request('inspect-challenge', { ownerPublicKey });
      const evidence = await sign(context('inspect'), challenge);
      return pump(() => request('preview-original', { ownerPublicKey, stageId, originalHash, evidence }));
    },
    async reconcile({ identity, stageId, originalHash } = {}) {
      session(); const challenge = await request('reconcile-challenge', { identity, stageId, originalHash });
      const purpose = stageId === STAGES[0] ? 'reconcile_setup_original' : 'reconcile_setup_stage';
      const evidence = await sign({ ...context(purpose), identity, stageId, originalHash }, challenge);
      return pump(() => request('reconcile', { identity, stageId, originalHash, evidence }));
    },
    async verifyFunded({ identity } = {}) {
      session(); const challenge = await request('funded-challenge', { identity });
      const evidence = await sign({ ...context('verify_setup_funded'), identity }, challenge);
      return pump(() => request('funded', { identity, evidence }));
    },
  });
}
