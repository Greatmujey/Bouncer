#!/usr/bin/env node
// Deterministic, plan-driven procurement runner. It pays configured vendors;
// it does not claim to deliver compute, storage or API services, or perform AI
// quote discovery. Default mode is read-only. --execute sends real testnet txs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { validateRpcEndpoint } from '../shared/rpc-endpoint.mjs';
import { validateProviderOrigin } from '../shared/provider-origin.mjs';
import { assertFinalPaymentReceipts } from '../shared/final-payment.mjs';
import { isTransactionHash, verifyDirectPayment } from '../shared/direct-payment-settlement.mjs';
import { MonotonicAccount, PaymentRpcProvider } from './near-account.mjs';
import { canonicalClaimOrigin, signClaimAuthorization } from '../packages/provider-sdk/lib/resource-claim.mjs';
import { assertJournalScope, reserveJournal, writeJournal } from './journal-write.mjs';

const { KeyPair, KeyPairSigner, transactions, utils } = nearApi;
const DEFAULT_RPC = 'https://test.rpc.fastnear.com';
const CONTRACT_VERSIONS = new Set(['bouncer-agent-v4', 'bouncer-agent-v5', 'bouncer-agent-v6', 'bouncer-agent-v7', 'bouncer-agent-v8', 'bouncer-agent-v9']);
const U128_MAX = (1n << 128n) - 1n;
const GAS = 200_000_000_000_000n;
const EXPLORER = hash => `https://testnet.nearblocks.io/txns/${hash}?network=testnet`;

function text(value, name, max = 128) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max) {
    throw new Error(`${name} must be a nonempty string of at most ${max} bytes`);
  }
  return value;
}

export function validatePlan(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('plan must be an object');
  const contractId = text(input.contract_id, 'contract_id', 64);
  const ownerId = text(input.owner_account_id, 'owner_account_id', 64);
  // This prototype intentionally refuses mainnet. Both account IDs are
  // explicitly testnet accounts; token IDs may also be implicit accounts.
  if (!contractId.endsWith('.testnet') || !ownerId.endsWith('.testnet')) {
    throw new Error('only .testnet contract and owner accounts are supported');
  }
  if (!Array.isArray(input.requests) || input.requests.length === 0 || input.requests.length > 100) {
    throw new Error('requests must be a nonempty array of at most 100 entries');
  }
  const ids = new Set();
  const requests = input.requests.map((request, index) => {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error(`request ${index} must be an object`);
    const id = text(request.id, `requests[${index}].id`, 64);
    if (!/^[A-Za-z0-9_-]+$/.test(id) || ids.has(id)) throw new Error(`invalid or duplicate request id: ${id}`);
    ids.add(id);
    const resource = text(request.resource, `${id}.resource`, 64);
    const policyId = text(request.policy_id, `${id}.policy_id`, 128);
    const token = text(request.token, `${id}.token`, 64);
    if (token === 'native') throw new Error(`${id}.token is native NEAR; use the dedicated OutLayer runner`);
    const payee = text(request.payee, `${id}.payee`, 64);
    if (typeof request.amount !== 'string' || !/^[0-9]+$/.test(request.amount)) {
      throw new Error(`${id}.amount must be a decimal string in the token's smallest units`);
    }
    const amount = BigInt(request.amount);
    if (amount <= 0n || amount > U128_MAX) throw new Error(`${id}.amount is outside the supported range`);
    const memo = request.memo === undefined ? `bouncer:${resource}:${id}` : text(request.memo, `${id}.memo`, 256);
    if (Buffer.byteLength(memo) > 256) throw new Error(`${id}.memo must be at most 256 bytes`);
    return { id, resource, policy_id: policyId, token, payee, amount: amount.toString(), memo };
  });
  return { contract_id: contractId, owner_account_id: ownerId, requests };
}

