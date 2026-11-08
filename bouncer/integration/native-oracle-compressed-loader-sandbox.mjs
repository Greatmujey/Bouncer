#!/usr/bin/env node
/**
 * Disposable nearcore research ONLY. Measures whether a small, temporary loader
 * can accept a compressed copy of the exact V9 code and self-deploy it on the
 * same keyless sandbox vault. No public chain, real wallet, phone or provider.
 * This is not a production receipt verifier, wallet review or retry protocol.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { act_impl_near, validateKnownFirstPartyActionRequest, MAX_ACTION_REQUEST_CANONICAL_JSON_LENGTH } from '@meteorwallet/connect-shared/internal';
import { NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE,
  NATIVE_ORACLE_V9_CODE_HASH, NATIVE_ORACLE_V9_SHA256 } from '../agent/native-oracle-wallet-plan.mjs';
import { buildResearchPhonePlan, prepareResearchPhoneAttempt, inspectResearchPhoneAttempt } from '../agent/native-phone-loader-research.mjs';
import { SANDBOX_CHAIN_ID, SANDBOX_SHA256, readVerifiedFile, assertSandboxStatus,
  requireFinalSuccess } from './v11-sandbox-support.mjs';
import { withSandboxOnlyFetch } from './v11-sandbox-setup-rpc.mjs';
import { startSandbox, stopSandboxChild } from './v11-nearcore-sandbox.mjs';

const { transactions: tx } = nearApi;
const ONE = 10n ** 24n, TGAS = 10n ** 12n, OWNER = 'loader-buyer.testnet', VAULT = `native.${OWNER}`;
const INTRUDER = 'loader-intruder.testnet', HOLD = `hold.${OWNER}`, FAILED = `failed.${OWNER}`;
const ref = { finality: 'final' };
const key = () => nearApi.KeyPair.fromRandom('ed25519');
const pub = pair => String(pair.getPublicKey());
const account = (id, provider, pair) => new nearApi.Account(id, provider, new nearApi.KeyPairSigner(pair));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest();
function failure(result, label, pattern = /rejected input|FunctionCallError|panic/i) {
  assert.equal(result?.final_execution_status, 'FINAL', `${label}: not FINAL`);
  assert.ok(result?.status?.Failure, `${label}: expected failure`);
  assert.match(JSON.stringify(result.status.Failure), pattern, label);
}
async function absent(provider, id) {
  let error;
  try { await provider.viewAccount(id, ref); } catch (caught) { error = caught; }
  assert.ok(error, `expected ${id} to be absent`);
  assert.match(`${error.message ?? ''} ${JSON.stringify(error)}`, /UNKNOWN_ACCOUNT|does not exist|doesn't exist|unknown account/i);
}
function createLoader(loader) {
  return [tx.createAccount(), tx.transfer(54n * ONE / 10n), tx.deployContract(loader),
    tx.functionCall('loader_init', {}, 20n * TGAS, 1n)];
}
function deploy(compressed, deposit = 1n) {
  return tx.functionCall('loader_deploy', compressed, 240n * TGAS, deposit);
}
function syntheticMeteorRequest(loader, compressed) {
  // Exercise the pinned public SDK schema and validator with the exact
  // compiled loader and compressed V9. This is not a live phone/wallet test.
  return act_impl_near.action.sign_and_send_transaction.request({network:'testnet', signerId:OWNER, receiverId:VAULT,
    actions:[{type:'CreateAccount',params:{}}, {type:'Transfer',params:{deposit:(54n*ONE/10n).toString()}},
      {type:'DeployContract',params:{code:loader.toString('base64'),codeEncoding:'base64'}},
      {type:'FunctionCall',params:{methodName:'loader_init',args:{},gas:(20n*TGAS).toString(),deposit:'1'}},
      {type:'FunctionCall',params:{methodName:'loader_deploy',args:compressed.toString('base64'),argsEncoding:'base64',
        gas:(240n*TGAS).toString(),deposit:'1'}}] }).toJsonObject();
}

async function main() {
  const binary = process.env.BOUNCER_SANDBOX_BIN, loaderPath = process.env.BOUNCER_PHONE_LOADER_WASM;
  readVerifiedFile(binary, SANDBOX_SHA256);
  const code = readVerifiedFile(new URL('../../bouncer.wasm', import.meta.url).pathname, NATIVE_ORACLE_V9_SHA256, {maxBytes:1_000_000});
  if (typeof loaderPath !== 'string' || !path.isAbsolute(loaderPath)) throw Error('explicit local research loader path required');
  const stat = fs.statSync(loaderPath);
  if (!stat.isFile() || stat.size < 8 || stat.size > 200_000) throw Error('unexpected research loader size');
  const loader = fs.readFileSync(loaderPath);
  assert.deepEqual([...loader.subarray(0,8)], [0,97,115,109,1,0,0,0]);
  const compressed = zlib.deflateRawSync(code, {level:9});
  assert.ok(compressed.length < 200_000);
  assert.deepEqual(zlib.inflateRawSync(compressed), code);
  const request = syntheticMeteorRequest(loader, compressed);
  const requestBytes = Buffer.byteLength(JSON.stringify(request));
  assert.equal(MAX_ACTION_REQUEST_CANONICAL_JSON_LENGTH, 400_000);
  const meteorValidation = validateKnownFirstPartyActionRequest(request);
  assert.equal(meteorValidation.ok, true, `Meteor SDK rejected synthetic request: ${meteorValidation.reason}`);
  assert.ok(requestBytes < 380_000, `synthetic action request is too close to Meteor's 400,000-byte cap: ${requestBytes}`);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-phone-loader-sandbox-'));
  const tokenKey = key(), ownerKey = key(), intruderKey = key(), agentKey = key(), providerKey = key();
  let sandbox;
  try {
    sandbox = await startSandbox(binary, directory, pub(tokenKey));
    const { provider, rpcUrl } = sandbox;
    const result = await withSandboxOnlyFetch(rpcUrl, async () => {
      assertSandboxStatus(await provider.status());
      const root = account('testnet', provider, sandbox.rootKey), owner = account(OWNER, provider, ownerKey);
      const intruder = account(INTRUDER, provider, intruderKey), agent = account(OWNER, provider, agentKey);
      const send = (signer, receiverId, actions) => signer.signAndSendTransaction({receiverId, actions, waitUntil:'FINAL', throwOnFailure:false});
      const must = async (signer, receiverId, actions, label) => {
        const result = await send(signer, receiverId, actions); requireFinalSuccess(result, label); return result;
      };
      for (const [id, pair] of [[OWNER,ownerKey], [INTRUDER,intruderKey], ['outlayer.testnet',providerKey]]) {
        await must(root, id, [tx.createAccount(),tx.transfer(100n*ONE),tx.addKey(pair.getPublicKey(),tx.fullAccessKey())], 'create sandbox account');
      }
      const bad = Buffer.from(compressed.subarray(0, compressed.length - 100));
      const beforeFailed = BigInt((await provider.viewAccount(OWNER, ref)).amount);
      failure(await send(owner, FAILED, [...createLoader(loader),deploy(bad)]), 'corrupt compressed code');
      await absent(provider, FAILED);
      const afterFailed = BigInt((await provider.viewAccount(OWNER, ref)).amount);
      assert.ok(beforeFailed >= afterFailed && beforeFailed - afterFailed < ONE / 2n,
        'failed atomic creation should refund storage funding except for gas');

      await must(owner, HOLD, createLoader(loader), 'create initialized loader for access-control checks');
      failure(await send(intruder,HOLD,[deploy(compressed)]),'non-owner loader deployment');
      failure(await send(owner,HOLD,[deploy(compressed,0n)]),'zero-yocto loader deployment');
      failure(await send(owner,HOLD,[tx.functionCall('loader_init',{},20n*TGAS,1n)]),'loader reinitialization');
      failure(await send(owner,HOLD,[deploy(bad)]),'wrong compressed code');
      const beforeRefund = BigInt((await provider.viewAccount(OWNER, ref)).amount);
      await must(owner,HOLD,[tx.functionCall('loader_refund',{},60n*TGAS,1n)],'owner explicitly refunds unused loader');
      await absent(provider,HOLD);
      const afterRefund = BigInt((await provider.viewAccount(OWNER, ref)).amount);
      assert.ok(afterRefund > beforeRefund + 5n*ONE, 'unused loader funding did not return to sandbox owner');

      const terms={owner:OWNER,vault:VAULT,policy_id:'loader-native',agent_public_key:pub(agentKey),
        per_tx_cap_yocto:(ONE/10n).toString(),daily_cap_yocto:(ONE/10n).toString(),vault_deposit_yocto:(ONE/10n).toString(),
        agent_gas_allowance_yocto:NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE};
      const publicInputs={terms,wasmBytes:code,loaderBytes:loader,compressedBytes:compressed,trustedOwnerPublicKey:pub(ownerKey)};
      const plan=buildResearchPhonePlan(publicInputs);
      const reconcile = async (sent,stageId,expectedStatus) => {
        const originalHash=sent.transaction_outcome.id, review=plan.review;
        const anchors={...publicInputs,review,trustedReviewHash:review.review_sha256,trustedOriginalHash:originalHash};
        const attempt=prepareResearchPhoneAttempt({...anchors,stageId});
        const receipt=await provider.txStatusReceipts(originalHash,OWNER,'FINAL');
        requireFinalSuccess(receipt,`original ${stageId} receipt`);
        assert.equal(inspectResearchPhoneAttempt({...anchors,attempt,result:receipt}).status,expectedStatus);
        return {receipt,anchors,attempt};
      };
      const setup = await must(owner,VAULT,plan.batches[0].actions,'compressed pinned V9 self-deploy');
      const walletResultBytes = Buffer.byteLength(JSON.stringify(setup));
      assert.ok(walletResultBytes < 380_000, `sandbox wallet result is too close to Meteor's 400,000-byte cap: ${walletResultBytes}`);
      const {receipt,anchors,attempt} = await reconcile(setup,plan.batches[0].id,'FINAL_RESEARCH_LOADER_AND_UPGRADE_MATCH');
      const deployReceipts = receipt.receipts.filter(r => r.predecessor_id===VAULT && r.receiver_id===VAULT &&
        r.receipt?.Action?.actions?.some(a => a.DeployContract?.code===digest(code).toString('base64')));
      assert.equal(deployReceipts.length,1,'matching V9 self-deployment receipt missing or duplicated');
      const calls = deployReceipts[0].receipt.Action.actions;
      assert.equal(calls.length,2);
      assert.equal(calls[1]?.FunctionCall?.method_name,'new');
      const newArgs = JSON.parse(Buffer.from(calls[1].FunctionCall.args,'base64').toString('utf8'));
      assert.deepEqual(newArgs,{owner:OWNER});
      assert.equal((await provider.viewAccount(VAULT,ref)).code_hash,NATIVE_ORACLE_V9_CODE_HASH);
      assert.deepEqual((await provider.viewAccessKeyList(VAULT,ref)).keys,[]);
      const view = (method,args={}) => provider.callFunction(VAULT,method,args,ref);
      assert.equal(await view('get_owner'),OWNER);
      const tampered=structuredClone(receipt), changed=tampered.receipts.find(r=>r.receipt_id===deployReceipts[0].receipt_id);
      changed.receipt.Action.actions[1].FunctionCall.args=Buffer.from('{"owner":"intruder.testnet"}').toString('base64');
      assert.throws(()=>inspectResearchPhoneAttempt({...anchors,attempt,result:tampered}),/self-upgrade/);
      const configured=await must(owner,VAULT,plan.batches[1].actions,'configure and fund upgraded V9');
      await reconcile(configured,plan.batches[1].id,'FINAL_RESEARCH_NATIVE_SETUP_RECEIPT_MATCH');
      const installed=await must(owner,OWNER,plan.batches[2].actions,'install restricted sandbox agent');
      const installationReceipt=await provider.txStatusReceipts(installed.transaction_outcome.id,OWNER,'FINAL');
      const installExpected=installationReceipt.receipts.some(r=>r.receipt_id===installationReceipt.transaction_outcome.outcome.status.SuccessReceiptId)
        ? 'FINAL_RESEARCH_NATIVE_SETUP_RECEIPT_MATCH' : 'FINAL_LOCAL_ADD_KEY_OUTCOME_MATCH';
      await reconcile(installed,plan.batches[2].id,installExpected);
      assert.equal(await view('vault_balance',{token:'native'}),terms.vault_deposit_yocto);
      assert.equal(await view('is_agent_key_allowed',{policy_id:terms.policy_id,public_key:pub(agentKey)}),true);
      const route=await view('get_outlayer_native_project',{policy_id:terms.policy_id});
      assert.equal(route.active,true);
      failure(await send(agent,VAULT,[tx.functionCall('execute_outlayer_native_project',{
        policy_id:terms.policy_id,amount:(ONE/10n+1n).toString(),expected_route:route},300n*TGAS,0n)]),
      'upgraded V9 native cap',/amount exceeds per-tx cap/i);
      assert.equal(await view('vault_balance',{token:'native'}),terms.vault_deposit_yocto);
      return { scope:'disposable loopback nearcore only; no real Meteor, wallet, provider or delivery',
        loader_bytes:loader.length,compressed_v9_bytes:compressed.length,synthetic_meteor_request_bytes:requestBytes,
        sandbox_wallet_result_json_bytes:walletResultBytes,meteor_mobile_action_limit_bytes:400000,
        pinned_meteor_sdk_validator_accepted:true,
        loader_sha256:digest(loader).toString('hex'),exact_v9_digest_checked_by_loader:true,
        all_three_original_receipt_graphs_matched_offline:true,tampered_upgrade_rejected:true,
        self_deployment_receipt_and_owner_matched:true,keyless_vault_and_policy_configured:true,agent_cap_enforced:true,
        non_owner_zero_yocto_reinitialization_and_corruption_rejected:true,
        failed_creation_rolled_back_except_gas:true,unused_loader_owner_refund_verified:true,
        complete_recovery_or_real_phone_proven:false };
    });
    assertSandboxStatus(await provider.status());
    console.log(JSON.stringify({...result,chain_id:SANDBOX_CHAIN_ID,nearcore_version:sandbox.versionText},null,2));
  } finally {
    if (sandbox) await stopSandboxChild(sandbox.child);
    fs.rmSync(directory,{recursive:true,force:true});
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  main().catch(error=>{console.error('Compressed native loader sandbox failed:',error?.stack??String(error));process.exitCode=1});
}
