import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import nearApi from 'near-api-js';
import { createNativeOracleReviewCache } from '../agent/native-oracle-review-cache.mjs';

const wasm=fs.readFileSync(new URL('../../bouncer.wasm',import.meta.url)),key=()=>String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
test('native review is fixed, unsigned, separately retained, and cannot be widened by client fields',async()=>{
  let clock=1_800_000_000_000;const cache=createNativeOracleReviewCache({wasmBytes:wasm,now:()=>clock}),agentPublicKey=key();
  const first=await cache.create({agentPublicKey});assert.match(first.task_id,/^[a-f0-9]{32}$/);
  assert.equal(first.signing_authorized,false);assert.equal(first.transaction_sent,false);
  assert.equal(first.review.owner,'great_mujey.testnet');assert.equal(first.review.vault,'native.great_mujey.testnet');
  assert.equal(first.review.agent_public_key,agentPublicKey);assert.equal(first.review.payee,'outlayer.testnet');
  assert.equal(first.review.vault_storage_funding_yocto,'5400000000000000000000000');
  assert.equal(first.review.per_tx_cap_yocto,'100000000000000000000000');
  first.review.payee='evil.testnet';assert.equal((await cache.getRetainedReview(first.task_id)).review.payee,'outlayer.testnet');
  await assert.rejects(cache.create({agentPublicKey,owner:'evil.testnet'}));await assert.rejects(cache.create({agentPublicKey:'bad'}));
  clock=first.expires_at_ms;assert.equal(await cache.getRetainedReview(first.task_id),null);
  clock--;await assert.rejects(cache.getRetainedReview(first.task_id)); // backwards clock cannot revive an old review
});

test('bounded review capacity and pinned artifact fail closed without creating a prompt',async()=>{
  let clock=1_800_000_000_000;const cache=createNativeOracleReviewCache({wasmBytes:wasm,now:()=>clock});
  for(let i=0;i<16;i++)await cache.create({agentPublicKey:key()});
  await assert.rejects(cache.create({agentPublicKey:key()}));clock+=30*60_000;
  assert.ok((await cache.create({agentPublicKey:key()})).review);
  const bad=Buffer.from(wasm);bad[80]^=1;assert.throws(()=>createNativeOracleReviewCache({wasmBytes:bad}));
});
