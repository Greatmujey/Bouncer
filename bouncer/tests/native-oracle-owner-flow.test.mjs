import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { buildNativeOracleWalletPlan, NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } from '../agent/native-oracle-wallet-plan.mjs';
import { createNativeOracleOwnerFlow, formatNativeNear } from '../web-src/native-oracle-owner-flow.mjs';

const wasm = fs.readFileSync(new URL('../../bouncer.wasm', import.meta.url));
const OWNER = 'great_mujey.testnet', VAULT = `native.${OWNER}`, ORIGIN = 'https://4173-synthetic.e2b.app';
const key = () => String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const hash = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n));

function fixture(options = {}) {
  const ownerKey = key(), agentKey = key(), calls = [], events = [];
  const review = buildNativeOracleWalletPlan({ wasmBytes: wasm, terms: { owner: OWNER, vault: VAULT, policy_id: 'price',
    agent_public_key: agentKey, per_tx_cap_yocto: '100000000000000000000000', daily_cap_yocto: '100000000000000000000000',
    vault_deposit_yocto: '100000000000000000000000', agent_gas_allowance_yocto: NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } }).review;
  const identity = { owner: OWNER, owner_public_key: ownerKey, operation_id: '1'.repeat(32), review_sha256: review.review_sha256,
    stages: review.stages.map(s => ({ stage_id: s.id, action_commitment_sha256: s.action_commitment_sha256 })) };
  const rows = identity.stages.map(s => ({ ...s, claimed: false, original_hash: null }));
  let local = false, reserved = false, session = true, unknown = options.unknown || false, loseRecordAck = options.loseRecordAck || false;
  let receiptMatches = true, lastHash = null, trial = null;
  const records = [];
  const store = {
    async inspect({ expected_public_key } = {}) { calls.push('device-inspect');
      return local ? { status:'LOCAL_DEVICE_KEY_AVAILABLE', owner:OWNER, vault:VAULT, origin:ORIGIN, public_key:agentKey,
        expected_public_key_matched:expected_public_key === agentKey, private_key_exportable:false, local_storage_only:true, signing_authorized:false }
        : { status:'NO_LOCAL_DEVICE_KEY' }; },
    async create() { calls.push('device-create'); local = true; return this.inspect(); }, close() { calls.push('device-close'); },
  };
  const client = {
    async inspect() { calls.push('inspect'); return reserved ? { status:'WITNESSED', identity:structuredClone(identity), review:structuredClone(review),
      database_stages:structuredClone(rows), witnessed_records:structuredClone(trial ? [...records,trial] : records), execution_authorized:false }
      : { status:'NO_LOCAL_RECORD', execution_authorized:false }; },
    async createReview() { calls.push('review'); return { task_id:review.review_sha256, review:structuredClone(review), signing_authorized:false, transaction_sent:false }; },
    async reserve() { calls.push('reserve'); reserved = true; records.push({event:'reserve'}); return { status:'RESERVED_NOT_CLAIMED', identity:structuredClone(identity),
      witness_head:'b'.repeat(40), execution_authorized:false }; },
    async approveStage({ stageId }) { calls.push(`prompt:${stageId}`); const i=rows.findIndex(r=>r.stage_id===stageId);
      assert.ok(i>=0 && !rows[i].claimed); rows[i].claimed=true; lastHash=hash(i+1); records.push({event:'claim',stage_id:stageId});
      if (unknown) { unknown=false; return {status:'WALLET_RESULT_UNKNOWN',do_not_retry:true,original_hash:null}; }
      return {status:'ORIGINAL_HASH_RETURNED',original_hash:lastHash,do_not_retry:true}; },
    async recordOriginal({ stageId, originalHash }) { calls.push(`record:${stageId}`); const row=rows.find(r=>r.stage_id===stageId);
      assert.equal(row.claimed,true); row.original_hash=originalHash; records.push({event:'original',stage_id:stageId,original_hash:originalHash});
      if (loseRecordAck) { loseRecordAck=false; throw Error('lost acknowledgment'); }
      return { status:'ORIGINAL_RECORDED', owner:OWNER, operation_id:identity.operation_id, stage_id:stageId,
        original_hash:originalHash, do_not_retry:true, execution_authorized:false }; },
    async previewOriginal({ stageId, originalHash }) { calls.push(`preview:${stageId}`); const row=rows.find(r=>r.stage_id===stageId);
      return { status:receiptMatches ? (stageId===rows.at(-1).stage_id ? 'FINAL_LOCAL_ADD_KEY_OUTCOME_MATCH' : 'FINAL_NATIVE_SETUP_RECEIPT_MATCH') : 'FINAL_FAILURE_NEEDS_STATE_REVIEW',
        stage_id:stageId, tx_hash:originalHash, original_recorded:row.original_hash===originalHash, execution_authorized:false }; },
    async verifyCompletion() { calls.push('completion'); const now=Date.now(); return {version:1,network:'testnet',
      status:'FOUR_ORIGINALS_AND_STATE_MATCH_NOT_AUTHORIZED',stage_id:'verify_native_setup_completion',owner:OWNER,vault:VAULT,
      review_sha256:review.review_sha256,independently_witnessed:true,witness_head:'b'.repeat(40),execution_authorized:false,
      signing_authorized:false,transaction_sent:false,owner_approval_obtained:false,wallet_prompt_authorized:false,
      prior_original_hashes:rows.map(r=>r.original_hash),checks:Object.fromEntries(['plain_owner','exact_owner_key','owner_native_estimate',
        'protocol_and_selected_features','agent_gas_allowance_estimate','pinned_project_identity_and_native_pricing','exact_agent_key',
        'exact_keyless_vault','native_policy_state','vault_native_balance','onchain_policy_check'].map(x=>[x,true])),blockers:[],
      observed_at:new Date(now).toISOString(),block_height:1,block_timestamp_nanosec:String(BigInt(now)*1000000n),agent_key_nonce:'0',block_hash:hash(77)}; },
  };
  const flow = createNativeOracleOwnerFlow({ client, deviceStore:store, ownerPublicKey:ownerKey, origin:ORIGIN, crypto:crypto.webcrypto,
    isCurrent:()=>session, interact:async(work)=>work(), onChange:s=>events.push(s) });
  return {flow,client,store,calls,events,review,identity,rows,get lastHash(){return lastHash},
    setSession:v=>{session=v},setLocal:v=>{local=v},setReceiptMatches:v=>{receiptMatches=v},setTrial:v=>{trial=v}};
}

