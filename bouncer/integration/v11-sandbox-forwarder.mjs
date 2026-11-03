/**
 * TEST ONLY. Prepares and exercises the experimental forwarder on a named,
 * loopback-only nearcore sandbox already created by v11-nearcore-sandbox.
 * The token is nearcore's example FT at an artificial genesis address; the
 * escrow is a deliberately tiny fixture, NOT the real PayPerCall contract.
 * No seller, Circle, live testnet, signed production transaction or delivery.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { buildExperimentalForwarder } from '../experiments/paypercall-forwarder/build.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { PAYPERCALL_TESTNET_ESCROW as ESCROW } from '../agent/paypercall-inspect.mjs';
import { V11_SHA256, assertSandboxStatus, requireFinalSuccess } from './v11-sandbox-support.mjs';
import { loopbackSandboxUrl, withSandboxOnlyFetch } from './v11-sandbox-setup-rpc.mjs';
import { buildSandboxEscrowStandIn, FIXTURE_FORWARDER as ADAPTER } from './fixtures/paypercall-stand-in.mjs';

const BUYER = 'forward-buyer.testnet', VAULT = 'vault.forward-buyer.testnet';
const NEAR = 10n ** 24n, TGAS = 10n ** 12n, { transactions: tx } = nearApi;
const key = () => nearApi.KeyPair.fromRandom('ed25519');
const pub = pair => String(pair.getPublicKey());
const account = (id, provider, pair) => new nearApi.Account(id, provider, new nearApi.KeyPairSigner(pair));
const fn = (method, args = {}, deposit = 0n, gas = 100n * TGAS) => tx.functionCall(method, args, gas, deposit);
const codeHash = bytes => nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(bytes).digest());

/** Fail before signing unless the supplied root and mock-token owner are tied
 * to the exact same loopback endpoint and the V11 bytes match the known pin. */
export async function exerciseSandboxForwarder({ rpcUrl, root, tokenOwner, wasm, storageMin, checkpoint = () => {} }) {
  const endpoint = loopbackSandboxUrl(rpcUrl);
  let rootEndpoint, tokenOwnerEndpoint;
  try {
    rootEndpoint = loopbackSandboxUrl(root?.provider?.connection?.url);
    tokenOwnerEndpoint = loopbackSandboxUrl(tokenOwner?.provider?.connection?.url);
  } catch { throw new Error('isolated sandbox root, token owner and pinned V11 are required'); }
  if (root?.accountId !== 'testnet' || tokenOwner?.accountId !== 'owner.testnet' ||
      rootEndpoint !== endpoint || tokenOwnerEndpoint !== endpoint || !Buffer.isBuffer(wasm) || wasm.length !== 536325 ||
      crypto.createHash('sha256').update(wasm).digest('hex') !== V11_SHA256 || typeof storageMin !== 'string' ||
      !/^[1-9][0-9]{0,24}$/.test(storageMin) || BigInt(storageMin) > 10n ** 23n || typeof checkpoint !== 'function') {
    throw new Error('isolated sandbox root, token owner and pinned V11 are required');
  }
  return withSandboxOnlyFetch(endpoint, () => exercise({ endpoint, root, tokenOwner, wasm, storageMin, checkpoint }));
}

