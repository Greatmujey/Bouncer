/** READ ONLY: inspect the original signed V3/V12 transaction by hash and
 * verify the fresh keyless vault state. This script never signs or sends. */
import fs from 'node:fs';
import path from 'node:path';
import { ExperimentalSvalinSetupRpc } from '../agent/svalin-setup-rpc.mjs';
import { reconcileVaultBootstrap } from '../agent/keyless-vault-v12-runner.mjs';
const read = rel => JSON.parse(fs.readFileSync(path.join(process.cwd(), rel), 'utf8'));
const plan = read('config/testnet-owner-v3-plan.json');
const envelope = read('evidence/testnet-owner-v3/vault-v12-bootstrap-original.json');
const provider = new ExperimentalSvalinSetupRpc('https://test.rpc.fastnear.com');
const result = await reconcileVaultBootstrap({ plan, envelope, provider });
console.log(JSON.stringify({ ...result, reconciliation_only: true, sent: false, signed: false }, null, 2));
