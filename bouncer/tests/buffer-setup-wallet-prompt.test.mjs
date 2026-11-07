import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import nearApi from 'near-api-js';
import { buildBufferWalletSetup } from '../agent/buffer-wallet-setup-plan.mjs';
import { prepareBufferSetupWalletPrompt } from '../web-src/buffer-setup-wallet-prompt.mjs';
import { wasm, NOW, snapshot } from './buffer-wallet-setup-fixture.mjs';

// Synthetic wallet, synthetic testnet snapshot and disposable owner key only.
// No live wallet, transaction, broadcast, seller or funds are used.
const sha = data => createHash('sha256').update(data).digest('hex');
const OWNER = 'prompt-test.testnet', TOKEN = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
const WASM_HASH = '033f255c5822ff97495809f7d60fddf66f266f20c36285fe71296b66decc6d12';
const NEAR_HASH = 'Dg53QzTrw3cDWdgYTptmpkqvoeUpSXQsxL5HLcoF6Cq';
const stages = ['create_keyless_vault','register_vault_circle','fund_vault_circle'];
const hash = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n));
const time = 1_800_000_000_000;
function syntheticReview() {
  const vault = `vault.${OWNER}`;
  const actions = [
    [{ type:'create_account' }, { type:'transfer', deposit_yocto:'6000000000000000000000000' },
      { type:'deploy_contract', bytes:536651, sha256:WASM_HASH, near_code_hash:NEAR_HASH },
      { type:'function_call', method:'new', args:{ owner:OWNER }, gas:'30000000000000', deposit_yocto:'0' }],
    [{ type:'function_call', method:'storage_deposit', args:{ account_id:vault, registration_only:true },
      gas:'50000000000000', deposit_yocto:'1250000000000000000000' }],
    [{ type:'function_call', method:'ft_transfer_call', args:{ receiver_id:vault, amount:'20000000', msg:'' },
      gas:'300000000000000', deposit_yocto:'1' }],
  ];
  const review = { format:'bouncer-buffer-wallet-setup-review-v1', network:'testnet', owner:OWNER, vault,
    token:TOKEN, seller:'buffer-john-desk.testnet', fixed_product:'weekly-market-brief', fixed_product_price_atoms:'20000000',
    vault_wasm_sha256:WASM_HASH, vault_wasm_near_hash:NEAR_HASH, signing_or_broadcast_authorized:false,
    wallet_approval_obtained:false, stages:stages.map((id, i) => ({ id, signer_id:OWNER, receiver_id:i === 0 ? vault : TOKEN,
      actions:actions[i], action_commitment_sha256:String(i + 1).repeat(64) })) };
  return { ...review, review_sha256:sha(JSON.stringify(review)) };
}
function setup(review = syntheticReview(), i = 1) {
  const identity = { owner:OWNER, owner_public_key:String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey()),
    operation_id:'a'.repeat(32), review_sha256:review.review_sha256, stages:review.stages.map(s =>
      ({ stage_id:s.id, action_commitment_sha256:s.action_commitment_sha256 })) };
  const claim = { status:'PROMPT_CLAIMED_NO_HASH', independently_witnessed:true, do_not_retry:true,
    execution_authorized:false, owner:OWNER, operation_id:identity.operation_id, review_sha256:review.review_sha256,
    stage_id:stages[i], action_commitment_sha256:review.stages[i].action_commitment_sha256,
    witness_head:'c'.repeat(40), preflight_block_hash:hash(9), preflight_checked_at:new Date(time).toISOString() };
  const calls = [], wallet = { manifest:{ features:{ signAndSendTransaction:true } }, async signAndSendTransaction(params) {
    calls.push(params); return { transaction:{ hash:hash(4) }, transaction_outcome:{ id:hash(4) } };
  } };
  return { review, identity, claim, wallet, calls, args:{ wallet, review, identity, stageId:stages[i], crypto:webcrypto, now:()=>time } };
}

test('reviewed token registration makes exactly one explicit wallet call and retains only the original hash', async () => {
  const f = setup(), prompt = await prepareBufferSetupWalletPrompt(f.args);
  assert.equal(f.calls.length, 0);
  const result = await prompt.invoke(f.claim);
  assert.equal(result.status, 'ORIGINAL_HASH_RETURNED'); assert.equal(result.original_hash, hash(4));
  assert.equal(result.final_execution_verified, false); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].network, 'testnet'); assert.equal(f.calls[0].signerId, OWNER); assert.equal(f.calls[0].receiverId, TOKEN);
  assert.deepEqual(f.calls[0].actions, [{ type:'FunctionCall', params:{ methodName:'storage_deposit',
    args:{ account_id:`vault.${OWNER}`, registration_only:true }, gas:'50000000000000', deposit:'1250000000000000000000' } }]);
  await assert.rejects(prompt.invoke(f.claim), /BUFFER_SETUP_PROMPT_UNAVAILABLE/);
  assert.equal(f.calls.length, 1);
});

