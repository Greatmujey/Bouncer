import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFtCallGoal, verifyFtCallSettlement, runFtCallGoal, recoverFtCallGoal } from '../agent/ft-call.mjs';
import { signingFixture } from './signing-fixture.mjs';
const initReceipt = '6'.repeat(44), tokenReceipt = '7'.repeat(44), callbackReceipt = '8'.repeat(44);
const goal = { id: 'api-credit', contract_id: 'bouncer.testnet', owner_account_id: 'owner.testnet', policy_id: 'api',
  payee: 'vendor.testnet', token: 'usdc.fakes.testnet', amount: '100', msg: '{"action":"deposit_balance"}',
  policy_revision: 1, route_revision: 2 };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
const signedArgs = () => ({ policy_id: goal.policy_id, payee: goal.payee, amount: goal.amount, expected_token: goal.token,
  expected_msg: goal.msg, expected_policy_revision: goal.policy_revision, expected_route_revision: goal.route_revision });
const signing = signingFixture({ ownerId: goal.owner_account_id, contractId: goal.contract_id, method: 'execute_ft_call', args: signedArgs() });
const { key, hash } = signing;
const transferArgs = () => ({ receiver_id: goal.payee, amount: goal.amount, memo: 'bouncer:guarded-ft-call', msg: goal.msg });
const callbackArgs = () => ({ policy_id: goal.policy_id, token: goal.token, amount: goal.amount, bucket: 24, policy_revision: goal.policy_revision });
function outcome(id, executor_id, status, logs = [], receipt_ids = []) { return { id, outcome: { executor_id, status, logs, receipt_ids } }; }
function receipt(id, predecessor_id, receiver_id, name, args, deposit) {
  return { receipt_id: id, predecessor_id, receiver_id, receipt: { Action: { actions: [{ FunctionCall: { method_name: name, args: encode(args), deposit } }] } } };
}
function finalResult(used = '60') {
  const value = encode(used), unused = (100n - BigInt(used)).toString();
  return { final_execution_status: 'FINAL', status: { SuccessValue: value }, transaction_outcome: { id: hash, outcome: { receipt_ids: [initReceipt] } },
    transaction: { hash, signer_id: goal.owner_account_id, receiver_id: goal.contract_id, public_key: key,
      actions: [{ FunctionCall: { method_name: 'execute_ft_call', deposit: '0', gas: '300000000000000', args: encode(signedArgs()) } }] },
    receipts_outcome: [
      outcome(initReceipt, goal.contract_id, { SuccessReceiptId: callbackReceipt }, ['BOUNCER guarded ft_transfer_call initiated; full amount reserved'], [tokenReceipt, callbackReceipt]),
      outcome(tokenReceipt, goal.token, { SuccessReceiptId: '9'.repeat(44) }),
      outcome(callbackReceipt, goal.contract_id, { SuccessValue: value }, [`BOUNCER ft_transfer_call settled; used=${used}; unused=${unused}`]),
    ],
    receipts: [receipt(tokenReceipt, goal.contract_id, goal.token, 'ft_transfer_call', transferArgs(), '1'),
      receipt(callbackReceipt, goal.contract_id, goal.contract_id, 'after_execute_ft_call', callbackArgs(), '0')],
  };
}
function fixture() {
  const state = new Map();
  const journal = { get(id) { return state.get(id); }, put(id, entry) { state.set(id, structuredClone(entry)); } };
  let sends = 0, reads = 0;
  const provider = {
    async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewAccessKey() { return { permission: { FunctionCall: { receiver_id: goal.contract_id, method_names: ['execute_ft_call'] } } }; },
    async callFunction(_, method) {
      if (method === 'contract_version') return 'bouncer-agent-v6';
      if (method === 'get_owner') return goal.owner_account_id;
      if (method === 'get_policy') return { token: goal.token, per_tx_cap: '100', daily_cap: '300' };
      if (method === 'get_ft_call_route') return { token: goal.token, msg: goal.msg, policy_revision: goal.policy_revision, route_revision: goal.route_revision, active: true };
      if (method === 'is_agent_key_allowed') return true;
      if (method === 'check') return [true, 'ok'];
      throw new Error(`unexpected view ${method}`);
    },
    async sendTransactionUntil(signed, wait) {
      sends++; assert.equal(signed.transaction.receiverId, goal.contract_id); assert.equal(wait, 'FINAL');
      assert.equal(journal.get(goal.id).status, 'pending'); assert.equal(journal.get(goal.id).tx_hash, hash);
      return { transaction_outcome: { id: hash } };
    },
    async txStatusReceipts(tx, owner, wait) { reads++; assert.equal(tx, hash); assert.equal(owner, goal.owner_account_id); assert.equal(wait, 'FINAL'); return finalResult(); },
  };
  const account = signing.newAccount();
  return { provider, account, journal, state, sends: () => sends, reads: () => reads };
}
const run = (f, opts = {}) => runFtCallGoal({ goal, provider: f.provider, account: f.account, publicKey: key, journal: f.journal, log: () => {}, ...opts });

