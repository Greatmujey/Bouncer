import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import nearApi from 'near-api-js';
import { nep413Payload } from '../web-src/cli-login.mjs';
import { createWitnessedSetupClient } from '../web-src/witnessed-setup-client.mjs';
import { fetchBufferReadinessPreview } from '../web-src/buffer-readiness-preview.mjs';
import { buildBufferWalletSetup } from '../agent/buffer-wallet-setup-plan.mjs';
import { createReadOnlyPreviewService } from '../agent/read-only-preview-service.mjs';
import { createWitnessedSetupHttpHandler } from '../agent/witnessed-setup-http.mjs';
import { createPostgresWalletPromptAuth, initializePostgresWalletPromptAuth } from '../agent/postgres-wallet-prompt-auth.mjs';
import { createPostgresWalletPromptFence, initializePostgresWalletPromptFence } from '../agent/postgres-wallet-prompt-fence.mjs';
import { createGitBranchWitnessStore, createGitNativeOraclePromptWitnessStore } from '../agent/git-branch-witness-store.mjs';
import { createWalletPromptWitness } from '../agent/git-wallet-prompt-witness.mjs';
import { createNativeOraclePromptWitness } from '../agent/git-native-oracle-prompt-witness.mjs';
import { createWitnessedWalletSetup } from '../agent/witnessed-wallet-setup.mjs';
import { createAuthenticatedWitnessedSetupService } from '../agent/authenticated-witnessed-setup-service.mjs';
import { wasm, NOW, snapshot as makeSnapshot, fixture as receiptFixture } from './buffer-wallet-setup-fixture.mjs';
import { firstSetupPreflightFixture, setSyntheticSetupStage } from './fixtures/wallet-setup-preflight-provider.mjs';

// Three FAKE transactions, throwaway keys and fabricated chain data. Even the
// reused account string is isolated in a new disposable test database and a
// local bare Git repo: no real wallet, RPC, GitHub, seller or token is touched.
const url = process.env.BOUNCER_TEST_POSTGRES_URL;
const dbtest = url && wasm ? test : test.skip;
const OWNER = 'great_mujey.testnet', site = 'https://phone.example.test';
const branch = 'arena/0ee9ab70-near-hub', stages = ['create_keyless_vault','register_vault_circle','fund_vault_circle'];

