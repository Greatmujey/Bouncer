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
const publicKey = der.toString('base64url'), split = Math.ceil(publicKey.length / 2);
if (!process.env.GITHUB_OUTPUT || split > 220 || publicKey.length - split > 220) throw Error('workflow output unavailable');
fs.writeFileSync(path.join(temp, 'bouncer-read-only-handoff-public.txt'), publicKey + '\n', { mode: 0o644, flag: 'wx' });
fs.appendFileSync(process.env.GITHUB_OUTPUT, `part1=${publicKey.slice(0, split)}\npart2=${publicKey.slice(split)}\n`);
console.log('One-use public key ready; no wallet key is involved.');
