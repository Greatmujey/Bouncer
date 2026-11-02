/**
 * TEST ONLY. Exercise the real V11 bytecode and nearcore's example FT on a
 * disposable, loopback-only chain. A second V11 vault stands in for a token
 * receiver; it is NOT PayPerCall and does not implement escrow, service calls,
 * buyer claims, operator delivery, or the PayPerCall receiver message.
 *
 * This isolates the token/ledger consequence of a later plain FT transfer vs
 * a later ft_transfer_call. It does not fix Bouncer, prove Circle semantics,
 * authorize a live payment, or prove any seller's deployed code.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { V11_SHA256, assertSandboxStatus, requireFinalSuccess, requireReceiptLog } from './v11-sandbox-support.mjs';
import { loopbackSandboxUrl, withSandboxOnlyFetch } from './v11-sandbox-setup-rpc.mjs';

const BUYER = 'escrow-buyer.testnet', BUYER_VAULT = 'vault.escrow-buyer.testnet';
const RECEIVER = 'escrow-receiver.testnet', RECEIVER_VAULT = 'vault.escrow-receiver.testnet';
const BUY_POLICY = 'unlocked-api', LOCKED_POLICY = 'locked-api', RETURN_POLICY = 'return';
const FT_MSG = '{"sandbox_only":"receiver-ignores-this"}', RETURN_MSG = 'sandbox-return';
const NEAR = 10n ** 24n, TGAS = 10n ** 12n, { transactions: tx } = nearApi;
const key = () => nearApi.KeyPair.fromRandom('ed25519');
const account = (id, provider, pair) => new nearApi.Account(id, provider, new nearApi.KeyPairSigner(pair));
const fn = (method, args = {}, deposit = 0n, gas = 100n * TGAS) => tx.functionCall(method, args, gas, deposit);
const pub = pair => String(pair.getPublicKey());

export async function exerciseSandboxEscrowBoundary({ rpcUrl, root, tokenOwner, wasm, storageMin, checkpoint = () => {} }) {
  const endpoint = loopbackSandboxUrl(rpcUrl);
  let rootEndpoint, tokenOwnerEndpoint;
  try {
    rootEndpoint = loopbackSandboxUrl(root?.provider?.connection?.url);
    tokenOwnerEndpoint = loopbackSandboxUrl(tokenOwner?.provider?.connection?.url);
  } catch { throw new Error('isolated sandbox root, token owner and pinned V11 are required'); }
  if (root?.accountId !== 'testnet' || tokenOwner?.accountId !== 'owner.testnet' ||
      rootEndpoint !== endpoint || tokenOwnerEndpoint !== endpoint ||
      !Buffer.isBuffer(wasm) || wasm.length !== 536325 || crypto.createHash('sha256').update(wasm).digest('hex') !== V11_SHA256 ||
      typeof storageMin !== 'string' || !/^[1-9][0-9]{0,24}$/.test(storageMin) || BigInt(storageMin) > 10n ** 23n ||
      typeof checkpoint !== 'function') throw new Error('isolated sandbox root, token owner and pinned V11 are required');
  return withSandboxOnlyFetch(endpoint, () => exercise({ endpoint, root, tokenOwner, wasm, storageMin, checkpoint }));
}

async function exercise({ endpoint, root, tokenOwner, wasm, storageMin, checkpoint }) {
  const provider = new nearApi.providers.JsonRpcProvider({ url: endpoint });
  assertSandboxStatus(await provider.status());
  const buyerKey = key(), buyerAgentKey = key(), receiverKey = key(), receiverAgentKey = key();
  const buyer = account(BUYER, provider, buyerKey), buyerAgent = account(BUYER, provider, buyerAgentKey);
  const receiver = account(RECEIVER, provider, receiverKey), receiverAgent = account(RECEIVER, provider, receiverAgentKey);
  const call = (signer, receiverId, method, args, deposit = 0n, gas = 100n * TGAS) =>
    signer.signAndSendTransaction({ receiverId, actions: [fn(method, args, deposit, gas)], waitUntil: 'FINAL', throwOnFailure: false });
  const must = async (signer, receiverId, method, args, deposit = 0n, gas = 100n * TGAS) => {
    const result = await call(signer, receiverId, method, args, deposit, gas);
    requireFinalSuccess(result, method); return result;
  };
  const batch = async (signer, receiverId, actions, label) => {
    const result = await signer.signAndSendTransaction({ receiverId, actions, waitUntil: 'FINAL', throwOnFailure: false });
    requireFinalSuccess(result, label); return result;
  };
  const view = (id, method, args = {}) => provider.callFunction(id, method, args, { finality: 'final' });
  const ftBalance = id => view(TOKEN, 'ft_balance_of', { account_id: id });
  const tracked = id => view(id, 'vault_balance', { token: TOKEN });
  const spent = (id, policy) => view(id, 'daily_spent', { policy_id: policy });
  const setupOwner = (id, pair) => batch(root, id, [tx.createAccount(), tx.transfer(100n * NEAR),
    tx.addKey(pair.getPublicKey(), tx.fullAccessKey())], 'create sandbox owner');
  const setupVault = (signer, id, owner) => batch(signer, id, [tx.createAccount(), tx.transfer(8n * NEAR),
    tx.deployContract(wasm), fn('new', { owner })], 'create keyless sandbox vault');
  const addAgent = (signer, id, pair, methods) => batch(signer, id,
    [tx.addKey(pair.getPublicKey(), tx.functionCallAccessKey(id === BUYER ? BUYER_VAULT : RECEIVER_VAULT, methods, NEAR))],
    'install sandbox restricted key');
  const assertFailure = (result, pattern, label) => {
    assert.equal(result?.final_execution_status, 'FINAL', `${label}: result must be FINAL`);
    assert.ok(result?.status?.Failure, `${label}: expected failure`);
    assert.match(JSON.stringify(result.status.Failure), pattern, `${label}: unexpected failure`);
  };

  await setupOwner(BUYER, buyerKey); await setupOwner(RECEIVER, receiverKey);
  await setupVault(buyer, BUYER_VAULT, BUYER); await setupVault(receiver, RECEIVER_VAULT, RECEIVER);
  assert.deepEqual((await provider.viewAccessKeyList(BUYER_VAULT, { finality: 'final' })).keys, []);
  assert.deepEqual((await provider.viewAccessKeyList(RECEIVER_VAULT, { finality: 'final' })).keys, []);
  await addAgent(buyer, BUYER, buyerAgentKey, ['execute_ft_call']);
  await addAgent(receiver, RECEIVER, receiverAgentKey, ['execute', 'execute_ft_call']);
  for (const id of [BUYER_VAULT, RECEIVER_VAULT]) {
    await must(tokenOwner, TOKEN, 'storage_deposit', { account_id: id, registration_only: true }, BigInt(storageMin), 50n * TGAS);
  }
  await must(tokenOwner, TOKEN, 'ft_transfer_call', { receiver_id: BUYER_VAULT, amount: '1000',
    memo: 'sandbox-only initial funding', msg: '' }, 1n, 300n * TGAS);
  assert.equal(await ftBalance(BUYER_VAULT), '1000'); assert.equal(await tracked(BUYER_VAULT), '1000');

  for (const policy of [BUY_POLICY, LOCKED_POLICY]) {
    await must(buyer, BUYER_VAULT, 'set_policy', { policy_id: policy, token: TOKEN, per_tx_cap: '100', daily_cap: '200' }, 1n);
    await must(buyer, BUYER_VAULT, 'allow_payee', { policy_id: policy, payee: RECEIVER_VAULT }, 1n);
    await must(buyer, BUYER_VAULT, 'grant_agent_key', { policy_id: policy, public_key: pub(buyerAgentKey) }, 1n);
    await must(buyer, BUYER_VAULT, 'set_ft_call_message', { policy_id: policy, payee: RECEIVER_VAULT, msg: FT_MSG }, 1n);
  }
  await must(buyer, BUYER_VAULT, 'lock_ft_policy_to_intents', { policy_id: LOCKED_POLICY }, 1n);
  const request = policy_id => ({ policy_id, payee: RECEIVER_VAULT, amount: '100', expected_token: TOKEN,
    expected_msg: FT_MSG, expected_policy_revision: 1, expected_route_revision: 1 });
  const blocked = await call(buyerAgent, BUYER_VAULT, 'execute_ft_call', request(LOCKED_POLICY), 0n, 300n * TGAS);
  assertFailure(blocked, /policy requires exact FT intents/, 'locked FT-call');
  assert.equal(await ftBalance(BUYER_VAULT), '1000'); assert.equal(await tracked(BUYER_VAULT), '1000');

  await must(receiver, RECEIVER_VAULT, 'set_policy', { policy_id: RETURN_POLICY, token: TOKEN,
    per_tx_cap: '100', daily_cap: '200' }, 1n);
  await must(receiver, RECEIVER_VAULT, 'allow_payee', { policy_id: RETURN_POLICY, payee: BUYER_VAULT }, 1n);
  await must(receiver, RECEIVER_VAULT, 'grant_agent_key', { policy_id: RETURN_POLICY, public_key: pub(receiverAgentKey) }, 1n);
  await must(receiver, RECEIVER_VAULT, 'set_ft_call_message', { policy_id: RETURN_POLICY, payee: BUYER_VAULT, msg: RETURN_MSG }, 1n);

  const first = await must(buyerAgent, BUYER_VAULT, 'execute_ft_call', request(BUY_POLICY), 0n, 300n * TGAS);
  requireReceiptLog(first, BUYER_VAULT, 'BOUNCER ft_transfer_call settled; used=100; unused=0');
  assert.equal(await ftBalance(BUYER_VAULT), '900'); assert.equal(await tracked(BUYER_VAULT), '900');
  assert.equal(await ftBalance(RECEIVER_VAULT), '100'); assert.equal(await tracked(RECEIVER_VAULT), '100');
  assert.equal(await spent(BUYER_VAULT, BUY_POLICY), '100');

  // Stand-in receiver returns tokens by plain ft_transfer, like the reviewed
  // PayPerCall source's later refund. V11 does not receive ft_on_transfer.
  const plain = await must(receiverAgent, RECEIVER_VAULT, 'execute', { policy_id: RETURN_POLICY, payee: BUYER_VAULT,
    amount: '100', memo: 'sandbox-only plain return', expected_token: TOKEN }, 0n, 200n * TGAS);
  assert.equal(await ftBalance(BUYER_VAULT), '1000'); assert.equal(await tracked(BUYER_VAULT), '900');
  assert.equal(await ftBalance(RECEIVER_VAULT), '0'); assert.equal(await tracked(RECEIVER_VAULT), '0');
  assert.equal(await spent(BUYER_VAULT, BUY_POLICY), '100');
  const tooMuch = await call(buyer, BUYER_VAULT, 'withdraw', { token: TOKEN, amount: '1000' }, 1n);
  assertFailure(tooMuch, /insufficient vault balance/, 'withdraw untracked return');

  // An unlocked route is not one-shot: a second request fits the 200-unit
  // daily cap. The stand-in returns the second 100 with ft_transfer_call;
  // V11's receiver hook credits that callback, but does not repair the first
  // plain return or release the earlier rolling spend.
  const second = await must(buyerAgent, BUYER_VAULT, 'execute_ft_call', request(BUY_POLICY), 0n, 300n * TGAS);
  assert.equal(await ftBalance(BUYER_VAULT), '900'); assert.equal(await tracked(BUYER_VAULT), '800');
  const callbackReturn = await must(receiverAgent, RECEIVER_VAULT, 'execute_ft_call', { policy_id: RETURN_POLICY,
    payee: BUYER_VAULT, amount: '100', expected_token: TOKEN, expected_msg: RETURN_MSG,
    expected_policy_revision: 1, expected_route_revision: 1 }, 0n, 300n * TGAS);
  assert.equal(await ftBalance(BUYER_VAULT), '1000'); assert.equal(await tracked(BUYER_VAULT), '900');
  assert.equal(await spent(BUYER_VAULT, BUY_POLICY), '200');
  const overBudget = await call(buyerAgent, BUYER_VAULT, 'execute_ft_call', request(BUY_POLICY), 0n, 300n * TGAS);
  assertFailure(overBudget, /daily cap exceeded/, 'third FT call exceeds budget');
  assert.equal(await ftBalance(BUYER_VAULT), '1000'); assert.equal(await tracked(BUYER_VAULT), '900');
  checkpoint('sandbox receiver shows plain-FT return is untracked; transfer-call return credits the receiver hook');
  return { scope: 'ONLY isolated local nearcore, V11 bytecode and an example mock FT; receiver is another V11 vault, NOT PayPerCall or Circle',
    buyer_and_receiver_are_keyless_local_contracts: true, locked_exact_policy_rejected_ft_call: true,
    unlocked_route_repeated_within_daily_budget: true, third_call_rejected_by_daily_budget: true,
    plain_return_token_delta: '100', plain_return_vault_ledger_delta: '0',
    callback_return_token_delta: '100', callback_return_vault_ledger_delta: '100',
    final_token_balance: '1000', final_vault_tracked_balance: '900', conservative_spend: '200',
    local_hashes: { first_payment: first.transaction_outcome.id, plain_return: plain.transaction_outcome.id,
      second_payment: second.transaction_outcome.id, callback_return: callbackReturn.transaction_outcome.id },
    seller_contacted: false, independent_fulfillment_verified: false, production_testnet_chain_check_not_exercised: true };
}
