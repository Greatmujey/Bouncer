import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import nearApi from 'near-api-js';
import { buildUnsignedSvalinTrialSetup, unsignedSvalinBatchCommitment, assertSvalinBatchMatchesReview } from '../agent/svalin-setup-plan.mjs';
import { CIRCLE_TESTNET_USDC } from '../scripts/circle-testnet-setup.mjs';
import { SVALIN_PAYEE } from '../agent/svalin-pro-readiness.mjs';

const names = [
  'new', 'contract_version', 'get_owner', 'get_policy', 'set_policy', 'allow_payee',
  'grant_agent_key', 'is_agent_key_allowed', 'lock_ft_policy_to_intents', 'is_exact_ft_policy_locked',
  'is_exact_ft_payee_locked', 'set_exact_ft_intent', 'get_exact_ft_intent', 'execute_exact_ft',
  'after_exact_ft_transfer', 'ft_on_transfer', 'vault_balance', 'daily_spent', 'check', 'withdraw',
];
const marker = 'bouncer-agent-v11-exact-ft-testnet';
const cli = fileURLToPath(new URL('../agent/svalin-setup-plan.mjs', import.meta.url));
const codeHash = bytes => nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(bytes).digest());
function leb(value) {
  const result = [];
  do { let next = value & 127; value >>>= 7; if (value) next |= 128; result.push(next); } while (value);
  return result;
}
function section(id, payload) { return [id, ...leb(payload.length), ...payload]; }
// Deliberately harmless stub: all function exports point to the same empty
// body. This proves marker/export/hash checks are NOT a behavioral audit.
function stubWasm({ exportNames = names, versionMarker = marker } = {}) {
  const exported = exportNames.flatMap(name => { const b = [...Buffer.from(name)]; return [...leb(b.length), ...b, 0, 0]; });
  const out = Buffer.from([
    0, 97, 115, 109, 1, 0, 0, 0,
    ...section(1, [1, 0x60, 0, 0]), ...section(3, [1, 0]),
    ...section(7, [...leb(exportNames.length), ...exported]), ...section(10, [1, 2, 0, 0x0b]),
    ...section(0, [1, 0x78, ...Buffer.from(versionMarker)]),
  ]);
  assert.equal(WebAssembly.validate(out), true);
  return out;
}
function inputs() {
  const wasmBytes = stubWasm(), agentPublicKey = String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
  return { goal: { version: 1, id: 'first-risk', vault: 'trial.owner.testnet', owner: 'owner.testnet',
    vault_code_hash: codeHash(wasmBytes), policy_id: 'svalin', accept_unsigned_seller_risk: true,
    accept_exact_amount_matching_risk: true }, wasmBytes, agentPublicKey,
    initialVaultFundingYocto: (7n * 10n ** 24n).toString(), agentGasAllowanceYocto: (10n ** 23n).toString(),
    vaultTokenStorageDepositYocto: (125n * 10n ** 19n).toString() };
}
const args = action => JSON.parse(Buffer.from(action.functionCall.args).toString());

