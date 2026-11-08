/**
 * Experimental independent public witness for ONE named testnet owner's
 * four-stage or reviewed two-stage atomic native-oracle setup and ONE subsequent native trial. This records
 * only public hashes, account IDs and public keys, never private keys,
 * signatures, wallet requests, seller credentials or signed transactions.
 *
 * Every append uses a compare-and-swap against one remote Git branch. A
 * database restore without the witnessed claim cannot reopen that prompt. A
 * missing or ambiguous witness always blocks progress. GitHub administrators,
 * branch force-pushes, compromised credentials, a simultaneous rollback of
 * all copies, or a newly provisioned witness with no prior anchor are NOT
 * protected. The witness does not prove that a wallet was invoked or that a
 * transaction succeeded; the separately retained original and FINAL receipt
 * verification are still required. An original-hash entry is NOT receipt verification: a separately authenticated
 * coordinator must require a fresh full stage preflight before every claim.
 * This module never signs/sends a NEAR tx or invokes a wallet.
 */
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { V3_OWNER } from './v3-faucet-github-fence.mjs';
import { WalletWitnessError } from './git-wallet-prompt-witness.mjs';

const ZERO = '0'.repeat(64), HEX32 = /^[a-f0-9]{32}$/, HEX64 = /^[a-f0-9]{64}$/;
const STAGES = Object.freeze(['create_keyless_native_vault', 'configure_native_oracle_policy', 'fund_native_vault', 'install_native_oracle_agent']);
const ATOMIC_STAGES = Object.freeze(['create_configure_fund_native_vault', 'install_native_oracle_agent']);
const COMPRESSED_STAGES = Object.freeze(['create_compressed_native_vault','configure_fund_native_oracle','install_native_oracle_agent']);
const FORMAT = 'bouncer-native-oracle-prompt-witness-v1';
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
const exact = (x, fields) => obj(x) && Object.keys(x).length === fields.length && fields.every(k => Object.hasOwn(x, k));

const blocked = (code = 'WITNESS_UNAVAILABLE') => new WalletWitnessError(code,
  'independent native wallet prompt witness is unavailable, conflicting or uncertain; stop and reconcile, never repeat a prompt');
