#!/usr/bin/env node
/**
 * One disposable TESTNET-only integration check for the exact native wallet
 * plan. It is NOT the user's wallet, a phone test, or a production dispatcher.
 *
 * Each command is a separate CI step. Public originals are uploaded to GitHub
 * Actions as separate immutable artifacts before a helper call or send. Secret
 * keys and signed bearer bytes stay in RUNNER_TEMP and are never uploaded.
 * Every send is preceded by an exclusive local attempt marker; a timeout,
 * lost acknowledgment, failed preflight, cancellation or rerun is a hard stop.
 * No automatic replacement, helper retry, or transaction resend is permitted.
 *
 * This intentionally targets one isolated, locally generated QA account. Its
 * keys are discarded with the runner; its keyless vault's storage collateral
 * can remain locked. It cannot be used for the user's existing account.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { buildNativeOracleWalletPlan, assertNativeOracleBatchMatchesReview, NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE,
  NATIVE_ORACLE_TRIAL_MAX } from '../agent/native-oracle-wallet-plan.mjs';
import { prepareNativeOracleWalletAttempt, inspectNativeOracleWalletAttempt } from '../agent/native-oracle-wallet-evidence.mjs';
import { inspectNativeOracleWalletStage, inspectNativeOracleWalletCompletion } from '../agent/native-oracle-wallet-preflight.mjs';
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';
import { PaymentRpcProvider } from '../agent/near-account.mjs';
import { signReviewedProbeSetup, signReviewedCall } from '../agent/reviewed-transaction.mjs';
import { requestTestnetOwnerOnce } from '../agent/testnet-owner-bootstrap.mjs';
import { FileJournal } from '../agent/procurement.mjs';
import { runOracleGoal, validateOracleGoal } from '../agent/oracle-outlayer.mjs';

const { transactions: tx, utils, KeyPair, KeyPairSigner } = nearApi;
const RPC = 'https://rpc.testnet.near.org';
const GAS = 300n * 10n ** 12n;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const hash = bytes => utils.serialize.base_encode(crypto.createHash('sha256').update(bytes).digest());
const fail = message => { throw new Error(message); };

/** Serialize and retry ONLY bounded JSON-RPC views on transient HTTP/network
 * failures. A send method is rejected before fetch, so this cannot resend a
 * transaction. The block freshness and exact-original checks still apply. */
export function qaReadOnlyFetch({ fetchImpl = globalThis.fetch, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 4 } = {}) {
  if (typeof fetchImpl !== 'function' || typeof pause !== 'function' || !Number.isInteger(attempts) || attempts < 1 || attempts > 5) {
    fail('invalid QA read-only transport');
  }
  let queue = Promise.resolve();
  return (url, init = {}) => {
    let body;
    try { body = JSON.parse(init.body); } catch { throw new Error('QA transport only permits JSON-RPC views'); }
    const allowedMethods = ['status', 'block', 'gas_price', 'EXPERIMENTAL_protocol_config'];
    const allowedQuery = body?.method === 'query' && ['view_account', 'view_access_key_list', 'view_access_key', 'call_function'].includes(body?.params?.request_type);
    if (init.method !== 'POST' || (!allowedMethods.includes(body?.method) && !allowedQuery)) throw new Error('QA transport only permits JSON-RPC views');
    const work = queue.then(async () => {
      let lastError;
      for (let i = 0; i < attempts; i++) {
        try {
          const response = await fetchImpl(url, init);
          if (![429, 500, 502, 503, 504].includes(response.status) || i === attempts - 1) return response;
          await response.body?.cancel().catch(() => {});
        } catch (error) { lastError = error; if (i === attempts - 1) throw error; }
        await pause(300 * 2 ** i);
      }
      throw lastError ?? new Error('QA read-only transport unavailable');
    });
    queue = work.then(() => {}, () => {});
    return work;
  };
}

/** Construct the exact next nonce from the already verified FINAL snapshot.
 * near-api-js's Account.createTransaction currently increments twice; do not
 * mix that optimistic nonce with this independently checked FINAL state. */