async function runScenario({ loseClaimAck = false, unknownWallet = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-setup-flow-'));
  const bare = path.join(dir, 'remote.git'), work = path.join(dir, 'work');
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding:'utf8', stdio:['ignore','pipe','pipe'] }).trim();
  const dbName = `bouncer_wallet_e2e_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({connectionString:url,max:2,connectionTimeoutMillis:5000}); let db, server, created = false;
  try {
    await admin.query(`CREATE DATABASE "${dbName}"`); created = true;
    const target = new URL(url); target.pathname = `/${dbName}`;
    db = new pg.Pool({connectionString:target.href,max:8,connectionTimeoutMillis:5000});
    await initializePostgresWalletPromptAuth({ pool:db }); await initializePostgresWalletPromptFence({ pool:db });
    fs.mkdirSync(work); git(dir,['init','--bare','--initial-branch',branch,bare]); git(work,['init','--initial-branch',branch]);
    git(work,['config','user.email','synthetic@example.test']); git(work,['config','user.name','Synthetic test']);
    git(work,['remote','add','origin',bare]); fs.writeFileSync(path.join(work,'README.md'),'Synthetic test only\n');
    git(work,['add','README.md']); git(work,['commit','-m','Initial synthetic commit']); git(work,['push','origin',branch]);
    const pair = nearApi.KeyPair.fromRandom('ed25519'), ownerKey = String(pair.getPublicKey());
    const snap = makeSnapshot(); snap.owner = OWNER; snap.candidate_vault = `vault.${OWNER}`;
    const review = buildBufferWalletSetup({snapshot:snap,wasmBytes:wasm,nowMs:NOW}).review;
    const originals = [0,1,2].map(i=>receiptFixture(i,70+i,{owner:OWNER,ownerKey}));
    const {provider,state,blockHash} = firstSetupPreflightFixture({owner:OWNER,ownerKey});
    const receipts = { async viewNodeStatus() { return {chain_id:'testnet'}; }, async txStatusReceipts(hash, owner, finality) {
      assert.equal(owner,OWNER); assert.equal(finality,'FINAL');
      const found = originals.find(o=>o.trustedOriginalHash === hash); if (!found) throw Error('synthetic unknown'); return found.result;
    } };
    const auth = createPostgresWalletPromptAuth({pool:db,origin:site,provider});
    const fence = createPostgresWalletPromptFence({pool:db,authenticate:auth.authenticate,setupWasmBytes:wasm,
      setupPreflightProvider:provider,setupReceiptProvider:receipts});
    const initialHead = git(work,['rev-parse','HEAD']);
    const store = createGitBranchWitnessStore({repo:work,branch,initialHead});
    const witness = createWalletPromptWitness({store});
    const otherWitness = createNativeOraclePromptWitness({store:createGitNativeOraclePromptWitnessStore({repo:work,branch,initialHead})});
    const coordinator = createWitnessedWalletSetup({fence,witness,otherWitness});
    const bridge = {pending:()=>[],take:()=>null,submit:()=>false,takeForBrowser:()=>null,submitEncrypted:()=>false};
    server = createReadOnlyPreviewService({bridge,siteOrigin:site,relayUrl:'https://bouncer-testnet-readonly-relay-tau.vercel.app/api/read',
      inspectReadiness:async()=>structuredClone(snap),makeReview:async()=>structuredClone(review),
      setupFactory:({getRetainedReview}) => createWitnessedSetupHttpHandler({siteOrigin:site,wasmBytes:wasm,owner:OWNER,
        service:createAuthenticatedWitnessedSetupService({auth,fence,witness,coordinator,getRetainedReview,setupWasmBytes:wasm,setupReceiptProvider:receipts,owner:OWNER})}) });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base = `http://127.0.0.1:${server.address().port}`, calls = []; let droppedOriginalAck = false, droppedClaimAck = false;
    const fetchImpl = async (address, options={}) => {
      if (address === 'https://test.rpc.fastnear.com') return new Response(JSON.stringify({jsonrpc:'2.0',id:'bouncer-cli-login',
        result:{permission:'FullAccess'}}),{headers:{'content-type':'application/json'}});
      if (typeof address !== 'string' || !address.startsWith('/api/')) throw Error('unexpected network');
      calls.push([address,options.method||'GET']);
      const headers = new Headers(options.headers || {}); headers.set('origin',site);
      const response = await fetch(`${base}${address}`,{...options,headers});
      if (address === '/api/wallet-setup/claim' && loseClaimAck && !droppedClaimAck) {
        droppedClaimAck = true; await response.body?.cancel(); throw Error('synthetic lost claim acknowledgement');
      }
      if (address === '/api/wallet-setup/original' && !droppedOriginalAck &&
          JSON.parse(options.body).originalHash === originals[1].trustedOriginalHash) {
        // The server committed, but the browser never received the acknowledgement.
        droppedOriginalAck = true; await response.body?.cancel(); throw Error('synthetic lost acknowledgement');
      }
      return response;
    };
    let messages = 0, txs = 0;
    const wallet = { manifest:{features:{signAndSendTransaction:true}}, async signMessage(params) {
      messages++; const hash = crypto.createHash('sha256').update(nep413Payload(params)).digest();
      return {accountId:OWNER,publicKey:ownerKey,signature:Buffer.from(pair.sign(hash).signature).toString('base64')};
    }, async signAndSendTransaction(params) {
      assert.equal(params.network,'testnet'); assert.equal(params.signerId,OWNER); const hash = originals[txs++].trustedOriginalHash;
      return unknownWallet && txs === 1 ? {} : {transaction:{hash},transaction_outcome:{id:hash}};
    } };
    const browser = createWitnessedSetupClient({wallet,accountId:OWNER,ownerPublicKey:ownerKey,location:{origin:site,host:'phone.example.test'},
      crypto:crypto.webcrypto,fetch:fetchImpl,isCurrent:()=>true});
    assert.equal(await browser.enabled(),true);
    const readiness = await fetchBufferReadinessPreview({fetch:fetchImpl});
    assert.equal(readiness.review.review_sha256,review.review_sha256);
    const reservation = await browser.reserve({taskId:readiness.task_id,review:readiness.review});
    assert.equal(reservation.status,'RESERVED_NOT_CLAIMED');
    if (loseClaimAck) {
      await assert.rejects(browser.approveStage({identity:reservation.identity,review:readiness.review,stageId:stages[0]}), /SETUP_RESULT_UNKNOWN/);
      assert.equal(droppedClaimAck,true); assert.equal(txs,0);
      const recovered = await browser.inspect();
      assert.equal(recovered.witnessed_records.at(-1).event,'claim');
      assert.equal(recovered.witnessed_records.at(-1).stage_id,stages[0]);
      await assert.rejects(browser.approveStage({identity:reservation.identity,review:readiness.review,stageId:stages[0]}));
      assert.equal(txs,0); return;
    }
    if (unknownWallet) {
      const outcome = await browser.approveStage({identity:reservation.identity,review:readiness.review,stageId:stages[0]});
      assert.equal(outcome.status,'WALLET_RESULT_UNKNOWN'); assert.equal(txs,1);
      await assert.rejects(browser.previewOriginal({stageId:stages[0],originalHash:originals[1].trustedOriginalHash}), /RECEIPT_UNKNOWN/);
      const stillClaimed = await browser.inspect(); assert.equal(stillClaimed.witnessed_records.at(-1).event,'claim');
      const proof = await browser.previewOriginal({stageId:stages[0],originalHash:originals[0].trustedOriginalHash});
      assert.equal(proof.status,'FINAL_SETUP_RECEIPT_MATCH'); assert.equal(proof.original_recorded,false);
      assert.equal((await browser.recordOriginal({identity:reservation.identity,stageId:stages[0],
        originalHash:originals[0].trustedOriginalHash})).status,'ORIGINAL_RECORDED');
      const reconciled = await browser.reconcile({identity:reservation.identity,stageId:stages[0],
        originalHash:originals[0].trustedOriginalHash});
      assert.equal(reconciled.status,'FINAL_SETUP_RECEIPT_MATCH'); assert.equal(txs,1); return;
    }
    for (let i=0;i<3;i++) {
      setSyntheticSetupStage(state,blockHash,i);
      const result = await browser.approveStage({identity:reservation.identity,review:readiness.review,stageId:stages[i]});
      assert.equal(result.status,'ORIGINAL_HASH_RETURNED'); assert.equal(result.original_hash,originals[i].trustedOriginalHash);
      if (i === 1) {
        await assert.rejects(browser.recordOriginal({identity:reservation.identity,stageId:stages[i],originalHash:result.original_hash}), /SETUP_RESULT_UNKNOWN/);
        const recovered = await browser.inspect();
        assert.equal(recovered.witnessed_records.find(record => record.stage_id === stages[i] && record.event === 'original').original_hash, result.original_hash);
      } else assert.equal((await browser.recordOriginal({identity:reservation.identity,stageId:stages[i],originalHash:result.original_hash})).status,'ORIGINAL_RECORDED');
      const matched = await browser.reconcile({identity:reservation.identity,stageId:stages[i],originalHash:result.original_hash});
      assert.equal(matched.status,i===2?'FINAL_FUNDING_RECEIPTS_MATCH':'FINAL_SETUP_RECEIPT_MATCH');
      await assert.rejects(browser.approveStage({identity:reservation.identity,review:readiness.review,stageId:stages[i]}));
    }
    setSyntheticSetupStage(state,blockHash,3);
    const verified = await browser.verifyFunded({identity:reservation.identity});
    assert.equal(verified.status,'READ_ONLY_SETUP_STAGE_PROFILE_MATCH'); assert.equal(verified.spending_unlocked,false);
    const restored = await browser.inspect();
    assert.equal(restored.status,'WITNESSED'); assert.equal(restored.witnessed_records.length,7);
    assert.equal(restored.review.review_sha256,review.review_sha256); assert.equal(txs,3); assert.equal(messages,13); assert.equal(droppedOriginalAck,true);
    assert.ok(calls.every(([u])=>u.startsWith('/api/read-only/')||u.startsWith('/api/wallet-setup/')));
  } finally {
    if (server) await new Promise(resolve=>server.close(resolve));
    await db?.end(); if (created) await admin.query(`DROP DATABASE "${dbName}"`); await admin.end();
    fs.rmSync(dir,{recursive:true,force:true});
  }
}

dbtest('browser to signed HTTP, PostgreSQL, Git CAS and three synthetic wallet outcomes reaches funded verification', { timeout:45_000 }, () => runScenario());
dbtest('lost claim acknowledgement blocks wallet invocation and remains fenced on recovery', { timeout:45_000 }, () => runScenario({loseClaimAck:true}));
dbtest('a lost wallet result can be previewed and recovered by original hash without another wallet transaction', { timeout:45_000 }, () => runScenario({unknownWallet:true}));