/** Validate the locally pinned route attached to a resource payment. */
export function normalizeProviderRoute(route) {
  if (!route || typeof route !== 'object' || Array.isArray(route) || Object.keys(route).length !== 2 ||
      !Object.hasOwn(route, 'provider_id') || !Object.hasOwn(route, 'provider_origin') ||
      !(route.provider_id === null || (typeof route.provider_id === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(route.provider_id)))) {
    throw new Error('invalid recorded provider route');
  }
  if (route.provider_origin !== null) validateProviderOrigin(route.provider_origin);
  return { provider_id: route.provider_id, provider_origin: route.provider_origin };
}

/** Fingerprint a request already normalized by validatePlan. */
export function requestFingerprint(request) {
  return crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
}


/**
 * Run preflight checks and optionally execute a plan. `journal` exposes
 * get(id) and put(id, entry); every live payment is marked pending BEFORE it
 * is sent. An unresolved pending entry is never retried automatically.
 */
export async function runProcurement(options) {
  // The shared journal's owner fence must cover nonce preparation and signing,
  // not just the later database insert. It stays held until this batch returns;
  // any unresolved hash blocks other participating journals for the owner.
  if (options?.execute && options?.journal?.sharedDirectV3 === true) {
    if (typeof options.journal.withOwnerFence !== 'function') throw new Error('shared buyer owner payment fence is required');
    return options.journal.withOwnerFence(() => runProcurementCore(options));
  }
  return runProcurementCore(options);
}

