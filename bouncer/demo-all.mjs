// END-TO-END DEMO — fresh contract every run (no leftover state).
// Creates: bouncer-XXXX.testnet (owner), user-XXXX.bouncer, vendor-XXXX.bouncer.
// Shows:  deploy+init, policy+allowlist, vault funded via real ft_transfer_call,
//         happy-path payment succeeds, daily-cap reject, per-tx-cap reject,
//         unknown-payee reject, 0-deposit escalation REJECTED on-chain, final balances.
//
// Run:  node bouncer/demo-all.mjs    (from repo root, no prior deploy needed)
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import nearApi from 'near-api-js';

const { KeyPair, KeyPairSigner, Account, providers } = nearApi;
const { JsonRpcProvider } = providers;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const NETWORK = 'testnet';
const RPC = 'https://rpc.testnet.near.org';
const HELPER = 'https://helper.testnet.near.org';
const WNEAR = 'wrap.testnet';

process.env.NODE_NO_WARNINGS = '1';
process.on('warning', () => {});
const origOut = process.stdout.write.bind(process.stdout);
process.stdout.write = (c, ...r) => {
  const s = Buffer.isBuffer(c) ? c.toString() : String(c);
  if (/deprecated|It will be removed|please switch/i.test(s)) return true;
  return origOut(c, ...r);
};
process.stderr.write = (c, ...r) => {
  const s = Buffer.isBuffer(c) ? c.toString() : String(c);
  if (/deprecated|warning/i.test(s)) return true;
  return process.stderr.write ? process.stderr.write(c, ...r) : true;
};

const WASM_PATH = path.join(REPO_ROOT, 'bouncer.wasm');
if (!fs.existsSync(WASM_PATH)) { console.error('bouncer.wasm missing at', WASM_PATH); process.exit(1); }
const WASM = fs.readFileSync(WASM_PATH);

const KEY_DIR = path.join(os.homedir(), '.near-credentials', NETWORK);
fs.mkdirSync(KEY_DIR, { recursive: true });
const provider = new JsonRpcProvider({ url: RPC });

const txUrl = h => `https://testnet.nearblocks.io/txns/${h}?network=testnet`;
const ONE_NEAR = 10n**24n;
const STORAGE = '1250000000000000000000'; // 0.00125 N
const YOCTO = '1';

function saveKey(id, kp) {
  fs.writeFileSync(path.join(KEY_DIR, `${id}.json`), JSON.stringify({
    account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString(),
  }, null, 2));
}
function acctFor(id, kp) { return new Account(id, provider, new KeyPairSigner(kp)); }

async function helperCreate(id, pk) {
  const r = await fetch(`${HELPER}/account`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ newAccountId: id, newAccountPublicKey: pk }),
  });
  if (!r.ok) throw new Error(`helper ${r.status}: ${await r.text()}`);
  return r.json();
}

