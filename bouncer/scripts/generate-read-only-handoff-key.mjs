/** Temporary runner handoff public key; not a NEAR key or a signer. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const temp = process.env.RUNNER_TEMP;
if (!temp) throw Error('runner temporary directory required');
const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
fs.writeFileSync(path.join(temp, 'bouncer-read-only-handoff-private.pem'),
  pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
const der = pair.publicKey.export({ type: 'spki', format: 'der' });
console.log(`::notice title=BOUNCER_READ_ONLY_SESSION_PUBLIC_KEY::${der.toString('base64')}`);