export function qaSnapshotAccount({ accountId, pair, nonce, blockHash }) {
  let block, n, key;
  try {
    if (typeof accountId !== 'string' || !accountId.endsWith('.testnet') || !pair ||
        typeof nonce !== 'string' || !/^(?:0|[1-9][0-9]{0,15})$/.test(nonce)) throw Error();
    n = BigInt(nonce);
    if (n >= BigInt(Number.MAX_SAFE_INTEGER)) throw Error();
    block = Uint8Array.from(utils.serialize.base_decode(blockHash)); key = pair.getPublicKey();
    if (block.length !== 32 || key.keyType !== 0) throw Error();
  } catch { throw new Error('QA needs a verified FINAL snapshot, nonce and Ed25519 key'); }
  const signer = new KeyPairSigner(pair);
  let prepared = false;
  return Object.freeze({ accountId, signer,
    async createTransaction(receiver, actions, suppliedKey) {
      if (prepared || typeof receiver !== 'string' || !Array.isArray(actions) || !actions.length || String(suppliedKey) !== String(key)) {
        fail('QA snapshot transaction cannot be replaced or reused');
      }
      prepared = true;
      return tx.createTransaction(accountId, key, receiver, n + 1n, actions, Uint8Array.from(block));
    },
  });
}

/** Verify canonical actions, exact signed bytes, key and original hash. This
 * function never sends. Kept separate so mismatches are tested offline. */
export function inspectQaSigned({ bytes, signerId, receiverId, publicKey, actions, txHash, signedSha256 }) {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > 1_000_000 ||
        !Array.isArray(actions) || !actions.length || !/^[a-f0-9]{64}$/.test(signedSha256) || sha(bytes) !== signedSha256) throw Error();
    const decoded = tx.SignedTransaction.decode(bytes), source = decoded.transaction;
    const key = utils.PublicKey.from(publicKey), sig = decoded.signature?.ed25519Signature?.data;
    if (key.keyType !== 0 || String(key) !== publicKey || source.signerId !== signerId || source.receiverId !== receiverId ||
        typeof source.nonce !== 'bigint' || source.nonce < 1n || !Array.isArray(source.blockHash) || source.blockHash.length !== 32 ||
        !Array.isArray(source.publicKey?.ed25519Key?.data) ||
        !Buffer.from(source.publicKey.ed25519Key.data).equals(Buffer.from(key.ed25519Key.data)) ||
        !Array.isArray(sig) || sig.length !== 64 || sig.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw Error();
    const canonical = tx.createTransaction(signerId, key, receiverId, source.nonce, actions, Uint8Array.from(source.blockHash));
    const unsigned = Buffer.from(tx.encodeTransaction(canonical));
    const digest = crypto.createHash('sha256').update(unsigned).digest();
    if (!Buffer.from(tx.encodeTransaction(source)).equals(unsigned) || hash(unsigned) !== txHash ||
        !key.verify(digest, Uint8Array.from(sig))) throw Error();
    const signed = new tx.SignedTransaction({ transaction: canonical,
      signature: new tx.Signature({ keyType: 0, data: Uint8Array.from(sig) }) });
    if (!Buffer.from(tx.encodeTransaction(signed)).equals(Buffer.from(bytes))) throw Error();
    return { signed, transaction: canonical, txHash, digest: Uint8Array.from(digest) };
  } catch { throw new Error('QA signed transaction differs from the retained original; stop and reconcile'); }
}

/** Build the account interface expected by the existing guarded oracle runner.
 * It signs nothing: only the exact already-signed QA original is accepted. */
export function qaPresignedAccount(checked, publicKey) {
  if (!checked?.signed || !checked.transaction || !checked.digest) fail('verified QA original required');
  const key = utils.PublicKey.from(publicKey), saved = Buffer.from(tx.encodeTransaction(checked.transaction));
  let prepared = false, used = false;
  return Object.freeze({ accountId: checked.transaction.signerId,
    signer: Object.freeze({ getPublicKey: async () => key,
      async signTransaction(transaction) {
        if (!prepared || used || !Buffer.from(tx.encodeTransaction(transaction)).equals(saved)) fail('QA original cannot be replaced or reused');
        used = true; return [Uint8Array.from(checked.digest), checked.signed];
      } }),
    async createTransaction(receiver, actions, suppliedKey) {
      if (prepared || receiver !== checked.transaction.receiverId || String(suppliedKey) !== String(key)) fail('QA original cannot be replaced or reused');
      const candidate = tx.createTransaction(checked.transaction.signerId, key, receiver, checked.transaction.nonce,
        actions, Uint8Array.from(checked.transaction.blockHash));
      if (!Buffer.from(tx.encodeTransaction(candidate)).equals(saved)) fail('QA original cannot be replaced or reused');
      prepared = true; return candidate;
    },
  });
}