test('FT goal is a bounded owner-pinned testnet order, including exact revisions and message', () => {
  assert.deepEqual(validateFtCallGoal(goal), goal);
  const invalid = [{ ...goal, amount: '0' }, { ...goal, amount: '-1' }, { ...goal, amount: '01' }, { ...goal, token: 'native' },
    { ...goal, payee: 'vendor.near' }, { ...goal, policy_revision: 0 }, { ...goal, route_revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...goal, msg: 'x'.repeat(2049) }, { ...goal, extra: true }, { ...goal, id: '../x' }];
  for (const item of invalid) assert.throws(() => validateFtCallGoal(item));
  assert.equal(validateFtCallGoal({ ...goal, msg: '' }).msg, '');
  assert.equal(validateFtCallGoal({ ...goal, token: 'a'.repeat(64) }).token, 'a'.repeat(64));
});

test('settlement uses NEP-141 amount USED and explicitly does not imply delivery', () => {
  assert.deepEqual(verifyFtCallSettlement(goal, finalResult(), key), { tx_hash: hash, token: goal.token, receiver: goal.payee,
    requested: '100', used: '60', unused: '40', verification: 'NEP-141 settlement via trusted RPC, token and Bouncer; no provider delivery verified' });
  const refund = finalResult('0');
  refund.receipts_outcome.push(outcome('9'.repeat(44), goal.payee, { Failure: { error: 'receiver refused' } }));
  assert.equal(verifyFtCallSettlement(goal, refund, key).unused, '100');
  assert.equal(verifyFtCallSettlement(goal, finalResult('100'), key).unused, '0');
});

test('new callback binds prepaid accounting to the reviewed payee and message, while legacy receipts remain recoverable', () => {
  const current = finalResult();
  current.receipts[1].receipt.Action.actions[0].FunctionCall.args = encode({ ...callbackArgs(), payee: goal.payee, msg: goal.msg });
  assert.equal(verifyFtCallSettlement(goal, current, key).used, '60');
  current.receipts[1].receipt.Action.actions[0].FunctionCall.args = encode({ ...callbackArgs(), payee: 'attacker.testnet', msg: goal.msg });
  assert.throws(() => verifyFtCallSettlement(goal, current, key), /callback/);
});

test('mismatched, malformed or unbound transaction and callback evidence fail closed', () => {
  const mutations = [
    r => { r.final_execution_status = 'EXECUTED'; }, r => { r.status.SuccessValue = encode(null); },
    r => { r.status.SuccessValue = encode('101'); }, r => { r.status.Failure = {}; },
    r => { r.transaction.signer_id = 'attacker.testnet'; }, r => { r.transaction_outcome.id = '1'.repeat(50); },
    r => { r.transaction.public_key = 'ed25519:other'; }, r => { r.transaction.actions.push(r.transaction.actions[0]); },
    r => { r.transaction.actions[0].FunctionCall.deposit = '1'; }, r => { r.transaction.actions[0].FunctionCall.gas = '1'; },
    r => { r.transaction_outcome.outcome.receipt_ids = ['other']; },
    r => { const a = signedArgs(); a.expected_msg = 'stolen'; r.transaction.actions[0].FunctionCall.args = encode(a); },
    r => { r.receipts_outcome[0].outcome.logs = []; }, r => { r.receipts_outcome[0].outcome.receipt_ids = [tokenReceipt]; },
    r => { r.receipts_outcome[0].outcome.status = { SuccessReceiptId: tokenReceipt }; },
    r => { r.receipts_outcome.push(structuredClone(r.receipts_outcome[1])); },
    r => { r.receipts.push(structuredClone(r.receipts[0])); },
    r => { r.receipts_outcome[1].outcome.status = { Failure: {} }; },
    r => { r.receipts[0].receipt.Action.actions[0].FunctionCall.deposit = '0'; },
    r => { const a = transferArgs(); a.receiver_id = 'attacker.testnet'; r.receipts[0].receipt.Action.actions[0].FunctionCall.args = encode(a); },
    r => { const a = transferArgs(); a.msg = 'stolen'; r.receipts[0].receipt.Action.actions[0].FunctionCall.args = encode(a); },
    r => { const a = callbackArgs(); a.policy_revision++; r.receipts[1].receipt.Action.actions[0].FunctionCall.args = encode(a); },
    r => { r.receipts_outcome[2].outcome.logs = []; }, r => { r.receipts_outcome[2].outcome.status = { Failure: {} }; },
    r => { r.receipts_outcome[2].outcome.status.Failure = {}; },
    r => { delete r.receipts; },
  ];
  for (const mutate of mutations) { const result = finalResult(); mutate(result); assert.throws(() => verifyFtCallSettlement(goal, result, key)); }
});