test('Circle funding is bound to the keyless vault and exactly 20 test USDC', async () => {
  const f = setup(syntheticReview(), 2), prompt = await prepareBufferSetupWalletPrompt(f.args);
  await prompt.invoke(f.claim);
  assert.deepEqual(f.calls[0].actions, [{ type:'FunctionCall', params:{ methodName:'ft_transfer_call',
    args:{ receiver_id:`vault.${OWNER}`, amount:'20000000', msg:'' }, gas:'300000000000000', deposit:'1' } }]);
});

test('missing witness, changed claim, elapsed preflight or wrong wallet never invokes', async () => {
  const f = setup(), prompt = await prepareBufferSetupWalletPrompt(f.args);
  const changes = [{ independently_witnessed:false }, { witness_head:'bad' }, { stage_id:stages[2] },
    { operation_id:'f'.repeat(32) }, { action_commitment_sha256:'f'.repeat(64) },
    { preflight_checked_at:new Date(time-5001).toISOString() }, { preflight_block_hash:'wrong' }];
  for (const c of changes) await assert.rejects(prompt.invoke({ ...f.claim, ...c }), /BUFFER_SETUP_PROMPT_UNAVAILABLE/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(prepareBufferSetupWalletPrompt({ ...f.args, wallet:{ manifest:{features:{}}, signAndSendTransaction() {} } }));
});

test('changed owner, amount, receiver, digest or stage fails before wallet invocation', async () => {
  const f = setup();
  const changes = [
    r => { r.owner = 'other.testnet'; }, r => { r.fixed_product_price_atoms = '20000001'; },
    r => { r.stages[1].receiver_id = 'evil.testnet'; }, r => { r.stages[1].actions[0].deposit_yocto = '99999999999999999999999'; },
    r => { r.stages[1].actions[0].args.account_id = 'evil.testnet'; }, r => { r.seller = 'evil.testnet'; },
    r => { r.review_sha256 = 'f'.repeat(64); },
  ];
  for (const change of changes) { const review = structuredClone(f.review); change(review);
    await assert.rejects(prepareBufferSetupWalletPrompt({ ...f.args, review }), /BUFFER_SETUP_PROMPT_UNAVAILABLE/); }
  assert.equal(f.calls.length, 0);
});

test('rejection, no hash and contradictory wallet hashes are unknown and never retried', async () => {
  for (const mode of ['throw','missing','conflicting']) {
    const f = setup(); let calls = 0;
    f.wallet.signAndSendTransaction = async () => { calls++; if (mode === 'throw') throw Error('wallet rejected or timed out');
      return mode === 'missing' ? {} : { transaction:{hash:hash(2)}, transaction_outcome:{id:hash(3)} }; };
    const prompt = await prepareBufferSetupWalletPrompt(f.args), result = await prompt.invoke(f.claim);
    assert.equal(result.status, 'WALLET_RESULT_UNKNOWN'); assert.equal(result.original_hash, null); assert.equal(result.do_not_retry, true);
    await assert.rejects(prompt.invoke(f.claim)); assert.equal(calls, 1);
  }
});

test('the exact pinned V12 bytes are checked before a creation claim is consumed', { skip: !wasm }, async () => {
  const s = snapshot(); s.owner = OWNER; s.candidate_vault = `vault.${OWNER}`;
  const { review } = buildBufferWalletSetup({ snapshot:s, wasmBytes:wasm, nowMs:NOW });
  const f = setup(review, 0);
  await assert.rejects(prepareBufferSetupWalletPrompt({ ...f.args, wasmBytes:new Uint8Array(wasm.length) }));
  const prompt = await prepareBufferSetupWalletPrompt({ ...f.args, wasmBytes:wasm });
  await prompt.invoke(f.claim);
  assert.deepEqual(f.calls[0].actions.map(x => x.type), ['CreateAccount','Transfer','DeployContract','FunctionCall']);
  assert.equal(f.calls[0].actions[2].params.code.length, 536651);
  assert.equal(sha(f.calls[0].actions[2].params.code), WASM_HASH);
});