/** An exclusive, fsynced marker is written before a potentially mutating call.
 * It is local to this one runner, not a distributed or rollback-proof fence. */
export function markQaAttempt(file, publicInfo) {
  let fd;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(fd, json(publicInfo)); fs.fsyncSync(fd);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  const dir = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

function checkedEnv() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== 'Greatmujey/Bouncer' ||
      process.env.GITHUB_REF !== 'refs/heads/arena/0e4386ea-near-hub' || process.env.GITHUB_RUN_ATTEMPT !== '1' ||
      process.env.BOUNCER_NATIVE_QA !== 'one-shot-testnet-only' || !/^[0-9]+$/.test(process.env.GITHUB_RUN_ID ?? '') ||
      !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? '') || !process.env.GITHUB_TOKEN ||
      !process.env.RUNNER_TEMP || !path.isAbsolute(process.env.RUNNER_TEMP)) fail('one-shot testnet QA is restricted to the reviewed GitHub run');
  return path.join(process.env.RUNNER_TEMP, 'bouncer-native-qa');
}
function writeExclusive(file, bytes, mode = 0o600) {
  let fd;
  try { fd = fs.openSync(file, 'wx', mode); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  const dir = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
function paths(root) {
  return { root, secret: path.join(root, 'private'), pub: path.join(root, 'public'), wasm: path.resolve('bouncer.wasm') };
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function output(name, value) {
  const text = String(value);
  const safeValue = name === 'artifact_file' ? path.isAbsolute(text) && !/[\r\n]/.test(text) : /^[A-Za-z0-9._-]+$/.test(text);
  if (!process.env.GITHUB_OUTPUT || !/^[a-z_]+$/.test(name) || !safeValue) fail('invalid CI output');
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${text}\n`);
}
function artifactName(kind, bytes) { return `native-qa-${process.env.GITHUB_RUN_ID}-${kind}-${sha(bytes)}`; }
function publicFile(p, kind, data) {
  const bytes = json(data), file = path.join(p.pub, `${kind}.json`), name = artifactName(kind, bytes);
  writeExclusive(file, bytes); output('artifact_name', name); output('artifact_file', file);
  return { file, name };
}
async function requireArtifact(p, kind, id) {
  if (!/^[1-9][0-9]*$/.test(id ?? '')) fail('a retained public artifact is required before any send');
  const file = path.join(p.pub, `${kind}.json`), bytes = fs.readFileSync(file), name = artifactName(kind, bytes);
  const api = `https://api.github.com/repos/Greatmujey/Bouncer/actions/artifacts/${id}`;
  const response = await fetch(api, { headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28' }, redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) fail('public original artifact cannot be independently read; stop before sending');
  const data = await response.json();
  if (String(data.id) !== id || data.name !== name || data.expired !== false ||
      String(data.workflow_run?.id) !== process.env.GITHUB_RUN_ID || data.workflow_run?.head_sha !== process.env.GITHUB_SHA) {
    fail('public original artifact does not match this exact run; stop before sending');
  }
  return readJson(file);
}
function privateKeys(p) {
  const keys = readJson(path.join(p.secret, 'keys.json'));
  const owner = KeyPair.fromString(keys.owner), agent = KeyPair.fromString(keys.agent);
  const bootstrap = readJson(path.join(p.pub, 'bootstrap.json'));
  if (String(owner.getPublicKey()) !== bootstrap.owner_public_key || String(agent.getPublicKey()) !== bootstrap.review.agent_public_key) {
    fail('QA keys do not match the retained public review');
  }
  return { owner, agent, bootstrap };
}
function planFor(p, bootstrap) {
  const review = bootstrap.review, wasm = fs.readFileSync(p.wasm);
  const plan = buildNativeOracleWalletPlan({ wasmBytes: wasm, terms: { owner: review.owner, vault: review.vault,
    policy_id: review.policy_id, agent_public_key: review.agent_public_key, per_tx_cap_yocto: review.per_tx_cap_yocto,
    daily_cap_yocto: review.daily_cap_yocto, vault_deposit_yocto: review.vault_deposit_yocto,
    agent_gas_allowance_yocto: review.agent_gas_allowance_yocto } });
  if (!isDeepStrictEqual(plan.review, review)) fail('public QA review changed');
  return { ...plan, wasm };
}
function providers() {
  return { views: new ReadOnlyNearRpcProvider(RPC, { timeoutMs: 30_000, fetchImpl: qaReadOnlyFetch() }),
    rpc: new PaymentRpcProvider(RPC, { receiptTimeoutMs: 120_000, sendTimeoutMs: 120_000 }) };
}
/** Repeat only a read of the SAME original hash, never a transaction send. */
export async function readFinalOriginal(rpc, original, owner, { pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!rpc || typeof rpc.txStatusReceipts !== 'function' || typeof original !== 'string' || typeof owner !== 'string' || typeof pause !== 'function') {
    fail('original-hash read requires a provider, original and owner');
  }
  let last;
  for (let i = 0; i < 3; i++) {
    try { return await rpc.txStatusReceipts(original, owner, 'FINAL'); }
    catch (error) { last = error; if (i < 2) await pause(500 * 2 ** i); }
  }
  throw last;
}
async function prior(p, review, count, rpc) {
  const entries = [];
  for (let i = 0; i < count; i++) {
    const data = readJson(path.join(p.pub, `stage${i}.json`));
    if (data.review_sha256 !== review.review_sha256 || data.attempt?.stage_id !== review.stages[i].id) fail('earlier public original changed');
    const result = await readFinalOriginal(rpc, data.attempt.tx_hash, review.owner);
    entries.push({ attempt: data.attempt, trustedOriginalHash: data.attempt.tx_hash, result });
  }
  return entries;
}
async function preflight(p, boot, index, views, rpc) {
  const plan = planFor(p, boot), args = { review: plan.review, wasmBytes: plan.wasm, trustedReviewHash: plan.review.review_sha256,
    trustedOwnerPublicKey: boot.owner_public_key, prior: await prior(p, plan.review, index, rpc), provider: views };
  const result = index === 4 ? await inspectNativeOracleWalletCompletion(args) :
    await inspectNativeOracleWalletStage({ ...args, stageId: plan.batches[index].id });
  const expected = index === 4 ? 'FOUR_ORIGINALS_AND_STATE_MATCH_NOT_AUTHORIZED' : 'STATE_CHECKS_PASSED_NOT_AUTHORIZED';
  if (result.status !== expected) fail(`fresh QA state blocked: ${(result.blockers ?? []).join(', ')}`);
  return { plan, result };
}
function verifyActionAttempt(p, boot, stage, original, bytes) {
  const plan = planFor(p, boot), batch = plan.batches[stage];
  assertNativeOracleBatchMatchesReview(batch, plan.review.stages[stage]);
  const expectedAttempt = prepareNativeOracleWalletAttempt({ review: plan.review, wasmBytes: plan.wasm,
    trustedReviewHash: plan.review.review_sha256, trustedOwnerPublicKey: boot.owner_public_key,
    stageId: batch.id, trustedOriginalHash: original.attempt?.tx_hash });
  if (!isDeepStrictEqual(original.attempt, expectedAttempt) || original.review_sha256 !== plan.review.review_sha256) fail('retained setup original differs from review');
  return inspectQaSigned({ bytes, signerId: batch.signerId, receiverId: batch.receiverId, publicKey: boot.owner_public_key,
    actions: batch.actions, txHash: original.attempt.tx_hash, signedSha256: original.signed_sha256 });
}
function nonceMatches(snapshot, transaction, agent = false) {
  const n = agent ? snapshot.agent_key_nonce : snapshot.owner_key_nonce;
  if (typeof n !== 'string' || transaction.nonce !== BigInt(n) + 1n) fail('QA signer nonce changed; reconcile the original, do not replace it');
}
function getGoal(review) {
  return validateOracleGoal({ id: `qa-native-${process.env.GITHUB_RUN_ID}`, contract_id: review.vault, owner_account_id: review.owner,
    policy_id: review.policy_id, amount: review.per_tx_cap_yocto,
    route: { project: review.project, route_revision: 1, policy_revision: 1, payee_revision: 1, active: true }, max_age_seconds: 300 });
}
function trialActions(goal) {
  return [tx.functionCall('execute_outlayer_native_project', { policy_id: goal.policy_id, amount: goal.amount, expected_route: goal.route }, GAS, 0n)];
}

async function init(p) {
  fs.mkdirSync(p.secret, { recursive: true, mode: 0o700 }); fs.mkdirSync(p.pub, { recursive: true, mode: 0o700 });
  const owner = KeyPair.fromRandom('ed25519'), agent = KeyPair.fromRandom('ed25519');
  const ownerId = `bouncer-owner-${crypto.randomBytes(12).toString('hex')}.testnet`, vault = `native.${ownerId}`;
  const wasm = fs.readFileSync(p.wasm);
  const { review } = buildNativeOracleWalletPlan({ wasmBytes: wasm, terms: { owner: ownerId, vault, policy_id: 'native-price',
    agent_public_key: String(agent.getPublicKey()), per_tx_cap_yocto: NATIVE_ORACLE_TRIAL_MAX,
    daily_cap_yocto: NATIVE_ORACLE_TRIAL_MAX, vault_deposit_yocto: NATIVE_ORACLE_TRIAL_MAX,
    agent_gas_allowance_yocto: NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } });
  writeExclusive(path.join(p.secret, 'keys.json'), json({ owner: owner.toString(), agent: agent.toString() }));
  const bootstrapPlan = { version: 1, network: 'testnet', purpose: 'new-bouncer-testnet-owner', account_id: ownerId,
    public_key: String(owner.getPublicKey()) };
  publicFile(p, 'bootstrap', { kind: 'disposable-testnet-qa', run_id: process.env.GITHUB_RUN_ID,
    owner_public_key: String(owner.getPublicKey()), bootstrap_plan: bootstrapPlan, review,
    user_wallet_used: false, phone_wallet_used: false, keys_retained_after_run: false,
    scope: 'Fresh QA account only; never represents the user wallet. Keyless vault storage collateral can remain locked.' });
  console.log(`Disposable QA account ${ownerId}; not the user's wallet. No account has been created yet.`);
}
async function faucet(p, artifactId) {
  const saved = await requireArtifact(p, 'bootstrap', artifactId), { bootstrap } = privateKeys(p);
  if (!isDeepStrictEqual(saved, bootstrap)) fail('bootstrap artifact changed');
  const { views } = providers();
  const result = await requestTestnetOwnerOnce({ plan: bootstrap.bootstrap_plan, provider: views,
    persistAttempt: async attempt => {
      if (attempt.account_id !== bootstrap.review.owner || attempt.public_key !== bootstrap.owner_public_key) return false;
      markQaAttempt(path.join(p.secret, 'faucet-attempt'), { ...attempt, artifact_id: artifactId });
      console.log(`Retained bootstrap ${attempt.account_id}, FINAL preflight ${attempt.before_block_hash}, artifact ${artifactId}; helper POST at most once.`);
      return true;
    } });
  writeExclusive(path.join(p.pub, 'faucet-result.json'), json(result));
  console.log(`QA account observed at FINAL: ${result.account_id}, block ${result.block_hash}.`);
}
async function prepareStage(p, index) {
  const { owner, bootstrap } = privateKeys(p), { views, rpc } = providers();
  const { plan, result: snapshot } = await preflight(p, bootstrap, index, views, rpc);
  const batch = plan.batches[index]; assertNativeOracleBatchMatchesReview(batch, plan.review.stages[index]);
  const account = qaSnapshotAccount({ accountId: plan.review.owner, pair: owner,
    nonce: snapshot.owner_key_nonce, blockHash: snapshot.block_hash });
  const prepared = await signReviewedProbeSetup({ account, signerId: batch.signerId, publicKey: owner.getPublicKey(),
    receiverId: batch.receiverId, actions: batch.actions });
  nonceMatches(snapshot, prepared.signed.transaction);
  const bytes = Buffer.from(tx.encodeTransaction(prepared.signed));
  const attempt = prepareNativeOracleWalletAttempt({ review: plan.review, wasmBytes: plan.wasm,
    trustedReviewHash: plan.review.review_sha256, trustedOwnerPublicKey: bootstrap.owner_public_key,
    stageId: batch.id, trustedOriginalHash: prepared.txHash });
  writeExclusive(path.join(p.secret, `stage${index}.signed`), bytes);
  publicFile(p, `stage${index}`, { kind: 'disposable-qa-original', stage_index: index, review_sha256: plan.review.review_sha256,
    attempt, signed_sha256: sha(bytes), preflight_block_hash: snapshot.block_hash,
    user_wallet_used: false, do_not_resend: true });
  console.log(`Prepared ${batch.id} original ${prepared.txHash}; no broadcast yet.`);
}
async function sendStage(p, index, artifactId) {
  const original = await requireArtifact(p, `stage${index}`, artifactId), { bootstrap } = privateKeys(p), { views, rpc } = providers();
  const { result: snapshot, plan } = await preflight(p, bootstrap, index, views, rpc);
  const file = path.join(p.secret, `stage${index}.signed`), bytes = fs.readFileSync(file);
  const checked = verifyActionAttempt(p, bootstrap, index, original, bytes);
  nonceMatches(snapshot, checked.transaction);
  markQaAttempt(path.join(p.secret, `stage${index}-sent`), { tx_hash: checked.txHash, artifact_id: artifactId });
  fs.unlinkSync(file); // no on-disk bearer survives the only send attempt
  console.log(`Sending retained original ${checked.txHash} once; no automatic retry.`);
  const sent = await rpc.sendTransactionOnce(checked.signed, 'FINAL');
  if (sent?.transaction_outcome?.id !== checked.txHash) fail('send acknowledgment differs; reconcile original, never resend');
  const chain = await readFinalOriginal(rpc, checked.txHash, plan.review.owner);
  const proof = inspectNativeOracleWalletAttempt({ review: plan.review, wasmBytes: plan.wasm,
    trustedReviewHash: plan.review.review_sha256, trustedOwnerPublicKey: bootstrap.owner_public_key,
    attempt: original.attempt, trustedOriginalHash: checked.txHash, result: chain });
  if (!['FINAL_NATIVE_SETUP_RECEIPT_MATCH', 'FINAL_LOCAL_ADD_KEY_OUTCOME_MATCH'].includes(proof.status)) fail('original finalized without the expected success; stop and reconcile');
  writeExclusive(path.join(p.pub, `stage${index}-result.json`), json(proof));
  console.log(`${proof.stage_id}: ${proof.status} ${proof.tx_hash}`);
}
async function prepareTrial(p) {
  const { agent, bootstrap } = privateKeys(p), { views, rpc } = providers();
  const { plan, result: snapshot } = await preflight(p, bootstrap, 4, views, rpc), goal = getGoal(plan.review);
  const account = qaSnapshotAccount({ accountId: goal.owner_account_id, pair: agent,
    nonce: snapshot.agent_key_nonce, blockHash: snapshot.block_hash });
  const args = { policy_id: goal.policy_id, amount: goal.amount, expected_route: goal.route };
  const prepared = await signReviewedCall({ account, publicKey: agent.getPublicKey(), ownerId: goal.owner_account_id,
    contractId: goal.contract_id, method: 'execute_outlayer_native_project', args, gas: GAS });
  nonceMatches(snapshot, prepared.signed.transaction, true);
  const bytes = Buffer.from(tx.encodeTransaction(prepared.signed));
  writeExclusive(path.join(p.secret, 'trial.signed'), bytes);
  publicFile(p, 'trial', { kind: 'disposable-qa-trial-original', review_sha256: plan.review.review_sha256,
    goal, agent_public_key: String(agent.getPublicKey()), tx_hash: prepared.txHash, signed_sha256: sha(bytes),
    preflight_block_hash: snapshot.block_hash, user_wallet_used: false, do_not_resend: true });
  console.log(`Prepared independent OutLayer trial original ${prepared.txHash}; no broadcast yet.`);
}
async function sendTrial(p, artifactId) {
  const original = await requireArtifact(p, 'trial', artifactId), { bootstrap } = privateKeys(p), { views, rpc } = providers();
  const { plan, result: snapshot } = await preflight(p, bootstrap, 4, views, rpc), goal = getGoal(plan.review);
  if (!isDeepStrictEqual(original.goal, goal) || original.review_sha256 !== plan.review.review_sha256 ||
      original.agent_public_key !== plan.review.agent_public_key) fail('trial artifact differs from reviewed QA goal');
  const file = path.join(p.secret, 'trial.signed'), bytes = fs.readFileSync(file);
  const checked = inspectQaSigned({ bytes, signerId: goal.owner_account_id, receiverId: goal.contract_id,
    publicKey: original.agent_public_key, actions: trialActions(goal), txHash: original.tx_hash, signedSha256: original.signed_sha256 });
  nonceMatches(snapshot, checked.transaction, true);
  markQaAttempt(path.join(p.secret, 'trial-sent'), { tx_hash: checked.txHash, artifact_id: artifactId });
  fs.unlinkSync(file);
  const account = qaPresignedAccount(checked, original.agent_public_key);
  const journal = new FileJournal(path.join(p.secret, 'trial-journal.json'), goal.contract_id, goal.owner_account_id);
  try {
    console.log(`Running guarded QA trial ${checked.txHash} at most once; maximum ${goal.amount} yoctoNEAR.`);
    const provider = {
      viewNodeStatus: views.viewNodeStatus.bind(views), callFunction: views.callFunction.bind(views),
      viewAccessKey: views.viewAccessKey.bind(views), block: views.block.bind(views),
      txStatusReceipts: (hash, owner) => readFinalOriginal(rpc, hash, owner),
      sendTransactionOnce: rpc.sendTransactionOnce.bind(rpc),
    };
    const result = await runOracleGoal({ goal, provider, account, publicKey: utils.PublicKey.from(original.agent_public_key), journal, execute: true });
    if (result.status !== 'FULFILLED' || result.delivery?.tx_hash !== checked.txHash) fail('QA trial did not establish matching provider delivery');
    writeExclusive(path.join(p.pub, 'trial-result.json'), json({ kind: 'disposable-qa-trial-result', user_wallet_used: false,
      setup_originals: plan.review.stages.map((_, i) => readJson(path.join(p.pub, `stage${i}.json`)).attempt.tx_hash),
      owner: goal.owner_account_id, vault: goal.contract_id, result }));
    console.log(`QA FULFILLED ${checked.txHash}; independent single-source OutLayer delivery, not user-wallet or storage proof.`);
  } finally { journal.close(); }
}
async function main() {
  const p = paths(checkedEnv()), [command, arg, artifact] = process.argv.slice(2);
  if (command === 'init' && arg === undefined) return init(p);
  if (command === 'faucet' && arg && artifact === undefined) return faucet(p, arg);
  if (command === 'prepare-stage' && /^[0-3]$/.test(arg ?? '') && artifact === undefined) return prepareStage(p, Number(arg));
  if (command === 'send-stage' && /^[0-3]$/.test(arg ?? '') && artifact) return sendStage(p, Number(arg), artifact);
  if (command === 'prepare-trial' && arg === undefined) return prepareTrial(p);
  if (command === 'send-trial' && arg && artifact === undefined) return sendTrial(p, arg);
  fail('unsupported QA phase');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    const message = String(error?.message ?? 'unknown failure').replace(/https?:\/\/\S+/g, '[url]')
      .replace(/ed25519:[1-9A-HJ-NP-Za-km-z]+/g, 'ed25519:[redacted]').slice(0, 600);
    console.error(`QA stopped: ${message}; do not retry an unresolved original.`);
    if (process.env.GITHUB_ACTIONS === 'true') {
      const safe = message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
      console.log(`::error title=Testnet QA stopped::${safe}; do not retry an unresolved original.`);
    }
    process.exitCode = 1;
  });
}
