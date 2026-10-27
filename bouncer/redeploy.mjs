// Redeploy + demo. Uses read-only try_* views for the three rejections so we see
// clean human-readable messages (no panic-trap noise), plus two real mutating setup txs.
//
// Run from ANY directory:  node bouncer/redeploy.mjs

// Silence near-api-js v6 deprecation warnings for clean recording.
process.env.NODE_NO_WARNINGS = '1';
process.on('warning', () => {});
const _origWarn = console.warn;
console.warn = (...a) => { const m = a.join(' '); if (!/deprecated|please switch|It will be removed/i.test(m)) _origWarn.apply(console, a); };

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

async function mutate(label, method, args, deposit, expectReject = false) {
  console.log(`\n=== ${label} ===`);
  console.log(`    ✍  ${method}(...) deposit=${deposit} yocto`);
  try {
    const res = await me.functionCall({
      contractId: ID, methodName: method, args,
      attachedDeposit: BigInt(deposit), gas: BigInt('150000000000000'),
    });
    console.log(`    ✅ OK      tx: ${txUrl(res.transaction_outcome.id)}`);
    return res;
  } catch (e) {
    const msg = e.message || String(e);
    // Extract the GuestPanic / ExecutionError message out of near-api-js's blob
    let short = msg;
    const em = msg.match(/ExecutionError":"([^"]+)"/);
    if (em) short = em[1];
    else short = msg.split('\n')[0].slice(0, 250);
    const mark = expectReject ? '❌ REJECTED ON-CHAIN (expected)' : '❌ TX FAILED';
    console.log(`    ${mark}: ${short}`);
    return null;
  }
}

async function view(label, method, args) {
  console.log(`\n=== ${label} ===`);
  const res = await me.viewFunction({ contractId: ID, methodName: method, args });
  const ok = res[0];
  const reason = res[1];
  const mark = ok ? '✅' : '❌';
  console.log(`    ${mark}  ${ok ? 'ALLOWED' : 'BLOCKED'} — ${reason}`);
  return res;
}

console.log(`╔══════════════════════════════════════════════════════════════╗`);
console.log(`║   BOUNCER — on-chain AI-agent payments firewall (testnet)    ║`);
console.log(`╚══════════════════════════════════════════════════════════════╝`);
console.log(`\nContract: ${ID}`);
console.log(`Wasm:     ${WASM.length} bytes  (code upgrade; state preserved)`);

// 1) code upgrade only
const dtx = await me.deployContract(WASM);
console.log(`\n=== STEP 1: Upgrade wasm code ===`);
console.log(`    ✅ deploy  tx: ${txUrl(dtx.transaction_outcome.id)}`);

// 2) two REAL mutating txs (policy + allowlist) — require 1 yocto, signed by owner
await mutate('STEP 2a: SET POLICY (owner-signed, 1 yocto) — 5 USDC per-tx cap',
  'set_policy', { policy_id: 'usdc-agent', token: USDC, per_tx_cap: '5000000' }, '1');
await mutate('STEP 2b: ALLOWLIST vendor.testnet (owner-signed, 1 yocto)',
  'allow_payee', { policy_id: 'usdc-agent', payee: 'vendor.testnet' }, '1');

// 3) view check + three read-only simulation demos — no gas waste, no flaky panics
await view('STEP 3a (view): 3 USDC to vendor within cap+allowlist — would succeed except balance',
  'try_execute', { policy_id: 'usdc-agent', payee: 'vendor.testnet', amount: '3000000' });

await view('STEP 3b (view): BLOCK — over cap: 10 USDC > 5 USDC',
  'try_execute', { policy_id: 'usdc-agent', payee: 'vendor.testnet', amount: '10000000' });

await view('STEP 3c (view): BLOCK — unknown payee attacker.testnet not in allowlist',
  'try_execute', { policy_id: 'usdc-agent', payee: 'attacker.testnet', amount: '1000000' });

await view('STEP 3d (view): ESCALATION — set_policy called with 0 deposit (1-yocto guard fires)',
  'try_set_policy', { attached_yoctos: '0', predecessor: ID, per_tx_cap: '999000000' });

await view('STEP 3e (view): ESCALATION — set_policy called as non-owner (attacker.testnet)',
  'try_set_policy', { attached_yoctos: '1', predecessor: 'attacker.testnet', per_tx_cap: '999000000' });

// 4) real on-chain escalation proof: call set_policy with 0 deposit — tx must be rejected
await mutate('STEP 4 (on-chain): REAL set_policy with 0 deposit — expect on-chain rejection',
  'set_policy', { policy_id: 'pwn', token: USDC, per_tx_cap: '999000000' }, '0', true);

console.log(`\n=== Explorer: https://testnet.nearblocks.io/address/${ID}?tab=receipts ===`);
console.log(`\nRecord from the ╔═══ banner through the explorer line. Narrate: policy set ✅, vendor allowlisted ✅, then the four ❌ rejections including the REAL on-chain escalation at step 4.`);