function ownerKey(value) {
  try { const k = nearApi.utils.PublicKey.from(value); return typeof value === 'string' && String(k) === value && k.keyType === 0 && k.ed25519Key?.data?.length === 32; }
  catch { return false; }
}
function identity(input) {
  const expectedStages = input?.stages?.length === COMPRESSED_STAGES.length ? COMPRESSED_STAGES :
    input?.stages?.length === ATOMIC_STAGES.length ? ATOMIC_STAGES : STAGES;
  if (!exact(input, ['owner', 'owner_public_key', 'operation_id', 'review_sha256', 'stages']) ||
      !isTestnetAccount(input.owner) || input.owner === V3_OWNER || !input.owner.endsWith('.testnet') || !ownerKey(input.owner_public_key) || !HEX32.test(input.operation_id ?? '') ||
      !HEX64.test(input.review_sha256 ?? '') || !Array.isArray(input.stages) || input.stages.length !== expectedStages.length ||
      input.stages.some((stage, i) => !exact(stage, ['stage_id', 'action_commitment_sha256']) ||
        stage.stage_id !== expectedStages[i] || !HEX64.test(stage.action_commitment_sha256 ?? ''))) throw blocked('WITNESS_INVALID');
  return { owner: input.owner, owner_public_key: input.owner_public_key, operation_id: input.operation_id,
    review_sha256: input.review_sha256, stages: input.stages.map(s => ({ stage_id: s.stage_id,
      action_commitment_sha256: s.action_commitment_sha256 })) };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function firstRecord(id) {
  return { format: FORMAT, version: 1, sequence: 1, event: 'reserve', ...identity(id), previous_sha256: ZERO };
}
function nextRecord(state, event, stageIndex, originalHash) {
  const stage = state.identity.stages[stageIndex];
  const record = { version: 1, sequence: state.records.length + 1, event, owner: state.identity.owner,
    operation_id: state.identity.operation_id, review_sha256: state.identity.review_sha256,
    stage_id: stage.stage_id, action_commitment_sha256: stage.action_commitment_sha256,
    ...(event === 'original' ? { original_hash: originalHash } : {}), previous_sha256: state.last_hash };
  return record;
}
function trialValues(value, id) {
  if (!exact(value, ['goal_id','goal_sha256','agent_public_key','original_hash']) ||
      typeof value.goal_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.goal_id) ||
      !HEX64.test(value.goal_sha256 ?? '') || !ownerKey(value.agent_public_key) ||
      value.agent_public_key === id.owner_public_key || !isTransactionHash(value.original_hash)) throw blocked('WITNESS_INVALID');
  return { goal_id:value.goal_id, goal_sha256:value.goal_sha256,
    agent_public_key:value.agent_public_key, original_hash:value.original_hash };
}
function trialRecord(state, raw) {
  const trial = trialValues(raw, state.identity);
  return { version:1, sequence:state.records.length+1, event:'trial_claim', owner:state.identity.owner,
    operation_id:state.identity.operation_id, review_sha256:state.identity.review_sha256,
    ...trial, previous_sha256:state.last_hash };
}
function step(state, record) {
  if (!state) {
    if (!exact(record, ['format','version','sequence','event','owner','owner_public_key','operation_id','review_sha256','stages','previous_sha256']) ||
        record.format !== FORMAT || record.version !== 1 || record.sequence !== 1 || record.event !== 'reserve' || record.previous_sha256 !== ZERO) throw blocked('WITNESS_INVALID');
    const id = identity({ owner: record.owner, owner_public_key: record.owner_public_key, operation_id: record.operation_id,
      review_sha256: record.review_sha256, stages: record.stages });
    if (!same(record, firstRecord(id))) throw blocked('WITNESS_INVALID');
    return { identity: id, records: [record], last_hash: sha(JSON.stringify(record)), stage_index: 0, phase: 'reserved' };
  }
  if (state.phase === 'complete') {
    if (!obj(record)) throw blocked('WITNESS_INVALID');
    const trial=trialValues({goal_id:record.goal_id,goal_sha256:record.goal_sha256,
      agent_public_key:record.agent_public_key,original_hash:record.original_hash},state.identity);
    if (record.event !== 'trial_claim' || state.records.some(r => r.original_hash === trial.original_hash) ||
        !same(record,trialRecord(state,trial))) throw blocked('WITNESS_INVALID');
    return {identity:state.identity,records:[...state.records,record],last_hash:sha(JSON.stringify(record)),
      stage_index:state.stage_index,phase:'trial_claimed',trial};
  }
  const expectEvent = state.phase === 'reserved' || state.phase === 'original' ? 'claim' : state.phase === 'claimed' ? 'original' : null;
  const index = state.phase === 'original' ? state.stage_index + 1 : state.stage_index;
  if (!expectEvent || index >= state.identity.stages.length || record.event !== expectEvent ||
      (expectEvent === 'original' && (!isTransactionHash(record.original_hash) || state.records.some(r => r.original_hash === record.original_hash)))) throw blocked('WITNESS_INVALID');
  const expected = nextRecord(state, expectEvent, index, record.original_hash);
  if (!same(record, expected)) throw blocked('WITNESS_INVALID');
  return { identity: state.identity, records: [...state.records, record], last_hash: sha(JSON.stringify(record)),
    stage_index: index, phase: expectEvent === 'claim' ? 'claimed' : index === state.identity.stages.length - 1 ? 'complete' : 'original' };
}

/** Strict, hash-linked canonical JSON lines; empty means NO known witness only
 * at this exact remote head, never proof of no other wallet or other database. */
export function parseNativeOraclePromptWitness(text, expectedOwner) {
  if (typeof text !== 'string' || text.length > 32_768 || (text && !text.endsWith('\n'))) throw blocked('WITNESS_INVALID');
  if (!text) return null;
  const lines = text.slice(0, -1).split('\n'); if (lines.length > 2 + STAGES.length * 2 || lines.some(line => !line)) throw blocked('WITNESS_INVALID');
  let state = null;
  for (const line of lines) {
    let record; try { record = JSON.parse(line); } catch { throw blocked('WITNESS_INVALID'); }
    if (JSON.stringify(record) !== line) throw blocked('WITNESS_INVALID');
    state = step(state, record);
  }
  if (expectedOwner !== undefined && state.identity.owner !== expectedOwner) throw blocked('WITNESS_INVALID');
  return state;
}

/** Storage MUST provide a separately retained, acknowledged CAS: read(owner)
 * returns {head, text}, append({owner, expectedHead, expectedText, text}) must
 * atomically add to exactly that remote head or reject. Unknown acknowledgments
 * never authorize a prompt. */
