// Happy-path + daily-limit demo.
//   1. Create "user" sub-account with 5 NEAR (simulates human depositor).
//   2. Create "vendor" sub-account, NEP-141 register both + bouncer on wrap.testnet.
//   3. User wraps NEAR -> wNEAR.
//   4. User ft_transfer_calls wNEAR to BOUNCER (real ft_on_transfer credit).
//   5. Bouncer sets wNEAR policy (2 N/tx, 1 N/day), allowlists vendor.
//   6. execute 0.1 N -> vendor (SUCCEEDS).
//   7. execute 0.95 N -> BLOCKED by daily cap (0.1+0.95 > 1.0).
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import nearApi from 'near-api-js';

const { KeyPair, KeyPairSigner, Account, providers } = nearApi;
const { JsonRpcProvider } = providers;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NETWORK = 'testnet';
const RPC = 'https://rpc.testnet.near.org';
const WNEAR = 'wrap.testnet';
process.env.NODE_NO_WARNINGS = '1';

const ID_FILE = path.join(os.homedir(), '.bouncer_id');
const KEY_DIR = path.join(os.homedir(), '.near-credentials', NETWORK);
const BOUNCER_ID = fs.readFileSync(ID_FILE, 'utf8').trim();
const bkp = KeyPair.fromString(JSON.parse(fs.readFileSync(path.join(KEY_DIR, `${BOUNCER_ID}.json`),'utf8')).private_key);
const provider = new JsonRpcProvider({ url: RPC });
const bouncerAcct = new Account(BOUNCER_ID, provider, new KeyPairSigner(bkp));

const txUrl = h => `https://testnet.nearblocks.io/txns/${h}?network=testnet`;
const ONE_NEAR = 10n**24n;
const STORAGE_DEPOSIT = '1250000000000000000000';

