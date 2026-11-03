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

const OWNER = 'bouncer-owner-bbbbbbbbbbbbbbbbbbbbbbbb.testnet', NEAR = 10n ** 24n;
const checks = Object.fromEntries(['new_direct_child_absent', 'owner_and_circle_ready', 'circle_code_pinned',
  'vault_not_pre_registered_for_circle', 'testnet_protocol_floor', 'selected_v12_wasm_features',
  'owner_native_estimate', 'vault_native_estimate'].map(k => [k, 'PASS']));
const features = { global_contract_host_fns: true, reftypes_bulk_memory: true, gas_key_host_fns: true, universal_accounts: true };

export async function exerciseSandboxV12Bootstrap({ rpcUrl, root, wasm, directory }) {
  return withSandboxOnlyFetch(rpcUrl, async () => {
    const pair = nearApi.KeyPair.fromRandom('ed25519'), publicKey = String(pair.getPublicKey()), rpc = new SandboxSetupRpc(rpcUrl);
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
    return { scope: 'synthetic offline snapshot and isolated nearcore only; not testnet, Circle or seller delivery',
      local_tx_hash: envelope.tx_hash, root_receipt_id: receipt.root_receipt_id, original_hash_journaled_before_send: true,
      lost_ack_recovered_without_resend: true, transport_calls: rpc.transportCalls, vault_key_count: vaultKeys.keys.length,
      fixed_six_test_near_and_pinned_code: true, owner_and_version_checked: true, seller_contacted: false };
  });
}