async function exercise({ endpoint, root, tokenOwner, wasm, storageMin, checkpoint }) {
  const provider = new nearApi.providers.JsonRpcProvider({ url: endpoint });
  assertSandboxStatus(await provider.status());
  const buyerKey = key(), vaultAgentKey = key(), forwarderAgentKey = key();
  const buyer = account(BUYER, provider, buyerKey), vaultAgent = account(BUYER, provider, vaultAgentKey);
  const forwarderAgent = account(BUYER, provider, forwarderAgentKey);
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
  const failure = (result, pattern, label) => {
    assert.equal(result?.final_execution_status, 'FINAL', `${label}: result must be FINAL`);
    assert.ok(result?.status?.Failure, `${label}: expected failure`);
    assert.match(JSON.stringify(result.status.Failure), pattern, `${label}: unexpected failure`);
  };
  const admissionFailure = async (promise, pattern, label) => {
    let error;
    try { await promise; } catch (caught) { error = caught; }
    assert.ok(error, `${label}: expected admission rejection`);
    assert.match(`${error.message ?? ''} ${JSON.stringify(error)}`, pattern);
  };
  const view = (id, method, args = {}) => provider.callFunction(id, method, args, { finality: 'final' });
  const ftBalance = id => view(TOKEN, 'ft_balance_of', { account_id: id });
  const tracked = () => view(VAULT, 'vault_balance', { token: TOKEN });
  const spent = () => view(VAULT, 'daily_spent', { policy_id: 'forward' });

  await batch(root, BUYER, [tx.createAccount(), tx.transfer(100n * NEAR),
    tx.addKey(buyerKey.getPublicKey(), tx.fullAccessKey())], 'create isolated forwarder buyer');
  await batch(buyer, VAULT, [tx.createAccount(), tx.transfer(8n * NEAR), tx.deployContract(wasm),
    fn('new', { owner: BUYER })], 'create isolated keyless V11 vault');
  const block = await provider.viewBlock({ finality: 'final' });
  const nowMs = Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n);
  const artifact = await buildExperimentalForwarder({ owner: BUYER, vault: VAULT, adapter: ADAPTER,
    vault_agent_public_key: pub(vaultAgentKey), forwarder_agent_public_key: pub(forwarderAgentKey),
    policy_id: 'forward', intent_id: 'forward-1', amount: '100', service_id: 7, request: 'wrap.testnet',
    expires_at_ms: nowMs + 60 * 60 * 1000, native_return_cap: NEAR.toString(), native_reserve: NEAR.toString() }, { nowMs });
  await batch(buyer, ADAPTER, [tx.createAccount(), tx.transfer(3n * NEAR), tx.deployContract(artifact.wasm)],
    'create isolated keyless forwarder');
  await batch(root, ESCROW, [tx.createAccount(), tx.transfer(3n * NEAR), tx.deployContract(await buildSandboxEscrowStandIn())],
    'create isolated keyless escrow stand-in');
  for (const id of [VAULT, ADAPTER, ESCROW]) {
    assert.deepEqual((await provider.viewAccessKeyList(id, { finality: 'final' })).keys, []);
    await must(tokenOwner, TOKEN, 'storage_deposit', { account_id: id, registration_only: true }, BigInt(storageMin), 50n * TGAS);
  }
  assert.equal((await provider.viewAccount(ADAPTER, { finality: 'final' })).code_hash, codeHash(artifact.wasm));
  assert.deepEqual(await view(ADAPTER, 'configuration'), artifact.review);
  assert.equal(await view(ADAPTER, 'opened'), false);

  await batch(buyer, BUYER, [tx.addKey(vaultAgentKey.getPublicKey(), tx.functionCallAccessKey(VAULT, ['execute_exact_ft'], NEAR)),
    tx.addKey(forwarderAgentKey.getPublicKey(), tx.functionCallAccessKey(ADAPTER, ['open', 'return_tokens', 'claim'], NEAR))],
    'install distinct restricted receiver keys');
  assert.notEqual(pub(vaultAgentKey), pub(forwarderAgentKey));
  const vaultPermission = (await provider.viewAccessKey(BUYER, pub(vaultAgentKey), { finality: 'final' })).permission.FunctionCall;
  const forwarderPermission = (await provider.viewAccessKey(BUYER, pub(forwarderAgentKey), { finality: 'final' })).permission.FunctionCall;
  assert.equal(vaultPermission.receiver_id, VAULT); assert.deepEqual(vaultPermission.method_names, ['execute_exact_ft']);
  assert.equal(forwarderPermission.receiver_id, ADAPTER);
  assert.deepEqual(forwarderPermission.method_names, ['open', 'return_tokens', 'claim']);
  await admissionFailure(call(forwarderAgent, VAULT, 'execute_exact_ft', { intent_id: 'forward-1' }),
    /ReceiverMismatch|receiver.*(?:mismatch|access.key|permission)/i, 'forwarder key cannot act on vault');
  await admissionFailure(call(forwarderAgent, ADAPTER, 'open', {}, 1n),
    /DepositWithFunctionCall|attached deposit|deposit.*(?:function|access.key)|requires.*full.access/i, 'restricted key cannot attach deposit');

  const policy = { policy_id: 'forward', token: TOKEN, per_tx_cap: '100', daily_cap: '100' };
  failure(await call(buyer, VAULT, 'set_policy', policy, 0n), /exactly 1 yoctoNEAR/, 'vault owner guard');
  await must(buyer, VAULT, 'set_policy', policy, 1n);
  await must(buyer, VAULT, 'allow_payee', { policy_id: 'forward', payee: ADAPTER }, 1n);
  await must(buyer, VAULT, 'grant_agent_key', { policy_id: 'forward', public_key: pub(vaultAgentKey) }, 1n);
  await must(buyer, VAULT, 'lock_ft_policy_to_intents', { policy_id: 'forward' }, 1n);
  await must(tokenOwner, TOKEN, 'ft_transfer_call', { receiver_id: VAULT, amount: '100', msg: '' }, 1n, 300n * TGAS);
  await must(buyer, VAULT, 'set_exact_ft_intent', { intent_id: artifact.review.intent_id, policy_id: 'forward',
    expected_token: TOKEN, payee: ADAPTER, amount: '100', memo: artifact.review.intent_memo,
    review_hash: artifact.review.review_sha256, expires_at_ms: String(artifact.review.expires_at_ms),
    agent_public_key: pub(vaultAgentKey) }, 1n);
  assert.equal(await ftBalance(VAULT), '100'); assert.equal(await tracked(), '100');
  failure(await call(root, ADAPTER, 'open', {}), /FORWARDER BLOCKED/, 'non-owner forwarder');
  assert.equal(await view(ADAPTER, 'opened'), false);

  const paidForwarder = await must(vaultAgent, VAULT, 'execute_exact_ft', { intent_id: 'forward-1' }, 0n, 250n * TGAS);
  assert.equal(await ftBalance(VAULT), '0'); assert.equal(await tracked(), '0');
  assert.equal(await ftBalance(ADAPTER), '100'); assert.equal(await spent(), '100');
  const opened = await must(forwarderAgent, ADAPTER, 'open', {}, 0n, 300n * TGAS);
  assert.equal(await view(ADAPTER, 'opened'), true);
  assert.equal(await ftBalance(ADAPTER), '40'); assert.equal(await ftBalance(ESCROW), '60');
  failure(await call(forwarderAgent, ADAPTER, 'open', {}, 0n, 300n * TGAS), /FORWARDER BLOCKED/, 'open replay');

  const partialReturn = await must(forwarderAgent, ADAPTER, 'return_tokens', { amount: '40' }, 0n, 300n * TGAS);
  assert.equal(await ftBalance(VAULT), '40'); assert.equal(await tracked(), '40');
  const laterRefund = await must(root, ESCROW, 'fixture_refund_later', {}, 0n, 100n * TGAS);
  assert.equal(await ftBalance(ESCROW), '0'); assert.equal(await ftBalance(ADAPTER), '60');
  assert.equal(await tracked(), '40');
  const laterReturn = await must(forwarderAgent, ADAPTER, 'return_tokens', { amount: '60' }, 0n, 300n * TGAS);
  assert.equal(await ftBalance(ADAPTER), '0'); assert.equal(await ftBalance(VAULT), '100');
  assert.equal(await tracked(), '100'); assert.equal(await spent(), '100');
  failure(await call(vaultAgent, VAULT, 'execute_exact_ft', { intent_id: 'forward-1' }, 0n, 250n * TGAS),
    /consumed, cancelled, expired or stale/, 'exact-intent replay');
  failure(await call(buyer, ADAPTER, 'return_native', { amount: '1' }, 0n), /FORWARDER BLOCKED/, 'native owner guard');
  await must(buyer, ADAPTER, 'return_native', { amount: '1' }, 1n);
  checkpoint('experimental forwarder and mock-FT partial/late return checked on isolated nearcore');
  return { scope: 'ONLY isolated nearcore, V11, an example mock FT and a hard-coded stand-in; NOT Circle or PayPerCall',
    forwarder_sha256: artifact.wasm_sha256, distinct_receiver_scoped_keys: true, keyless_vault_and_forwarder: true,
    exact_intent_and_open_replays_blocked: true, zero_yocto_owner_policy_and_native_return_blocked: true,
    function_call_key_cannot_attach_one_yocto: true, partial_token_return: '40', later_plain_refund_to_forwarder: '60',
    final_vault_actual: '100', final_vault_tracked: '100', conservative_spend: '100',
    local_hashes: { paid_forwarder: paidForwarder.transaction_outcome.id, opened: opened.transaction_outcome.id,
      partial_return: partialReturn.transaction_outcome.id, standin_refund: laterRefund.transaction_outcome.id,
      later_return: laterReturn.transaction_outcome.id }, seller_contacted: false, independent_fulfillment_verified: false,
    real_paypercall_storage_quote_claim_and_delivery_not_tested: true };
}
