// Happy-path demo:
//  1) Create vendor.testnet sub-account (funded from bouncer account)
//  2) Storage-deposit vendor on wrap.testnet (wNEAR NEP-141)
//  3) Wrap some of the bouncer's NEAR into wNEAR via wrap.testnet
//  4) ft_transfer_call wNEAR into Bouncer vault (ft_on_transfer credits vault)
//  5) execute() a 0.1 NEAR payment to vendor (under cap, allowlisted, vault funded) -> SUCCESS
//  6) Show vendor's wNEAR balance increased
//
// Uses the account saved by deploy.mjs. Run from repo root:
//   node bouncer/fund-and-pay.mjs
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import nearApi from 'near-api-js';

const { KeyPair, KeyPairSigner, keyStores, Account, providers, transactions } = nearApi;
const { JsonRpcProvider } = providers;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const NETWORK = 'testnet';
const RPC = 'https://rpc.testnet.near.org';
const WNEAR = 'wrap.testnet';

// quiet
process.on('warning', () => {});
const _ow = console.warn; console.warn = (...a)=>{ const m=a.join(' '); if(!/deprecated|please switch/i.test(m))_ow.apply(console,a); };

const ID_FILE = path.join(os.homedir(), '.bouncer_id');
const KEY_DIR = path.join(os.homedir(), '.near-credentials', NETWORK);
const BOUNCER_ID = fs.readFileSync(ID_FILE, 'utf8').trim();
const bouncerKey = JSON.parse(fs.readFileSync(path.join(KEY_DIR, `${BOUNCER_ID}.json`), 'utf8'));
const bkp = KeyPair.fromString(bouncerKey.private_key);
const provider = new JsonRpcProvider({ url: RPC });
const bouncerAcct = new Account(BOUNCER_ID, provider, new KeyPairSigner(bkp));

function txUrl(h){return `https://testnet.nearblocks.io/txns/${h}?network=testnet`;}
const YOCTO_PER_NEAR = '1000000000000000000000000'; // 1e24
const ONE_NEAR = BigInt(YOCTO_PER_NEAR);
const TENTH_NEAR = ONE_NEAR / 10n; // 0.1 NEAR in yocto — within a small cap

async function call(acct, contractId, method, args, deposit, gas) {
  return acct.functionCall({ contractId, methodName: method, args,
    attachedDeposit: BigInt(deposit||'0'), gas: BigInt(gas||'100000000000000') });
}

async function view(acct, contractId, method, args) {
  return acct.viewFunction({ contractId, methodName: method, args });
}

