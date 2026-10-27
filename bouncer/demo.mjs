// Runs the three Bouncer demo scenarios (ALLOW / BLOCK / ESCALATION-PROOF)
// against the deployed contract and prints results with explorer links.
//
// Uses the key saved by deploy.mjs in ~/.near-credentials/testnet/<account>.json.
// Run:  node bouncer/demo.mjs
import fs from 'fs';
import path from 'path';
import os from 'os';
import nearApi from 'near-api-js';

const { KeyPair, keyStores, InMemorySigner, Account, Connection, JsonRpcProvider } = nearApi;
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
const connection = Connection.fromConfig({
  networkId: NETWORK, provider, signer, jsvmAccountId: `jsvm.${NETWORK}`,
});
const me = new Account(connection, ID);

function txUrl(txHash) {
  return `https://testnet.nearblocks.io/txns/${txHash}?network=testnet`;
}

async function call(label, method, args, deposit = '0', expectedOk = true) {
  console.log(`\n=== ${label} ===`);
  console.log(`    calling ${method}(${JSON.stringify(args).slice(0, 80)}...)`);
  try {
    const res = await me.functionCall({
      contractId: ID, methodName: method, args,
      attachedDeposit: BigInt(deposit), gas: BigInt('100000000000000'),
    });
    const hash = Buffer.from(res.transaction_outcome.id).toString('hex');
    console.log(`    ✅ status: ok`);
    console.log(`    tx: ${txUrl(hash)}`);
    if (res.receipts_outcome && res.receipts_outcome.length) {
      const last = res.receipts_outcome[res.receipts_outcome.length - 1].outcome;
      const logs = last.logs || [];
      if (logs.length) console.log(`    logs: ${logs.join(' | ')}`);
    }
    return res;
  } catch (e) {
    const msg = (e.message || String(e)).split('\n')[0];
    console.log(`    ❌ ${expectedOk ? 'unexpected ' : ''}rejection: ${msg.slice(0, 300)}`);
    return null;
  }
}

// Step 0 — setup policy + allowlist + (fake) fund the vault with USDC
// Note: usdc.fakes.testnet is a canonical NEP-141 fake token used in tests.
// We can't mint it without owning that contract, but we can still show:
//   1. setup calls succeed
//   2. over-cap rejection fires BEFORE balance check
//   3. escalation rejection fires at the 1-yocto check
await call('Set policy (5 USDC cap, 1 yocto deposit — owner only)', 'set_policy',
  { policy_id: 'usdc-agent', token: USDC, per_tx_cap: '5000000' }, '1');
await call('Allowlist vendor.testnet', 'allow_payee',
  { policy_id: 'usdc-agent', payee: 'vendor.testnet' }, '1');

// Demo 1 — under cap, allowlisted payee (fails at "insufficient balance" because vault empty,
//         but proves policy passed and we got to the balance check cleanly — so re-run after funding)
// To keep the demo self-contained without relying on external fake-USDC mint, we show the three
// hard security guarantees in terms of what fails first:
await call('CHECK: 3 USDC in cap -> passes policy (fails at insufficient balance — expected without funding)',
  'check', { policy_id: 'usdc-agent', payee: 'vendor.testnet', amount: '3000000' });

// Demo 2 — over cap panic (policy rejects before balance)
await call('BLOCK: 10 USDC over 5 USDC per-tx cap — should panic "amount out of per-tx range"',
  'execute', { policy_id: 'usdc-agent', payee: 'vendor.testnet', amount: '10000000', memo: 'too much' }, '1');

// Demo 3 — non-allowlisted payee
await call('BLOCK: payee attacker.testnet not in allowlist',
  'execute', { policy_id: 'usdc-agent', payee: 'attacker.testnet', amount: '1000000', memo: 'x' }, '1');

// Demo 4 — ESCALATION PROOF: try to call set_policy WITHOUT any deposit
// This is the headline. near-cli / API attaches 0 deposit. NEAR will reject with
// "requires exactly 1 yoctoNEAR" — our assert fires. If called from a function-call key,
// NEAR rejects at the protocol level as DepositWithFunctionCall before our assert even runs.
await call('ESCALATION: set_policy with 0 deposit — should be REJECTED (proves yocto-guard)',
  'set_policy', { policy_id: 'usdc-agent', token: USDC, per_tx_cap: '999000000' }, '0');

console.log(`\n=== Explorer: https://testnet.nearblocks.io/address/${ID}?tab=receipts ===`);
