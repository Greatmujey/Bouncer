import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { webcrypto } from 'node:crypto';
import { assertNativeOracleWalletDeployAvailable, NATIVE_ORACLE_V9_BYTES,
  METEOR_MOBILE_ACTION_LIMIT_BYTES } from '../web-src/native-oracle-wallet-compatibility.mjs';
import { createNativeOracleSetupClient } from '../web-src/native-oracle-setup-client.mjs';

test('the pinned V9 code alone exceeds the mobile bridge action limit after base64', () => {
  const code = fs.readFileSync(new URL('../../bouncer.wasm', import.meta.url));
  assert.equal(code.length, NATIVE_ORACLE_V9_BYTES);
  assert.equal(code.toString('base64').length, 603_568);
  assert.ok(code.toString('base64').length > METEOR_MOBILE_ACTION_LIMIT_BYTES);
  assert.throws(() => assertNativeOracleWalletDeployAvailable({manifest:{id:'meteor-wallet'}}),
    error => error.code === 'NATIVE_METEOR_DEPLOY_TOO_LARGE');
  // No compatibility claim is made for another wallet.
  assert.equal(assertNativeOracleWalletDeployAvailable({manifest:{id:'other-wallet'}}), undefined);
});

test('Meteor reservation stops before network, identity signing, or device inspection', async () => {
  let requests = 0, signatures = 0, inspections = 0;
  const wallet = { manifest:{id:'meteor-wallet'}, async signMessage() { signatures++; } };
  const client = createNativeOracleSetupClient({ wallet, accountId:'great_mujey.testnet', ownerPublicKey:'public',
    deviceStore:{async inspect() { inspections++; }}, location:{origin:'https://bouncer.example'}, crypto:webcrypto,
    fetch:async () => { requests++; throw Error('unexpected network'); }, isCurrent:()=>true, isTopLevel:true });
  assert.throws(() => client.assertWalletDeployAvailable(), error => error.code === 'NATIVE_METEOR_DEPLOY_TOO_LARGE');
  const review = { review_sha256:'a'.repeat(64) };
  await assert.rejects(client.reserve({taskId:review.review_sha256,review}), error => error.code === 'NATIVE_METEOR_DEPLOY_TOO_LARGE');
  assert.deepEqual({requests,signatures,inspections},{requests:0,signatures:0,inspections:0});
});