async function runProcurementCore({ plan: rawPlan, provider, account, publicKey, journal, journalRoutes, claimOrigins, execute = false,
  durablePayment = false, log = console.log, onCheck = () => {}, beforePayment = async () => {}, beforeBroadcast = () => {}, beforeBroadcastCheckpoint,
  onPaid = async () => {}, stopOnBlocked = false }) {
  const plan = validatePlan(rawPlan);
  if (typeof beforePayment !== 'function' || typeof beforeBroadcast !== 'function' || typeof onPaid !== 'function' || typeof stopOnBlocked !== 'boolean' || typeof durablePayment !== 'boolean' ||
      (beforeBroadcastCheckpoint !== undefined && (typeof beforeBroadcastCheckpoint !== 'function' || !execute || !durablePayment || journal?.sharedDirectV3 !== true))) {
    throw new Error('invalid procurement execution hooks');
  }
  let routes;
  if (journalRoutes !== undefined) {
    if (!(journalRoutes instanceof Map) || journalRoutes.size !== plan.requests.length) throw new Error('invalid payment journal routes');
    routes = new Map();
    for (const request of plan.requests) {
      if (!journalRoutes.has(request.id)) throw new Error('missing payment journal route');
      routes.set(request.id, normalizeProviderRoute(journalRoutes.get(request.id)));
    }
  }
  const claims = new Map();
  if (claimOrigins !== undefined) {
    if (!(claimOrigins instanceof Map) || !routes) throw new Error('authenticated claims require reviewed provider routes');
    for (const [id, origin] of claimOrigins) {
      const request = plan.requests.find(item => item.id === id), route = routes.get(id);
      if (!request || !['compute', 'storage', 'api'].includes(request.resource) || !route?.provider_origin || canonicalClaimOrigin(origin) !== origin ||
          validateProviderOrigin(route.provider_origin).origin !== origin ||
          !new RegExp(`^bouncer-order-v3:${request.resource}:[a-f0-9]{32}:[a-f0-9]{64}$`).test(request.memo)) {
        throw new Error('authenticated claim does not match the reviewed request and origin');
      }
      claims.set(id, origin);
    }
    if (execute && claims.size && !durablePayment) throw new Error('authenticated claims require durable signed-hash journaling');
    if (execute && claims.size && typeof journal?.list !== 'function') throw new Error('authenticated claims require the original listable exclusive journal');
  }
  for (const request of plan.requests) {
    if (request.memo.startsWith('bouncer-order-v3:') && !claims.has(request.id)) {
      throw new Error(`${request.id}: seller-v3 memo requires its reviewed authenticated claim origin`);
    }
  }
  assertJournalScope(journal, plan.contract_id, plan.owner_account_id);
  if (journal?.sharedDirectV3 === true) {
    if (execute && !durablePayment) throw new Error('shared buyer execution requires durable signed-hash payments');
    if (claims.size !== plan.requests.length) throw new Error('shared buyer supports only authenticated seller-v3 direct payments');
    if (plan.requests.some(request => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(request.id))) throw new Error('invalid shared buyer request ID');
  }
  if (!account || account.accountId !== plan.owner_account_id) throw new Error('agent key account does not match the plan owner');
  if (execute && !journal) throw new Error('a journal is required for live execution');
  // A .testnet-looking account ID is not proof of the RPC's chain. This is
  // still a trust assumption: a malicious RPC can lie about its chain_id.
  const status = await provider.viewNodeStatus();
  if (status?.chain_id !== 'testnet') throw new Error('RPC must report the NEAR testnet chain');
  const version = await provider.callFunction(plan.contract_id, 'contract_version', {}, { finality: 'final' });
  if (!CONTRACT_VERSIONS.has(version)) throw new Error(`unsupported contract version: ${version || 'unknown'}`);
  const access = await provider.viewAccessKey(plan.owner_account_id, publicKey, { finality: 'final' });
  const permission = access.permission?.FunctionCall;
  if (!permission || permission.receiver_id !== plan.contract_id ||
      JSON.stringify(permission.method_names) !== JSON.stringify(['execute'])) {
    throw new Error('agent key must be a function-call key scoped ONLY to execute on this contract');
  }

  const totals = { paid: 0, blocked: 0, skipped: 0, ready: 0 };
  let stopNewPayments = false;
  for (const request of plan.requests) {
    const hash = requestFingerprint(request);
    const previous = journal?.get(request.id);
    if (previous && previous.fingerprint !== hash) throw new Error(`${request.id}: journal entry does not match the request`);
    if (previous?.status === 'completed') {
      onCheck({ id: request.id, status: 'SKIPPED' });
      log(`[procurement] SKIP ${request.id}: already paid (${previous.tx_hash})`);
      totals.skipped++;
      continue;
    }
    if (previous) {
      throw new Error(`${request.id}: unresolved pending payment; inspect the chain and journal before retrying`);
    }
    if (stopNewPayments) {
      onCheck({ id: request.id, status: 'DEFERRED', reason: 'A previous execution-time policy check blocked the batch.' });
      log(`[procurement] DEFERRED ${request.id}: no payment submitted after an earlier block`);
      totals.deferred = (totals.deferred || 0) + 1;
      continue;
    }

    const policy = await provider.callFunction(plan.contract_id, 'get_policy', { policy_id: request.policy_id }, { finality: 'final' });
    if (!policy || policy.token !== request.token) {
      throw new Error(`${request.id}: expected token does not match the on-chain policy`);
    }
    const allowed = await provider.callFunction(plan.contract_id, 'is_agent_key_allowed', {
      policy_id: request.policy_id, public_key: publicKey.toString(),
    }, { finality: 'final' });
    if (allowed !== true) throw new Error(`${request.id}: agent key is not granted to this policy`);
    const decision = await provider.callFunction(plan.contract_id, 'check', {
      policy_id: request.policy_id, payee: request.payee, amount: request.amount,
    }, { finality: 'final' });
    if (!Array.isArray(decision) || typeof decision[0] !== 'boolean') throw new Error(`${request.id}: invalid policy verdict`);
    if (!decision[0]) {
      onCheck({ id: request.id, status: 'BLOCKED', reason: decision[1] });
      log(`[procurement] BLOCKED ${request.id} (${request.resource}): ${decision[1]}`);
      totals.blocked++;
      if (execute && stopOnBlocked) stopNewPayments = true;
      continue;
    }
    if (!execute) {
      onCheck({ id: request.id, status: 'READY' });
      log(`[procurement] READY ${request.id} (${request.resource}): ${request.amount} ${request.token} → ${request.payee} (dry run)`);
      totals.ready++;
      continue;
    }
    // A mutable vendor balance is not a transaction receipt: other buyers can
    // pay or the vendor can spend between views. The durable path verifies the
    // exact FINAL receipt graph instead; the legacy path retains its old check.
    const before = durablePayment ? null : BigInt(await provider.callFunction(request.token, 'ft_balance_of', { account_id: request.payee }, { finality: 'final' }));
    // Persist the exact normalized request before sending. The opt-in signed
    // path additionally fsyncs the signed transaction hash BEFORE its one
    // broadcast. It never stores the key or signed transaction bytes.
    const args = { policy_id: request.policy_id, payee: request.payee, amount: request.amount,
      memo: request.memo, expected_token: request.token };
    let pending = { fingerprint: hash, status: 'pending', request,
      ...(routes ? { provider_route: routes.get(request.id) } : {}), started_at: new Date().toISOString() };
    let txHash, signed;
    if (durablePayment) {
      if (!account.signer || typeof account.createTransaction !== 'function' ||
          String(await account.signer.getPublicKey()) !== String(publicKey)) throw new Error('signer does not match the reviewed agent key');
      if (typeof provider.sendTransactionUntil !== 'function' || typeof provider.txStatusReceipts !== 'function') throw new Error('durable payment requires signed broadcast and receipt-inclusive RPC');
      const transaction = await account.createTransaction(plan.contract_id, [transactions.functionCall('execute', args, GAS, 0n)], publicKey);
      const action = transaction?.actions?.[0]?.functionCall, reviewedKey = utils.PublicKey.from(String(publicKey));
      if (transaction?.signerId !== plan.owner_account_id || transaction.receiverId !== plan.contract_id ||
          String(transaction.publicKey) !== String(publicKey) || !Array.isArray(transaction.actions) || transaction.actions.length !== 1 ||
          transaction.actions[0]?.enum !== 'functionCall' || action?.methodName !== 'execute' || action.gas !== GAS || action.deposit !== 0n ||
          !Buffer.from(action.args || []).equals(Buffer.from(JSON.stringify(args)))) throw new Error('prepared transaction does not match the reviewed payment');
      // Compute the hash independently, and ensure the actual signed payload and
      // signature match the prepared request before journaling or broadcasting.
      const unsigned = Buffer.from(transactions.encodeTransaction(transaction));
      const digest = crypto.createHash('sha256').update(unsigned).digest();
      const [bytes, signedTransaction] = await account.signer.signTransaction(transaction);
      if (!(bytes instanceof Uint8Array) || !Buffer.from(bytes).equals(digest) || !signedTransaction?.transaction ||
          !Buffer.from(transactions.encodeTransaction(signedTransaction.transaction)).equals(unsigned) ||
          !reviewedKey.verify(digest, signedTransaction.signature?.data)) throw new Error('signed transaction does not match the reviewed payment');
      txHash = utils.serialize.base_encode(bytes);
      if (!isTransactionHash(txHash)) throw new Error('invalid signed transaction hash');
      signed = signedTransaction;
      pending = { ...pending, payment_version: 'direct-signed-v1', agent_public_key: String(publicKey), tx_hash: txHash };
      if (claims.has(request.id)) {
        // An off-chain NEP-413 signature by the same restricted key binds the
        // claim to this reviewed transaction and seller. Persist it BEFORE the
        // only broadcast so recovery needs no signing key. Treat the journal
        // as private: the signature is a replayable bearer credential.
        const terms = { network: 'near:testnet', contract_id: plan.contract_id, owner_account_id: plan.owner_account_id,
          seller_origin: claims.get(request.id), resource: request.resource, policy_id: request.policy_id, token: request.token,
          payee: request.payee, amount: request.amount, memo: request.memo, tx_hash: txHash };
        const authorization = await signClaimAuthorization({ terms, signer: account.signer, publicKey });
        pending = { ...pending, resource_authorization: authorization };
      }
    }
    // A mission may impose an additional time-sensitive condition. Check it
    // immediately before journaling/broadcasting each *new* payment, not just
    // once at batch preview. A rejection here leaves no pending entry; no
    // signed bytes have been broadcast or persisted.
    await beforePayment(Object.freeze({ ...request }));
    // Recheck after asynchronous signing. A file journal reserves synchronously;
    // the shared journal additionally performs an atomic, awaited DB insert.
    // Its unique request/challenge/hash constraints are the authority if two
    // workers (or two calls on the same journal) race.
    if (journal.get(request.id)) throw new Error(`${request.id}: journal entry appeared during payment preparation; recover it instead of paying`);
    if (claims.has(request.id)) {
      const challenge = /^bouncer-order-v3:(?:compute|storage|api):([a-f0-9]{32}):[a-f0-9]{64}$/.exec(request.memo)?.[1];
      if (!challenge || journal.list().some(entry => {
        if (entry?.id === request.id || typeof entry?.request?.memo !== 'string') return false;
        const prior = /^bouncer-order-v[23]:(?:compute|storage|api):([a-f0-9]{32}):[a-f0-9]{64}$/.exec(entry.request.memo);
        return prior?.[1] === challenge;
      })) throw new Error(`${request.id}: seller challenge is already recorded in this journal; never pay again`);
    }
    await reserveJournal(journal, request.id, pending);
    // Optional shared-buyer checkpointing must finish before the final
    // synchronous guard and the only broadcast. Failure leaves the original
    // pending hash quarantined; it never authorizes a replacement payment.
    if (beforeBroadcastCheckpoint) {
      try { await beforeBroadcastCheckpoint(Object.freeze({ id: request.id, tx_hash: txHash })); }
      catch { throw new Error(`${request.id}: encrypted checkpoint failed before broadcast; no payment was sent; preserve the pending journal and reconcile`); }
    }
    if (journal?.sharedDirectV3 === true) {
      if (typeof journal.assertPendingForBroadcast !== 'function') throw new Error(`${request.id}: shared journal pre-broadcast fence is required; no payment was sent`);
      try { await journal.assertPendingForBroadcast(request.id, txHash); }
      catch { throw new Error(`${request.id}: shared journal pre-broadcast check failed; no payment was sent; preserve the pending hash and reconcile`); }
    }
    // A synchronous final guard can enforce a time-sensitive condition after
    // fsync but immediately before submission. If it rejects, nothing was sent;
    // retain the pending hash conservatively rather than inventing a retry.
    try {
      const verdict = beforeBroadcast(Object.freeze({ ...request }));
      if (verdict && typeof verdict.then === 'function') {
        Promise.resolve(verdict).catch(() => {}); // do not leak a rejected async hook
        throw new Error('pre-broadcast guard must be synchronous');
      }
    } catch (error) {
      throw new Error(`${request.id}: pre-broadcast guard rejected after journal write; no payment was sent, retain the pending entry and reconcile: ${error.message}`, { cause: error });
    }
    try {
      const result = durablePayment
        ? await provider.sendTransactionUntil(signed, 'FINAL')
        : await account.callFunctionRaw({ contractId: plan.contract_id, methodName: 'execute', args, deposit: 0n, gas: GAS, waitUntil: 'FINAL' });
      const candidateHash = result?.transaction_outcome?.id;
      if (durablePayment && candidateHash !== txHash) throw new Error('RPC returned a different or missing transaction hash');
      if (!durablePayment && typeof candidateHash === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(candidateHash)) txHash = candidateHash;
      if (!durablePayment && txHash) await writeJournal(journal, request.id, { ...pending, tx_hash: txHash });
      let settlement;
      if (durablePayment) {
        const chain = await provider.txStatusReceipts(txHash, plan.owner_account_id, 'FINAL');
        settlement = verifyDirectPayment({ result: chain, contractId: plan.contract_id, ownerAccountId: plan.owner_account_id,
          request, publicKey: String(publicKey), txHash });
      } else assertFinalPaymentReceipts(result, request.token);
      if (typeof txHash !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(txHash)) throw new Error('invalid transaction hash');
      if (!durablePayment) {
        const after = BigInt(await provider.callFunction(request.token, 'ft_balance_of', { account_id: request.payee }, { finality: 'final' }));
        if (after !== before + BigInt(request.amount)) throw new Error('vendor balance delta did not match the payment');
      }
      await writeJournal(journal, request.id, { ...pending, status: 'completed', tx_hash: txHash, ...(settlement ? { settlement } : {}), completed_at: new Date().toISOString() });
      log(`[procurement] PAID ${request.id} (${request.resource}): ${request.amount} ${request.token} → ${request.payee} ${EXPLORER(txHash)}`);
      totals.paid++;
    } catch (error) {
      // A network timeout or failure may happen after broadcast. Keep pending:
      // retrying blindly could pay twice. The owner must reconcile manually.
      const errorHash = error?.transaction_outcome?.id;
      if (!txHash && typeof errorHash === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(errorHash)) {
        txHash = errorHash;
        await writeJournal(journal, request.id, { ...pending, tx_hash: txHash });
      }
      const reference = txHash ? ` (tx ${txHash})` : '';
      throw new Error(`${request.id}: payment could not be confirmed${reference}; journal may be pending or uncertain, do not retry automatically: ${error.message}`, { cause: error });
    }
    // Payment and its journal entry are already confirmed. Delivery failures
    // must not be mislabeled as uncertain payments, and must stop the loop
    // before any later request can be sent.
    await onPaid({ id: request.id, tx_hash: txHash });
  }
  return totals;
}

