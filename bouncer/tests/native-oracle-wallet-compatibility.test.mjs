import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { webcrypto } from 'node:crypto';
import zlib from 'node:zlib';
import { act_impl_near, validateKnownFirstPartyActionRequest, MAX_ACTION_REQUEST_CANONICAL_JSON_LENGTH } from '@meteorwallet/connect-shared/internal';
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

test('pinned Meteor bridge validator rejects direct V9 but accepts the size of the research loader request', () => {
  // This exercises the SDK's request schema/size gate only. A dummy loader of
  // the isolated build's size does not prove its contents or real-phone behavior.
  const code = fs.readFileSync(new URL('../../bouncer.wasm', import.meta.url));
  const compressed = zlib.deflateRawSync(code, {level:9}), loader = Buffer.alloc(28_950);
  assert.equal(MAX_ACTION_REQUEST_CANONICAL_JSON_LENGTH, METEOR_MOBILE_ACTION_LIMIT_BYTES);
  const build = actions => act_impl_near.action.sign_and_send_transaction.request({ network:'testnet',
    signerId:'great_mujey.testnet', receiverId:'native.great_mujey.testnet', actions }).toJsonObject();
  const common = [{type:'CreateAccount',params:{}},
    {type:'Transfer',params:{deposit:'5400000000000000000000000'}}];
  const direct = build([...common,{type:'DeployContract',params:{code:code.toString('base64'),codeEncoding:'base64'}}]);
  const compact = build([...common,{type:'DeployContract',params:{code:loader.toString('base64'),codeEncoding:'base64'}},
    {type:'FunctionCall',params:{methodName:'loader_init',args:{},gas:'20000000000000',deposit:'1'}},
    {type:'FunctionCall',params:{methodName:'loader_deploy',args:compressed.toString('base64'),argsEncoding:'base64',
      gas:'240000000000000',deposit:'1'}}]);
  const rejected = validateKnownFirstPartyActionRequest(direct), accepted = validateKnownFirstPartyActionRequest(compact);
  assert.equal(rejected.ok, false); assert.equal(rejected.reason, 'request_too_large');
  assert.equal(accepted.ok, true);
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) < 380_000);
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
