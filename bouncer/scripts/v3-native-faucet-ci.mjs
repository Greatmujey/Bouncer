#!/usr/bin/env node
/** First-attempt GitHub Actions coordinator for ONE native testnet faucet
 * transfer to the already-existing V3 owner. It never loads or signs with the
 * owner key. A pre-helper encrypted recovery snapshot is sealed to the known
 * owner public key, uploaded and downloaded for byte-for-byte confirmation.
 * The helper reservation and every original transaction hash are recorded in
 * acknowledged GitHub checks before network submission. Unknown results are
 * never resent. Recovery snapshot freshness is supplied by those checks. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { FileJournal } from '../agent/procurement.mjs';
import { readFileJournalKeyFile } from '../agent/file-journal-crypto.mjs';
import { ExperimentalSvalinSetupRpc } from '../agent/svalin-setup-rpc.mjs';
import { inspectTollgateV13Funding } from '../agent/tollgate-v13-funding.mjs';
import { HELPER_URL, runNativeTestnetFaucet } from '../agent/native-testnet-faucet.mjs';
import { sealFaucetRecoveryKey, faucetRecoveryBundleDigest } from '../agent/v3-faucet-sealed-recovery.mjs';
import { createGithubFaucetFence, guardFaucetProvider, fixedV3Plan, V3_OWNER, V3_PUBLIC_KEY,
  V3_FAUCET_REPO, V3_FAUCET_BRANCH } from '../agent/v3-faucet-github-fence.mjs';
import { githubOriginalFence } from '../agent/github-original-fence.mjs';

const ID = 'native-testnet-faucet-v1';
const plan = fixedV3Plan(JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v3-plan.json', import.meta.url), 'utf8')));
const mode = process.argv[2], temp = process.env.RUNNER_TEMP;
const runId = process.env.GITHUB_RUN_ID, headSha = process.env.GITHUB_SHA, token = process.env.GITHUB_TOKEN;
const parent = process.env.BOUNCER_FAUCET_EXPECTED_PARENT;
if (!['prepare', 'execute'].includes(mode) || process.argv.length !== 3 || !temp ||
    process.env.GITHUB_REPOSITORY !== V3_FAUCET_REPO || process.env.GITHUB_REF !== `refs/heads/${V3_FAUCET_BRANCH}` ||
    process.env.GITHUB_EVENT_NAME !== 'push' || process.env.GITHUB_RUN_ATTEMPT !== '1' ||
    !/^[1-9][0-9]{0,15}$/.test(runId ?? '') || !/^[a-f0-9]{40}$/.test(headSha ?? '') ||
    !/^[a-f0-9]{40}$/.test(parent ?? '') || typeof token !== 'string' || token.length < 20) {
  throw new Error('fixed first-attempt V3 GitHub Actions context required');
}
const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
if (event.before !== parent || event.after !== headSha || !event.head_commit?.message?.includes('[v3-native-faucet-once]')) {
  throw new Error('one fixed parent and one faucet trigger commit required');
}
const root = path.resolve(temp, 'bouncer-v3-native-faucet-once');
const journalFile = path.join(root, 'journal.json'), keyFile = path.join(root, 'journal-key.bin');
const bundle = path.join(root, 'recovery'), downloaded = path.join(root, 'downloaded');
const bundleJournal = path.join(bundle, 'journal.encrypted.json'), envelopeFile = path.join(bundle, 'sealed-key.json');
const provider = new ExperimentalSvalinSetupRpc('https://test.rpc.fastnear.com');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const noSend = new Proxy(provider, { get(t, p) {
  if (p === 'sendTransactionOnce') return async () => { throw new Error('prepare cannot send'); };
  const v = Reflect.get(t, p, t); return typeof v === 'function' ? v.bind(t) : v;
} });
function publicEntry(e) {
  if (!e || e.recipient !== V3_OWNER || !/^bouncer-faucet-[a-f0-9]{32}\.testnet$/.test(e.temporary_account ?? '') ||
      e.helper_attempted !== true || e.helper_response !== 'unknown' || e.transfer !== null || e.cleanup !== null) {
    throw new Error('pre-helper original journal differs; stop');
  }
  return { temporary_account: e.temporary_account, temporary_public_key: e.temporary_public_key };
}
async function prepare() {
  if (fs.existsSync(root)) throw new Error('original work directory already exists; do not replace it');
  fs.mkdirSync(root, { mode: 0o700 }); fs.mkdirSync(bundle, { mode: 0o700 });
  // This is a trusted-RPC FINAL preflight, not proof the owner backup exists.
  const snapshot = await inspectTollgateV13Funding({ ownerPlan: plan, provider });
  if (!snapshot.proposed_child_absent_at_view || snapshot.owner !== V3_OWNER) throw new Error('V3 preflight differs; no helper request');
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, key, { flag: 'wx', mode: 0o600 });
  const journal = new FileJournal(journalFile, V3_OWNER, V3_OWNER, { encryptionKey: key, keyFile });
  try {
    let fakeCalls = 0;
    const result = await runNativeTestnetFaucet({ recipient: V3_OWNER, journal, provider: noSend, execute: true,
      fetchImpl: async () => { fakeCalls++; throw new Error('offline preparation only'); } });
    const e = journal.get(ID), info = publicEntry(e);
    if (fakeCalls !== 1 || result.status !== 'TEMPORARY_ACCOUNT_UNCONFIRMED') throw new Error('preparation unexpectedly progressed; no helper request');
    const encrypted = fs.readFileSync(journalFile);
    const sealed = sealFaucetRecoveryKey({ key, ownerAccount: V3_OWNER, ownerPublicKey: V3_PUBLIC_KEY,
      temporaryAccount: info.temporary_account, temporaryPublicKey: info.temporary_public_key, journalBytes: encrypted });
    const envelopeBytes = Buffer.from(`${JSON.stringify(sealed)}\n`);
    fs.writeFileSync(bundleJournal, encrypted, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(envelopeFile, envelopeBytes, { flag: 'wx', mode: 0o600 });
    const digest = faucetRecoveryBundleDigest(encrypted, envelopeBytes);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `digest=${digest}\n`);
    console.log(JSON.stringify({ phase: 'prepared-no-network-mutation', owner: V3_OWNER, ...info,
      recovery_bundle_sha256: digest, owner_key_accessed: false, helper_contacted: false, owner_backup_verified: false,
      note: 'The retained snapshot predates the helper. Later public original hashes must be reconciled from GitHub checks.' }));
  } finally { journal.close(); key.fill(0); }
}
async function execute() {
  const artifactId = process.env.BOUNCER_FAUCET_ARTIFACT_ID, digest = process.env.BOUNCER_FAUCET_DIGEST;
  const originalJournal = fs.readFileSync(bundleJournal), originalEnvelope = fs.readFileSync(envelopeFile);
  const downloadedJournal = fs.readFileSync(path.join(downloaded, 'journal.encrypted.json'));
  const downloadedEnvelope = fs.readFileSync(path.join(downloaded, 'sealed-key.json'));
  if (!originalJournal.equals(downloadedJournal) || !originalEnvelope.equals(downloadedEnvelope) ||
      !fs.readFileSync(journalFile).equals(originalJournal) || faucetRecoveryBundleDigest(originalJournal, originalEnvelope) !== digest) {
    throw new Error('downloaded immutable recovery snapshot differs; no helper request');
  }
  const envelope = JSON.parse(originalEnvelope.toString('utf8'));
  if (envelope?.format !== 'bouncer-v3-faucet-recovery-v1' || envelope?.context?.owner_account !== V3_OWNER ||
      envelope.context.owner_public_key !== V3_PUBLIC_KEY || envelope.context.journal_sha256 !== sha(originalJournal)) {
    throw new Error('recovery envelope scope differs; no helper request');
  }
  if (!await githubOriginalFence({ artifactId, runId, headSha, digest, token, maxArtifactBytes: 100_000,
    prefix: 'v3-native-faucet-recovery' })) throw new Error('retained recovery artifact not verified; no helper request');
  const key = readFileJournalKeyFile(keyFile);
  const journal = new FileJournal(journalFile, V3_OWNER, V3_OWNER, { encryptionKey: key, keyFile, requireExisting: true });
  key.fill(0);
  try {
    const entry = journal.get(ID), info = publicEntry(entry);
    if (envelope.context.temporary_account !== info.temporary_account || envelope.context.temporary_public_key !== info.temporary_public_key) {
      throw new Error('recovery identity differs; no helper request');
    }
    const fence = createGithubFaucetFence({ token, runId, headSha, artifactId, bundleDigest: digest });
    await fence('helper', { helper_url: HELPER_URL, ...info, recipient: V3_OWNER,
      meaning: 'one helper attempt may follow; original must be reconciled, never repeated' });
    // Exactly one helper POST, regardless of failure or a lost response. The
    // pre-helper encrypted journal and public check already survive the runner.
    let acknowledged = false;
    try {
      const r = await fetch(HELPER_URL, { method: 'POST', redirect: 'error', credentials: 'omit',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ newAccountId: info.temporary_account, newAccountPublicKey: info.temporary_public_key }),
        signal: AbortSignal.timeout(60_000) });
      acknowledged = r.ok === true;
      await r.body?.cancel().catch(() => {});
    } catch { /* The helper may still have acted. Never make a second POST. */ }
    journal.put(ID, { ...entry, helper_response: acknowledged ? 'acknowledged' : 'unknown' });
    const guarded = guardFaucetProvider(provider, journal, fence);
    let result;
    for (let i = 0; i < 8; i++) {
      result = await runNativeTestnetFaucet({ recipient: V3_OWNER, journal, provider: guarded, execute: true, resume: true });
      if (result.status !== 'TEMPORARY_ACCOUNT_UNCONFIRMED') break;
      if (i < 7) await delay(2000); // read-only account observations; never repeats helper
    }
    console.log(JSON.stringify({ ...result, recovery_artifact_id: artifactId, recovery_bundle_sha256: digest,
      owner_key_accessed: false, owner_backup_verified: false, no_owner_transactions_signed: true,
      recovery_snapshot_is_pre_helper: true, do_not_resend_originals: true }));
    if (result.status !== 'FUNDED_AND_CLEANED') process.exitCode = 2;
  } finally { journal.close(); }
}
try { if (mode === 'prepare') await prepare(); else await execute(); }
catch (error) { console.error(`V3 faucet stopped: ${String(error?.message ?? 'unknown').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300)}`); process.exitCode = 1; }