/** Atomic local journal and exclusive lock; not a distributed idempotency system. */
export class FileJournal {
  constructor(file, contractId, ownerId) {
    this.file = path.resolve(file);
    this.lockFile = `${this.file}.lock`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.lockFd = fs.openSync(this.lockFile, 'wx', 0o600);
    this.failed = false;
    try {
      this.data = fs.existsSync(this.file)
        ? JSON.parse(fs.readFileSync(this.file, 'utf8'))
        : { version: 1, contract_id: contractId, owner_account_id: ownerId, entries: [] };
      if (this.data.version !== 1 || this.data.contract_id !== contractId ||
          this.data.owner_account_id !== ownerId || !Array.isArray(this.data.entries)) {
        throw new Error('journal belongs to a different contract/account or has an invalid format');
      }
      const ids = new Set();
      for (const entry of this.data.entries) {
        if (!entry || typeof entry.id !== 'string' || ids.has(entry.id) ||
            !['pending', 'completed'].includes(entry.status) || typeof entry.fingerprint !== 'string' ||
            (entry.status === 'completed' && typeof entry.tx_hash !== 'string')) {
          throw new Error('journal contains invalid or duplicate entries');
        }
        if (entry.provider_route !== undefined) normalizeProviderRoute(entry.provider_route);
        if (entry.request !== undefined) {
          let recorded;
          try { recorded = validatePlan({ contract_id: contractId, owner_account_id: ownerId, requests: [entry.request] }).requests[0]; }
          catch { throw new Error('journal contains an invalid recorded request'); }
          if (recorded.id !== entry.id || requestFingerprint(recorded) !== entry.fingerprint) {
            throw new Error('journal recorded request does not match its fingerprint');
          }
        }
        ids.add(entry.id);
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }
  assertAvailable() {
    if (this.lockFd === null) throw new Error('journal is closed');
    if (this.failed) throw new Error('journal has a failed write; close, reopen and reconcile it before continuing');
  }
  get(id) { this.assertAvailable(); return this.data.entries.find(entry => entry.id === id); }
  // A snapshot lets protocols reject reused seller challenges across this
  // journal without handing callers a mutable reference to its entries.
  list() { this.assertAvailable(); return structuredClone(this.data.entries); }
  put(id, entry) {
    this.assertAvailable();
    if (typeof id !== 'string' || !id || !entry || typeof entry !== 'object' || Array.isArray(entry) ||
        (Object.hasOwn(entry, 'id') && entry.id !== id)) throw new Error('journal entry ID does not match its key');
    const index = this.data.entries.findIndex(item => item.id === id);
    const entries = this.data.entries.slice();
    const next = { ...entry, id };
    if (index === -1) entries.push(next); else entries[index] = next;
    const data = { ...this.data, entries };
    const temp = `${this.file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      const fd = fs.openSync(temp, 'wx', 0o600);
      try {
        fs.fchmodSync(fd, 0o600);
        fs.writeFileSync(fd, JSON.stringify(data, null, 2) + '\n');
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(temp, this.file);
      // Persist the directory entry too. If either sync fails, stop before the
      // next broadcast; a renamed file may already contain the newer state.
      const directoryFd = fs.openSync(path.dirname(this.file), 'r');
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      this.data = data;
    } catch (error) {
      // The rename may have succeeded even if directory synchronization did
      // not. Never keep using a possibly stale in-memory journal after error.
      this.failed = true;
      throw error;
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }
  close() {
    if (this.lockFd !== null) {
      fs.closeSync(this.lockFd);
      this.lockFd = null;
      fs.unlinkSync(this.lockFile);
    }
  }
}

function parseArgs(args) {
  const out = { execute: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--execute') out.execute = true;
    else if (arg === '--durable') out.durable = true;
    else if (arg === '--help') out.help = true;
    else if (['--plan', '--key', '--state', '--rpc'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) {
      out[arg.slice(2)] = args[++i];
    } else throw new Error(`unknown or incomplete argument: ${arg}`);
  }
  return out;
}
function expandHome(value) { return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value; }
export function createRuntime({ plan: rawPlan, keyFile, rpc }) {
  const plan = validatePlan(rawPlan);
  const rpcUrl = validateRpcEndpoint(rpc || process.env.NEAR_TESTNET_RPC || DEFAULT_RPC);
  const credentials = JSON.parse(fs.readFileSync(expandHome(keyFile), 'utf8'));
  if (credentials.account_id !== plan.owner_account_id || typeof credentials.private_key !== 'string') {
    throw new Error('agent key file does not match owner_account_id');
  }
  const key = KeyPair.fromString(credentials.private_key);
  const provider = new PaymentRpcProvider(rpcUrl);
  const account = new MonotonicAccount(plan.owner_account_id, provider, new KeyPairSigner(key));
  return { provider, account, publicKey: key.getPublicKey() };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node bouncer/agent/procurement.mjs --plan PLAN.json --key AGENT_KEY.json [--state JOURNAL.json] [--rpc URL] [--execute] [--durable]');
    console.log('Dry run by default. --execute submits real testnet payments. --durable records the signed hash before broadcasting.');
    return;
  }
  if (!options.plan || !options.key) throw new Error('provide --plan and --key; use --help for usage');
  const planPath = path.resolve(expandHome(options.plan));
  const plan = validatePlan(JSON.parse(fs.readFileSync(planPath, 'utf8')));
  const { provider, account, publicKey } = createRuntime({ plan, keyFile: options.key, rpc: options.rpc });
  const journalPath = path.resolve(expandHome(options.state || `${planPath}.bouncer-journal.json`));
  const journal = options.execute ? new FileJournal(journalPath, plan.contract_id, plan.owner_account_id) : null;
  try {
    console.log(`[procurement] ${options.execute ? 'LIVE TESTNET' : 'DRY RUN'} on ${plan.contract_id}; ${plan.requests.length} request(s)`);
    const totals = await runProcurement({ plan, provider, account, publicKey, journal, execute: options.execute, durablePayment: options.durable === true });
    console.log(`[procurement] paid=${totals.paid} blocked=${totals.blocked} skipped=${totals.skipped} ready=${totals.ready}`);
    if (options.execute) console.log(`[procurement] journal: ${journalPath}`);
    if (totals.blocked > 0) process.exitCode = 2;
  } finally {
    journal?.close();
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`[procurement] ERROR: ${error.message}`); process.exitCode = 1; });
}