test('review describes the exact five unsigned batches, their safety boundaries and deterministic commitments', () => {
  const input = inputs(), { review, batches } = buildUnsignedSvalinTrialSetup(input);
  assert.equal(review.status, 'UNSIGNED_OFFLINE_PLAN_ONLY'); assert.equal(review.network, 'testnet');
  for (const name of ['transaction_signed', 'transaction_sent', 'seller_contacted', 'setup_or_funding_verified',
    'owner_approval_obtained', 'independent_fulfillment_verified']) assert.equal(review[name], false, name);
  assert.equal(review.artifact.marker_and_exports_are_not_an_audit, true);
  assert.equal(review.artifact.near_code_hash, input.goal.vault_code_hash);
  assert.deepEqual(batches.map(b => b.id), ['create_keyless_vault', 'configure_locked_policy',
    'install_restricted_agent_key', 'register_vault_for_test_usdc', 'fund_vault_with_test_usdc']);
  assert.deepEqual(batches[0].actions.map(a => a.enum), ['createAccount', 'transfer', 'deployContract', 'functionCall']);
  assert.equal(batches[0].signerId, input.goal.owner); assert.equal(batches[0].receiverId, input.goal.vault);
  assert.equal(batches[0].actions[1].transfer.deposit.toString(), input.initialVaultFundingYocto);
  assert.deepEqual(Buffer.from(batches[0].actions[2].deployContract.code), input.wasmBytes);
  assert.equal(batches[0].actions[3].functionCall.methodName, 'new');
  assert.equal(batches[0].actions[3].functionCall.deposit, 0n);
  assert.deepEqual(args(batches[0].actions[3]), { owner: input.goal.owner });
  assert.equal(batches[0].actions.some(a => a.enum === 'addKey'), false, 'vault remains keyless');

  const configuration = batches[1];
  assert.equal(configuration.signerId, input.goal.owner); assert.equal(configuration.receiverId, input.goal.vault);
  assert.deepEqual(configuration.actions.map(a => a.functionCall.methodName),
    ['set_policy', 'allow_payee', 'lock_ft_policy_to_intents', 'grant_agent_key']);
  assert.ok(configuration.actions.every(a => a.enum === 'functionCall' && a.functionCall.deposit === 1n));
  assert.deepEqual(args(configuration.actions[0]), { policy_id: 'svalin', token: CIRCLE_TESTNET_USDC,
    per_tx_cap: '5009999', daily_cap: '5009999' });
  assert.deepEqual(args(configuration.actions[1]), { policy_id: 'svalin', payee: SVALIN_PAYEE });
  assert.deepEqual(args(configuration.actions[2]), { policy_id: 'svalin' });
  assert.deepEqual(args(configuration.actions[3]), { policy_id: 'svalin', public_key: input.agentPublicKey });
  assert.equal(configuration.actions.reduce((sum, a) => sum + a.functionCall.gas, 0n), 120n * 10n ** 12n);

  const install = batches[2], add = install.actions[0].addKey;
  assert.equal(install.signerId, input.goal.owner); assert.equal(install.receiverId, input.goal.owner);
  assert.equal(install.actions[0].enum, 'addKey'); assert.equal(String(add.publicKey), input.agentPublicKey);
  assert.equal(add.accessKey.permission.enum, 'functionCall');
  assert.equal(add.accessKey.permission.functionCall.receiverId, input.goal.vault);
  assert.deepEqual(add.accessKey.permission.functionCall.methodNames, ['execute_exact_ft']);
  assert.equal(add.accessKey.permission.functionCall.allowance.toString(), input.agentGasAllowanceYocto);

  const registration = batches[3];
  assert.equal(registration.signerId, input.goal.owner); assert.equal(registration.receiverId, CIRCLE_TESTNET_USDC);
  assert.equal(registration.actions[0].functionCall.methodName, 'storage_deposit');
  assert.deepEqual(args(registration.actions[0]), { account_id: input.goal.vault, registration_only: true });
  assert.equal(registration.actions[0].functionCall.deposit.toString(), input.vaultTokenStorageDepositYocto);
  assert.equal(review.stages[3].actions[0].method, 'storage_deposit');

  const deposit = batches[4]; assert.equal(deposit.signerId, input.goal.owner);
  assert.equal(deposit.receiverId, CIRCLE_TESTNET_USDC);
  assert.equal(deposit.actions[0].functionCall.methodName, 'ft_transfer_call');
  assert.deepEqual(args(deposit.actions[0]), { receiver_id: input.goal.vault, amount: '5009999', msg: '' });
  assert.equal(deposit.actions[0].functionCall.deposit, 1n);
  assert.equal(review.stages[4].actions[0].method, 'ft_transfer_call');
  assert.equal(review.unresolved.some(s => /registration.*bounds/.test(s)), true);
  assert.equal(review.unresolved.some(s => /never blindly retry/i.test(s)), true);
  assert.equal(JSON.stringify(review).includes(input.wasmBytes.toString('base64')), false, 'binary is not printed');
  assert.equal(JSON.stringify(review).includes('private_key'), false);

  for (const [index, batch] of batches.entries()) {
    assert.equal(unsignedSvalinBatchCommitment(batch), review.stages[index].action_commitment_sha256);
    assert.equal(assertSvalinBatchMatchesReview(batch, review.stages[index]), true);
    assert.ok(review.stages[index].prerequisite.length > 30);
  }
  const { review_sha256, ...canonical } = review;
  assert.equal(review_sha256, crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex'));
  assert.deepEqual(buildUnsignedSvalinTrialSetup(input).review, review);
});

test('mutable inputs are snapshotted; a later SDK action substitution changes the review commitment', () => {
  const input = inputs(), initial = Buffer.from(input.wasmBytes);
  const { review, batches } = buildUnsignedSvalinTrialSetup(input);
  input.wasmBytes.fill(0); input.goal.policy_id = 'other';
  assert.deepEqual(Buffer.from(batches[0].actions[2].deployContract.code), initial);
  assert.equal(review.goal.policy_id, 'svalin');
  assert.equal(unsignedSvalinBatchCommitment(batches[0]), review.stages[0].action_commitment_sha256);
  const alteredReview = structuredClone(review.stages[0]); alteredReview.actions[1].deposit_yocto = '1';
  assert.throws(() => assertSvalinBatchMatchesReview(batches[0], alteredReview), /does not match/);
  assert.throws(() => assertSvalinBatchMatchesReview(batches[1], review.stages[0]), /does not match/);
  batches[0].actions[2].deployContract.code[0] ^= 1;
  assert.notEqual(unsignedSvalinBatchCommitment(batches[0]), review.stages[0].action_commitment_sha256);
  assert.throws(() => assertSvalinBatchMatchesReview(batches[0], review.stages[0]), /does not match/);
  batches[1].actions[0].functionCall.deposit = 0n;
  assert.notEqual(unsignedSvalinBatchCommitment(batches[1]), review.stages[1].action_commitment_sha256);
  assert.throws(() => assertSvalinBatchMatchesReview(batches[1], review.stages[1]), /does not match/);
  batches[2].actions[0].addKey.accessKey.permission.functionCall.methodNames.push('set_policy');
  assert.notEqual(unsignedSvalinBatchCommitment(batches[2]), review.stages[2].action_commitment_sha256);
  assert.throws(() => assertSvalinBatchMatchesReview(batches[2], review.stages[2]), /does not match/);
  batches[3].receiverId = 'attacker.testnet';
  assert.notEqual(unsignedSvalinBatchCommitment(batches[3]), review.stages[3].action_commitment_sha256);
  assert.throws(() => assertSvalinBatchMatchesReview(batches[3], review.stages[3]), /does not match/);
});

test('rejects unsafe account hierarchy, unsupported goals, private extra inputs and noncanonical keys', () => {
  const mutate = [
    x => { x.goal.vault = 'owner.testnet'; }, x => { x.goal.vault = 'other.testnet'; },
    x => { x.goal.vault = 'deep.trial.owner.testnet'; }, x => { x.goal.owner = 'owner.near'; },
    x => { x.goal.accept_unsigned_seller_risk = false; }, x => { x.goal.policy_id = 'bad:policy'; },
    x => { x.goal.private_key = 'secret-value'; }, x => { x.privateKey = 'secret-value'; },
    x => { x.agentPublicKey = 'not-a-public-key'; }, x => { x.agentPublicKey = 123; },
  ];
  for (const change of mutate) {
    const value = inputs(); change(value);
    assert.throws(() => buildUnsignedSvalinTrialSetup(value), error => {
      assert.equal(error.message.includes('secret-value'), false); return true;
    });
  }
  assert.throws(() => unsignedSvalinBatchCommitment({ signerId: 'owner.near', receiverId: 'victim.near', actions: [] }));
});

test('funding and allowance require canonical positive bounded integer strings', () => {
  for (const field of ['initialVaultFundingYocto', 'agentGasAllowanceYocto', 'vaultTokenStorageDepositYocto']) {
    for (const invalid of ['', '0', '00', '01', '-1', '+1', '1.0', '1e23', ' 1', '9'.repeat(40), 1, 1n, null]) {
      const value = inputs(); value[field] = invalid;
      assert.throws(() => buildUnsignedSvalinTrialSetup(value), /canonical positive|bounded/);
    }
  }
  const funding = inputs(); funding.initialVaultFundingYocto = (50n * 10n ** 24n + 1n).toString();
  assert.throws(() => buildUnsignedSvalinTrialSetup(funding), /bounded/);
  const allowance = inputs(); allowance.agentGasAllowanceYocto = (10n ** 24n + 1n).toString();
  assert.throws(() => buildUnsignedSvalinTrialSetup(allowance), /bounded/);
  const registration = inputs(); registration.vaultTokenStorageDepositYocto = (10n ** 23n + 1n).toString();
  assert.throws(() => buildUnsignedSvalinTrialSetup(registration), /bounded/);
  const boundary = inputs(); boundary.initialVaultFundingYocto = (50n * 10n ** 24n).toString();
  boundary.agentGasAllowanceYocto = (10n ** 24n).toString();
  assert.equal(buildUnsignedSvalinTrialSetup(boundary).review.status, 'UNSIGNED_OFFLINE_PLAN_ONLY');
});

test('rejects wrong hash, stale marker, malformed bytes, missing exports and oversized artifacts', () => {
  let value = inputs(); value.goal.vault_code_hash = codeHash(Buffer.from('different'));
  assert.throws(() => buildUnsignedSvalinTrialSetup(value), /code hash/);
  value = inputs(); value.wasmBytes = stubWasm({ versionMarker: 'bouncer-agent-v9' }); value.goal.vault_code_hash = codeHash(value.wasmBytes);
  assert.throws(() => buildUnsignedSvalinTrialSetup(value), /marker/);
  value = inputs(); value.wasmBytes = Buffer.concat([Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), Buffer.from(marker)]);
  value.goal.vault_code_hash = codeHash(value.wasmBytes); assert.throws(() => buildUnsignedSvalinTrialSetup(value), /malformed/);
  value = inputs(); value.wasmBytes = stubWasm({ exportNames: names.filter(n => n !== 'execute_exact_ft') });
  value.goal.vault_code_hash = codeHash(value.wasmBytes); assert.throws(() => buildUnsignedSvalinTrialSetup(value), /exports/);
  value = inputs(); value.wasmBytes = Buffer.alloc(4 * 1024 * 1024 + 1);
  assert.throws(() => buildUnsignedSvalinTrialSetup(value), /bounded/);
  value = inputs(); value.wasmBytes = 'not-bytes'; assert.throws(() => buildUnsignedSvalinTrialSetup(value), /bounded/);
  // The stub is accepted as a sanity-check fixture, despite doing nothing.
  // Neither these tests nor the planner assert that it implements Bouncer.
  assert.equal(buildUnsignedSvalinTrialSetup(inputs()).review.artifact.marker_and_exports_are_not_an_audit, true);
});

