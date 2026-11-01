import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { createSweepHandoffRequest, validateSweepHandoffRequest, sealSweepHandoff, openSweepHandoff } from '../agent/ref-sweep-handoff.mjs';

const pair = nearApi.KeyPair.fromRandom('ed25519'), other = nearApi.KeyPair.fromRandom('ed25519');
const context = { owner_account_id: 'owner.testnet', contract_id: 'vault.testnet', router_id: 'router.testnet',
  original_hash: nearApi.utils.serialize.base_encode(Buffer.alloc(32, 1)), output_receipt_id: nearApi.utils.serialize.base_encode(Buffer.alloc(32, 2)),
  expected_output: '6926', sweep_public_key: pair.getPublicKey().toString() };
const credentials = { account_id: context.owner_account_id, private_key: pair.toString() };
const { request, privateKey } = createSweepHandoffRequest({ runId: '123456', context });
const encrypt = () => sealSweepHandoff({ request, expected: context, credentials });

test('a one-use handoff encrypts only the reviewed scoped testnet key', () => {
  const first = encrypt(), second = encrypt();
  assert(!JSON.stringify(first).includes(credentials.private_key));
  assert.notEqual(first.envelope.ciphertext, second.envelope.ciphertext);
  assert.equal(String(openSweepHandoff({ request, expected: context, response: first, privateKey }).getPublicKey()), context.sweep_public_key);
});

test('changed trade, scope, key, challenge or unknown fields fail closed', () => {
  for (const bad of [
    { ...request, router_id: 'attacker.testnet' }, { ...request, original_hash: '3'.repeat(32) },
    { ...request, output_receipt_id: '4'.repeat(32) }, { ...request, expected_output: '6927' },
    { ...request, challenge: 'x'.repeat(64) }, { ...request, run_id: '01' }, { ...request, owner_account_id: 'owner.near' },
    { ...request, rsa_key_id: '0'.repeat(64) }, { ...request, extra: true },
  ]) assert.throws(() => validateSweepHandoffRequest(bad, context));
  assert.throws(() => sealSweepHandoff({ request, expected: context, credentials: { ...credentials, private_key: other.toString() } }));
  assert.throws(() => sealSweepHandoff({ request, expected: context, credentials: { ...credentials, owner_key: pair.toString() } }));
});

test('tampering and a response replayed into another worker challenge fail authentication', () => {
  const response = encrypt();
  const bytes = Buffer.from(response.envelope.ciphertext, 'base64'); bytes[0] ^= 1;
  assert.throws(() => openSweepHandoff({ request, expected: context, privateKey,
    response: { ...response, envelope: { ...response.envelope, ciphertext: bytes.toString('base64') } } }));
  assert.throws(() => openSweepHandoff({ request: { ...request, challenge: 'b'.repeat(64) }, expected: context, response, privateKey }));
  assert.throws(() => openSweepHandoff({ request, expected: context, response: { ...response, run_id: '999' }, privateKey }));
});

test('live handoff commands fail before network without the explicit recovery context', async () => {
  const { spawnSync } = await import('node:child_process'), path = await import('node:path'), { fileURLToPath } = await import('node:url');
  const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const env = { ...process.env }; delete env.BOUNCER_REF_SWEEP_ACK;
  const worker = spawnSync(process.execPath, ['scripts/resume-original-ref-sweep.mjs', '/tmp/original', '/tmp/out'],
    { cwd, env, encoding: 'utf8', timeout: 5000 });
  assert.notEqual(worker.status, 0); assert.match(worker.stderr, /explicit testnet sweep-only acknowledgement/);
  const response = spawnSync(process.execPath, ['scripts/respond-original-ref-sweep.mjs'],
    { cwd, env, encoding: 'utf8', timeout: 5000 });
  assert.notEqual(response.status, 0); assert.match(response.stderr, /usage/);
});
