#!/usr/bin/env node
/**
 * One-shot, testnet-only recovery of the already verified original Ref input.
 * No input key exists in this process. The only credential accepted is the
 * separately scoped sweep key encrypted to an ephemeral in-memory RSA key.
 * The original journal is required and an existing sweep is never resent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import nearApi from 'near-api-js';
import { PaymentRpcProvider, MonotonicAccount } from '../agent/near-account.mjs';
import { openConfiguredFileJournal } from '../agent/procurement.mjs';
import { recoverRefSwap, runRefSweepOnly } from '../agent/ref-swap.mjs';
import { validateRefSwapGoal, REF_SWAP_OUTPUT } from '../agent/ref-swap-evidence.mjs';
import { createSweepHandoffRequest, encodeSweepHandoffRequest, decodeSweepHandoffFile, openSweepHandoff } from '../agent/ref-sweep-handoff.mjs';
import { readBoundedJson } from '../shared/bounded-json.mjs';

const REPO = 'abdullahimujeeb0505-stack/Bouncer', BRANCH = 'arena/88d70c7c-near-hub';
const ORIGINAL_HASH = 'DzWVHLp51KuoUoy8oaYNQTgLNAMgSRcegYT4mjuXCXrz';
const OUTPUT_RECEIPT = '7KEWv6Ux5EHX6R1F7ipdZmvFZKp7p6iQkpRsynXieSSX';
const OWNER = 'owner.bouncer-ref-44f619d9.testnet', VAULT = 'bouncer-ref-44f619d9.testnet', ROUTER = 'ref-router-44f619d9.testnet';
const OUTPUT = '6926';
const originalDir = process.argv[2], priorAttemptDir = process.argv[3], workDir = process.argv[4];
if (!originalDir || !priorAttemptDir || !workDir || process.argv.length !== 5 || process.env.BOUNCER_REF_SWEEP_ACK !== 'testnet-original-sweep-only') {
  throw new Error('original and prior-attempt artifacts, output directory and explicit testnet sweep-only acknowledgement are required');
}
const token = process.env.GITHUB_TOKEN, runId = process.env.GITHUB_RUN_ID;
if (!token || !/^[1-9][0-9]{0,19}$/.test(runId || '') || process.env.GITHUB_REPOSITORY !== REPO ||
    process.env.GITHUB_REF !== `refs/heads/${BRANCH}` || process.env.GITHUB_RUN_ATTEMPT !== '1' ||
    !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA || '')) throw new Error('private first-attempt GitHub Actions context required');
const provider = new PaymentRpcProvider(process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com');
const view = (id, method, args) => provider.callFunction(id, method, args, { finality: 'final' });
function find(directory, name) {
  const files = [];
  function visit(root, level) {
    if (level > 3) return;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) visit(file, level + 1);
      else if (entry.isFile() && entry.name === name) files.push(file);
    }
  }
  visit(directory, 0);
  if (files.length !== 1) throw new Error(`expected exactly one retained ${name}`);
  return files[0];
}
async function github(method, url, body, { allowNotFound = false } = {}) {
  const response = await fetch(`https://api.github.com${url}`, { method, redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub handoff HTTP ${response.status}`);
  return readBoundedJson(response, { maxBytes: 2_000_000, label: 'GitHub handoff' });
}
function write(file, value) { fs.writeFileSync(path.join(workDir, file), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); }

async function main() {
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  // Copy the immutable original, not a reconstructed or empty journal.
  const goalFile = find(originalDir, 'goal.json'), journalFile = find(originalDir, 'journal.json'), identityFile = find(originalDir, 'identity.json');
  const goal = validateRefSwapGoal(JSON.parse(fs.readFileSync(goalFile, 'utf8'))), identity = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
  if (goal.contract_id !== VAULT || goal.owner_account_id !== OWNER || goal.router_id !== ROUTER ||
      identity.contract !== VAULT || identity.owner !== OWNER || identity.router !== ROUTER || typeof identity.sweep_key !== 'string') {
    throw new Error('original reviewed trade or scoped key identity mismatch');
  }
  // The only intervening recovery attempt failed at the GitHub handoff, but
  // verify its retained journal too: never ignore a possible prepared sweep.
  const priorGoal = validateRefSwapGoal(JSON.parse(fs.readFileSync(find(priorAttemptDir, 'goal.json'), 'utf8')));
  if (JSON.stringify(priorGoal) !== JSON.stringify(goal)) throw new Error('prior recovery goal differs from the original trade');
  const prior = openConfiguredFileJournal(find(priorAttemptDir, 'journal.json'), VAULT, OWNER, { requireExisting: true });
  try {
    if (prior.get(`${goal.id}-input`)?.tx_hash !== ORIGINAL_HASH || prior.get(`${goal.id}-sweep`)) {
      throw new Error('prior recovery recorded an unexpected or existing sweep; do not send');
    }
  } finally { prior.close(); }
  if (process.env.BOUNCER_REF_SWEEP_ARTIFACT_CHECK_ONLY === '1') {
    console.log('Original and prior-attempt journals match; no sweep is recorded. Artifact-only check sent no transaction.');
    return;
  }
  fs.copyFileSync(goalFile, path.join(workDir, 'goal.json'), fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(journalFile, path.join(workDir, 'journal.json'), fs.constants.COPYFILE_EXCL);
  const journal = openConfiguredFileJournal(path.join(workDir, 'journal.json'), VAULT, OWNER, { requireExisting: true });
  let sweepHash;
  try {
    const input = journal.get(`${goal.id}-input`);
    if (input?.tx_hash !== ORIGINAL_HASH || journal.get(`${goal.id}-sweep`)) throw new Error('unexpected input or existing sweep; no new transfer allowed');
    const original = await recoverRefSwap({ goal, provider, journal, log: () => {} });
    if (original.status !== 'OUTPUT_RECEIVED' || original.swap.tx_hash !== ORIGINAL_HASH || original.swap.output_amount !== OUTPUT ||
        original.swap.output_receipt_id !== OUTPUT_RECEIPT) throw new Error('original linked Ref output did not verify exactly; no sweep allowed');
    const [access, routerBalance, vaultBalance] = await Promise.all([
      provider.viewAccessKey(OWNER, identity.sweep_key, { finality: 'final' }),
      view(REF_SWAP_OUTPUT, 'ft_balance_of', { account_id: ROUTER }), view(VAULT, 'vault_balance', { token: REF_SWAP_OUTPUT }),
    ]);
    const permission = access?.permission?.FunctionCall;
    if (!permission || permission.receiver_id !== ROUTER || JSON.stringify(permission.method_names) !== '["sweep_output"]' ||
        routerBalance !== OUTPUT || vaultBalance !== '0') throw new Error('scoped key, router balance or vault state changed; stop before handoff');
    const context = { owner_account_id: OWNER, contract_id: VAULT, router_id: ROUTER, original_hash: ORIGINAL_HASH,
      output_receipt_id: OUTPUT_RECEIPT, expected_output: OUTPUT, sweep_public_key: identity.sweep_key };
    // This repository blocks issue access for workflow tokens. Test the
    // contents-read channel before publishing the ephemeral request; only a
    // ciphertext file at this run-specific path can answer it.
    const accessible = await github('GET', `/repos/${REPO}/contents/bouncer/README.md?ref=${process.env.GITHUB_SHA}`);
    if (accessible?.type !== 'file') throw new Error('private repository contents access is unavailable');
    const responsePath = `bouncer/recovery/ref-sweep-${runId}.json`;
    const endpoint = `/repos/${REPO}/contents/${responsePath}?ref=${encodeURIComponent(BRANCH)}`;
    if (await github('GET', endpoint, undefined, { allowNotFound: true })) throw new Error('run-specific handoff file already exists; stop');
    const { request, privateKey } = createSweepHandoffRequest({ runId, context });
    // Job annotations are not available until this job ends. Publish the
    // public-only challenge as a completed GitHub Actions check instead; its
    // app, head, run-specific name, details URL and external id are verified
    // by the operator before the scoped key can be encrypted to it.
    const checkName = `Scoped Ref sweep handoff ${runId}`, details = `https://github.com/${REPO}/actions/runs/${runId}`;
    const published = await github('POST', `/repos/${REPO}/check-runs`, { name: checkName, head_sha: process.env.GITHUB_SHA,
      external_id: `bouncer-ref-sweep-${runId}`, details_url: details, status: 'completed', conclusion: 'success',
      output: { title: 'Scoped Ref sweep handoff request', summary: encodeSweepHandoffRequest(request) } });
    if (!Number.isSafeInteger(published?.id) || published.name !== checkName || published.head_sha !== process.env.GITHUB_SHA ||
        published.app?.slug !== 'github-actions') throw new Error('GitHub did not acknowledge the authenticated public handoff check');
    console.log(`::notice title=Scoped Ref sweep handoff check published::run_id=${runId}; check_id=${published.id}; no_input_key_requested=true`);
    let response;
    for (let i = 0; i < 180 && !response; i++) {
      const file = await github('GET', endpoint, undefined, { allowNotFound: true });
      if (file) response = decodeSweepHandoffFile(file, responsePath);
      else await delay(2000);
    }
    if (!response) throw new Error('no encrypted sweep-key handoff received before timeout; no sweep sent');
    const key = openSweepHandoff({ request, expected: context, response, privateKey });
    const account = new MonotonicAccount(OWNER, provider, new nearApi.KeyPairSigner(key));
    let sends = 0;
    const guarded = new Proxy(provider, { get(target, property) {
      if (property === 'sendTransactionUntil') return async (...args) => {
        const pending = journal.get(`${goal.id}-sweep`);
        if (++sends !== 1 || pending?.status !== 'pending' || typeof pending.tx_hash !== 'string') throw new Error('sweep hash was not journaled before its single send');
        sweepHash = pending.tx_hash;
        console.log(`::notice title=Original Ref sweep hash journaled::owner=${OWNER}; router=${ROUTER}; tx=${sweepHash}; original=${ORIGINAL_HASH}; never_resend=true`);
        return target.sendTransactionUntil(...args);
      };
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const result = await runRefSweepOnly({ goal, provider: guarded, sweepAccount: account, sweepPublicKey: key.getPublicKey(), journal, execute: true });
    if (sends !== 1 || result.status !== 'COMPLETED' || result.swap.tx_hash !== ORIGINAL_HASH || result.swap.output_receipt_id !== OUTPUT_RECEIPT ||
        result.vault_credit.credited !== OUTPUT || result.vault_credit.tx_hash !== sweepHash) throw new Error('original swap and sweep proof did not complete');
    const [vaultLedger, vaultToken, routerToken] = await Promise.all([
      view(VAULT, 'vault_balance', { token: REF_SWAP_OUTPUT }), view(REF_SWAP_OUTPUT, 'ft_balance_of', { account_id: VAULT }),
      view(REF_SWAP_OUTPUT, 'ft_balance_of', { account_id: ROUTER }),
    ]);
    if (vaultLedger !== OUTPUT || vaultToken !== OUTPUT || routerToken !== '0') throw new Error('vault ledger and real token balances do not reconcile');
    const proof = { original_input: ORIGINAL_HASH, output_receipt: OUTPUT_RECEIPT, sweep: sweepHash, output_micro: OUTPUT,
      vault: VAULT, router: ROUTER, vault_ledger: vaultLedger, vault_token: vaultToken, router_token: routerToken,
      same_input_reused: true, input_sends: 0, sweep_sends: sends, result,
      scope: 'testnet only; trusted RPC, Ref, token and pinned contracts; no commercial seller or production claim' };
    write('proof.json', proof);
    console.log(`::notice title=Verified guarded Ref swap and vault credit::${JSON.stringify(proof)}`);
  } finally {
    try { sweepHash ||= journal.get(`${goal.id}-sweep`)?.tx_hash; } catch { /* retained file is authoritative */ }
    try { journal.close(); } catch (error) { console.error(`Journal close requires inspection: ${error.message}`); }
    if (sweepHash) {
      try { write('sweep-receipt.json', await provider.txStatusReceipts(sweepHash, OWNER, 'FINAL')); }
      catch (error) { console.error(`Retain original sweep hash ${sweepHash}; receipt remains unresolved: ${error.message}`); }
    }
  }
}
main().catch(error => { console.error(`[original-ref-sweep] ${error.message}`); process.exitCode = 1; });
