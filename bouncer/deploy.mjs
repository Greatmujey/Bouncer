// one-shot deploy: creates a funded testnet account via the NEAR helper (faucet),
// deploys bouncer.wasm from the repo root, and initializes. No login or faucet website needed.
//
// Run from the repo root (Codespaces default):  node bouncer/deploy.mjs
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import nearApi from 'near-api-js';

const { KeyPair, keyStores, InMemorySigner, Account, Connection, JsonRpcProvider } = nearApi;
const NETWORK = 'testnet';
const RPC = 'https://rpc.testnet.near.org';
const HELPER = 'https://helper.testnet.near.org';
const WASM_PATH = path.resolve('bouncer.wasm');

if (!fs.existsSync(WASM_PATH)) {
  console.error('bouncer.wasm not found in repo root. Run from repo root.');
  process.exit(1);
}
const WASM = fs.readFileSync(WASM_PATH);

const suffix = crypto.randomBytes(3).toString('hex');
const ACCOUNT_ID = `bouncer-${suffix}.testnet`;
const keystore = new keyStores.InMemoryKeyStore();

async function http(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { return txt; }
}

(async () => {
  console.log(`==> Creating funded testnet account: ${ACCOUNT_ID}`);
  const keyPair = KeyPair.fromRandom('ed25519');
  await keystore.setKey(NETWORK, ACCOUNT_ID, keyPair);
  const createRes = await http(`${HELPER}/account`, {
    method: 'POST',
    body: { newAccountId: ACCOUNT_ID, newAccountPublicKey: keyPair.getPublicKey().toString() },
  });
  console.log('    helper:', typeof createRes === 'string' ? createRes.slice(0, 200) : JSON.stringify(createRes).slice(0, 200));

  const provider = new JsonRpcProvider({ url: RPC });
  const signer = new InMemorySigner(keystore);
  const connection = Connection.fromConfig({
    networkId: NETWORK, provider, signer,
    jsvmAccountId: `jsvm.${NETWORK}`,
  });
  const account = new Account(connection, ACCOUNT_ID);

  console.log(`==> Deploying bouncer.wasm (${WASM.length} bytes)...`);
  const dtx = await account.deployContract(WASM);
  console.log('    deploy tx:', Buffer.from(dtx.transaction_outcome.id).toString('hex'));

  console.log(`==> Initializing new({owner:"${ACCOUNT_ID}"})...`);
  const itx = await account.functionCall({
    contractId: ACCOUNT_ID,
    methodName: 'new',
    args: { owner: ACCOUNT_ID },
    attachedDeposit: BigInt(0),
    gas: BigInt('100000000000000'),
  });
  console.log('    init tx:', Buffer.from(itx.transaction_outcome.id).toString('hex'));

  const bal = await account.viewFunction({
    contractId: ACCOUNT_ID,
    methodName: 'vault_balance',
    args: { token: 'usdc.fakes.testnet' },
  });
  console.log('    vault_balance(usdc):', bal);

  // persist key to ~/.near-credentials so `near` CLI and other scripts can sign
  const keyDir = path.join(os.homedir(), '.near-credentials', NETWORK);
  fs.mkdirSync(keyDir, { recursive: true });
  fs.writeFileSync(path.join(keyDir, `${ACCOUNT_ID}.json`), JSON.stringify({
    account_id: ACCOUNT_ID,
    public_key: keyPair.getPublicKey().toString(),
    private_key: keyPair.toString(),
  }, null, 2));

  // stash the contract id for demo scripts
  fs.writeFileSync('/tmp/bouncer_id', ACCOUNT_ID);
  fs.writeFileSync(path.join(os.homedir(), '.bouncer_id'), ACCOUNT_ID);

  console.log();
  console.log(`=== CONTRACT DEPLOYED ===`);
  console.log(`Account:   ${ACCOUNT_ID}`);
  console.log(`Explorer:  https://testnet.nearblocks.io/address/${ACCOUNT_ID}`);
  console.log(`Key saved: ~/.near-credentials/testnet/${ACCOUNT_ID}.json`);
  console.log(`Next:      node bouncer/demo.mjs`);
})().catch(e => { console.error(e); process.exit(1); });
