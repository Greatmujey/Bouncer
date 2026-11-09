// Public research binaries and synthetic wallet request only; no signing/send.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,webcrypto} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import nearApi from 'near-api-js';
import {validateKnownFirstPartyActionRequest} from '@meteorwallet/connect-shared/internal';
import {fixture} from './v14-witness-fixture.mjs';
import {buildV14PhoneResearchPlan} from '../agent/native-v14-phone-plan.mjs';
import {syntheticV14MeteorRequest} from '../integration/v14-synthetic-meteor.mjs';
import {verifyV14BrowserPhonePlan} from '../web-src/v14-phone-wallet-plan.mjs';
import {V14_TESTNET_ARTIFACT} from '../shared/v14-testnet-artifact.mjs';
import {V14_PHONE_RESEARCH_ARTIFACTS as pins,V14_PHONE_RESEARCH_SIZES as sizes} from '../shared/v14-phone-research-artifacts.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
test('exact public research binaries reconstruct all stages and fit the synthetic Meteor bridge',async()=>{
  const loader=await readFile(new URL('../web/artifacts/v14-research-loader.wasm',import.meta.url)),
    compressed=await readFile(new URL('../web/artifacts/v14-research.deflate',import.meta.url)),
    vault=inflateRawSync(compressed,{maxOutputLength:sizes.vault});
  assert.equal(loader.length,sizes.loader);assert.equal(compressed.length,sizes.compressed);assert.equal(vault.length,sizes.vault);
  assert.equal(sha(loader),pins.loader_sha256);assert.equal(sha(compressed),pins.compressed_sha256);assert.equal(sha(vault),pins.vault_sha256);
  assert.equal(pins.vault_sha256,V14_TESTNET_ARTIFACT.sha256);
  assert.equal(nearApi.utils.serialize.base_encode(createHash('sha256').update(vault).digest()),V14_TESTNET_ARTIFACT.near_code_hash);
  const {inputs}=fixture();inputs.vaultWasm=vault;inputs.loaderWasm=loader;inputs.compressed=compressed;
  inputs.trustedArtifacts={vault_sha256:pins.vault_sha256,loader_sha256:pins.loader_sha256};
  inputs.mission.goals.find(item=>item.kind==='storage').goal.contract_code_hash=V14_TESTNET_ARTIFACT.near_code_hash;
  const plan=buildV14PhoneResearchPlan(inputs),request=syntheticV14MeteorRequest(plan.batches[0]);
  assert.equal(validateKnownFirstPartyActionRequest(request).ok,true);
  assert.ok(Buffer.byteLength(JSON.stringify(request))<400_000);
  const browser=await verifyV14BrowserPhonePlan({review:plan.review,trustedReviewSha256:plan.review.review_sha256,trustedArtifacts:pins,
    loaderBytes:loader,compressedBytes:compressed,crypto:webcrypto});
  assert.deepEqual(browser.stages.map(stage=>stage.action_commitment_sha256),plan.review.stages.map(stage=>stage.action_commitment_sha256));
  assert.equal(browser.wallet_prompt_authorized,false);
});
