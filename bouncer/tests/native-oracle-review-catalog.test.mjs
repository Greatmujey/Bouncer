import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import nearApi from 'near-api-js';
import { createNativeOracleReviewCatalog } from '../agent/native-oracle-review-catalog.mjs';

const wasm=fs.readFileSync(new URL('../../bouncer.wasm',import.meta.url));
const key=()=>String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());

test('a pinned unsigned review reconstructs identically on another instance without memory or private keys',async()=>{
  const firstInstance=createNativeOracleReviewCatalog({wasmBytes:wasm}),agentPublicKey=key();
  const first=await firstInstance.create({agentPublicKey});
  assert.match(first.task_id,/^[a-f0-9]{64}$/);assert.equal(first.task_id,first.review.review_sha256);
  assert.equal(first.signing_authorized,false);assert.equal(first.transaction_sent,false);
  assert.equal(first.review.owner,'great_mujey.testnet');assert.equal(first.review.vault,'native.great_mujey.testnet');
  assert.equal(first.review.agent_public_key,agentPublicKey);assert.equal(first.review.payee,'outlayer.testnet');
  assert.equal(first.review.vault_storage_funding_yocto,'5400000000000000000000000');
  assert.equal(first.review.per_tx_cap_yocto,'100000000000000000000000');
  const other=createNativeOracleReviewCatalog({wasmBytes:wasm});
  assert.deepEqual(await other.create({agentPublicKey}),first);
  const reconstructed=await other.getRetainedReview(first.task_id,agentPublicKey);
  assert.deepEqual(reconstructed.review,first.review);
  first.review.payee='evil.testnet';
  assert.equal((await other.getRetainedReview(first.task_id,agentPublicKey)).review.payee,'outlayer.testnet');
  assert.equal(await other.getRetainedReview(first.task_id,key()),null);
  assert.equal(await other.getRetainedReview('f'.repeat(64),agentPublicKey),null);
  assert.equal(await other.getRetainedReview(first.task_id,'bad'),null);
  assert.equal(await other.getRetainedReview(first.task_id),null);
  assert.equal(await other.getRetainedReview('a'.repeat(32),agentPublicKey),null);
  await assert.rejects(other.create({agentPublicKey,owner:'evil.testnet'}));
  await assert.rejects(other.create({agentPublicKey:'bad'}));
  await assert.rejects(other.create({agentPublicKey:`ed25519:${'1'.repeat(20000)}`}));
  let getterCalled=false;const accessor=Object.defineProperty({},'agentPublicKey',{enumerable:true,get(){getterCalled=true;return agentPublicKey}});
  await assert.rejects(other.create(accessor));assert.equal(getterCalled,false);
});

test('requests do not exhaust process-local review slots, and a modified artifact fails closed',async()=>{
  const catalog=createNativeOracleReviewCatalog({wasmBytes:wasm}),agentPublicKey=key();
  const first=await catalog.create({agentPublicKey});
  for(let i=0;i<20;i++)await catalog.create({agentPublicKey:key()});
  assert.deepEqual(await catalog.getRetainedReview(first.task_id,agentPublicKey),{review:first.review});
  const bad=Buffer.from(wasm);bad[80]^=1;assert.throws(()=>createNativeOracleReviewCatalog({wasmBytes:bad}));
});

test('opt-in atomic catalog binds the owner key and still reconstructs existing four-stage reviews', async () => {
  const agentPublicKey = key(), ownerPublicKey = key(), original = createNativeOracleReviewCatalog({ wasmBytes: wasm });
  const old = await original.create({ agentPublicKey });
  const atomic = createNativeOracleReviewCatalog({ wasmBytes: wasm, enableAtomic: true });
  const made = await atomic.create({ agentPublicKey, ownerPublicKey });
  assert.equal(made.review.format, 'bouncer-atomic-native-oracle-wallet-review-v1');
  assert.equal(made.review.owner_public_key, ownerPublicKey); assert.equal(made.review.stages.length, 2);
  assert.equal(made.signing_authorized, false); assert.equal(made.transaction_sent, false);
  assert.deepEqual((await atomic.getRetainedReview(made.task_id, agentPublicKey, ownerPublicKey)).review, made.review);
  assert.deepEqual((await atomic.getRetainedReview(old.task_id, agentPublicKey, ownerPublicKey)).review, old.review);
  assert.equal(await atomic.getRetainedReview(made.task_id, agentPublicKey, key()), null);
  assert.equal(await original.getRetainedReview(made.task_id, agentPublicKey, ownerPublicKey), null);
  await assert.rejects(atomic.create({ agentPublicKey }));
  await assert.rejects(atomic.create({ agentPublicKey, ownerPublicKey: agentPublicKey }));
  await assert.rejects(atomic.create({ agentPublicKey, ownerPublicKey, extra: true }));
  let called = false; const input = { agentPublicKey };
  Object.defineProperty(input, 'ownerPublicKey', { enumerable: true, get() { called = true; return ownerPublicKey; } });
  await assert.rejects(atomic.create(input)); assert.equal(called, false);
});
