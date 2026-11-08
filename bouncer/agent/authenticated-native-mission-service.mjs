/**
 * Optional operator-hosted testnet mission service. Disabled unless explicitly
 * composed with a fixed mission, preinstalled narrowly scoped agent signers,
 * a durable local FileJournal and the PostgreSQL one-use owner authenticator.
 * The browser cannot choose a signer, RPC, journal, goal, receiver or amount.
 * The server operator, filesystem, RPC and database remain trust boundaries;
 * backups/rollbacks or a second journal can bypass local coordination. This
 * is not a production deployment, independent checkpoint or security audit.
 */
import crypto from 'node:crypto';
import { FileJournal } from './procurement.mjs';
import { runNativeMission, validateNativeMission } from './native-mission.mjs';
import { nativeMissionAction } from '../web-src/native-mission-auth.mjs';

const fail = () => new Error('native mission unavailable; stop and reconcile the original before approving again');
export function createAuthenticatedNativeMissionService({ mission: raw, provider, signers, journal, auth,
  run = runNativeMission, log = () => {} } = {}) {
  const mission = validateNativeMission(raw);
  const kinds = new Set(mission.goals.map(item => item.kind));
  if (!['compute','storage','api'].every(r => mission.required_resources.includes(r)) ||
      !['random','storage','oracle'].every(k => kinds.has(k)) ||
      !(journal instanceof FileJournal) || !provider || !signers || typeof signers !== 'object' ||
      !auth || typeof auth.issue !== 'function' || typeof auth.authenticate !== 'function' || typeof run !== 'function' || typeof log !== 'function') {
    throw new Error('complete fixed testnet mission, durable local journal, agent signers and one-use owner authentication required');
  }
  journal.assertScope(mission.contract_id, mission.owner_account_id);
  const missionSha256 = crypto.createHash('sha256').update(JSON.stringify(mission)).digest('hex');
  const review = Object.freeze({ format: 'bouncer-native-mission-review-v1', network: 'testnet', mission, mission_sha256: missionSha256 });
  // Capture only the configured goal signers. HTTP never supplies signers.
  const signerSnapshot = Object.fromEntries(mission.goals.map(({ goal }) => {
    const signer = signers[goal.id];
    if (!signer || !signer.account || !signer.publicKey) throw new Error('a configured restricted signer is required for every goal');
    return [goal.id, Object.freeze({ account: signer.account, publicKey: signer.publicKey })];
  }));
  const action = ownerPublicKey => nativeMissionAction({ owner: mission.owner_account_id, ownerPublicKey,
    vault: mission.contract_id, missionId: mission.id, missionSha256, maxNativeYocto: mission.max_native_amount });
  const checkHash = value => { if (value !== missionSha256) throw fail(); };
  const executeRun = options => run({ mission, provider, journal, log, ...options });
  return Object.freeze({
    getReview() { return structuredClone(review); },
    async preview({ missionSha256: requested } = {}) {
      checkHash(requested);
      const preview = await executeRun({ signers: signerSnapshot, execute: false });
      return { review: structuredClone(review), preview };
    },
    async issue({ missionSha256: requested, ownerPublicKey } = {}) {
      checkHash(requested); const authorization = action(ownerPublicKey);
      const preview = await executeRun({ signers: signerSnapshot, execute: false });
      if (preview?.status !== 'READY') throw fail();
      return auth.issue(authorization);
    },
    async execute({ missionSha256: requested, ownerPublicKey, evidence } = {}) {
      checkHash(requested); const authorization = action(ownerPublicKey);
      if (await auth.authenticate({ action: authorization, evidence }) !== true) throw fail();
      // The authenticated message explicitly approves this exact mission and
      // maximum. Re-run every current preflight; no input comes from the client.
      return executeRun({ signers: signerSnapshot, execute: true });
    },
    async recover({ missionSha256: requested } = {}) {
      checkHash(requested);
      return executeRun({ signers: {}, recoverOnly: true });
    },
  });
}
