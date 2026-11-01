#!/usr/bin/env node
/**
 * ONE-SHOT TESTNET DIAGNOSTIC; NOT A PURCHASE. Creates disposable helper
 * accounts, deploys and locks V10, confirms the zero-yocto owner guard rejects,
 * then asks YouTick's pinned access contract for a Play grant on a made-up job.
 * No quote, FT payment, upload, publication, token request or retrieval occurs.
 *
 * Every transaction hash is durably recorded before ONE broadcast. Failure,
 * timeout or an unknown hash is never retried; inspect original evidence by
 * hash. RSA-sealed credentials and an encrypted journal are retained separately.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { FileJournal } from '../agent/procurement.mjs';
import { MonotonicAccount, PaymentRpcProvider } from '../agent/near-account.mjs';
import { signReviewedCall, signReviewedOneYoctoOwnerCall } from '../agent/reviewed-transaction.mjs';
import { sealTestnetCredentials, testnetRecoveryKeyId } from '../agent/testnet-credential-envelope.mjs';
import { makeYoutickPlayGrantArgs, YOUTICK_PLAY_ORIGIN_HASH } from '../agent/youtick-play-proof.mjs';
import { YOUTICK_PLAY_GRANT_GAS } from '../agent/youtick-playback.mjs';
import { YOUTICK_ACCESS, YOUTICK_MARKET } from '../agent/youtick-capabilities.mjs';
import { YOUTICK_V1_CODE_HASH } from '../agent/youtick-quote.mjs';
import { YOUTICK_ACCESS_CODE_HASH } from '../agent/youtick-grant-runner.mjs';
import { validateYoutickGrantProbe, verifyYoutickZeroGrantProbe, inspectYoutickGrantProbe } from '../agent/youtick-grant-probe-evidence.mjs';
import { waitForNewTestnetKey, waitForFinalTestnetAccount } from '../shared/testnet-ready.mjs';

const { KeyPair, KeyPairSigner, transactions, utils } = nearApi;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY_ID = '13c804af6c55d701c9f39752dbbec3a2dae086f9179051c7ad868fd7d82e5176';
const ONE = 10n ** 24n, TGAS = 10n ** 12n, GAS = BigInt(YOUTICK_PLAY_GRANT_GAS);
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const notice = (title, value) => console.log(`::notice title=${title}::${JSON.stringify(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);

function writeExclusive(dir, name, value) {
  const fd = fs.openSync(path.join(dir, name), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const parent = fs.openSync(dir, 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}

/** Pin setup transaction actions and verify the returned signature before use.
 * No signed bytes are written to disk. The sender still must journal the hash. */
export async function signReviewedProbeSetup({ account, signerId, publicKey, receiverId, actions }) {
  if (!account || account.accountId !== signerId || !account.signer || typeof account.createTransaction !== 'function' ||
      String(await account.signer.getPublicKey()) !== String(publicKey) || !Array.isArray(actions) || !actions.length) {
    throw new Error('invalid reviewed diagnostic setup signer');
  }
  const key = utils.PublicKey.from(String(publicKey));
  if (key.keyType !== 0) throw new Error('diagnostic setup needs an Ed25519 key');
  // Snapshot action bytes before calling an untrusted builder. It may share and
  // mutate action objects; comparing only the references afterward is unsafe.
  const canonical = list => Buffer.from(transactions.encodeTransaction(transactions.createTransaction(signerId, key, receiverId, 1n, list, Buffer.alloc(32))));
  const reviewedActions = canonical(actions);
  const tx = await account.createTransaction(receiverId, actions, key);
  if (!tx || typeof tx.nonce !== 'bigint' || tx.nonce < 1n || !(tx.blockHash instanceof Uint8Array) || tx.blockHash.length !== 32) {
    throw new Error('invalid diagnostic setup nonce or block');
  }
  if (tx.signerId !== signerId || tx.receiverId !== receiverId || String(tx.publicKey) !== String(key) ||
      !Array.isArray(tx.actions) || !canonical(tx.actions).equals(reviewedActions)) throw new Error('diagnostic setup transaction differs from review');
  const bytes = Buffer.from(transactions.encodeTransaction(tx));
  const digest = crypto.createHash('sha256').update(bytes).digest();
  const [returned, signed] = await account.signer.signTransaction(tx);
  if (!(returned instanceof Uint8Array) || !Buffer.from(returned).equals(digest) || !signed?.transaction ||
      !Buffer.from(transactions.encodeTransaction(signed.transaction)).equals(bytes) || signed.signature?.enum !== 'ed25519Signature' ||
      !(signed.signature.data instanceof Uint8Array) || !key.verify(digest, signed.signature.data)) {
    throw new Error('signed diagnostic setup differs from review');
  }
  return { txHash: utils.serialize.base_encode(digest), signed };
}

