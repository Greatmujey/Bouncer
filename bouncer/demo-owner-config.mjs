import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import nearApi from 'near-api-js';
import crypto from 'node:crypto';

const DEFAULT_OWNER = 'great_mujey.testnet';
const NETWORK = 'testnet';

export function resolveDemoOwnerConfig({ env = process.env, home = os.homedir() } = {}) {
  const accountId = env.BOUNCER_OWNER_ACCOUNT || DEFAULT_OWNER;
  const credentialPath = path.join(home, '.near-credentials', NETWORK, `${accountId}.json`);
  if (!fs.existsSync(credentialPath)) {
    throw new Error(`No local NEAR testnet credential for ${accountId}; expected ${credentialPath}. Connect/sign with the owner wallet or install its private credential locally before running this demo.`);
  }

  let credentials;
  try { credentials = JSON.parse(fs.readFileSync(credentialPath, 'utf8')); }
  catch { throw new Error(`Could not read the local NEAR credential for ${accountId}`); }
  if (credentials?.account_id !== accountId || typeof credentials.private_key !== 'string') {
    throw new Error(`The local NEAR credential does not match ${accountId}`);
  }

  let keyPair;
  try { keyPair = nearApi.KeyPair.fromString(credentials.private_key); }
  catch { throw new Error(`The local NEAR credential for ${accountId} has an invalid private key`); }

  return {
    accountId,
    keyPair,
    contractAccountId: `bouncer-${crypto.randomBytes(3).toString('hex')}.${accountId}`,
  };
}
