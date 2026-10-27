// Redeploy: upgrade an already-deployed bouncer contract with a freshly-built bouncer.wasm,
// re-initialize it, then run the demo. Uses the account id saved by deploy.mjs in ~/.bouncer_id.
//
// Run from ANY directory in the repo:  node bouncer/redeploy.mjs
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

console.log(`Redeploying bouncer.wasm (${WASM.length} bytes) to ${ID}\n`);

const dtx = await me.deployContract(WASM);
console.log(`✅ deploy tx: ${dtx.transaction_outcome.id}`);

const itx = await me.functionCall({
  contractId: ID, methodName: 'new', args: { owner: ID },
  attachedDeposit: BigInt(0), gas: BigInt('100000000000000'),
});
console.log(`✅ init tx:   ${itx.transaction_outcome.id}`);

console.log(`\n=== Redeploy complete. Now run: node bouncer/demo.mjs ===`);