test('dry run checks exact route and spends nothing', async () => {
  const f = fixture(); assert.deepEqual(await run(f), { status: 'READY' }); assert.equal(f.sends(), 0); assert.equal(f.state.size, 0);
});

test('route changes and unsafe access keys block before signing or broadcast', async () => {
  for (const mutate of [
    f => { const original = f.provider.callFunction; f.provider.callFunction = async (c, m, a, o) => m === 'get_ft_call_route' ? { token: goal.token, msg: 'other', policy_revision: 1, route_revision: 2, active: true } : original(c, m, a, o); },
    f => { const original = f.provider.callFunction; f.provider.callFunction = async (c, m, a, o) => m === 'get_ft_call_route' ? { token: goal.token, msg: goal.msg, policy_revision: 1, route_revision: 2, active: false } : original(c, m, a, o); },
    f => { f.provider.viewAccessKey = async () => ({ permission: { FunctionCall: { receiver_id: goal.contract_id, method_names: ['execute_ft_call', 'set_policy'] } } }); },
  ]) { const f = fixture(); mutate(f); await assert.rejects(run(f, { execute: true })); assert.equal(f.sends(), 0); }
});

test('one broadcast is persisted first; key-free recovery verifies the same transaction', async () => {
  const f = fixture(), first = await run(f, { execute: true });
  assert.equal(first.status, 'SETTLED'); assert.equal(f.sends(), 1); assert.equal(f.journal.get(goal.id).status, 'completed');
  const again = await recoverFtCallGoal({ goal, provider: f.provider, journal: f.journal, log: () => {} });
  assert.equal(again.status, 'REUSED'); assert.equal(again.settlement.tx_hash, hash); assert.equal(f.sends(), 1);
  assert.equal((await run(f, { execute: true })).status, 'REUSED'); assert.equal(f.sends(), 1);
});

test('dry-run of a pending FT call reads the original receipt but leaves the journal unchanged', async () => {
  const f = fixture(), read = f.provider.txStatusReceipts;
  f.provider.txStatusReceipts = async (...args) => ({ ...await read(...args), receipts: [] });
  await assert.rejects(run(f, { execute: true }), /FT call unresolved/);
  const pending = structuredClone(f.journal.get(goal.id));
  f.provider.txStatusReceipts = read;
  f.journal.put(goal.id, { ...pending, status: 'invalid' });
  await assert.rejects(run(f, { execute: false }), /invalid journal status/);
  f.journal.put(goal.id, pending);
  assert.equal((await run(f, { execute: false })).status, 'REUSED');
  assert.deepEqual(f.journal.get(goal.id), pending); assert.equal(f.sends(), 1);
  assert.equal((await run(f, { execute: true })).status, 'REUSED');
  assert.equal(f.journal.get(goal.id).status, 'completed'); assert.equal(f.sends(), 1);
});

