/** TEST ONLY: use the fixed V12 signer and original-receipt verifier on an
 * isolated loopback chain. Circle fields below are synthetic signer fixtures;
 * there is no testnet deployment, Circle acquisition, or provider payment. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nearApi from 'near-api-js';
import { SandboxSetupRpc, withSandboxOnlyFetch } from './v11-sandbox-setup-rpc.mjs';
import { requireFinalSuccess } from './v11-sandbox-support.mjs';
import { syncWrite } from '../agent/circle-owner-offline-journal.mjs';
import { signVaultBootstrap, verifySignedVaultBootstrap, V12_NEAR_CODE_HASH } from '../agent/keyless-vault-v12.mjs';
import { verifyVaultBootstrapReceipt } from '../agent/keyless-vault-v12-runner.mjs';
import { newTestnetVaultId, V12_EXPECTED_BYTES, V12_EXPECTED_SHA256, VAULT_NATIVE_FUNDING_YOCTO,
  CIRCLE_TESTNET_CODE_HASH } from '../agent/keyless-vault-v12-readiness.mjs';
import { readPinnedJsonView } from '../agent/read-only-near-rpc.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE } from '../scripts/circle-testnet-setup.mjs';
import { inspectVaultCircleFunding } from '../agent/keyless-vault-v12-circle-readiness.mjs';
import { signVaultCircle } from '../agent/keyless-vault-v12-circle.mjs';
import { broadcastVaultCircleOnce, reconcileVaultCircle } from '../agent/keyless-vault-v12-circle-runner.mjs';

const OWNER = 'bouncer-owner-bbbbbbbbbbbbbbbbbbbbbbbb.testnet', NEAR = 10n ** 24n;
const checks = Object.fromEntries(['new_direct_child_absent', 'owner_and_circle_ready', 'circle_code_pinned',
  'vault_not_pre_registered_for_circle', 'testnet_protocol_floor', 'selected_v12_wasm_features',
  'owner_native_estimate', 'vault_native_estimate'].map(k => [k, 'PASS']));
const features = { global_contract_host_fns: true, reftypes_bulk_memory: true, gas_key_host_fns: true, universal_accounts: true };

// The pinned nearcore example FT is NOT Circle. Alias only the metadata and
// code-hash views in this loopback-only test adapter so V12's production pin
// checks can run against the real local token/receipt graph. This is not a
// general sandbox, deployed Circle code check, or testnet evidence.
class SandboxMockCircleRpc extends SandboxSetupRpc {
  async query(args) {
    const actual = await super.query(args);
    return args?.request_type === 'view_account' && args.account_id === CIRCLE ?
      { ...actual, code_hash: CIRCLE_TESTNET_CODE_HASH } : actual;
  }
  async callFunctionRaw(contract, method, args, reference) {
    const actual = await super.callFunctionRaw(contract, method, args, reference);
    if (contract !== CIRCLE || method !== 'ft_metadata') return actual;
    const metadata = JSON.parse(Buffer.from(actual.result).toString('utf8'));
    return { ...actual, result: [...Buffer.from(JSON.stringify({ ...metadata, symbol: 'USDC', decimals: 6 }))] };
  }
}

export async function exerciseSandboxV12Bootstrap({ rpcUrl, root, wasm, directory }) {
  return withSandboxOnlyFetch(rpcUrl, async () => {
    const pair = nearApi.KeyPair.fromRandom('ed25519'), publicKey = String(pair.getPublicKey()), rpc = new SandboxMockCircleRpc(rpcUrl);
    const plan = { version: 1, purpose: 'new-bouncer-testnet-owner', network: 'testnet', account_id: OWNER, public_key: publicKey };
    const vault = newTestnetVaultId(plan), t = nearApi.transactions;
    const created = await root.signAndSendTransaction({ receiverId: OWNER,
      actions: [t.createAccount(), t.transfer(20n * NEAR), t.addKey(pair.getPublicKey(), t.fullAccessKey())],
      waitUntil: 'FINAL', throwOnFailure: false });
    requireFinalSuccess(created, 'create synthetic V12 bootstrap owner');
    const block = await rpc.viewBlock({ finality: 'final' }), hash = block.header.hash;
    const [access, account, presence] = await Promise.all([
      rpc.query({ request_type: 'view_access_key', account_id: OWNER, public_key: publicKey, block_id: hash }),
      rpc.query({ request_type: 'view_account', account_id: OWNER, block_id: hash }),
      rpc.viewTestnetAccountPresenceAt(vault, hash),
    ]);
    assert.equal(presence.exists, false); assert.equal(presence.block_hash, hash); assert.equal(access.permission, 'FullAccess');
    // Only these Circle/protocol fields are fixtures for offline signing. The
    // deployment action itself contains no token registration or transfer.
    const snapshot = { version: 1, status: 'READ_ONLY_BOOTSTRAP_INDICATED', network: 'testnet', owner: OWNER, public_key: publicKey,
      vault, circle_token: CIRCLE, circle_code_hash: CIRCLE_TESTNET_CODE_HASH, block_hash: hash,
      block_timestamp_nanosec: block.header.timestamp_nanosec, owner_key_nonce: String(access.nonce), owner_native_yocto: account.amount,
      owner_test_usdc_atoms: '6898', planned_vault_native_yocto: VAULT_NATIVE_FUNDING_YOCTO, v12_sha256: V12_EXPECTED_SHA256,
      v12_bytes: V12_EXPECTED_BYTES, observed_protocol_version: 88, selected_v12_wasm_features: features, checks, blockers: [],
      signed: false, sent: false, vault_deployed: false };
    const envelope = await signVaultBootstrap({ plan, snapshot, wasmBytes: wasm, keyPair: pair });
    const signed = verifySignedVaultBootstrap(envelope, plan), journal = path.join(directory, 'sandbox-v12-bootstrap-original.json');
    syncWrite(journal, JSON.stringify({ version: 1, tx_hash: envelope.tx_hash, signed_tx_base64: envelope.signed_tx_base64 }) + '\n', 'wx', 0o600);
    assert.equal(JSON.parse(fs.readFileSync(journal)).tx_hash, envelope.tx_hash);
    rpc.loseNextAcknowledgementForTest();
    await assert.rejects(rpc.sendTransactionOnce(signed, 'FINAL', { beforeSubmit: () => { verifySignedVaultBootstrap(envelope, plan); } }),
      /simulated lost acknowledgement/);
    assert.equal(rpc.transportCalls, 1, 'lost response must not result in a second send');
    const receipt = verifyVaultBootstrapReceipt(await rpc.txStatusReceipts(envelope.tx_hash, OWNER, 'FINAL'), envelope, plan);
    const after = await rpc.viewBlock({ finality: 'final' }), blockId = after.header.hash;
    const [accountAfter, vaultKeys, actualOwner, version] = await Promise.all([
      rpc.query({ request_type: 'view_account', account_id: vault, block_id: blockId }),
      rpc.query({ request_type: 'view_access_key_list', account_id: vault, block_id: blockId }),
      readPinnedJsonView(rpc, blockId, vault, 'get_owner', {}), readPinnedJsonView(rpc, blockId, vault, 'contract_version', {}),
    ]);
    assert.equal(accountAfter.code_hash, V12_NEAR_CODE_HASH); assert.deepEqual(vaultKeys.keys, []);
    assert.equal(actualOwner, OWNER); assert.equal(version, 'bouncer-agent-v12-exact-ft-testnet');
    assert.equal(rpc.transportCalls, 1);

    // Local example FT only. The owner receives mock atoms before registration;
    // the production adapter's Circle identity fields above are synthetic.
    const bounds = await rpc.callFunctionRaw(CIRCLE, 'storage_balance_bounds', {}, { finality: 'final' });
    const min = JSON.parse(Buffer.from(bounds.result).toString('utf8')).min;
    const mockFunding = await root.signAndSendTransaction({ receiverId: CIRCLE, actions: [
      t.functionCall('storage_deposit', { account_id: OWNER, registration_only: true }, 50n * 10n ** 12n, BigInt(min)),
      t.functionCall('ft_transfer', { receiver_id: OWNER, amount: '6898' }, 50n * 10n ** 12n, 1n),
    ], waitUntil: 'FINAL', throwOnFailure: false });
    requireFinalSuccess(mockFunding, 'fund synthetic V12 owner with mock FT');
    const initial = await inspectVaultCircleFunding({ plan, provider: rpc });
    assert.equal(initial.register_eligible, true); assert.equal(initial.owner_circle_atoms, '6898');
    async function fence(kind, original) {
      const file = path.join(directory, `sandbox-v12-circle-${kind}-original.json`);
      syncWrite(file, JSON.stringify(original) + '\n', 'wx', 0o600);
      return record => record.tx_hash === original.tx_hash && record.kind === kind && fs.existsSync(file);
    }
    const registration = await signVaultCircle({ plan, snapshot: initial, kind: 'register', amountAtoms: '6898', keyPair: pair });
    const registered = await broadcastVaultCircleOnce({ plan, envelope: registration, provider: rpc,
      persistAttempt: await fence('register', registration) });
    assert.equal(registered.status, 'VAULT_CIRCLE_REGISTERED_AT_FINAL');
    const ready = await inspectVaultCircleFunding({ plan, provider: rpc });
    assert.equal(ready.fund_eligible, true); assert.equal(ready.vault_actual_circle_atoms, '0');
    const funding = await signVaultCircle({ plan, snapshot: ready, kind: 'fund', amountAtoms: '6898', keyPair: pair });
    rpc.loseNextAcknowledgementForTest();
    await assert.rejects(broadcastVaultCircleOnce({ plan, envelope: funding, provider: rpc,
      persistAttempt: await fence('fund', funding) }), /never resend/);
    assert.equal(rpc.transportCalls, 3, 'one creation and one send for each token stage');
    const funded = await reconcileVaultCircle({ plan, envelope: funding, provider: rpc });
    assert.equal(funded.status, 'VAULT_FUNDED_CIRCLE_TEST_USDC_AT_FINAL');
    assert.equal(funded.state.vault_actual_circle_atoms, '6898'); assert.equal(funded.state.vault_tracked_circle_atoms, '6898');
    assert.equal(funded.state.owner_circle_atoms, '0'); assert.equal(rpc.transportCalls, 3);
    return { scope: 'isolated nearcore with synthetic FT code/metadata aliases only; not testnet, Circle or seller delivery',
      local_tx_hash: envelope.tx_hash, root_receipt_id: receipt.root_receipt_id, original_hash_journaled_before_send: true,
      lost_ack_recovered_without_resend: true, transport_calls: rpc.transportCalls, vault_key_count: vaultKeys.keys.length,
      fixed_six_test_near_and_pinned_code: true, owner_and_version_checked: true, seller_contacted: false,
      local_mock_registration_and_funding: { mock_ft_code_and_metadata_aliased: true, registration_hash: registration.tx_hash,
        funding_hash: funding.tx_hash, amount_atoms: '6898', actual_and_tracked_match: true, lost_ack_recovered_without_resend: true } };
  });
}