async function callFrom(acct, contractId, method, args, deposit, gas, label) {
  if (label) console.log(`\n=== ${label} ===`);
  try {
    const res = await acct.functionCall({ contractId, methodName: method, args,
      attachedDeposit: BigInt(deposit||'0'), gas: BigInt(gas||'100000000000000') });
    if (label) {
      console.log(`    ✅ ok     tx: ${txUrl(res.transaction_outcome.id)}`);
      const last = res.receipts_outcome?.[res.receipts_outcome.length - 1]?.outcome;
      if (last?.logs?.length) for (const l of last.logs) if (!/deprecated/i.test(l)) console.log(`    log: ${l}`);
    }
    return res;
  } catch (e) {
    const msg = e.message || String(e);
    const em = msg.match(/ExecutionError":"([^"]+)"/);
    const short = em ? em[1] : msg.split('\n')[0].slice(0,300);
    if (label) console.log(`    ❌ ${short}`);
    throw e;
  }
}
async function view(contractId, method, args) {
  return bouncerAcct.viewFunction({ contractId, methodName: method, args });
}

(async () => {
  console.log(`╔════════════════════════════════════════════════════════════════════╗`);
  console.log(`║  MULTI-RESOURCE AGENT — fund vault, pay vendor, hit daily cap    ║`);
  console.log(`╚════════════════════════════════════════════════════════════════════╝`);
  console.log(`Bouncer contract : ${BOUNCER_ID}`);
  console.log(`Vault token      : ${WNEAR} (wNEAR)\n`);

  const suffix = crypto.randomBytes(2).toString('hex');
  const USER_ID = `user-${suffix}.${BOUNCER_ID}`;
  const VENDOR_ID = `vendor-${suffix}.${BOUNCER_ID}`;
  const PER_TX_CAP = (2n * ONE_NEAR).toString();
  const DAILY_CAP = (1n * ONE_NEAR).toString();
  const USER_WRAP = (2n * ONE_NEAR).toString();
  const USER_DEPOSIT = (15n * ONE_NEAR / 10n).toString();
  const PAY1 = (ONE_NEAR / 10n).toString();
  const PAY2 = (19n * ONE_NEAR / 20n).toString();

  function saveKey(acctId, kp){
    fs.mkdirSync(KEY_DIR,{recursive:true});
    fs.writeFileSync(path.join(KEY_DIR, `${acctId}.json`), JSON.stringify({
      account_id: acctId, public_key: kp.getPublicKey().toString(), private_key: kp.toString(),
    }, null, 2));
  }

  console.log(`=== 1) Create user ${USER_ID} (5 NEAR) ===`);
  const userKp = KeyPair.fromRandom('ed25519'); saveKey(USER_ID, userKp);
  const cu = await bouncerAcct.createAccount(USER_ID, userKp.getPublicKey(), BigInt('5000000000000000000000000'));
  console.log(`    ✅ created  tx: ${txUrl(cu.transaction_outcome.id)}`);
  const userAcct = new Account(USER_ID, provider, new KeyPairSigner(userKp));

  console.log(`\n=== 2) Create vendor ${VENDOR_ID} (0.5 NEAR) ===`);
  const vendorKp = KeyPair.fromRandom('ed25519'); saveKey(VENDOR_ID, vendorKp);
  const cv = await bouncerAcct.createAccount(VENDOR_ID, vendorKp.getPublicKey(), BigInt('500000000000000000000000'));
  console.log(`    ✅ created  tx: ${txUrl(cv.transaction_outcome.id)}`);

  console.log(`\n=== 3) NEP-141 storage deposits on ${WNEAR} ===`);
  await callFrom(userAcct, WNEAR, 'storage_deposit', {account_id: USER_ID}, STORAGE_DEPOSIT, '50000000000000');
  await callFrom(bouncerAcct, WNEAR, 'storage_deposit', {account_id: VENDOR_ID}, STORAGE_DEPOSIT, '50000000000000');
  await callFrom(bouncerAcct, WNEAR, 'storage_deposit', {account_id: BOUNCER_ID}, STORAGE_DEPOSIT, '50000000000000');

  console.log(`\n=== 4) User wraps 2 NEAR -> wNEAR ===`);
  await callFrom(userAcct, WNEAR, 'near_deposit', {}, USER_WRAP, '50000000000000');

  console.log(`\n=== 5) User ft_transfer_call 1.5 wNEAR -> Bouncer vault ===`);
  await callFrom(userAcct, WNEAR, 'ft_transfer_call',
    { receiver_id: BOUNCER_ID, amount: USER_DEPOSIT, msg:'deposit' }, '1', '200000000000000');
  const vbal1 = await view(BOUNCER_ID, 'vault_balance', { token: WNEAR });
  console.log(`    vault wNEAR now: ${Number(vbal1)/1e24} (expect 1.5)`);

  console.log(`\n=== 6) Set policy (per-tx 2 N, daily 1 N, owner 1 yocto) ===`);
  await callFrom(bouncerAcct, BOUNCER_ID, 'set_policy',
    { policy_id:'wnear-agent', token:WNEAR, per_tx_cap:PER_TX_CAP, daily_cap:DAILY_CAP }, '1','100000000000000');

  console.log(`\n=== 7) Allowlist ${VENDOR_ID} ===`);
  await callFrom(bouncerAcct, BOUNCER_ID, 'allow_payee',
    { policy_id:'wnear-agent', payee:VENDOR_ID }, '1','100000000000000');

  console.log(`\n=== 8) 🎯 execute 0.1 wNEAR -> vendor (should SUCCEED) ===`);
  try { await callFrom(bouncerAcct, BOUNCER_ID, 'execute',
    { policy_id:'wnear-agent', payee:VENDOR_ID, amount:PAY1, memo:'compute:1h' }, '1','200000000000000'); } catch {}

  console.log(`\n=== 9) 🛑 execute 0.95 wNEAR -> BLOCKED daily cap ===`);
  try { await callFrom(bouncerAcct, BOUNCER_ID, 'execute',
    { policy_id:'wnear-agent', payee:VENDOR_ID, amount:PAY2, memo:'storage:100gb' }, '1','200000000000000'); } catch {}

  const vendorBal = await view(WNEAR, 'ft_balance_of', { account_id: VENDOR_ID });
  const vaultBal = await view(BOUNCER_ID, 'vault_balance', { token: WNEAR });
  const userBal = await view(WNEAR, 'ft_balance_of', { account_id: USER_ID });
  console.log(`\n╔════════════════════════════════════════════════════════════════════╗`);
  console.log(`║                        FINAL BALANCES                            ║`);
  console.log(`╠════════════════════════════════════════════════════════════════════╣`);
  console.log(`║  user wNEAR    : ${String(Number(userBal)/1e24).padEnd(10)} (expect 0.5)                              ║`);
  console.log(`║  vendor wNEAR  : ${String(Number(vendorBal)/1e24).padEnd(10)} (expect 0.1 — only 1st payment)         ║`);
  console.log(`║  vault wNEAR   : ${String(Number(vaultBal)/1e24).padEnd(10)} (expect 1.4 — 1.5 in, 0.1 paid)          ║`);
  console.log(`╚════════════════════════════════════════════════════════════════════╝`);
  console.log(`\nExplorer: https://testnet.nearblocks.io/address/${BOUNCER_ID}?tab=receipts`);
})().catch(e => { console.error('❌ top-level:', (e.message||String(e)).slice(0,600)); process.exit(1); });