test('uncertain receipt leaves pending payment and recovery never resends', async () => {
  const f = fixture(), read = f.provider.txStatusReceipts;
  f.provider.txStatusReceipts = async (...args) => { const result = await read(...args); return { ...result, receipts: [] }; };
  await assert.rejects(run(f, { execute: true }), /FT call unresolved/);
  assert.equal(f.sends(), 1); assert.equal(f.journal.get(goal.id).status, 'pending');
  f.provider.txStatusReceipts = read;
  const recovered = await recoverFtCallGoal({ goal, provider: f.provider, journal: f.journal, log: () => {} });
  assert.equal(recovered.settlement.used, '60'); assert.equal(f.sends(), 1); assert.equal(f.journal.get(goal.id).status, 'completed');
});

test('send errors remain pending and changed goals or recorded settlements are never repaid', async () => {
  const f = fixture(); f.provider.sendTransactionUntil = async () => { throw new Error('timeout'); };
  await assert.rejects(run(f, { execute: true }), /do not resend automatically/);
  assert.equal(f.journal.get(goal.id).status, 'pending');
  await assert.rejects(recoverFtCallGoal({ goal: { ...goal, amount: '99' }, provider: f.provider, journal: f.journal, log: () => {} }), /does not match/);
  const recovered = await recoverFtCallGoal({ goal, provider: f.provider, journal: f.journal, log: () => {} });
  assert.equal(recovered.status, 'REUSED');
  const prior = f.journal.get(goal.id); f.journal.put(goal.id, { ...prior, settlement: { ...prior.settlement, used: '61' } });
  await assert.rejects(recoverFtCallGoal({ goal, provider: f.provider, journal: f.journal, log: () => {} }), /differs/);
});

test('FT calls support the distinct fresh v7 layout as well as existing v6 deployments', async () => {
  const f = fixture(), call = f.provider.callFunction;
  f.provider.callFunction = async (id, method, ...rest) => method === 'contract_version' ? 'bouncer-agent-v7' : call(id, method, ...rest);
  assert.equal((await run(f)).status, 'READY'); assert.equal(f.sends(), 0);
});

test('the separate testnet playback variant keeps the same guarded FT route checks', async () => {
  const f = fixture(), call = f.provider.callFunction;
  f.provider.callFunction = async (id, method, ...rest) => method === 'contract_version' ? 'bouncer-agent-v10-youtick-testnet' : call(id, method, ...rest);
  assert.equal((await run(f)).status, 'READY'); assert.equal(f.sends(), 0);
  f.provider.viewNodeStatus = async () => ({ chain_id: 'mainnet' });
  await assert.rejects(run(f), /must report testnet/); assert.equal(f.sends(), 0);
});

test('FT-call runner rejects altered prepared and signed transactions before journaling or broadcast', async () => {
  for (const mutate of [
    tx => { tx.receiverId = 'other.testnet'; }, tx => { tx.signerId = 'other.testnet'; },
    tx => { tx.actions[0].functionCall.methodName = 'execute'; }, tx => { tx.actions[0].functionCall.args = Buffer.from('{}'); },
    tx => { tx.actions[0].functionCall.deposit = 1n; }, tx => { tx.actions[0].functionCall.gas = 1n; },
    tx => { tx.actions.push(tx.actions[0]); },
  ]) {
    const f = fixture(), create = f.account.createTransaction;
    f.account.createTransaction = async (...args) => { const tx = await create(...args); mutate(tx); return tx; };
    await assert.rejects(run(f, { execute: true }), /prepared transaction does not match/);
    assert.equal(f.state.size, 0); assert.equal(f.sends(), 0);
  }
  for (const mutate of [
    ([hash]) => { hash[0] ^= 1; }, ([, signed]) => { signed.transaction.receiverId = 'other.testnet'; },
    ([, signed]) => { signed.signature.data[0] ^= 1; },
    ([, signed]) => { signed.signature.enum = 'secp256k1Signature'; },
  ]) {
    const f = fixture(), sign = f.account.signer.signTransaction;
    f.account.signer.signTransaction = async tx => { const result = await sign(tx); mutate(result); return result; };
    await assert.rejects(run(f, { execute: true }), /signed transaction does not match/);
    assert.equal(f.state.size, 0); assert.equal(f.sends(), 0);
  }
});

test('FT-call never broadcasts if the pending journal cannot be persisted', async () => {
  const f = fixture(); f.journal.put = () => { throw new Error('simulated fsync failure'); };
  await assert.rejects(run(f, { execute: true }), /simulated fsync failure/);
  assert.equal(f.sends(), 0); assert.equal(f.state.size, 0);
});