async function createFunded(provider, id, key) {
  // This is one helper POST per freshly generated account, never retried after
  // any ambiguous response. It creates/funds testnet accounts, not a purchase.
  const response = await fetch('https://helper.testnet.near.org/account', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newAccountId: id, newAccountPublicKey: key.getPublicKey().toString() }), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`testnet helper returned HTTP ${response.status}; do not retry this account`);
  await waitForNewTestnetKey(provider, id, key.getPublicKey());
  return waitForFinalTestnetAccount(provider, id, key.getPublicKey());
}

async function upstreamReady(provider, sessionPk, jobId, deviceHash) {
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('diagnostic requires testnet');
  const access = await provider.query({ request_type: 'view_account', account_id: YOUTICK_ACCESS, finality: 'final' });
  if (access?.code_hash !== YOUTICK_ACCESS_CODE_HASH || typeof access.block_hash !== 'string') throw new Error('access code hash changed before diagnostic');
  const block = { blockId: access.block_hash };
  const [market, state, policy, existing, verification] = await Promise.all([
    provider.query({ request_type: 'view_account', account_id: YOUTICK_MARKET, ...block }),
    provider.callFunction(YOUTICK_ACCESS, 'get_contract_state', {}, block),
    provider.callFunction(YOUTICK_ACCESS, 'get_scope_policy', { scope: 'Play' }, block),
    provider.callFunction(YOUTICK_ACCESS, 'get_session_grant', { session_pk: sessionPk }, block),
    provider.callFunction(YOUTICK_ACCESS, 'verify_session_grant', { session_pk: sessionPk, scope: 'Play', resource_id: jobId,
      origin_hash: YOUTICK_PLAY_ORIGIN_HASH, device_hash: deviceHash }, block),
  ]);
  if (market?.block_hash !== access.block_hash || market?.code_hash !== YOUTICK_V1_CODE_HASH ||
      state?.market_contract_id !== YOUTICK_MARKET || state.paused !== false || state.grant_issuance_enabled !== true ||
      !Number.isSafeInteger(policy?.max_ttl_ms) || policy.max_ttl_ms < 600_000 || policy.require_origin !== true || policy.require_device !== true ||
      existing !== null || verification?.valid !== false || verification?.owner_id !== null || verification?.reason !== 'Session grant not found') {
    throw new Error('pinned upstream access state, scope or fresh key is not ready');
  }
}