export function createNativeOraclePromptWitness({ store } = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.append !== 'function') throw Error('independent CAS witness store required');
  async function read(owner) {
    if (!isTestnetAccount(owner)) throw blocked('WITNESS_INVALID');
    let snapshot; try { snapshot = await store.read(owner); } catch { throw blocked(); }
    if (!obj(snapshot) || typeof snapshot.head !== 'string' || !snapshot.head || typeof snapshot.text !== 'string') throw blocked();
    return { head: snapshot.head, text: snapshot.text, state: parseNativeOraclePromptWitness(snapshot.text, owner) };
  }
  async function append(snapshot, owner, record) {
    const text = snapshot.text + JSON.stringify(record) + '\n';
    const state = parseNativeOraclePromptWitness(text, owner);
    let result; try { result = await store.append({ owner, expectedHead: snapshot.head, expectedText: snapshot.text, text }); }
    catch { throw blocked('WITNESS_COMMIT_UNKNOWN'); }
    if (!obj(result) || result.confirmed !== true || typeof result.head !== 'string' || !result.head) throw blocked('WITNESS_COMMIT_UNKNOWN');
    // A successful transport acknowledgment is not enough: re-read the
    // independently retained branch and require this exact append to exist.
    const reread = await read(owner);
    if (reread.text !== text || reread.head !== result.head) throw blocked('WITNESS_COMMIT_UNKNOWN');
    return { state, head: reread.head };
  }
  function assertIdentity(state, id) { if (!state || !same(state.identity, identity(id))) throw blocked('WITNESS_MISMATCH'); }
  return Object.freeze({
    inspect: read,
    async reserve(raw, expectedHead) {
      const id = identity(structuredClone(raw)), snapshot = await read(id.owner);
      if (snapshot.state) throw blocked('OWNER_ALREADY_WITNESSED');
      // A cross-flow coordinator may have checked the other namespace at this
      // exact branch head. Never advance from a different snapshot afterward.
      if (expectedHead !== undefined && (typeof expectedHead !== 'string' || !expectedHead || snapshot.head !== expectedHead)) {
        throw blocked('WITNESS_HEAD_CHANGED');
      }
      return append(snapshot, id.owner, firstRecord(id));
    },
    async assertClaimable(raw, stageId) {
      const id = identity(structuredClone(raw)), snapshot = await read(id.owner);
      assertIdentity(snapshot.state, id);
      const s = snapshot.state, index = s.phase === 'reserved' ? 0 : s.phase === 'original' ? s.stage_index + 1 : -1;
      if (index < 0 || index >= id.stages.length || id.stages[index].stage_id !== stageId) throw blocked('WITNESS_NOT_CLAIMABLE');
      return { head: snapshot.head, last_hash: s.last_hash, stage_id: stageId };
    },
    async claim(raw, stageId, prior) {
      const id = identity(structuredClone(raw)), snapshot = await read(id.owner);
      assertIdentity(snapshot.state, id);
      const s = snapshot.state, index = s.phase === 'reserved' ? 0 : s.phase === 'original' ? s.stage_index + 1 : -1;
      if (!exact(prior, ['head','last_hash','stage_id']) || prior.head !== snapshot.head || prior.last_hash !== s.last_hash ||
          prior.stage_id !== stageId || index < 0 || index >= id.stages.length || id.stages[index].stage_id !== stageId) throw blocked('WITNESS_NOT_CLAIMABLE');
      return append(snapshot, id.owner, nextRecord(s, 'claim', index));
    },
    /** Atomically retain the only trial hash BEFORE phone signing. This is a
     * claim, not evidence of a signature, submission or delivery. A lost
     * acknowledgment consumes the claim and must never be retried. */
    async claimTrial(raw, rawTrial, expectedHead) {
      const id=identity(structuredClone(raw)),trial=trialValues(structuredClone(rawTrial),id),snapshot=await read(id.owner);
      assertIdentity(snapshot.state,id);
      if (snapshot.state.phase!=='complete' || typeof expectedHead!=='string' || expectedHead!==snapshot.head ||
          snapshot.state.records.some(r=>r.original_hash===trial.original_hash)) throw blocked('WITNESS_NOT_CLAIMABLE');
      return append(snapshot,id.owner,trialRecord(snapshot.state,trial));
    },
    async recordOriginal(raw, stageId, originalHash) {
      const id = identity(structuredClone(raw)), snapshot = await read(id.owner);
      assertIdentity(snapshot.state, id);
      if (!isTransactionHash(originalHash)) throw blocked('WITNESS_INVALID');
      const s = snapshot.state;
      if (s.phase === 'claimed' && id.stages[s.stage_index]?.stage_id === stageId) {
        return append(snapshot, id.owner, nextRecord(s, 'original', s.stage_index, originalHash));
      }
      // Idempotent recording of the exact original is recovery, not a retry.
      const last = s.records.at(-1);
      if ((s.phase === 'original' || s.phase === 'complete') && last.stage_id === stageId && last.original_hash === originalHash) {
        return { state: s, head: snapshot.head };
      }
      throw blocked('WITNESS_MISMATCH');
    },
  });
}
