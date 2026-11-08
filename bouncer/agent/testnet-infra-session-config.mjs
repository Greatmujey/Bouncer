/** Strict configuration for a single short-lived, infrastructure-only
 * testnet session. This module never connects to a wallet or sends a NEAR tx. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import tls from 'node:tls';

const names = ['coordinator','checkpoint'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key=>Object.hasOwn(value,key));
function publicKey(value) {
  if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw Error('invalid session public key');
  const bytes = Buffer.from(value,'base64');
  if (bytes.toString('base64') !== value) throw Error('invalid session public key');
  const key = crypto.createPublicKey({key:bytes,format:'der',type:'spki'});
  if (key.asymmetricKeyType !== 'x25519') throw Error('invalid session public key');
  return key;
}
export function validateTestnetInfraConfig(value,runId) {
  if (!exact(value,['version','run_id','mode','projects','session_public_keys']) || value.version !== 1 ||
      value.run_id !== runId || !/^[1-9][0-9]{0,19}$/.test(runId ?? '') || value.mode !== 'provision-only' ||
      !exact(value.projects,names) || !exact(value.session_public_keys,names)) throw Error('invalid testnet infrastructure configuration');
  for (const role of names) {
    const p=value.projects[role];
    if (!exact(p,['ref','region']) || !/^[a-z]{20}$/.test(p.ref ?? '') ||
        p.region !== (role === 'coordinator' ? 'us-east-1' : 'us-west-1')) throw Error('invalid testnet project');
    publicKey(value.session_public_keys[role]);
  }
  if (value.projects.coordinator.ref === value.projects.checkpoint.ref ||
      value.session_public_keys.coordinator === value.session_public_keys.checkpoint) throw Error('testnet projects and keys must be distinct');
  return structuredClone(value);
}
export function testnetPoolerHosts(role,config) {
  const c=validateTestnetInfraConfig(config,config?.run_id);
  if (!names.includes(role)) throw Error('invalid infrastructure role');
  const region=c.projects[role].region;
  // These are fixed Supabase pooler domains, never a browser-provided URL.
  return [`aws-0-${region}.pooler.supabase.com`,`aws-1-${region}.pooler.supabase.com`];
}
/** The Supabase shared pooler's public root is not in Node's default trust
 * store. Add its fingerprint-pinned public CA without disabling verification
 * or hostname checks. This is used only for our fixed pooler hosts. */
export function testnetPoolerSsl() {
  const pem=fs.readFileSync(new URL('../infrastructure/supabase-root-2021.pem',import.meta.url),'utf8');
  const root=new crypto.X509Certificate(pem);
  const fingerprint='807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA';
  if(root.fingerprint256.replaceAll(':','')!==fingerprint || root.ca!==true ||
      Date.now()<Date.parse(root.validFrom) || Date.now()>=Date.parse(root.validTo)) throw Error('untrusted Supabase public root');
  return {rejectUnauthorized:true,ca:[...tls.rootCertificates,pem]};
}
export function deriveTestnetCheckpointToken({role,config,privateKey}) {
  const c=validateTestnetInfraConfig(config,config?.run_id);
  if (!names.includes(role)) throw Error('invalid infrastructure role');
  const own=crypto.createPrivateKey(privateKey);
  if (own.asymmetricKeyType !== 'x25519' ||
      crypto.createPublicKey(own).export({type:'spki',format:'der'}).toString('base64') !== c.session_public_keys[role]) {
    throw Error('session key does not match the run');
  }
  const peer=publicKey(c.session_public_keys[role === 'coordinator' ? 'checkpoint' : 'coordinator']);
  const shared=crypto.diffieHellman({privateKey:own,publicKey:peer});
  try {
    return Buffer.from(crypto.hkdfSync('sha256',shared,Buffer.from(`bouncer-testnet-session:${c.run_id}`),
      Buffer.from('independent-checkpoint-token-v1'),32)).toString('base64url');
  } finally { shared.fill(0); }
}