async function main() {
  if (process.env.BOUNCER_YOUTICK_GRANT_PROBE_ACK !== 'testnet-hypothetical-no-payment-once' ||
      !process.env.BOUNCER_YOUTICK_GRANT_PROBE_DIR || !process.env.BOUNCER_YOUTICK_V10_WASM) {
    throw new Error('explicit hypothetical testnet acknowledgement, fresh evidence directory and reviewed V10 artifact are required');
  }
  const dir = path.resolve(process.env.BOUNCER_YOUTICK_GRANT_PROBE_DIR), wasm = fs.readFileSync(process.env.BOUNCER_YOUTICK_V10_WASM);
  if (wasm.length < 8 || wasm.length > 1_000_000 || !wasm.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])) ||
      !wasm.includes(Buffer.from('bouncer-agent-v10-youtick-testnet'))) throw new Error('invalid reviewed testnet V10 artifact');
  const pub = fs.readFileSync(path.join(ROOT, 'bouncer/config/testnet-youtick-probe-recovery-public.pem'), 'utf8');
  if (testnetRecoveryKeyId(pub) !== KEY_ID) throw new Error('unexpected diagnostic recovery public key');
  const provider = new PaymentRpcProvider(process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com', { receiptTimeoutMs: 60_000 });
  const ownerKey = KeyPair.fromRandom('ed25519'), vaultKey = KeyPair.fromRandom('ed25519'), sessionKey = KeyPair.fromRandom('ed25519');
  const unusedAgentKey = KeyPair.fromRandom('ed25519'), suffix = crypto.randomBytes(5).toString('hex');
  const vault = `bouncer-ygrant-${suffix}.testnet`, owner = `owner-ygrant-${suffix}.testnet`, jobId = `bouncer-probe-${suffix}`;
  const deviceHash = crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex');
  const args = makeYoutickPlayGrantArgs({ vault, jobId, deviceHash, key: sessionKey });
  const vaultCodeHash = utils.serialize.base_encode(crypto.createHash('sha256').update(wasm).digest());
  const probe = validateYoutickGrantProbe({ version: 1, purpose: 'hypothetical-job-no-payment-testnet', vault, owner,
    vault_code_hash: vaultCodeHash, market_code_hash: YOUTICK_V1_CODE_HASH, access_code_hash: YOUTICK_ACCESS_CODE_HASH,
    owner_public_key: ownerKey.getPublicKey().toString(), prepared: { owner_id: owner, vault, method: 'issue_youtick_play_grant',
      deposit: '1', gas: YOUTICK_PLAY_GRANT_GAS, args } });
  // Read-only upstream checks happen before the helper can create accounts.
  await upstreamReady(provider, args.session_pk, jobId, deviceHash);
  fs.mkdirSync(dir, { mode: 0o700 }); // refuse a prior directory: never reuse a failed run
  const envelope = sealTestnetCredentials({ version: 5, purpose: 'youtick-play-grant-testnet', owner_account_id: owner, contract_id: vault,
    owner_secret: ownerKey.toString(), contract_secret: vaultKey.toString(), agent_secret: unusedAgentKey.toString(), session_secret: sessionKey.toString() }, pub);
  const journalKey = crypto.createHash('sha256').update('bouncer-youtick-probe-journal-v1\0').update(sessionKey.toString()).digest();
  let journal;
  try {
    writeExclusive(dir, 'sealed-testnet-credentials.json', envelope);
    writeExclusive(dir, 'probe.json', probe);
    writeExclusive(dir, 'identity.json', { vault, owner, vault_public_key: vaultKey.getPublicKey().toString(), owner_public_key: probe.owner_public_key,
      playback_public_key: args.session_pk, vault_code_hash: vaultCodeHash, purpose: probe.purpose });
    // Ciphertext only; availability of the separate local RSA private key is an
    // operator responsibility. Envelope creation does not authenticate origin.
    notice('Encrypted disposable YouTick diagnostic credentials', envelope);
    journal = new FileJournal(path.join(dir, 'journal.enc.json'), vault, owner, { encryptionKey: journalKey });
    const vaultState = await createFunded(provider, vault, vaultKey); writeExclusive(dir, 'vault-created.json', { account_id: vault });
    const ownerState = await createFunded(provider, owner, ownerKey); writeExclusive(dir, 'owner-created.json', { account_id: owner });
    const protocol = await provider.experimental_protocolConfig({ finality: 'final' });
    if (protocol?.runtime_config?.storage_amount_per_byte !== '10000000000000000000') throw new Error('unexpected testnet storage price');
    const storagePrice = 10n ** 19n, codeReserve = BigInt(wasm.length + 50_000) * storagePrice + ONE / 4n;
    if (BigInt(vaultState.amount) - BigInt(vaultState.storage_usage) * storagePrice < codeReserve ||
        BigInt(ownerState.amount) - BigInt(ownerState.storage_usage) * storagePrice < ONE / 2n) {
      throw new Error('testnet helper balances cannot cover diagnostic deployment and gas');
    }
    const account = (id, key) => new MonotonicAccount(id, provider, new KeyPairSigner(key));
    const vaultAccount = account(vault, vaultKey), ownerAccount = account(owner, ownerKey);
    async function submitOnce(id, signerId, signed, review) {
      const record = { kind: 'youtick-probe-transaction-v1', status: 'pending', fingerprint: fingerprint(review),
        tx_hash: signed.txHash, review };
      journal.put(id, record);
      writeExclusive(dir, `${id}-intent.json`, { id, signer_id: signerId, tx_hash: signed.txHash, review });
      console.log(`Recorded ${id} hash ${signed.txHash} before its only broadcast.`);
      try { await provider.sendTransactionUntil(signed.signed, 'FINAL'); }
      catch { console.log(`${id}: response failed or was lost; inspecting the original hash only.`); }
      let result;
      try { result = await provider.txStatusReceipts(signed.txHash, signerId, 'FINAL'); }
      catch { throw new Error(`${id} has unresolved hash ${signed.txHash}; inspect it without resending`); }
      writeExclusive(dir, `${id}-receipt.json`, result);
      return result;
    }
    function complete(id, proof) { const entry = journal.get(id); journal.put(id, { ...entry, status: 'completed', proof }); }
    const deployActions = [transactions.deployContract(wasm), transactions.functionCall('new', { owner }, 100n * TGAS, 0n),
      transactions.deleteKey(vaultKey.getPublicKey())];
    const deploy = await signReviewedProbeSetup({ account: vaultAccount, signerId: vault, publicKey: vaultKey.getPublicKey(), receiverId: vault, actions: deployActions });
    const deployResult = await submitOnce('deployment', vault, deploy, { signer_id: vault, receiver_id: vault,
      public_key: vaultKey.getPublicKey().toString(), code_hash: vaultCodeHash, owner, actions: ['deploy', 'new', 'delete_deployment_key'] });
    if (deployResult.final_execution_status !== 'FINAL' || deployResult.transaction_outcome?.id !== deploy.txHash ||
        deployResult.transaction?.hash !== deploy.txHash || deployResult.transaction?.signer_id !== vault ||
        typeof deployResult.status?.SuccessValue !== 'string' || deployResult.status?.Failure !== undefined ||
        !Array.isArray(deployResult.receipts_outcome) || !deployResult.receipts_outcome.length ||
        deployResult.receipts_outcome.some(item => item.outcome?.status?.Failure)) throw new Error('deployment did not produce complete successful FINAL receipts');
    const deployed = await provider.query({ request_type: 'view_account', account_id: vault, finality: 'final' });
    if (deployed?.code_hash !== vaultCodeHash) throw new Error('FINAL deployed vault hash differs from the built artifact');
    const block = { blockId: deployed.block_hash };
    const [version, actualOwner, keys, ownerAccess] = await Promise.all([
      provider.callFunction(vault, 'contract_version', {}, block), provider.callFunction(vault, 'get_owner', {}, block),
      provider.query({ request_type: 'view_access_key_list', account_id: vault, ...block }),
      provider.viewAccessKey(owner, ownerKey.getPublicKey(), block),
    ]);
    if (version !== 'bouncer-agent-v10-youtick-testnet' || actualOwner !== owner || !Array.isArray(keys?.keys) || keys.keys.length ||
        keys.block_hash !== deployed.block_hash || ownerAccess?.permission !== 'FullAccess') throw new Error('FINAL vault identity, locked keys or owner key differs');
    complete('deployment', { tx_hash: deploy.txHash, code_hash: vaultCodeHash, locked_vault_keys: true });
    await upstreamReady(provider, args.session_pk, jobId, deviceHash);
    const signOptions = { account: ownerAccount, publicKey: ownerKey.getPublicKey(), ownerId: owner, contractId: vault,
      method: probe.prepared.method, args, gas: GAS };
    const zero = await signReviewedCall(signOptions);
    const zeroResult = await submitOnce('zero-guard', owner, zero, { ...probe.prepared, deposit: '0' });
    const zeroProof = verifyYoutickZeroGrantProbe({ probe, result: zeroResult, txHash: zero.txHash });
    complete('zero-guard', zeroProof);
    // Do not issue the positive call unless the failed call left no grant.
    await upstreamReady(provider, args.session_pk, jobId, deviceHash);
    const grant = await signReviewedOneYoctoOwnerCall(signOptions);
    await submitOnce('grant', owner, grant, probe.prepared);
    const report = await inspectYoutickGrantProbe({ probe, provider, zeroHash: zero.txHash, grantHash: grant.txHash });
    if (!report.zero_guard?.rejected_by_one_yocto_guard || report.grant?.status !== 'GRANTED') throw new Error('diagnostic grant was not confirmed active');
    complete('grant', report.grant); writeExclusive(dir, 'report.json', report);
    notice('Hypothetical YouTick testnet owner grant proof', { vault, owner, job_id: jobId, vault_code_hash: vaultCodeHash,
      deployment_tx: deploy.txHash, zero_guard_tx: zero.txHash, grant_tx: grant.txHash, access_receipt: report.grant.access_receipt_id,
      zero_yocto_rejected: true, one_yocto_granted: true, vault_keys_removed: true,
      scope: 'no quote, FT payment, upload, publication, token, playback or delivery; access/source/RPC trust remains' });
  } finally { journal?.close(); journalKey.fill(0); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`[youtick-owner-grant-diagnostic] ${String(error.message).slice(0, 1000)}`); process.exitCode = 1; });
}
