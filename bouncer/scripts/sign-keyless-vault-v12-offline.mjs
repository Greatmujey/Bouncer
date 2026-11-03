/** Offline V3/V12 signer. A fresh FINAL snapshot and the exact locked WASM
 * must already be present. The secret is never handed to CI. The journal is
 * durable before the signed bearer is exported; do not run a new signature
 * when an original is pending. */
import path from 'node:path';
import fs from 'node:fs';
import { exportTemporaryTestnetOwner } from '../agent/testnet-owner-local-keyring.mjs';
import { signAndJournalVaultBootstrap } from '../agent/keyless-vault-v12-journal.mjs';

const root = process.cwd(), absolute = rel => path.join(root, rel);
const plan = JSON.parse(fs.readFileSync(absolute('config/testnet-owner-v3-plan.json'), 'utf8'));
const privateDir = absolute('../.bouncer-private/owner-v3');
const paths = { primary: '/home/user/bouncer-private-v3/recovery.json', backup: '/home/user/bouncer-private-v3/recovery-copy.json',
  snapshot: path.join(privateDir, 'vault-v12-bootstrap-snapshot.json'),
  swapJournal: path.join(privateDir, 'acquisition-swap-journal.json'),
  journal: path.join(privateDir, 'vault-v12-bootstrap-journal.json'),
  evidence: absolute('evidence/testnet-owner-v3/vault-v12-bootstrap-original.json'),
  lock: path.join(privateDir, 'vault-v12-bootstrap.lock'),
  wasm: '/home/user/bouncer-tools/v12-review/bouncer-v12.wasm' };
if (process.argv.slice(2).some(x => x !== '--restore') || process.argv.slice(2).length > 1) throw new Error('invalid offline V12 signer options');
const restore = process.argv[2] === '--restore';
if (!restore) exportTemporaryTestnetOwner({ dir: privateDir, plan, primary: paths.primary, backup: paths.backup });
const result = await signAndJournalVaultBootstrap({ plan, paths, restore });
console.log(JSON.stringify(result, null, 2));
