#!/usr/bin/env node
/**
 * Compatibility experiment only: run the official near-cli-rs offline with a
 * synthetic account, dummy public key and all-zero reference block. Compare the
 * exact UNSIGNED bytes to the existing reviewed Buffer plan. This deliberately
 * has no signing, network client, journal, broadcast or live execution mode.
 * In particular, it is not a plan to run against a real wallet or proof of
 * wallet control, agent authorization, deployment, or seller delivery.
 *
 * Usage: node scripts/test-near-cli-buffer-offline.mjs /path/to/near /path/to/v12.wasm
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import nearApi from 'near-api-js';
import { buildBufferWalletSetup, assertBufferWalletBatchMatchesReview } from '../agent/buffer-wallet-setup-plan.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE } from './circle-testnet-setup.mjs';
import { BUFFER_TESTNET_CONTRACT as SELLER } from '../experiments/buffer-forwarder/build.mjs';
import { CIRCLE_TESTNET_CODE_HASH, VAULT_NATIVE_FUNDING_YOCTO } from '../agent/keyless-vault-v12-readiness.mjs';

if (process.argv.length !== 4) throw new Error('usage: node scripts/test-near-cli-buffer-offline.mjs NEAR V12.wasm');
const near = path.resolve(process.argv[2]), wasmPath = path.resolve(process.argv[3]);
for (const file of [near, wasmPath]) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size < 1 || stat.size > 200_000_000) throw new Error('bounded regular files required');
}
const wasm = fs.readFileSync(wasmPath);
const OWNER = 'cli-offline-bouncer-testcase.testnet';
const VAULT = `vault.${OWNER}`;
// Published near-cli-rs test fixture, NOT a key belonging to any wallet.
const PUBLIC_KEY = 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp';
const ZERO_BLOCK = '11111111111111111111111111111111';
const nonce = 1n, now = Date.now();
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const allChecks = ['named_owner_has_no_local_or_global_code', 'owner_has_full_access_key', 'owner_circle_registered',
  'reviewed_circle_code_and_metadata', 'new_direct_child_absent', 'child_not_already_circle_registered',
  'circle_registration_cost_bounded', 'protocol_and_selected_features', 'owner_native_estimate', 'vault_native_estimate',
  'buffer_accepts_circle_and_is_registered', 'fixed_product_active', 'owner_balance_covers_fixed_price'];
// These are fabricated inputs solely for constructing a deterministic fixture.
// They MUST NOT be interpreted as on-chain balances or a fresh preflight.
const snapshot = { version: 1, network: 'testnet', owner: OWNER, candidate_vault: VAULT,
  block_hash: nearApi.utils.serialize.base_encode(Buffer.alloc(32, 9)),
  block_timestamp_nanosec: String(BigInt(now) * 1_000_000n), circle_token: CIRCLE,
  circle_code_hash: CIRCLE_TESTNET_CODE_HASH, owner_circle_atoms: '20000000',
  circle_registration_min_yocto: '1250000000000000000000', planned_vault_native_yocto: VAULT_NATIVE_FUNDING_YOCTO,
  checks: Object.fromEntries(allChecks.map(key => [key, true])), blockers: [], wallet_control_proven: false,
  wallet_approval_obtained: false, signer_present: false, signed: false, sent: false, vault_deployed: false,
  seller_contacted: false, quote_or_order_created: false, independently_fulfilled: false,
  seller: { account_id: SELLER, token: CIRCLE, paused: false, circle_registered: true,
    code_hash: nearApi.utils.serialize.base_encode(Buffer.alloc(32, 8)),
    fixed_products: [{ sku: 'weekly-market-brief', active: true, price_atoms: '20000000' }] } };
const plan = buildBufferWalletSetup({ snapshot, wasmBytes: wasm, nowMs: now });

// Decimal integer arithmetic only: never round the 1 yocto deposit or storage.
function nearAmount(value) {
  const n = BigInt(value), whole = n / (10n ** 24n), rest = n % (10n ** 24n);
  const fraction = rest.toString().padStart(24, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''} NEAR`;
}
function gasAmount(value) {
  const n = BigInt(value);
  if (n % (10n ** 12n)) throw new Error('fixture gas must be whole Tgas');
  return `${n / (10n ** 12n)} Tgas`;
}
function callArgs(action) {
  if (action?.enum !== 'functionCall') throw new Error('expected fixture function call');
  const call = action.functionCall;
  // Supplying already serialized bytes avoids differences in JSON key order.
  return [call.methodName, 'base64-args', Buffer.from(call.args).toString('base64'),
    'prepaid-gas', gasAmount(call.gas), 'attached-deposit', nearAmount(call.deposit)];
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-cli-offline-'));
try {
  const isolated = path.join(temp, 'home'); fs.mkdirSync(isolated, { mode: 0o700 });
  const env = { ...process.env, HOME: isolated, XDG_CONFIG_HOME: isolated, APPDATA: isolated,
    TMPDIR: temp, TMP: temp, TEMP: temp, NO_COLOR: '1', TERM: 'dumb' };
  const cli = (args) => {
    const result = spawnSync(near, args, { env, encoding: 'utf8', timeout: 30_000, maxBuffer: 100_000, stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.error || result.status !== 0) throw new Error(`official CLI offline command failed (status ${result.status}): ${(result.stderr || result.error?.message || '').slice(0, 1800)}`);
    return result.stdout;
  };
  const version = cli(['--version']).trim();
  if (!/^near(-cli-rs)? 0\.31\.1\b/.test(version)) throw new Error(`unexpected official CLI version: ${version}`);
  const output = [];
  for (let i = 0; i < plan.batches.length; i++) {
    const batch = plan.batches[i], reviewed = plan.review.stages[i];
    assertBufferWalletBatchMatchesReview(batch, reviewed);
    let actions;
    if (i === 0) {
      const [create, transfer, deploy, init] = batch.actions;
      assert.deepEqual([create.enum, transfer.enum, deploy.enum, init.enum], ['createAccount', 'transfer', 'deployContract', 'functionCall']);
      actions = ['add-action', 'create-account', 'add-action', 'transfer', nearAmount(transfer.transfer.deposit),
        'add-action', 'deploy', 'use-file', wasmPath, 'with-init-call', ...callArgs(init)];
    } else {
      assert.equal(batch.actions.length, 1);
      actions = ['add-action', 'function-call', ...callArgs(batch.actions[0])];
    }
    const file = path.join(temp, `stage-${i}.json`);
    const args = ['--offline', '--quiet', 'transaction', 'construct-transaction', batch.signerId, 'receiver-id', batch.receiverId,
      ...actions, 'skip', 'network-config', 'testnet', 'sign-later', '--signer-public-key', PUBLIC_KEY,
      '--nonce', String(nonce), '--block-hash', ZERO_BLOCK, 'save-to-file', file];
    // Refuse any accidental change from the permanently non-signing route.
    assert(args.includes('--offline') && args.includes('sign-later'));
    assert(!args.includes('send') && !args.includes('sign-with-keychain'));
    cli(args);
    const fileStat = fs.statSync(file);
    if (!fileStat.isFile() || fileStat.size < 1 || fileStat.size > 1_000_000) throw new Error('invalid bounded unsigned CLI output');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const encoded = parsed['Unsigned transaction (serialized as base64)'];
    if (typeof encoded !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error('invalid CLI unsigned transaction output');
    }
    const actual = Buffer.from(encoded, 'base64');
    if (actual.toString('base64') !== encoded) throw new Error('noncanonical CLI base64');
    const expected = Buffer.from(nearApi.transactions.encodeTransaction(nearApi.transactions.createTransaction(
      batch.signerId, nearApi.utils.PublicKey.from(PUBLIC_KEY), batch.receiverId, nonce, batch.actions, Buffer.alloc(32))));
    if (!actual.equals(expected) || parsed['Transaction hash to sign'] !== hash(expected)) {
      throw new Error(`official CLI unsigned bytes differ from the reviewed ${batch.id} fixture`);
    }
    output.push({ stage: batch.id, action_commitment_sha256: reviewed.action_commitment_sha256,
      cli_unsigned_bytes: actual.length, byte_for_byte_match: true });
  }
  console.log(JSON.stringify({ cli_version: version, network_configuration: 'testnet', synthetic_account: OWNER,
    stages: output, all_exact: true, dummy_block_hash: true, dummy_public_key: true,
    cli_offline_flag_used: true, cli_update_check_possible: true, signed: false, broadcast: false, ownership_proven: false,
    scope: 'Offline serialization compatibility only. No real account action, approval, vault deployment or delivery.' }));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
