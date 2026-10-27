// one-shot deploy: creates a funded testnet account via the NEAR helper (faucet),
// deploys bouncer.wasm from the repo root, and initializes. No login or faucet website needed.
//
// Run from ANY directory in the repo:  node bouncer/deploy.mjs
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import nearApi from 'near-api-js';

// near-api-js v6 exports — providers live under `providers`, KeyPairSigner wraps a KeyPair
const { KeyPair, KeyPairSigner, keyStores, Account, providers } = nearApi;
const { JsonRpcProvider } = providers;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const NETWORK = 'testnet';
const RPC = 'https://rpc.testnet.near.org';
const HELPER = 'https://helper.testnet.near.org';
const WASM_PATH = path.join(REPO_ROOT, 'bouncer.wasm');

if (!fs.existsSync(WASM_PATH)) {
  console.error('bouncer.wasm not found at', WASM_PATH, '\nAre you running from the Bouncer repo?');
  process.exit(1);
}
const WASM = fs.readFileSync(WASM_PATH);

const suffix = crypto.randomBytes(3).toString('hex');
const ACCOUNT_ID = `bouncer-${suffix}.testnet`;
const keystore = new keyStores.InMemoryKeyStore();

async function helperCreate(accountId, publicKey) {
  const res = await fetch(`${HELPER}/account`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`helper ${res.status}: ${t.slice(0, 300)}`);
  }
  return res.json();
}

(async () => {
  console.log(`==> Creating funded testnet account: ${ACCOUNT_ID}`);
  const kp = KeyPair.fromRandom('ed25519');
  await keystore.setKey(NETWORK, ACCOUNT_ID, kp);
  const created = await helperCreate(ACCOUNT_ID, kp.getPublicKey().toString());
  console.log('    helper ok: tx', created?.transaction_outcome?.id || '(executed optimistically)');

  const provider = new JsonRpcProvider({ url: RPC });
  const signer = new KeyPairSigner(kp);
  const account = new Account(ACCOUNT_ID, provider, signer);

  console.log(`==> Deploying bouncer.wasm (${WASM.length} bytes)...`);
  const dtx = await account.deployContract(WASM);
  console.log('    deploy tx:', dtx.transaction_outcome.id);

  console.log(`==> Initializing new({owner:"${ACCOUNT_ID}"})...`);
  const itx = await account.functionCall({
    contractId: ACCOUNT_ID,
    methodName: 'new',
    args: { owner: ACCOUNT_ID },
    attachedDeposit: BigInt(0),
    gas: BigInt('100000000000000'),
  });
  console.log('    init tx:', itx.transaction_outcome.id);

  const bal = await account.viewFunction({
    contractId: ACCOUNT_ID,
    methodName: 'vault_balance',
    args: { token: 'usdc.fakes.testnet' },
  });
  console.log('    vault_balance(usdc):', bal);

  // save key to NEAR's standard credentials folder (works with `near` CLI too)
  const keyDir = path.join(os.homedir(), '.near-credentials', NETWORK);
  fs.mkdirSync(keyDir, { recursive: true });
  fs.writeFileSync(path.join(keyDir, `${ACCOUNT_ID}.json`), JSON.stringify({
    account_id: ACCOUNT_ID,
    public_key: kp.getPublicKey().toString(),
    private_key: kp.toString(),
  }, null, 2));
  fs.writeFileSync(path.join(os.homedir(), '.bouncer_id'), ACCOUNT_ID);

  console.log();
  console.log(`=== CONTRACT DEPLOYED ===`);
  console.log(`Account:   ${ACCOUNT_ID}`);
  console.log(`Explorer:  https://testnet.nearblocks.io/address/${ACCOUNT_ID}`);
  console.log(`Next:      node bouncer/demo.mjs`);
})().catch(e => {
  console.error('\n!!! DEPLOY FAILED !!!');
  console.error(e && e.message ? e.message : e);
  process.exit(1);
});
