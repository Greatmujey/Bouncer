/** TEST ONLY: run the fixed V11 keyless creation signature and original-hash
 * receipt verifier on disposable local nearcore. No testnet or seller is
 * contacted. The owner's Circle-balance fields below are synthetic fixtures,
 * used solely to pass an offline signer; no mock token transfer is claimed. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nearApi from 'near-api-js';
import { SandboxSetupRpc, withSandboxOnlyFetch } from './v11-sandbox-setup-rpc.mjs';
import { requireFinalSuccess } from './v11-sandbox-support.mjs';
import { syncWrite } from '../agent/circle-owner-offline-journal.mjs';
import { signVaultBootstrap, verifySignedVaultBootstrap, V11_NEAR_CODE_HASH } from '../agent/keyless-vault-bootstrap.mjs';
import { verifyVaultBootstrapReceipt } from '../agent/keyless-vault-bootstrap-runner.mjs';
import { newTestnetVaultId, V11_EXPECTED_BYTES, V11_EXPECTED_SHA256, VAULT_NATIVE_FUNDING_YOCTO } from '../agent/keyless-vault-bootstrap-readiness.mjs';
import { readPinnedJsonView } from '../agent/read-only-near-rpc.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE } from '../scripts/circle-testnet-setup.mjs';
import { exerciseSandboxResourceAgent } from './v11-sandbox-resource-agent.mjs';
import { inspectVaultCircleFunding } from '../agent/keyless-vault-circle-readiness.mjs';
import { signVaultCircle } from '../agent/keyless-vault-circle.mjs';
import { broadcastVaultCircleOnce, reconcileVaultCircle } from '../agent/keyless-vault-circle-runner.mjs';

const { transactions: tx } = nearApi;
const OWNER = 'bouncer-owner-aaaaaaaaaaaaaaaaaaaaaaaa.testnet', NEAR = 10n ** 24n;
const checks = Object.fromEntries(['new_direct_child_absent', 'owner_and_circle_ready', 'vault_not_pre_registered_for_circle',
  'testnet_protocol_floor', 'selected_v11_wasm_features', 'owner_native_estimate', 'vault_native_estimate'].map(k => [k, 'PASS']));
const features = { global_contract_host_fns: true, reftypes_bulk_memory: true, gas_key_host_fns: true, universal_accounts: true };

// The genesis token is a pinned example FT, not Circle. Override ONLY its
// metadata view so the production Circle-specific preflight can be exercised
// on this isolated chain; all account state, transactions and receipts remain
// real local nearcore results. Never import this adapter in production.
class SandboxMockCircleRpc extends SandboxSetupRpc {
  async callFunctionRaw(contract, method, args, reference) {
    const actual = await super.callFunctionRaw(contract, method, args, reference);
    if (contract !== CIRCLE || method !== 'ft_metadata') return actual;
    const metadata = JSON.parse(Buffer.from(actual.result).toString('utf8'));
    return { ...actual, result: [...Buffer.from(JSON.stringify({ ...metadata, symbol: 'USDC', decimals: 6 }))] };
  }
}

export async function exerciseSandboxBootstrapRunner({ rpcUrl, root, sourceFtOwner, wasm, directory, checkpoint }) {
  return withSandboxOnlyFetch(rpcUrl, async () => {
    const ownerKey = nearApi.KeyPair.fromRandom('ed25519'), publicKey = String(ownerKey.getPublicKey()), rpc = new SandboxMockCircleRpc(rpcUrl);
    const plan = { version: 1, purpose: 'new-bouncer-testnet-owner', network: 'testnet', account_id: OWNER, public_key: publicKey };
    const vault = newTestnetVaultId(plan);
    const created = await root.signAndSendTransaction({ receiverId: OWNER, actions: [tx.createAccount(), tx.transfer(100n * NEAR),
      tx.addKey(ownerKey.getPublicKey(), tx.fullAccessKey())], waitUntil: 'FINAL', throwOnFailure: false });
    requireFinalSuccess(created, 'create synthetic bootstrap owner');
    const block = await rpc.viewBlock({ finality: 'final' }), hash = block.header.hash;
    const [access, account, presence] = await Promise.all([
      rpc.query({ request_type: 'view_access_key', account_id: OWNER, public_key: publicKey, block_id: hash }),
      rpc.query({ request_type: 'view_account', account_id: OWNER, block_id: hash }),
      rpc.viewTestnetAccountPresenceAt(vault, hash),
    ]);
    assert.equal(presence.exists, false); assert.equal(presence.block_hash, hash); assert.equal(access.permission, 'FullAccess');
    // These Circle fields/checks are fixed test fixtures; the signed deployment
    // action does not transfer or register tokens. Do not call this a funded
    // Circle account, a real preflight, or a testnet deployment.
    const snapshot = { version: 1, status: 'READ_ONLY_BOOTSTRAP_INDICATED', network: 'testnet', owner: OWNER, public_key: publicKey,
      vault, circle_token: CIRCLE, circle_code_hash: V11_NEAR_CODE_HASH, block_hash: hash,
      block_timestamp_nanosec: block.header.timestamp_nanosec, owner_key_nonce: String(access.nonce), owner_native_yocto: account.amount,
      owner_test_usdc_atoms: '6917', planned_vault_native_yocto: VAULT_NATIVE_FUNDING_YOCTO, v11_sha256: V11_EXPECTED_SHA256,
      v11_bytes: V11_EXPECTED_BYTES, observed_protocol_version: 88, selected_v11_wasm_features: features, checks, blockers: [],
      signed: false, sent: false, vault_deployed: false };
    const envelope = await signVaultBootstrap({ plan, snapshot, wasmBytes: wasm, keyPair: ownerKey });
    const signed = verifySignedVaultBootstrap(envelope, plan), journal = path.join(directory, 'sandbox-vault-original.json');
    syncWrite(journal, JSON.stringify({ version: 1, tx_hash: envelope.tx_hash, signed_tx_base64: envelope.signed_tx_base64 }) + '\n', 'wx', 0o600);
    const original = JSON.parse(fs.readFileSync(journal));
    assert.equal(original.tx_hash, envelope.tx_hash); assert.equal(original.signed_tx_base64, envelope.signed_tx_base64);
    rpc.loseNextAcknowledgementForTest();
    await assert.rejects(rpc.sendTransactionOnce(signed, 'FINAL', { beforeSubmit: () => { verifySignedVaultBootstrap(envelope, plan); } }),
      /simulated lost acknowledgement/);
    assert.equal(rpc.transportCalls, 1, 'lost response must not result in a second send');
    const outcome = await rpc.txStatusReceipts(envelope.tx_hash, OWNER, 'FINAL');
    const evidence = verifyVaultBootstrapReceipt(outcome, envelope, plan);
    const after = await rpc.viewBlock({ finality: 'final' }), afterHash = after.header.hash;
    const [accountAfter, vaultKeys, actualOwner, version] = await Promise.all([
      rpc.query({ request_type: 'view_account', account_id: vault, block_id: afterHash }),
      rpc.query({ request_type: 'view_access_key_list', account_id: vault, block_id: afterHash }),
      readPinnedJsonView(rpc, afterHash, vault, 'get_owner', {}),
      readPinnedJsonView(rpc, afterHash, vault, 'contract_version', {}),
    ]);
    assert.equal(accountAfter.code_hash, V11_NEAR_CODE_HASH); assert.deepEqual(vaultKeys.keys, []);
    assert.equal(actualOwner, OWNER); assert.equal(version, 'bouncer-agent-v11-exact-ft-testnet');
    assert.equal(rpc.transportCalls, 1);
    checkpoint('generic fixed 6-NEAR keyless deployment recovered its original receipt after a simulated lost acknowledgement');

    // Real mock-FT balance/registration on the disposable chain; Circle
    // metadata is synthetic. The source account belongs only to this test.
    const bounds = await rpc.callFunctionRaw(CIRCLE, 'storage_balance_bounds', {}, { finality: 'final' });
    const min = JSON.parse(Buffer.from(bounds.result).toString('utf8')).min;
    const fundOwner = await sourceFtOwner.signAndSendTransaction({ receiverId: CIRCLE, actions: [
      tx.functionCall('storage_deposit', { account_id: OWNER, registration_only: true }, 50n * 10n ** 12n, BigInt(min)),
      tx.functionCall('ft_transfer', { receiver_id: OWNER, amount: '6907' }, 50n * 10n ** 12n, 1n),
    ], waitUntil: 'FINAL', throwOnFailure: false });
    requireFinalSuccess(fundOwner, 'fund synthetic owner with mock FT');
    const initial = await inspectVaultCircleFunding({ plan, provider: rpc });
    assert.equal(initial.register_eligible, true); assert.equal(initial.owner_circle_atoms, '6907');
    async function fence(kind, signed) {
      const file = path.join(directory, `sandbox-circle-vault-${kind}-original.json`);
      syncWrite(file, JSON.stringify(signed) + '\n', 'wx', 0o600);
      return record => record.tx_hash === signed.tx_hash && record.kind === kind && fs.existsSync(file);
    }
    const registration = await signVaultCircle({ plan, snapshot: initial, kind: 'register', amountAtoms: '6907', keyPair: ownerKey });
    const registered = await broadcastVaultCircleOnce({ plan, envelope: registration, provider: rpc,
      persistAttempt: await fence('register', registration) });
    assert.equal(registered.status, 'VAULT_CIRCLE_REGISTERED_AT_FINAL');
    const ready = await inspectVaultCircleFunding({ plan, provider: rpc });
    assert.equal(ready.fund_eligible, true); assert.equal(ready.vault_actual_circle_atoms, '0');
    const funding = await signVaultCircle({ plan, snapshot: ready, kind: 'fund', amountAtoms: '6907', keyPair: ownerKey });
    rpc.loseNextAcknowledgementForTest();
    await assert.rejects(broadcastVaultCircleOnce({ plan, envelope: funding, provider: rpc,
      persistAttempt: await fence('fund', funding) }), /never resend/);
    assert.equal(rpc.transportCalls, 3);
    const funded = await reconcileVaultCircle({ plan, envelope: funding, provider: rpc });
    assert.equal(funded.status, 'VAULT_FUNDED_CIRCLE_TEST_USDC_AT_FINAL');
    assert.equal(funded.state.vault_actual_circle_atoms, '6907');
    assert.equal(funded.state.vault_tracked_circle_atoms, '6907');
    assert.equal(funded.state.owner_circle_atoms, '0'); assert.equal(rpc.transportCalls, 3);
    checkpoint('mock-FT vault registration and full deposit recovered the original funding receipt after a simulated lost acknowledgement');
    const resourceAgent = await exerciseSandboxResourceAgent({ rpc, ownerPlan: plan, ownerKey, directory, checkpoint,
      expectedCircleCodeHash: funded.state.circle_code_hash });
    return { scope: 'disposable local nearcore and mock FT only; Circle metadata was synthesized; not testnet or seller delivery',
      sandbox_transaction_hash: envelope.tx_hash, original_receipt_id: evidence.root_receipt_id,
      original_hash_journaled_before_send: true, lost_ack_recovered_without_resend: true, transport_calls: rpc.transportCalls,
      sandbox_resource_agent: resourceAgent,
      recovered_v11_code_hash: accountAfter.code_hash, vault_key_count: vaultKeys.keys.length,
      owner_and_version_checked: true, mock_ft_vault_registered: true, mock_ft_vault_actual_atoms: funded.state.vault_actual_circle_atoms,
      mock_ft_vault_tracked_atoms: funded.state.vault_tracked_circle_atoms, mock_ft_funding_original_hash: funding.tx_hash,
      mock_ft_funding_lost_ack_recovered_without_resend: true, testnet_deployment: false, circle_funding: false, seller_contacted: false };
  });
}