(async () => {
  console.log(`╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║   HAPPY-PATH FUND + PAY (wNEAR through Bouncer firewall)    ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝`);
  console.log(`Bouncer: ${BOUNCER_ID}\n`);

  // --- 0. Pick a policy cap (2 NEAR so 0.1 NEAR goes through)
  const CAP_YOCTO = (2n * ONE_NEAR).toString(); // 2 NEAR cap
  const AMOUNT_YOCTO = TENTH_NEAR.toString();   // 0.1 NEAR payment

  const VENDOR_ID = `vendor-${BOUNCER_ID}`;
  // Create a fresh in-memory key for vendor
  const vendorKp = KeyPair.fromRandom('ed25519');
  const vendorKs = new keyStores.InMemoryKeyStore();
  await vendorKs.setKey(NETWORK, VENDOR_ID, vendorKp);

  // --- 1. Create vendor sub-account under bouncer (requires 0.00182 NEAR for storage + key)
  console.log(`=== 1) Create vendor sub-account ${VENDOR_ID} ===`);
  try {
    const createTx = await bouncerAcct.createAccount(
      VENDOR_ID, vendorKp.getPublicKey(),
      BigInt('100000000000000000000000') // 0.1 NEAR initial balance for storage
    );
    console.log(`    ✅ created   tx: ${txUrl(createTx.transaction_outcome.id)}`);
  } catch (e) {
    // already exists is fine
    console.log(`    (vendor already exists, continuing)`);
  }

  // --- 2. Storage-deposit vendor on wrap.testnet (required for NEP-141 receiver)
  console.log(`\n=== 2) Storage-deposit vendor on ${WNEAR} (NEP-141 registration) ===`);
  const sdTx = await call(bouncerAcct, WNEAR, 'storage_deposit',
    { account_id: VENDOR_ID },
    '1250000000000000000000', // 0.00125 NEAR (min for wNEAR storage)
    '50000000000000');
  console.log(`    ✅ deposited tx: ${txUrl(sdTx.transaction_outcome.id)}`);

  // Storage-deposit bouncer itself so it can hold wNEAR
  await call(bouncerAcct, WNEAR, 'storage_deposit',
    { account_id: BOUNCER_ID }, '1250000000000000000000', '50000000000000');

  // --- 3. Wrap 1 NEAR of the bouncer's NEAR into wNEAR
  console.log(`\n=== 3) Wrap 1 NEAR into wNEAR via ${WNEAR}.near_deposit() ===`);
  const wrapTx = await call(bouncerAcct, WNEAR, 'near_deposit', {},
    ONE_NEAR.toString(), // attach 1 NEAR -> mints 1 wNEAR
    '50000000000000');
  console.log(`    ✅ wrapped   tx: ${txUrl(wrapTx.transaction_outcome.id)}`);

  // --- 4. Set Bouncer policy for wNEAR at 2 NEAR cap, allowlist vendor
  console.log(`\n=== 4) Set wNEAR policy (2 NEAR cap, 1 yocto) ===`);
  const polTx = await call(bouncerAcct, BOUNCER_ID, 'set_policy',
    { policy_id: 'wnear-agent', token: WNEAR, per_tx_cap: CAP_YOCTO }, '1', '100000000000000');
  console.log(`    ✅ policy    tx: ${txUrl(polTx.transaction_outcome.id)}`);

  console.log(`\n=== 5) Allowlist vendor ${VENDOR_ID} (1 yocto) ===`);
  const alTx = await call(bouncerAcct, BOUNCER_ID, 'allow_payee',
    { policy_id: 'wnear-agent', payee: VENDOR_ID }, '1', '100000000000000');
  console.log(`    ✅ allowlist tx: ${txUrl(alTx.transaction_outcome.id)}`);

  // --- 6. ft_transfer_call 1 wNEAR into Bouncer vault (triggers ft_on_transfer)
  console.log(`\n=== 6) ft_transfer_call 1 wNEAR into Bouncer vault ===`);
  const fundTx = await call(bouncerAcct, WNEAR, 'ft_transfer_call',
    { receiver_id: BOUNCER_ID, amount: ONE_NEAR.toString(), msg: 'fund-vault' },
    '1', // 1 yocto for ft_transfer
    '200000000000000'); // more gas for cross-contract callback
  console.log(`    ✅ funded    tx: ${txUrl(fundTx.transaction_outcome.id)}`);

  // Verify vault balance
  const vbal = await view(bouncerAcct, BOUNCER_ID, 'vault_balance', { token: WNEAR });
  console.log(`    vault_balance(wNEAR): ${vbal} yocto (${Number(vbal)/1e24} wNEAR)`);

  // --- 7. EXECUTE 0.1 NEAR payment to vendor (the happy path!)
  console.log(`\n=== 7) 🎯 execute() payment — send 0.1 wNEAR to vendor ===`);
  const execTx = await call(bouncerAcct, BOUNCER_ID, 'execute',
    { policy_id: 'wnear-agent', payee: VENDOR_ID, amount: AMOUNT_YOCTO, memo: 'compute:1h' },
    '1',
    '200000000000000');
  console.log(`    ✅ PAID      tx: ${txUrl(execTx.transaction_outcome.id)}`);
  const last = execTx.receipts_outcome?.[execTx.receipts_outcome.length - 1]?.outcome;
  if (last?.logs?.length) console.log(`    logs: ${last.logs.join(' | ')}`);

  // --- 8. Verify vendor's wNEAR balance
  console.log(`\n=== 8) Verify vendor ${VENDOR_ID} received wNEAR ===`);
  const vbal_after = await view(bouncerAcct, WNEAR, 'ft_balance_of', { account_id: VENDOR_ID });
  const vbal_b = await view(bouncerAcct, BOUNCER_ID, 'vault_balance', { token: WNEAR });
  console.log(`    vendor wNEAR balance:  ${vbal_after} yocto (${Number(vbal_after)/1e24} wNEAR)`);
  console.log(`    Bouncer vault balance: ${vbal_b} yocto (${Number(vbal_b)/1e24} wNEAR)`);
  console.log(`    (expect vendor=0.1, vault=0.9)`);

  console.log(`\n=== DONE: happy path complete. Payment went through the firewall and landed on-chain. ===`);
  console.log(`Explorer: https://testnet.nearblocks.io/address/${BOUNCER_ID}?tab=receipts`);
})().catch(e => { console.error('\n❌', (e.message||String(e)).slice(0,800)); process.exit(1); });
