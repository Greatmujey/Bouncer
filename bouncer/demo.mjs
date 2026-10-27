// Bouncer demo: policy setup, allowlist, view check, and three on-chain rejections.
// Uses the key saved by deploy.mjs in ~/.near-credentials/testnet/<account>.json.
// Run from ANY directory in the repo:  node bouncer/demo.mjs
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import nearApi from 'near-api-js';

const { KeyPair, keyStores, InMemorySigner, Account, JsonRpcProvider } = nearApi;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const NETWORK = 'testnet';
const RPC = 'https://rpc.testnet.near.org';
const USDC = 'usdc.fakes.testnet';

const ID = fs.readFileSync(path.join(os.homedir(), '.bouncer_id'), 'utf8').trim();
console.log(`Contract: ${ID}\n`);

const keyPath = path.join(os.homedir(), '.near-credentials', NETWORK, `${ID}.json`);
const cred = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
const keystore = new keyStores.InMemoryKeyStore();
await keystore.setKey(NETWORK, ID, KeyPair.fromString(cred.private_key));

const provider = new JsonRpcProvider({ url: RPC });
const signer = new InMemorySigner(keystore);
const me = new Account(ID, provider, signer);

function txUrl(txHash) {
  return `https://testnet.nearblocks.io/txns/${txHash}?network=testnet`;
}

async function call(label, method, args, deposit = '0', expectReject = false) {
  console.log(`\n=== ${label} ===`);
  console.log(`    -> ${method}(${JSON.stringify(args).slice(0, 90)}), deposit=${deposit} yocto`);
  try {
    const res = await me.functionCall({
      contractId: ID, methodName: method, args,
      attachedDeposit: BigInt(deposit), gas: BigInt('150000000000000'),
    });
    const hash = res.transaction_outcome.id;
    console.log(`    ✅ status: ok`);
    console.log(`    tx: ${txUrl(hash)}`);
    const last = res.receipts_outcome?.[res.receipts_outcome.length - 1]?.outcome;
    if (last?.logs?.length) console.log(`    logs: ${last.logs.join(' | ')}`);
    return res;
  } catch (e) {
    const msg = (e.message || String(e)).split('\n')[0];
    const short = msg.length > 500 ? msg.slice(0, 500) + '...' : msg;
    const mark = expectReject ? '❌ REJECTED (expected — policy/guard worked)' : '❌ unexpected error';
    console.log(`    ${mark}:`);
    console.log(`       ${short}`);
    return null;
  }
}

async function view(label, method, args) {
  console.log(`\n=== ${label} ===`);
  const res = await me.viewFunction({ contractId: ID, methodName: method, args });
  console.log('    result ->', JSON.stringify(res));
  return res;
}

// --- setup (owner-only, require 1 yocto) ---
await call('SET POLICY: 5 USDC per-tx cap (owner-only, 1 yocto attached)',
  'set_policy', { policy_id: 'usdc-agent', token: USDC, per_tx_cap: '5000000' }, '1');

await call('ALLOWLIST VENDOR: vendor.testnet (owner-only, 1 yocto attached)',
  'allow_payee', { policy_id: 'usdc-agent', payee: 'vendor.testnet' }, '1');

// --- read-only view ---
await view('VIEW check(): 3 USDC to vendor — within cap & allowlisted',
  'check', { policy_id: 'usdc-agent', payee: 'vendor.testnet', amount: '3000000' });

// --- three on-chain rejections ---
await call('BLOCK #1 — over cap: 10 USDC > 5 USDC per-tx cap',
  'execute', { policy_id: 'usdc-agent', payee: 'vendor.testnet', amount: '10000000', memo: 'too much' }, '1', true);

await call('BLOCK #2 — unknown payee: attacker.testnet not in allowlist',
  'execute', { policy_id: 'usdc-agent', payee: 'attacker.testnet', amount: '1000000', memo: 'x' }, '1', true);

await call('ESCALATION PROOF — set_policy with 0 deposit (must be rejected: 1-yocto guard)',
  'set_policy', { policy_id: 'usdc-agent', token: USDC, per_tx_cap: '999000000' }, '0', true);

console.log(`\n=== Explorer: https://testnet.nearblocks.io/address/${ID}?tab=receipts ===`);
console.log(`\nDone. Record over the terminal: show the two ✅ setup lines, then the ✅ view line, then the three ❌ rejection lines with their panic messages.`);