test('CLI prints only a public offline plan, blocks execution flags and rejects unsafe files', () => {
  const input = inputs(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-svalin-setup-'));
  const goalPath = path.join(dir, 'goal.json'), wasmPath = path.join(dir, 'stub.wasm');
  const preload = path.join(dir, 'offline-only.mjs');
  fs.writeFileSync(goalPath, JSON.stringify(input.goal)); fs.writeFileSync(wasmPath, input.wasmBytes);
  fs.writeFileSync(preload, "globalThis.fetch = () => { throw new Error('network is forbidden in this test'); };\n");
  const options = ['--goal', goalPath, '--wasm', wasmPath, '--agent-public-key', input.agentPublicKey,
    '--vault-funding-yocto', input.initialVaultFundingYocto, '--agent-allowance-yocto', input.agentGasAllowanceYocto,
    '--vault-token-storage-yocto', input.vaultTokenStorageDepositYocto];
  const run = a => spawnSync(process.execPath, [cli, ...a], { encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, NODE_OPTIONS: `--import=${preload}` } });
  try {
    const before = fs.readdirSync(dir).sort();
    let result = run(options); assert.equal(result.status, 0, result.stderr);
    const review = JSON.parse(result.stdout); assert.equal(review.transaction_sent, false);
    assert.equal(review.seller_contacted, false); assert.equal(review.artifact.near_code_hash, input.goal.vault_code_hash);
    assert.deepEqual(fs.readdirSync(dir).sort(), before, 'no state, credential, journal or transaction file is created');
    result = run(['--help']); assert.equal(result.status, 0); assert.match(result.stdout, /no private keys.*network.*signature/i);
    for (const bad of [[...options, '--execute'], [...options, '--private-key', 'secret-value'],
      [...options.slice(0, -2), '--goal', goalPath], []]) {
      result = run(bad); assert.equal(result.status, 1); assert.equal(result.stdout, '');
      assert.equal(result.stderr.includes('secret-value'), false);
    }
    const link = path.join(dir, 'link.wasm'); fs.symlinkSync(wasmPath, link);
    result = run(options.map(a => a === wasmPath ? link : a)); assert.equal(result.status, 1); assert.match(result.stderr, /bounded regular/);
    fs.writeFileSync(wasmPath, Buffer.alloc(4 * 1024 * 1024 + 1));
    result = run(options); assert.equal(result.status, 1); assert.match(result.stderr, /bounded regular/);
    fs.writeFileSync(wasmPath, input.wasmBytes); fs.writeFileSync(goalPath, 'x'.repeat(16 * 1024 + 1));
    result = run(options); assert.equal(result.status, 1); assert.match(result.stderr, /bounded public goal/);
    fs.writeFileSync(goalPath, JSON.stringify({ ...input.goal, private_key: 'secret-value' }));
    result = run(options); assert.equal(result.status, 1); assert.equal(result.stderr.includes('secret-value'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