async function prepare(f) {
  await f.flow.check(); assert.equal(f.flow.getState().phase,'create_device');
  await f.flow.createDevice(); assert.equal(f.flow.getState().phase,'review');
  await f.flow.reserve({ownerConfirmed:true}); assert.equal(f.flow.getState().phase,'stage');
}

test('each native setup stage requires a separate explicit approval and a successful original receipt', async () => {
  const f=fixture(); await f.flow.check(); assert.equal(f.flow.getState().phase,'create_device');
  assert.equal(f.calls.some(c=>c.startsWith('prompt:')),false);
  await f.flow.createDevice(); const terms=f.flow.getState().terms;
  assert.deepEqual({storage:terms.storageNear,deposit:terms.depositNear,cap:terms.capNear,daily:terms.dailyNear,gas:terms.gasAllowanceNear},
    {storage:'5.4',deposit:'0.1',cap:'0.1',daily:'0.1',gas:'0.5'});
  await assert.rejects(f.flow.reserve(),e=>e.code==='NATIVE_OWNER_CONFIRMATION_REQUIRED');
  assert.equal(f.calls.includes('reserve'),false);
  await f.flow.reserve({ownerConfirmed:true});
  for (let i=0;i<4;i++) {
    const before=f.calls.filter(c=>c.startsWith('prompt:')).length;
    await assert.rejects(f.flow.approveStage(),e=>e.code==='NATIVE_OWNER_CONFIRMATION_REQUIRED');
    assert.equal(f.calls.filter(c=>c.startsWith('prompt:')).length,before);
    await f.flow.approveStage({ownerConfirmed:true});
    assert.equal(f.flow.getState().phase,'await_receipt');
    assert.equal(f.calls.filter(c=>c.startsWith('prompt:')).length,i+1);
    await assert.rejects(f.flow.approveStage({ownerConfirmed:true}),e=>e.code==='NATIVE_FLOW_ACTION_NOT_AVAILABLE');
    await f.flow.checkReceipt();
    assert.equal(f.flow.getState().phase,i===3?'verify_setup':'stage');
  }
  await f.flow.verifySetup(); assert.equal(f.flow.getState().phase,'setup_verified');
  assert.match(f.flow.getState().message,/did not buy a resource/);
  assert.equal(f.calls.filter(c=>c.startsWith('prompt:')).length,4);
});

