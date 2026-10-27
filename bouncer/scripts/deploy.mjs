#!/usr/bin/env node
// Deploy the Bouncer contract to testnet (or mainnet if NETWORK=mainnet).
//
// Prerequisites:
//   1. Run `npm run build` first to produce contracts/bouncer/res/bouncer.wasm
//   2. Set DEPLOYER_KEY (ed25519 secret key for the deployer account; creates
//      a new sub-account e.g. bouncer.<deployer>)
//   3. Deployer account must already exist and have ~30 NEAR for testnet
//
// Usage:
//   DEPLOYER_ID=you.testnet DEPLOYER_KEY=ed25519:... CONTRACT_ID=bouncer.you.testnet \
//     node scripts/deploy.mjs

import * as fs from 'fs';
import * as path from 'path';
import * as nearApi from 'near-api-js';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const { keyStores, KeyPair, InMemorySigner, Account, Connection, JsonRpcProvider, transactions } = nearApi;

const NETWORK = process.env.NETWORK || 'testnet';
const RPC = process.env.RPC_URL || (NETWORK === 'mainnet'
  ? 'https://rpc.mainnet.near.org' : 'https://rpc.testnet.near.org');
const DEPLOYER_ID = process.env.DEPLOYER_ID;
const DEPLOYER_KEY = process.env.DEPLOYER_KEY;
const CONTRACT_ID = process.env.CONTRACT_ID;

if (!DEPLOYER_ID || !DEPLOYER_KEY || !CONTRACT_ID) {
  console.error(`usage: DEPLOYER_ID=you.testnet DEPLOYER_KEY=ed25519:... CONTRACT_ID=bouncer.you.testnet node scripts/deploy.mjs`);
  process.exit(1);
}

// CI commits bouncer.wasm to the repo root after building.
const WASM_PATH = path.join(ROOT, '..', 'bouncer.wasm');
if (!fs.existsSync(WASM_PATH)) {
  console.error(`wasm not found at ${WASM_PATH}; run npm run build first`);
  process.exit(1);
}

async function makeAccount(accountId, keyStr) {
  const kp = KeyPair.fromString(keyStr);
  const keystore = new keyStores.InMemoryKeyStore();
  await keystore.setKey(NETWORK, accountId, kp);
  const provider = new JsonRpcProvider({ url: RPC });
  const signer = new InMemorySigner(keystore);
  const connection = Connection.fromConfig({
    networkId: NETWORK, provider, signer,
    jsvmAccountId: `jsvm.${NETWORK}`,
  });
  return new Account(connection, accountId);
}

(async () => {
  console.log(`==> Deploying Bouncer to ${CONTRACT_ID} on ${NETWORK}`);
  const wasm = fs.readFileSync(WASM_PATH);
  console.log(`    wasm size: ${wasm.length} bytes`);

  const deployer = await makeAccount(DEPLOYER_ID, DEPLOYER_KEY);

  // 1. Create sub-account if needed (create account + transfer 30 NEAR + add key).
  try {
    await deployer.viewFunction({ contractId: CONTRACT_ID, methodName: 'vault_balance', args: { token: 'noop.near' } });
    console.log(`    contract account ${CONTRACT_ID} exists; skipping create`);
  } catch {
    console.log(`    creating sub-account ${CONTRACT_ID}...`);
    const keyPair = KeyPair.fromString(DEPLOYER_KEY); // same key for simplicity
    const pk = keyPair.getPublicKey();
    const amount = nearApi.utils.format.parseNearAmount('30');
    await deployer.createAccount(CONTRACT_ID, pk, BigInt(amount));
    console.log(`    created and funded with 30 NEAR`);
  }

  // 2. Deploy the contract.
  const contract = await makeAccount(CONTRACT_ID, DEPLOYER_KEY);
  console.log(`    deploying wasm...`);
  const deployTx = await contract.deployContract(wasm);
  console.log(`    deployed in tx ${deployTx.transaction_outcome.id ? Buffer.from(deployTx.transaction_outcome.id).toString('hex') : deployTx.transaction.hash}`);

  // 3. Initialize (idempotent: if already initialized, skip).
  try {
    await contract.functionCall({
      contractId: CONTRACT_ID,
      methodName: 'new',
      args: { owner: DEPLOYER_ID },
      attachedDeposit: BigInt(0),
      gas: BigInt('100000000000000'),
    });
    console.log(`    initialized with owner=${DEPLOYER_ID}`);
  } catch (e) {
    if (/contract is already initialized|already initialized/.test(e.message)) {
      console.log(`    already initialized — skipping new()`);
    } else {
      throw e;
    }
  }

  console.log();
  console.log(`==> Done. Contract: ${CONTRACT_ID}`);
  console.log(`    Explorer: https://${NETWORK === 'mainnet' ? 'nearblocks.io' : 'testnet.nearblocks.io'}/address/${CONTRACT_ID}`);
  console.log();
  console.log(`Next steps:`);
  console.log(`  1. Register the vault with the USDC token contract (storage_deposit 0.00125 N):`);
  console.log(`     near call usdc.${NETWORK === 'mainnet' ? 'near' : 'fakes.testnet'} storage_deposit '' --accountId ${CONTRACT_ID} --deposit 0.00125`);
  console.log(`  2. Call set_policy from your full-access key to create a policy`);
  console.log(`  3. Add a function-call key for the agent (see docs/DEPLOY.md)`);
})().catch(e => { console.error(e); process.exit(1); });
