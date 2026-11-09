// Synthetic artifacts and public reviews only; no wallet or transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
import {fixture} from './v14-witness-fixture.mjs';
import {verifyV14BrowserPhonePlan} from '../web-src/v14-phone-wallet-plan.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function argumentsFor() {
  const {review,inputs}=fixture();
  return {review:structuredClone(review),trustedReviewSha256:review.review_sha256,
    trustedArtifacts:{...inputs.trustedArtifacts,compressed_sha256:sha(inputs.compressed)},
    loaderBytes:new Uint8Array(inputs.loaderWasm),compressedBytes:new Uint8Array(inputs.compressed),crypto:webcrypto};
}
function rehash(review) {
  const copy=structuredClone(review);delete copy.review_sha256;
  review.review_sha256=sha(JSON.stringify(copy));return review.review_sha256;
}

test('browser reconstructs all six exact wallet action commitments without a prompt',async()=>{
  const args=argumentsFor(),result=await verifyV14BrowserPhonePlan(args);
  assert.deepEqual(result.stages.map(stage=>stage.action_commitment_sha256),args.review.stages.map(stage=>stage.action_commitment_sha256));
  assert.equal(result.wallet_prompt_authorized,false);assert.equal(result.transaction_sent,false);
  assert.deepEqual(result.stages[0].actions.map(action=>action.type),['CreateAccount','Transfer','DeployContract','FunctionCall','FunctionCall']);
  assert.equal(result.stages[0].actions[3].params.deposit,'1');assert.equal(result.stages[0].actions[4].params.deposit,'1');
  assert.deepEqual(result.stages[5].actions.map(action=>action.params.accessKey.permission.methodNames),
    [['execute_outlayer'],['execute_outlayer_native_project'],['execute_native_storage']]);
  assert.ok(result.stages[0].actions[2].params.code instanceof Uint8Array);
  assert.ok(result.stages[0].actions[4].params.args instanceof Uint8Array);
});

test('changed action, owner, key scope or commitment is rejected even after the review digest is recomputed',async()=>{
  for(const mutate of [
    review=>{review.stages[0].actions[1].deposit_yocto='999'},
    review=>{review.stages[0].actions[4].expected_owner='attacker.testnet'},
    review=>{review.stages[5].actions[0].method_names=['*']},
    review=>{review.stages[3].action_commitment_sha256='f'.repeat(64)},
    review=>{review.mission.goals[0].goal.amount='9999'},
    review=>{review.agent_public_keys.price=review.owner_public_key},
  ]) {
    const args=argumentsFor();mutate(args.review);args.trustedReviewSha256=rehash(args.review);
    await assert.rejects(verifyV14BrowserPhonePlan(args),/no wallet prompt/);
  }
});

test('caller mutations after verification begins cannot change the retained review or action bytes',async()=>{
  const args=argumentsFor(),expectedOwner=args.review.owner,expectedFirst=args.loaderBytes[0];
  const pending=verifyV14BrowserPhonePlan(args);
  args.review.owner='attacker.testnet';args.loaderBytes[0]^=1;args.compressedBytes[0]^=1;
  const result=await pending;
  assert.equal(result.review.owner,expectedOwner);
  assert.equal(result.stages[0].actions.find(action=>action.type==='DeployContract').params.code[0],expectedFirst);
});

test('artifact substitution, malformed compression and stale trusted review fail before wallet actions',async()=>{
  let args=argumentsFor();args.loaderBytes[8]^=1;
  await assert.rejects(verifyV14BrowserPhonePlan(args),/no wallet prompt/);
  args=argumentsFor();args.compressedBytes[0]^=1;
  await assert.rejects(verifyV14BrowserPhonePlan(args),/no wallet prompt/);
  args=argumentsFor();args.trustedArtifacts.loader_sha256='f'.repeat(64);
  await assert.rejects(verifyV14BrowserPhonePlan(args),/no wallet prompt/);
  args=argumentsFor();args.trustedReviewSha256='f'.repeat(64);
  await assert.rejects(verifyV14BrowserPhonePlan(args),/no wallet prompt/);
  args=argumentsFor();
  // A trusted compressed digest alone is insufficient if the expanded bytes
  // differ or exceed the separately pinned vault artifact.
  const larger=deflateRawSync(Buffer.alloc(args.review.artifacts.vault_bytes+2));
  args.compressedBytes=new Uint8Array(larger);args.review.artifacts.compressed_bytes=larger.length;
  args.review.artifacts.compressed_sha256=sha(larger);args.trustedArtifacts.compressed_sha256=sha(larger);
  args.trustedReviewSha256=rehash(args.review);
  await assert.rejects(verifyV14BrowserPhonePlan(args),/no wallet prompt/);
});