async function callFrom(acct, cid, method, args, deposit, gas, label) {
  if (label) console.log(`\n=== ${label} ===`);
  try {
    const r = await acct.functionCall({ contractId: cid, methodName: method, args,
      attachedDeposit: BigInt(deposit||'0'), gas: BigInt(gas||'100000000000000') });
    if (label) {
      console.log(`    ✅ ok      tx: ${txUrl(r.transaction_outcome.id)}`);
      const last = r.receipts_outcome?.[r.receipts_outcome.length-1]?.outcome;
      if (last?.logs) for (const l of last.logs) if (l.startsWith('BOUNCER')) console.log(`    📜 ${l}`);
    }
    return r;
  } catch (e) {
    const msg = e.message || String(e);
    const em = msg.match(/ExecutionError":"([^"]+)"/);
    const short = em ? em[1] : msg.split('\n')[0].slice(0,280);
    if (label) console.log(`    ❌ ${short}`);
    throw e;
  }
}
async function viewFrom(acct, cid, method, args) {
  return acct.viewFunction({ contractId: cid, methodName: method, args });
}

(async () => {
  console.log(`╔════════════════════════════════════════════════════════════════════════╗`);
  console.log(`║  BOUNCER — multi-resource AI agent payments firewall (NEAR testnet)  ║`);
  console.log(`║  fresh deploy • happy path • caps • allowlist • daily • escalation  ║`);
  console.log(`╚════════════════════════════════════════════════════════════════════════╝\n`);

  // --- 1. Fresh bouncer account via helper (server-side faucet, no wallet) ---
  const suffix = crypto.randomBytes(3).toString('hex');
  const BID = `bouncer-${suffix}.testnet`;
  console.log(`=== 1) Creating funded contract account: ${BID} ===`);
  const bkp = KeyPair.fromRandom('ed25519'); saveKey(BID, bkp);
  await helperCreate(BID, bkp.getPublicKey().toString());
  const bouncer = acctFor(BID, bkp);

  // --- 2. Deploy + init ---
  console.log(`\n=== 2) Deploy bouncer.wasm (${WASM.length} bytes) + new({owner}) ===`);
  const dtx = await bouncer.deployContract(WASM);
  console.log(`    ✅ deploy  tx: ${txUrl(dtx.transaction_outcome.id)}`);
  const itx = await bouncer.functionCall({ contractId: BID, methodName:'new', args:{owner:BID},
    attachedDeposit:0n, gas:BigInt('100000000000000') });
  console.log(`    ✅ init    tx: ${txUrl(itx.transaction_outcome.id)}`);

  // --- 3. Create user + vendor sub-accounts ---
  const UID = `user-${suffix}.${BID}`, VID = `vendor-${suffix}.${BID}`;
  console.log(`\n=== 3) Create user ${UID} (5 N) and vendor ${VID} (0.5 N) ===`);
  const ukp = KeyPair.fromRandom('ed25519'); saveKey(UID, ukp);
  const vkp = KeyPair.fromRandom('ed25519'); saveKey(VID, vkp);
  const cu = await bouncer.createAccount(UID, ukp.getPublicKey(), BigInt('5000000000000000000000000'));
  console.log(`    ✅ user      tx: ${txUrl(cu.transaction_outcome.id)}`);
  const cv = await bouncer.createAccount(VID, vkp.getPublicKey(), BigInt('500000000000000000000000'));
  console.log(`    ✅ vendor    tx: ${txUrl(cv.transaction_outcome.id)}`);
  const user = acctFor(UID, ukp);

  // --- 4. NEP-141 storage deposits ---
  console.log(`\n=== 4) NEP-141 storage deposits on ${WNEAR} ===`);
  await callFrom(user,    WNEAR,'storage_deposit',{account_id:UID}, STORAGE,'50T');
  await callFrom(bouncer, WNEAR,'storage_deposit',{account_id:VID}, STORAGE,'50T');
  await callFrom(bouncer, WNEAR,'storage_deposit',{account_id:BID}, STORAGE,'50T');

  // --- 5. User wraps 2 NEAR ---
  console.log(`\n=== 5) User wraps 2 NEAR → wNEAR ===`);
  await callFrom(user, WNEAR, 'near_deposit', {}, (2n*ONE_NEAR).toString(), '50T');

  // --- 6. Set wNEAR policy: 2 N/tx, 1 N/day ---
  console.log(`\n=== 6) Set policy: 2 N/tx, 1 N/day (owner-signed, 1 yocto) ===`);
  await callFrom(bouncer, BID, 'set_policy',
    { policy_id:'wnear-agent', token:WNEAR,
      per_tx_cap:(2n*ONE_NEAR).toString(),
      daily_cap:(1n*ONE_NEAR).toString() }, YOCTO, '100T');

  // --- 7. Allowlist vendor ---
  console.log(`\n=== 7) Allowlist ${VID} ===`);
  await callFrom(bouncer, BID, 'allow_payee',
    { policy_id:'wnear-agent', payee:VID }, YOCTO, '100T');

  // --- 8. User deposits 1.5 wNEAR to vault ---
  console.log(`\n=== 8) User ft_transfer_call 1.5 wNEAR → Bouncer vault ===`);
  await callFrom(user, WNEAR, 'ft_transfer_call',
    { receiver_id:BID, amount:(3n*ONE_NEAR/2n).toString(), msg:'fund' }, YOCTO, '200T');
  const vb = await viewFrom(bouncer, BID, 'vault_balance', { token:WNEAR });
  console.log(`    vault wNEAR: ${Number(vb)/1e24} (expect 1.5)`);

  // --- 9. SUCCESS: 0.1 wNEAR to vendor ---
  console.log(`\n=== 9) 🎯 execute 0.1 wNEAR → vendor — expect SUCCESS ===`);
  try { await callFrom(bouncer, BID, 'execute',
    { policy_id:'wnear-agent', payee:VID, amount:(ONE_NEAR/10n).toString(), memo:'compute:1h' },
    YOCTO, '200T'); } catch {}

  // --- 10. BLOCK daily cap: 0.95 ---
  console.log(`\n=== 10) 🛑 execute 0.95 wNEAR — BLOCKED daily cap (0.1+0.95 > 1.0/day) ===`);
  try { await callFrom(bouncer, BID, 'execute',
    { policy_id:'wnear-agent', payee:VID, amount:(19n*ONE_NEAR/20n).toString(), memo:'storage:100gb' },
    YOCTO, '200T'); } catch {}

  // --- 11. BLOCK per-tx cap: 3 wNEAR ---
  console.log(`\n=== 11) 🛑 execute 3 wNEAR — BLOCKED over per-tx cap (2 N) ===`);
  try { await callFrom(bouncer, BID, 'execute',
    { policy_id:'wnear-agent', payee:VID, amount:(3n*ONE_NEAR).toString(), memo:'too much' },
    YOCTO, '200T'); } catch {}

  // --- 12. BLOCK unknown payee ---
  console.log(`\n=== 12) 🛑 execute 0.1 wNEAR → attacker.testnet — BLOCKED payee not allowlisted ===`);
  try { await callFrom(bouncer, BID, 'execute',
    { policy_id:'wnear-agent', payee:'attacker.testnet', amount:(ONE_NEAR/10n).toString(), memo:'x' },
    YOCTO, '200T'); } catch {}

  // --- 13. ESCALATION: set_policy with 0 deposit ---
  console.log(`\n=== 13) 🔒 set_policy with 0 deposit — ON-CHAIN ESCALATION REJECTION ===`);
  try { await callFrom(bouncer, BID, 'set_policy',
    { policy_id:'pwn', token:WNEAR, per_tx_cap:'999000000000000000000000000', daily_cap:null }, '0', '100T'); } catch {}

  // --- 14. Views ---
  console.log(`\n=== 14) View verdicts ===`);
  const vEsc = await viewFrom(bouncer, BID, 'try_set_policy',
    { attached_yoctos:'0', predecessor:BID, per_tx_cap:'1' });
  console.log(`    0-deposit set_policy view: ${JSON.stringify(vEsc)}`);
  const vOwn = await viewFrom(bouncer, BID, 'try_set_policy',
    { attached_yoctos:'1', predecessor:'attacker.testnet', per_tx_cap:'1' });
  console.log(`    non-owner set_policy view:  ${JSON.stringify(vOwn)}`);

  // --- 15. Balances ---
  const vBal = await viewFrom(bouncer, WNEAR, 'ft_balance_of', { account_id: VID });
  const bBal = await viewFrom(bouncer, BID, 'vault_balance', { token: WNEAR });
  const uBal = await viewFrom(bouncer, WNEAR, 'ft_balance_of', { account_id: UID });
  console.log(`\n╔════════════════════════════════════════════════════════════════════════╗`);
  console.log(`║                            FINAL BALANCES                            ║`);
  console.log(`╠════════════════════════════════════════════════════════════════════════╣`);
  console.log(`║  user wNEAR   : ${String(Number(uBal)/1e24).padEnd(12)} (expect 0.5: 2 wrapped - 1.5 deposited)     ║`);
  console.log(`║  vendor wNEAR : ${String(Number(vBal)/1e24).padEnd(12)} (expect 0.1: only the allowed payment)      ║`);
  console.log(`║  vault wNEAR  : ${String(Number(bBal)/1e24).padEnd(12)} (expect 1.4: 1.5 in, 0.1 paid out)         ║`);
  console.log(`╚════════════════════════════════════════════════════════════════════════╝`);

  fs.writeFileSync(path.join(os.homedir(), '.bouncer_id'), BID);
  console.log(`\nContract: ${BID}`);
  console.log(`Explorer: https://testnet.nearblocks.io/address/${BID}?tab=receipts`);
})().catch(e => { console.error('\n❌ FATAL:', (e.message||String(e)).slice(0,800)); process.exit(1); });