test('FT execution prefers the bounded one-shot provider path', async () => {
  const f = fixture(), original = f.provider.sendTransactionUntil.bind(f.provider);
  f.provider.sendTransactionOnce = original;
  f.provider.sendTransactionUntil = async () => { throw new Error('unbounded send path must not run'); };
  assert.equal((await run(f, { execute: true })).status, 'SETTLED');
  assert.equal(f.sends(), 1);
});

test('concurrent FT operations sharing a journal cannot reserve or send twice', async () => {
  const f = fixture(); let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const check = f.provider.viewNodeStatus.bind(f.provider);
  f.provider.viewNodeStatus = async () => { entered(); await gate; return check(); };
  const first = run(f, { execute: true });
  await started;
  await assert.rejects(run(f, { execute: true }), /another payment operation.*journal/);
  await assert.rejects(recoverFtCallGoal({ goal, provider: f.provider, journal: f.journal }), /another payment operation.*journal/);
  release();
  assert.equal((await first).status, 'SETTLED');
  assert.equal(f.sends(), 1);
});

test('FT execution will not overwrite a journal entry inserted while signing', async () => {
  const f = fixture(), create = f.account.createTransaction.bind(f.account);
  f.account.createTransaction = async (...args) => {
    const tx = await create(...args);
    f.journal.put(goal.id, { status: 'pending', tx_hash: 'unrelated reservation' });
    return tx;
  };
  await assert.rejects(run(f, { execute: true }), /entry appeared before broadcast/);
  assert.equal(f.sends(), 0);
  assert.equal(f.journal.get(goal.id).tx_hash, 'unrelated reservation');
});

test('FT and paid-project protocols coordinate the same in-process journal object', async () => {
  const { runProjectGoal } = await import('../agent/outlayer-project.mjs');
  const f = fixture(); let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const check = f.provider.viewNodeStatus.bind(f.provider);
  f.provider.viewNodeStatus = async () => { entered(); await gate; return check(); };
  const first = run(f, { execute: true });
  await started;
  await assert.rejects(runProjectGoal({ journal: f.journal }), /another payment operation.*journal/);
  release();
  assert.equal((await first).status, 'SETTLED');
  assert.equal(f.sends(), 1);
});

test('V11 FT runner requires a pinned keyless vault, exact one-method key, and unlocked exact-intent boundaries', async () => {
  const { V11_NEAR_CODE_HASH } = await import('../agent/keyless-vault-bootstrap.mjs');
  const { V11_RESOURCE_VERSION } = await import('../agent/v11-resource-preflight.mjs');
  const f=fixture(), original=f.provider.callFunction.bind(f.provider), block='1'.repeat(32);
  let locked=false, code=V11_NEAR_CODE_HASH, keyMethods=['execute_ft_call'];
  f.provider.callFunction=async(account,method,args,ref)=>method==='contract_version'?V11_RESOURCE_VERSION:original(account,method,args,ref);
  f.provider.viewBlock=async()=>({header:{hash:block,timestamp_nanosec:String(BigInt(Date.now())*1_000_000n)}});
  f.provider.query=async q=>{
    assert.equal(q.block_id,block);
    if(q.request_type==='view_account')return {block_hash:block,code_hash:code};
    if(q.request_type==='view_access_key_list')return {block_hash:block,keys:[]};
    if(q.request_type==='view_access_key')return {block_hash:block,permission:{FunctionCall:{receiver_id:goal.contract_id,method_names:keyMethods,allowance:'100'}}};
    throw Error('unexpected query');
  };
  f.provider.callFunctionRaw=async(account,method,args,ref)=>{
    assert.equal(ref.blockId,block);
    const value=method==='is_exact_ft_policy_locked'||method==='is_exact_ft_payee_locked'?locked:await f.provider.callFunction(account,method,args,ref);
    return {block_hash:block,result:[...Buffer.from(JSON.stringify(value))]};
  };
  assert.deepEqual(await run(f),{status:'READY'});
  locked=true;await assert.rejects(run(f),/exact-intent lock/);locked=false;
  code='wrong';await assert.rejects(run(f),/vault code/);code=V11_NEAR_CODE_HASH;
  keyMethods=['execute_ft_call','execute'];await assert.rejects(run(f),/restricted key/);
  assert.equal(f.sends(),0);
});