test('unknown wallet result is recovered by original hash and never prompts again', async () => {
  const f=fixture({unknown:true}); await prepare(f); await f.flow.approveStage({ownerConfirmed:true});
  assert.equal(f.flow.getState().phase,'recover'); assert.equal(f.calls.filter(c=>c.startsWith('prompt:')).length,1);
  await assert.rejects(f.flow.approveStage({ownerConfirmed:true}),e=>e.code==='NATIVE_FLOW_ACTION_NOT_AVAILABLE');
  await assert.rejects(f.flow.recoverOriginal({hash:'not-a-hash',ownerConfirmed:true}),e=>e.code==='NATIVE_ORIGINAL_REQUIRED');
  await f.flow.check(); assert.equal(f.flow.getState().phase,'recover');
  await f.flow.recoverOriginal({hash:f.lastHash,ownerConfirmed:true}); assert.equal(f.flow.getState().phase,'await_receipt');
  await f.flow.checkReceipt(); assert.equal(f.flow.getState().phase,'stage');
  assert.equal(f.flow.getState().stageId,'configure_native_oracle_policy');
  assert.equal(f.calls.filter(c=>c.startsWith('prompt:')).length,1);
});

test('lost original-record acknowledgement recovers the retained hash without a second wallet prompt', async () => {
  const f=fixture({loseRecordAck:true}); await prepare(f);
  await assert.rejects(f.flow.approveStage({ownerConfirmed:true}),/lost acknowledgment/);
  assert.equal(f.flow.getState().phase,'stopped'); assert.equal(f.flow.getState().originalHash,f.lastHash);
  await f.flow.check(); assert.equal(f.flow.getState().phase,'await_receipt');
  await f.flow.checkReceipt(); assert.equal(f.flow.getState().stageId,'configure_native_oracle_policy');
  assert.equal(f.calls.filter(c=>c.startsWith('prompt:')).length,1);
});

test('a failed receipt or a lost local key blocks subsequent wallet transactions', async () => {
  const f=fixture(); await prepare(f); await f.flow.approveStage({ownerConfirmed:true});
  f.setReceiptMatches(false); await f.flow.checkReceipt(); assert.equal(f.flow.getState().phase,'blocked');
  await assert.rejects(f.flow.approveStage({ownerConfirmed:true}),e=>e.code==='NATIVE_FLOW_ACTION_NOT_AVAILABLE');
  f.setLocal(false); await f.flow.check(); assert.equal(f.flow.getState().phase,'blocked');
  assert.match(f.flow.getState().message,/does not have the retained agent key/);
  assert.equal(f.calls.filter(c=>c.startsWith('prompt:')).length,1);
});

