#!/usr/bin/env node
/** Read only. Reconcile the one retained QA creation original and inspect the
 * NEXT setup state. No wallet, private key, signature, transaction or helper. */
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { buildNativeOracleWalletPlan } from '../agent/native-oracle-wallet-plan.mjs';
import { inspectNativeOracleWalletAttempt } from '../agent/native-oracle-wallet-evidence.mjs';
import { inspectNativeOracleWalletStage } from '../agent/native-oracle-wallet-preflight.mjs';
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';
import { PaymentRpcProvider } from '../agent/near-account.mjs';
import { qaReadOnlyFetch, readFinalOriginal } from './native-testnet-qa.mjs';

async function main() {
  const [bootPath, attemptPath] = process.argv.slice(2);
  if (!bootPath || !attemptPath || process.argv.length !== 4) throw new Error('two public retained artifacts required');
  const boot = JSON.parse(fs.readFileSync(bootPath, 'utf8')), original = JSON.parse(fs.readFileSync(attemptPath, 'utf8'));
  const review = boot.review, wasm = fs.readFileSync(path.resolve('bouncer.wasm'));
  const plan = buildNativeOracleWalletPlan({ wasmBytes: wasm, terms: { owner: review.owner, vault: review.vault, policy_id: review.policy_id,
    agent_public_key: review.agent_public_key, per_tx_cap_yocto: review.per_tx_cap_yocto, daily_cap_yocto: review.daily_cap_yocto,
    vault_deposit_yocto: review.vault_deposit_yocto, agent_gas_allowance_yocto: review.agent_gas_allowance_yocto } });
  if (boot.kind !== 'disposable-testnet-qa' || boot.user_wallet_used !== false || !isDeepStrictEqual(plan.review, review) ||
      original.kind !== 'disposable-qa-original' || original.stage_index !== 0 || original.review_sha256 !== review.review_sha256) {
    throw new Error('retained public QA review or original differs');
  }
  const attempt = original.attempt, trustedOriginalHash = attempt.tx_hash;
  const rpc = new PaymentRpcProvider('https://rpc.testnet.near.org', { receiptTimeoutMs: 120_000 });
  const result = await readFinalOriginal(rpc, trustedOriginalHash, review.owner);
  const proof = inspectNativeOracleWalletAttempt({ review, wasmBytes: wasm, trustedReviewHash: review.review_sha256,
    trustedOwnerPublicKey: boot.owner_public_key, attempt, trustedOriginalHash, result });
  if (proof.status !== 'FINAL_NATIVE_SETUP_RECEIPT_MATCH') throw new Error('retained creation original has not been verified as FINAL success');
  const views = new ReadOnlyNearRpcProvider('https://rpc.testnet.near.org', { timeoutMs: 30_000, fetchImpl: qaReadOnlyFetch() });
  const snapshot = await inspectNativeOracleWalletStage({ review, wasmBytes: wasm, trustedReviewHash: review.review_sha256,
    trustedOwnerPublicKey: boot.owner_public_key, stageId: review.stages[1].id,
    prior: [{ attempt, trustedOriginalHash, result }], provider: views });
  const summary = { status: proof.status, network: 'testnet', owner: review.owner, vault: review.vault,
    original_tx_hash: trustedOriginalHash, root_receipt: proof.root_receipt, next_stage_status: snapshot.status,
    next_stage_blockers: snapshot.blockers, fresh_block_hash: snapshot.block_hash, vault_state: snapshot.vault_state,
    user_wallet_used: false, provider_payment_sent: false, phone_wallet_used: false,
    scope: 'Trusted testnet RPC receipt and fresh views only. This is a disposable keyless QA deployment, not user-wallet approval or provider delivery.' };
  const output = JSON.stringify(summary);
  console.log('::notice title=Original native QA creation proof::' + output.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A'));
}
main().catch(error => {
  const safe = String(error?.message ?? 'unknown error').replace(/https?:\/\/\S+/g, '[url]').replace(/ed25519:[1-9A-HJ-NP-Za-km-z]+/g, '[key]')
    .slice(0, 600).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.error('Read-only QA inspection failed:', safe);
  console.log('::error title=Original native QA inspection stopped::' + safe);
  process.exitCode = 1;
});
