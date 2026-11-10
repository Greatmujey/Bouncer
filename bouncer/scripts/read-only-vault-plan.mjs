#!/usr/bin/env node
/** Read-only exact vault plan for great_mujey.testnet -> native.great_mujey.testnet.
 * Public testnet JSON-RPC view calls only. No wallet, no signature, no transaction, no deployment. */
const RPC = 'https://rpc.testnet.near.org';
const OWNER = 'great_mujey.testnet';
const VAULT = 'native.great_mujey.testnet';
const ONE = 10n ** 24n;
const MARGIN_BYTES = 50_000n;
const STORAGE_RESERVE_YOCTO = ONE / 10n;

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'vault-plan', method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`RPC ${method} error: ${JSON.stringify(body.error)}`);
  return body.result;
}

const block = await rpc('block', { finality: 'final' });
const { hash } = block;
const started = Date.now();

const [ownerAccount, ownerKeys, protocol, gasPrice, vaultAccount] = await Promise.all([
  rpc('query', { request_type: 'view_account', account_id: OWNER, block_id: hash }),
  rpc('query', { request_type: 'view_access_key_list', account_id: OWNER, block_id: hash }),
  rpc('EXPERIMENTAL_protocol_config', { block_id: hash }),
  rpc('gas_price', [hash]),
  rpc('query', { request_type: 'view_account', account_id: VAULT, block_id: hash }).catch(() => null),
]);

const finished = Date.now();
if (finished < started) throw new Error('clock moved backwards');

// Re-verify block still final at end (freshness bound)
const block2 = await rpc('block', { finality: 'final' });
if (block2.header.height < block.header.height) {
  throw new Error('chain advanced during read; re-run for fresh snapshot');
}

const storageCost = BigInt(protocol.runtime_config.storage_amount_per_byte);
const ownerBalance = BigInt(ownerAccount.amount);
const ownerStorageUsed = BigInt(ownerAccount.storage_usage) * storageCost;
const ownerAvailable = ownerBalance > ownerStorageUsed ? ownerBalance - ownerStorageUsed : 0n;

// V14 artifact bytes from pinned manifest
import { V14_TESTNET_ARTIFACT } from '../shared/v14-testnet-artifact.mjs';
const storageEstimate = (BigInt(V14_TESTNET_ARTIFACT.bytes) + MARGIN_BYTES) * storageCost + STORAGE_RESERVE_YOCTO;

// Create-account + deploy gas estimate (create account action + deploy contract action + function call overhead)
// create-account: ~10^14 gas base + storage; deploy: code size * gas per byte; use conservative upper bound
const CREATE_ACCOUNT_GAS = 10n ** 14n;
const DEPLOY_PER_BYTE_GAS = 1000n;
const DEPLOY_GAS = BigInt(V14_TESTNET_ARTIFACT.bytes) * DEPLOY_PER_BYTE_GAS;
const INIT_CALL_GAS = 10n ** 14n;
const totalCreateGas = CREATE_ACCOUNT_GAS + DEPLOY_GAS + INIT_CALL_GAS;
const gasUpfrontYocto = totalCreateGas * BigInt(gasPrice);
const ownerTotalUpfrontYocto = storageEstimate + gasUpfrontYocto;

const fullAccessKeys = ownerKeys.keys.filter(k => k.access_key.permission === 'FullAccess');

const vaultExists = vaultAccount && vaultAccount.block_hash === hash;
const vaultBalance = vaultExists ? BigInt(vaultAccount.amount) : 0n;
const vaultStorageUsed = vaultExists ? BigInt(vaultAccount.storage_usage) * storageCost : 0n;

console.log(JSON.stringify({
  network: 'testnet',
  block_hash: hash,
  block_height: block.header.height,
  observed_at_utc: new Date(finished).toISOString(),
  freshness: { block_still_final: block2.header.height >= block.header.height },
  owner: {
    account_id: OWNER,
    balance_yocto: ownerBalance.toString(),
    balance_near: (Number(ownerBalance) / 1e24).toFixed(6),
    storage_used_yocto: ownerStorageUsed.toString(),
    available_yocto: ownerAvailable.toString(),
    available_near: (Number(ownerAvailable) / 1e24).toFixed(6),
    full_access_keys: fullAccessKeys.length,
    total_keys: ownerKeys.keys.length,
  },
  storage: {
    amount_per_byte_yocto: storageCost.toString(),
    v14_artifact_bytes: V14_TESTNET_ARTIFACT.bytes,
    margin_bytes: Number(MARGIN_BYTES),
    storage_reserve_yocto: STORAGE_RESERVE_YOCTO.toString(),
    estimated_vault_storage_funding_yocto: storageEstimate.toString(),
    estimated_vault_storage_funding_near: (Number(storageEstimate) / 1e24).toFixed(6),
  },
  gas: {
    gas_price_yocto_per_gas: gasPrice.toString(),
    create_account_gas: CREATE_ACCOUNT_GAS.toString(),
    deploy_gas: DEPLOY_GAS.toString(),
    init_call_gas: INIT_CALL_GAS.toString(),
    total_create_gas: totalCreateGas.toString(),
    gas_upfront_estimate_yocto: gasUpfrontYocto.toString(),
    gas_upfront_estimate_near: (Number(gasUpfrontYocto) / 1e24).toFixed(6),
  },
  plan: {
    owner_total_upfront_estimate_yocto: ownerTotalUpfrontYocto.toString(),
    owner_total_upfront_estimate_near: (Number(ownerTotalUpfrontYocto) / 1e24).toFixed(6),
    available_covers_storage_and_gas: ownerAvailable >= ownerTotalUpfrontYocto,
    vault_exists_at_final_block: vaultExists,
    vault_balance_yocto: vaultBalance.toString(),
    vault_balance_near: vaultExists ? (Number(vaultBalance) / 1e24).toFixed(6) : 'n/a',
    vault_storage_used_yocto: vaultStorageUsed.toString(),
  },
  warnings: [
    'storage and gas are estimates from one FINAL snapshot',
    '6 test NEAR example in UI is NOT approved funding',
    'no wallet control proven, no transaction sent, no deployment authorized',
    'temporary FullAccess key risk: can move funds/change code until deleted',
  ],
}, null, 2));