test('already-witnessed trial cannot be mistaken for permission to request another transaction', async () => {
  const f=fixture(); await prepare(f);
  for(let i=0;i<4;i++){await f.flow.approveStage({ownerConfirmed:true});await f.flow.checkReceipt();}
  f.setTrial({event:'trial_claim',original_hash:hash(9)}); await f.flow.check();
  assert.equal(f.flow.getState().phase,'trial_retained'); assert.equal(f.flow.getState().originalHash,hash(9));
  await assert.rejects(f.flow.approveStage({ownerConfirmed:true}),e=>e.code==='NATIVE_FLOW_ACTION_NOT_AVAILABLE');
  assert.equal(f.calls.filter(c=>c.startsWith('prompt:')).length,4);
});

test('double taps cannot produce a second in-flight stage prompt', async () => {
  const f=fixture(); await prepare(f); const original=f.client.approveStage; let release;
  f.client.approveStage=async args=>{await new Promise(resolve=>{release=resolve});return original(args)};
  const first=f.flow.approveStage({ownerConfirmed:true}); await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(f.flow.approveStage({ownerConfirmed:true}),e=>e.code==='NATIVE_FLOW_ACTION_NOT_AVAILABLE');
  release(); await first; assert.equal(f.calls.filter(c=>c.startsWith('prompt:')).length,1);
  assert.equal(f.flow.getState().phase,'await_receipt');
});

test('an unacknowledged reservation and a malformed review both fail closed', async () => {
  const f=fixture();await f.flow.check();await f.flow.createDevice();
  f.client.reserve=async()=>{throw Error('synthetic lost reservation acknowledgement')};
  await assert.rejects(f.flow.reserve({ownerConfirmed:true}));assert.equal(f.flow.getState().phase,'stopped');
  await f.flow.check();assert.equal(f.flow.getState().phase,'blocked');assert.match(f.flow.getState().message,/do not reserve or prompt again/);
  const g=fixture();await g.flow.check();const original=g.client.createReview;
  g.client.createReview=async args=>{const output=await original(args);output.review.payee='evil.testnet';return output};
  await assert.rejects(g.flow.createDevice());assert.equal(g.flow.getState().phase,'stopped');
  assert.equal(g.calls.includes('reserve'),false);assert.equal(g.calls.some(c=>c.startsWith('prompt:')),false);
});

test('a status-only completion cannot be presented as a verified setup', async () => {
  const f=fixture();await prepare(f);
  for(let i=0;i<4;i++){await f.flow.approveStage({ownerConfirmed:true});await f.flow.checkReceipt();}
  f.client.verifyCompletion=async()=>({status:'FOUR_ORIGINALS_AND_STATE_MATCH_NOT_AUTHORIZED',execution_authorized:false});
  await f.flow.verifySetup();assert.equal(f.flow.getState().phase,'blocked');
  assert.match(f.flow.getState().message,/did not match/);
});

test('closing or changing the wallet session blocks pending work', async () => {
  const f=fixture(); let release;
  f.client.inspect=async()=>new Promise(resolve=>{release=()=>resolve({status:'NO_LOCAL_RECORD',execution_authorized:false})});
  const pending=f.flow.check(); await new Promise(resolve=>setImmediate(resolve)); f.setSession(false); release();
  await assert.rejects(pending,e=>e.code==='NATIVE_FLOW_SESSION_CHANGED');
  assert.equal(f.calls.includes('device-create'),false); assert.equal(f.calls.some(c=>c.startsWith('prompt:')),false);
  f.flow.destroy(); assert.ok(f.calls.includes('device-close'));
});

test('native display formatting is exact and rejects malformed amounts', () => {
  assert.equal(formatNativeNear('1'),'0.000000000000000000000001');
  assert.equal(formatNativeNear('5400000000000000000000000'),'5.4');
  assert.equal(formatNativeNear('123456789012345678901234567890'),'123456.78901234567890123456789');
  for(const invalid of ['01','-1','1.0',1,null]) assert.throws(()=>formatNativeNear(invalid));
});
