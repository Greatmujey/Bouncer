// Redeploy: upgrade the code on an existing bouncer contract without re-initializing
// (state persists across code upgrades on NEAR). Then re-applies the demo policy/allowlist
// and runs the three-rejection demo so panic messages are visible.
//
// Run from ANY directory in the repo:  node bouncer/redeploy.mjs

// Silence near-api-js v6 deprecation warnings during demo recording.
const _origWarn = console.warn;
console.warn = (...a) => { const m = a.join(' '); if (!/deprecated|please switch|It will be removed/i.test(m)) _origWarn.apply(console, a); };
process.on('warning', () => {});

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import nearApi from 'near-api-js';

const { KeyPair, KeyPairSigner, Account, providers } = nearApi;
const { JsonRpcProvider } = providers;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const NETWORK = 'testnet';
const RPC = 'https://rpc.testnet.near.org';
const USDC = 'usdc.fakes.testnet';

const WASM_PATH = path.join(REPO_ROOT, 'bouncer.wasm');
const ID_FILE = path.join(os.homedir(), '.bouncer_id');
const KEY_DIR = path.join(os.homedir(), '.near-credentials', NETWORK);

if (!fs.existsSync(WASM_PATH)) { console.error('bouncer.wasm missing'); process.exit(1); }
if (!fs.existsSync(ID_FILE)) { console.error('~/.bouncer_id missing — run deploy.mjs first'); process.exit(1); }

const ID = fs.readFileSync(ID_FILE, 'utf8').trim();
const keyPath = path.join(KEY_DIR, `${ID}.json`);
if (!fs.existsSync(keyPath)) { console.error('key missing at', keyPath); process.exit(1); }
const cred = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
const kp = KeyPair.fromString(cred.private_key);
const WASM = fs.readFileSync(WASM_PATH);

const provider = new JsonRpcProvider({ url: RPC });
const signer = new KeyPairSigner(kp);
const me = new Account(ID, provider, signer);

function txUrl(h) { return `https://testnet.nearblocks.io/txns/${h}?network=testnet`; }

async function call(label, method, args, deposit, expectReject = false) {
  console.log(`\n=== ${label} ===`);
  console.log(`    -> ${method}, deposit=${deposit} yocto`);
  try {
    const res = await me.functionCall({
      contractId: ID, methodName: method, args,
      attachedDeposit: BigInt(deposit), gas: BigInt('150000000000000'),
    });
    console.log(`    ✅ ok     tx: ${txUrl(res.transaction_outcome.id)}`);
    const last = res.receipts_outcome?.[res.receipts_outcome.length - 1]?.outcome;
    if (last?.logs?.length) console.log(`    logs: ${last.logs.join(' | ')}`);
    return res;
  } catch (e) {
    const msg = (e.message || String(e));
    // Try to extract just the ExecutionError string for readability
    let short = msg;
    const m = msg.match(/ExecutionError":"([^"]+)"/);
    if (m) short = m[1];
    else short = msg.split('\n')[0].slice(0, 400);
    const mark = expectReject ? '❌ REJECTED (expected)' : '❌ error';
    console.log(`    ${mark}: ${short}`);
    return null;
  }
}

async function view(label, method, args) {
  console.log(`\n=== ${label} ===`);
  const res = await me.viewFunction({ contractId: ID, methodName: method, args });
  console.log('    ->', JSON.stringify(res));
}

console.log(`Redeploying bouncer.wasm (${WASM.length} bytes) to ${ID} (no re-init — state persists)\n`);

// 1. Code upgrade only — no new() call; state from earlier deploy is preserved
const dtx = await me.deployContract(WASM);
console.log(`✅ deploy tx: ${txUrl(dtx.transaction_outcome.id)}`);
console.log(`   (wasm upgraded; state intact; no new() call — contract already initialized)`);

// 2. Re-set policy + allowlist (overwrite, same effect as before upgrade)
await call('SET POLICY (5 USDC cap, 1 yocto)', 'set_policy',
  { policy_id: 'usdc-agent', token: USDC, per_tx_cap: '5000000' }, '1');
await call('ALLOWLIST VENDOR', 'allow_payee',
  { policy_id: 'usdc-agent', payee: 'vendor.testnet' }, '1');

// 3. View check
await view('view check(): 3 USDC to vendor (expect allowed by policy, blocked by balance)',
  'check', { policy_id: 'usdc-agent', payee: 'vendor.testnet', amount: '3000000' });

// 4. Three on-chain rejections — each should now print a clean message
await call('BLOCK #1: over cap (10 USDC > 5)',
  'execute', { policy_id: 'usdc-agent', payee: 'vendor.testnet', amount: '10000000', memo: 'x' }, '1', true);
await call('BLOCK #2: unknown payee (attacker.testnet)',
  'execute', { policy_id: 'usdc-agent', payee: 'attacker.testnet', amount: '1000000', memo: 'x' }, '1', true);
await call('ESCALATION: set_policy with 0 deposit (1-yocto guard)',
  'set_policy', { policy_id: 'usdc-agent', token: USDC, per_tx_cap: '999000000' }, '0', true);

console.log(`\n=== Explorer: https://testnet.nearblocks.io/address/${ID}?tab=receipts ===`);
