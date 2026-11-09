/**
 * Optional operator-hosted testnet mission service. Disabled unless explicitly
 * composed with a fixed mission, preinstalled narrowly scoped agent signers,
 * a durable local FileJournal and the PostgreSQL one-use owner authenticator.
 * Without signers it can be composed solely for original-hash recovery.
 * The browser cannot choose a signer, RPC, journal, goal, receiver or amount.
 * The server operator, filesystem, RPC and database remain trust boundaries;
 * backups/rollbacks or a second journal can bypass local coordination. This
 * is not a production deployment, independent checkpoint or security audit.
 */
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { readNativeJournal } from './synchronous-native-journal.mjs';
import { FileJournal } from './procurement.mjs';
import { runNativeMission, validateNativeMission } from './native-mission.mjs';
import { marketInputFromOracle } from './market-summary.mjs';
import { nativeMissionAction } from '../web-src/native-mission-auth.mjs';

const fail = () => new Error('native mission unavailable; stop and reconcile the original before approving again');
export function createAuthenticatedNativeMissionService({ mission: raw, provider, signers, journal, auth,
  run = runNativeMission, log = () => {} } = {}) {
  const mission = validateNativeMission(raw);
  const kinds = new Set(mission.goals.map(item => item.kind));
  if (!['compute','storage','api'].every(r => mission.required_resources.includes(r)) ||
      !['storage','oracle'].every(k => kinds.has(k)) || !['random','market'].some(k => kinds.has(k)) ||
      !(journal instanceof FileJournal) || !provider || typeof run !== 'function' || typeof log !== 'function' ||
      (signers !== undefined && (!signers || typeof signers !== 'object' || Array.isArray(signers)))) {
    throw new Error('complete fixed testnet mission and durable local journal are required');
  }
  // Market missions use separately authenticated per-leg checkpoints. The
  // older random demo retains its existing single-approval behavior.
  const checkpointMode = kinds.has('market');
  const recoveryOnly = !signers || Object.keys(signers).length === 0;
  if (!recoveryOnly && (!auth || typeof auth.issue !== 'function' || typeof auth.authenticate !== 'function')) {
    throw new Error('one-use owner authentication is required for mission execution');
  }
  journal.assertScope(mission.contract_id, mission.owner_account_id);
  const missionSha256 = crypto.createHash('sha256').update(JSON.stringify(mission)).digest('hex');
  const review = Object.freeze({ format: 'bouncer-native-mission-review-v1', network: 'testnet', mission, mission_sha256: missionSha256 });
  // Capture only the configured goal signers. HTTP never supplies signers.
  const signerSnapshot = recoveryOnly ? {} : Object.fromEntries(mission.goals.map(({ goal }) => {
    const signer = signers[goal.id];
    if (!signer || !signer.account || !signer.publicKey) throw new Error('a configured restricted signer is required for every goal');
    return [goal.id, Object.freeze({ account: signer.account, publicKey: signer.publicKey })];
  }));
  const action = (ownerPublicKey, goalId) => {
    const goal = checkpointMode ? mission.goals.find(item => item.goal.id === goalId)?.goal : null;
    if (checkpointMode ? !goal : goalId !== undefined) throw fail();
    return nativeMissionAction({ owner: mission.owner_account_id, ownerPublicKey,
      vault: mission.contract_id, missionId: mission.id, missionSha256, maxNativeYocto: mission.max_native_amount,
      ...(checkpointMode ? { goalId: goal.id, goalMaxNativeYocto: goal.amount } : {}) });
  };
  const checkHash = value => { if (value !== missionSha256) throw fail(); };
  const executeRun = options => run({ mission, provider, journal, log, ...options });
  function originals() {
    const intent = readNativeJournal(journal, `native-mission:${mission.id}`);
    const entries = mission.goals.map(({goal}) => readNativeJournal(journal, goal.id));
    if (!intent && !entries.some(Boolean)) return { status:'NO_LOCAL_ORIGINALS', originals:[] };
    const fingerprint = crypto.createHash('sha256').update(`bouncer-native-mission-v1\0${JSON.stringify(mission)}`).digest('hex');
    if (!intent || intent.kind !== 'native-mission-intent-v1' || intent.status !== 'pending' || intent.fingerprint !== fingerprint ||
        !isDeepStrictEqual(intent.mission, mission)) throw fail();
    let stopped = false; const result = [];
    mission.goals.forEach(({kind,goal}, i) => {
      const entry = entries[i];
      if (!entry) { stopped = true; return; }
      const key = ['random','market'].includes(kind) ? 'outlayer_goal' : kind === 'oracle' ? 'oracle_goal' : 'storage_goal';
      const saved = entry[key];
      const comparable = kind === 'storage' && typeof goal.value !== 'string' && saved
        ? { ...saved, value:goal.value } : kind === 'market' && saved ? { ...saved, input:goal.input } : saved;
      if (kind === 'market' && saved) {
        const sourceIndex = mission.goals.findIndex(item => item.goal.id === goal.input.from_goal_id);
        const source = entries[sourceIndex];
        if (sourceIndex < 0 || sourceIndex >= i || source?.status !== 'completed' ||
            !isDeepStrictEqual(saved.input, marketInputFromOracle(goal.input.quantity, source.delivery)) ||
            saved.input.oracle_tx_hash !== source.tx_hash) throw fail();
      }
      if (stopped || !['pending','completed'].includes(entry.status) || !isTransactionHash(entry.tx_hash) ||
          !saved || !isDeepStrictEqual(comparable, goal) ||
          entry.fingerprint !== crypto.createHash('sha256').update(JSON.stringify(saved)).digest('hex')) throw fail();
      result.push({goal_id:goal.id,kind,status:entry.status,original_hash:entry.tx_hash});
      if (entry.status === 'pending') stopped = true;
    });
    return {status:result.length ? 'LOCAL_ORIGINALS' : 'NO_LOCAL_ORIGINALS',originals:result,
      note:'Local journal only; not proof of non-execution or an independent checkpoint.'};
  }
  return Object.freeze({
    getReview() { return structuredClone(review); },
    async preview({ missionSha256: requested } = {}) {
      checkHash(requested);
      if (recoveryOnly) return { review:structuredClone(review), preview:{status:'BLOCKED',stage:'recovery-only',new_payments:0,
        note:'Agent signers are unavailable; original-hash recovery only.'} };
      const preview = await executeRun({ signers: signerSnapshot, execute: false });
      return { review: structuredClone(review), preview };
    },
    async issue({ missionSha256: requested, ownerPublicKey, goalId } = {}) {
      checkHash(requested); if (recoveryOnly) throw fail();
      const authorization = action(ownerPublicKey, goalId);
      const preview = await executeRun({ signers: signerSnapshot, execute: false });
      if (preview?.status !== 'READY' || (checkpointMode && preview.next_goal_id !== goalId)) throw fail();
      return auth.issue(authorization);
    },
    async execute({ missionSha256: requested, ownerPublicKey, evidence, goalId } = {}) {
      checkHash(requested); if (recoveryOnly) throw fail();
      const authorization = action(ownerPublicKey, goalId);
      if (await auth.authenticate({ action: authorization, evidence }) !== true) throw fail();
      // A market challenge authorizes only this goal. The runner checks it is
      // still the next unpaid original after reconciling everything before it.
      return executeRun({ signers: signerSnapshot, execute: true, ...(checkpointMode ? { checkpointGoalId: goalId } : {}) });
    },
    async originals({ missionSha256: requested } = {}) {
      checkHash(requested); return originals();
    },
    async recover({ missionSha256: requested } = {}) {
      checkHash(requested);
      return executeRun({ signers: {}, recoverOnly: true });
    },
  });
}
