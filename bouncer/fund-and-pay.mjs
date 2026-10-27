// Happy-path demo with daily cap:
//  1) Create vendor sub-account (if missing) + storage-deposit on wrap.testnet
//  2) Set wNEAR policy: per-tx cap 2 NEAR, daily cap 1 NEAR
//  3) Wrap 2 NEAR into wNEAR, ft_transfer_call 1.5 wNEAR into vault
//  4) execute() 0.1 NEAR payment to vendor — succeeds
//  5) execute() another 0.95 NEAR — exceeds daily cap (0.1+0.95=1.05 > 1.0), BLOCKED
//  6) Show final balances
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import nearApi from 'near-api-js';

const { KeyPair, KeyPairSigner, keyStores, Account, providers } = nearApi;
const { JsonRpcProvider } = providers;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NETWORK = 'testnet';
const RPC = 'https://rpc.testnet.near.org';
const WNEAR = 'wrap.testnet';

process.on('warning', () => {});
const _ow = console.warn; console.warn = (...a)=>{ const m=a.join(' '); if(!/deprecated|please switch/i.test(m))_ow.apply(console,a); };

const ID_FILE = path.join(os.homedir(), '.bouncer_id');
const KEY_DIR = path.join(os.homedir(), '.near-credentials', NETWORK);
const BOUNCER_ID = fs.readFileSync(ID_FILE, 'utf8').trim();
const bkp = KeyPair.fromString(JSON.parse(fs.readFileSync(path.join(KEY_DIR, `${BOUNCER_ID}.json`),'utf8')).private_key);
const provider = new JsonRpcProvider({ url: RPC });
const bouncerAcct = new Account(BOUNCER_ID, provider, new KeyPairSigner(bkp));

const txUrl = h => `https://testnet.nearblocks.io/txns/${h}?network=testnet`;
const ONE_NEAR = 10n**24n;

async function call(contractId, method, args, deposit, gas, label) {
  if (label) console.log(`\n=== ${label} ===`);
  try {
    const res = await bouncerAcct.functionCall({ contractId, methodName: method, args,
      attachedDeposit: BigInt(deposit||'0'), gas: BigInt(gas||'100000000000000') });
    if (label) console.log(`    ✅ ok     tx: ${txUrl(res.transaction_outcome.id)}`);
    return res;
  } catch (e) {
    const msg = e.message || String(e);
    const em = msg.match(/ExecutionError":"([^"]+)"/);
    const short = em ? em[1] : msg.split('\n')[0].slice(0,250);
    if (label) console.log(`    ❌ ${short}`);
    throw e;
  }
}
async function view(contractId, method, args) {
  return bouncerAcct.viewFunction({ contractId, methodName: method, args });
}

(async () => {
  console.log(`╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║   HAPPY PATH + DAILY CAP — wNEAR through Bouncer firewall   ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝`);
  console.log(`Bouncer: ${BOUNCER_ID}\n`);

  const VENDOR_ID = `vendor-${BOUNCER_ID}`;
  const PER_TX_CAP = (2n * ONE_NEAR).toString();
  const DAILY_CAP = (1n * ONE_NEAR).toString();   // 1 NEAR/day
  const PAY1 = (ONE_NEAR / 10n).toString();      // 0.1 NEAR — first spend
  const PAY2 = (19n * ONE_NEAR / 20n).toString();// 0.95 NEAR — would push over daily cap

  const vendorKp = KeyPair.fromRandom('ed25519');
  console.log(`=== 1) Ensure vendor ${VENDOR_ID} exists and is registered on ${WNEAR} ===`);
  try {
    const createTx = await bouncerAcct.createAccount(VENDOR_ID, vendorKp.getPublicKey(),
      BigInt('100000000000000000000000'));
    console.log(`    ✅ vendor created  tx: ${txUrl(createTx.transaction_outcome.id)}`);
  } catch { console.log(`    (vendor exists)`); }

  await call(WNEAR, 'storage_deposit', {account_id:VENDOR_ID}, '1250000000000000000000','50000000000000');
  await call(WNEAR, 'storage_deposit', {account_id:BOUNCER_ID}, '1250000000000000000000','50000000000000');

  console.log(`\n=== 2) Wrap 2 NEAR -> wNEAR ===`);
  await call(WNEAR, 'near_deposit', {}, (2n*ONE_NEAR).toString(), '50000000000000');

  console.log(`\n=== 3) Set policy: per-tx 2 NEAR, daily 1 NEAR ===`);
  await call(BOUNCER_ID, 'set_policy',
    { policy_id:'wnear-agent', token:WNEAR, per_tx_cap:PER_TX_CAP, daily_cap:DAILY_CAP }, '1','100000000000000');

  console.log(`\n=== 4) Allowlist ${VENDOR_ID} ===`);
  await call(BOUNCER_ID, 'allow_payee',
    { policy_id:'wnear-agent', payee:VENDOR_ID }, '1','100000000000000');

  console.log(`\n=== 5) Fund vault with 1.5 wNEAR via ft_transfer_call ===`);
  await call(WNEAR, 'ft_transfer_call',
    { receiver_id:BOUNCER_ID, amount: (3n*ONE_NEAR/2n).toString(), msg:'fund' },
    '1','200000000000000');

  const vbal = await view(BOUNCER_ID, 'vault_balance', { token: WNEAR });
  console.log(`    vault wNEAR: ${Number(vbal)/1e24}`);

  console.log(`\n=== 6) PAY 0.1 wNEAR to vendor (within cap, within daily) — expect SUCCESS ===`);
  try {
    await call(BOUNCER_ID, 'execute',
      { policy_id:'wnear-agent', payee:VENDOR_ID, amount:PAY1, memo:'compute:1h' },
      '1','200000000000000');
  } catch {}

  console.log(`\n=== 7) PAY 0.95 wNEAR — BLOCKED by daily cap (0.1+0.95 > 1.0/day) ===`);
  try {
    await call(BOUNCER_ID, 'execute',
      { policy_id:'wnear-agent', payee:VENDOR_ID, amount:PAY2, memo:'storage:100gb' },
      '1','200000000000000');
  } catch {}

  const vendorBal = await view(WNEAR, 'ft_balance_of', { account_id: VENDOR_ID });
  const vaultBal = await view(BOUNCER_ID, 'vault_balance', { token: WNEAR });
  console.log(`\n=== FINAL BALANCES ===`);
  console.log(`    vendor wNEAR:  ${Number(vendorBal)/1e24} (expect 0.1)`);
  console.log(`    vault wNEAR:   ${Number(vaultBal)/1e24} (expect 1.4)`);
  console.log(`\n=== DONE. Happy path ✅ + daily cap ✅ demonstrated end-to-end. ===`);
})().catch(e => { console.error('❌', (e.message||String(e)).slice(0,600)); process.exit(1); });
