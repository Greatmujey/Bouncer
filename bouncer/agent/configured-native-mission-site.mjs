/**
 * Explicit single-host testnet mission wiring. The host, filesystem, database
 * and RPC are trusted; none is an independent rollback/fork checkpoint. This
 * module never creates a journal, deploys a vault, prompts a wallet or sends
 * a transaction at startup. Execution remains owner-consent gated.
 */
import fs from 'node:fs';
import path from 'node:path';
import nearApi from 'near-api-js';
import pg from 'pg';
import { validateNativeMission } from './native-mission.mjs';
import { assertPinnedNativeStorageVault } from './native-storage.mjs';
import { FileJournal } from './procurement.mjs';
import { readFileJournalKeyFile } from './file-journal-crypto.mjs';
import { PaymentRpcProvider, MonotonicAccount } from './near-account.mjs';
import { ReadOnlyNearRpcProvider } from './read-only-near-rpc.mjs';
import { createPostgresWalletPromptAuth, inspectPostgresWalletPromptAuthSchema } from './postgres-wallet-prompt-auth.mjs';
import { createAuthenticatedNativeMissionService } from './authenticated-native-mission-service.mjs';
import { createNativeMissionSite } from './native-mission-site.mjs';
import { createRailwayNativeMissionBackend } from './native-mission-railway.mjs';
import { acquireRailwayNativeJournalFence } from './railway-native-journal-fence.mjs';
import { validateNativeProxySiteOrigin, validateRailwayNativeBackend, validateNativeProxySecret } from './native-mission-proxy.mjs';
import { validateSellerDatabaseUrl } from '../services/shared-resource-provider.mjs';

const MAX_KEY_ALLOWANCE=10n**24n;
const METHODS={random:'execute_outlayer',market:'execute_outlayer',oracle:'execute_outlayer_native_project',storage:'execute_native_storage'};
const keysEqual=(a,b)=>Array.isArray(a) && a.length===1 && a[0]===b;
const exact=(obj,fields)=>obj && Object.getPrototypeOf(obj)===Object.prototype && Object.keys(obj).length===fields.length && fields.every(x=>Object.hasOwn(obj,x));

/** Operator files must not be links, shared or replaceable by another user. */
export function assertPrivateParent(file) {
  if(typeof file!=='string' || !path.isAbsolute(file) || file.includes('\0'))throw new Error('an absolute private file path is required');
  const parent=path.dirname(file);let fd;
  try {
    fd=fs.openSync(parent,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const a=fs.fstatSync(fd),b=fs.lstatSync(parent);
    const privateDir=s=>s.isDirectory() && (s.mode&0o700)===0o700 && (s.mode&0o077)===0 &&
      (typeof process.getuid!=='function'||s.uid===process.getuid());
    if(!privateDir(a)||!privateDir(b)||a.dev!==b.dev||a.ino!==b.ino)throw new Error();
  } catch {throw new Error('file parent must be an existing owner-only 0700 directory');}
  finally {if(fd!==undefined)fs.closeSync(fd)}
}
function readJsonFile(file,{secret=false,max=65536}={}) {
  assertPrivateParent(file);let fd,bytes;
  try {
    fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.nlink!==1||stat.size<2||stat.size>max||
        (secret?(stat.mode&0o077)!==0:(stat.mode&0o022)!==0)||
        (typeof process.getuid==='function'&&stat.uid!==process.getuid()))throw new Error();
    bytes=fs.readFileSync(fd);if(bytes.length!==stat.size)throw new Error();
    return JSON.parse(bytes.toString('utf8'));
  } catch {throw new Error(secret?'restricted agent keys are unavailable or not private':'mission file is unavailable or unsafe');}
  finally {bytes?.fill(0);if(fd!==undefined)fs.closeSync(fd)}
}
export function readConfiguredMission(file) {return validateNativeMission(readJsonFile(file));}

/** Railway supplies this mount path only when a volume is attached. Require
 * the original, key and reviewed inputs to resolve inside that declared
 * volume. This detects common ephemeral-path mistakes, not rollback, a forged
 * environment, volume loss or whether the provider's storage is durable. */
export function assertRailwayNativeVolume({mountPath, files} = {}) {
  if (typeof mountPath !== 'string' || !path.isAbsolute(mountPath) || mountPath === '/' ||
      !Array.isArray(files) || files.length < 3) throw new Error('a Railway persistent volume and all original paths are required');
  let root;
  try {
    const stat = fs.lstatSync(mountPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error();
    root = fs.realpathSync(mountPath);
    if (root === '/') throw Error();
    for (const file of files) {
      if (typeof file !== 'string' || !path.isAbsolute(file)) throw Error();
      const parent = fs.realpathSync(path.dirname(file)), relative = path.relative(root, parent);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Error();
      assertPrivateParent(file);
    }
  } catch { throw new Error('original journal, key and mission must live inside the declared Railway volume'); }
}

/** Never accept signers from HTTP. Only a private operator file is supported. */
export function readConfiguredNativeSigners(file,mission,provider) {
  const stored=readJsonFile(file,{secret:true});
  if(!exact(stored,['format','owner_account_id','keys'])||stored.format!=='bouncer-restricted-agent-keys-v1'||
      stored.owner_account_id!==mission.owner_account_id||!stored.keys||Object.getPrototypeOf(stored.keys)!==Object.prototype||
      Object.keys(stored.keys).length!==mission.goals.length||
      mission.goals.some(({goal})=>!Object.hasOwn(stored.keys,goal.id)))throw new Error('restricted agent key file does not match the fixed mission');
  const signers=Object.create(null),seen=new Set();
  try {
    for(const {goal} of mission.goals) {
      const secret=stored.keys[goal.id];delete stored.keys[goal.id];
      if(typeof secret!=='string'||!secret.startsWith('ed25519:')||secret.length>128)throw new Error();
      const pair=nearApi.KeyPair.fromString(secret),publicKey=pair.getPublicKey(),id=String(publicKey);
      if(!id.startsWith('ed25519:')||seen.has(id))throw new Error();seen.add(id);
      signers[goal.id]={account:new MonotonicAccount(mission.owner_account_id,provider,new nearApi.KeyPairSigner(pair)),publicKey};
    }
  } catch {throw new Error('restricted agent keys are invalid or reused');}
  return signers;
}

/** Read-only startup guard; runners repeat key, vault and policy checks before
 * every payment. Views are trusted-RPC snapshots, not atomic guarantees. */
export async function inspectConfiguredNativeSigners({mission,provider,signers}) {
  if((await provider.viewNodeStatus())?.chain_id!=='testnet')throw new Error('testnet RPC is required');
  const storage=mission.goals.find(item=>item.kind==='storage');
  if(!storage)throw new Error('pinned native storage vault is required');
  const final={finality:'final'};
  await assertPinnedNativeStorageVault(provider,storage.goal,final);
  const [version,owner]=await Promise.all([
    provider.callFunction(mission.contract_id,'contract_version',{},final),
    provider.callFunction(mission.contract_id,'get_owner',{},final),
  ]);
  if(version!=='bouncer-agent-v14-native-storage-testnet'||owner!==mission.owner_account_id)throw new Error('reviewed V14 vault or owner differs');
  for(const {kind,goal} of mission.goals) {
    const signer=signers[goal.id];
    if(!signer||signer.account?.accountId!==mission.owner_account_id||!signer.publicKey)throw new Error('restricted agent signer is missing');
    const permission=(await provider.viewAccessKey(mission.owner_account_id,signer.publicKey,final))?.permission?.FunctionCall;
    const allowance=permission?.allowance;
    if(permission?.receiver_id!==mission.contract_id||!keysEqual(permission.method_names,METHODS[kind])||
        typeof allowance!=='string'||!/^[1-9][0-9]{0,24}$/.test(allowance)||BigInt(allowance)>MAX_KEY_ALLOWANCE) {
      throw new Error('agent access key is not restricted to its reviewed method, vault and bounded allowance');
    }
  }
  return {status:'RESTRICTED_SIGNERS_CHECKED',transactions_sent:0};
}

/** Track server-side work even after a browser disconnects. On shutdown, stop
 * accepting new operations and wait for already-started work before closing
 * the original journal or database. This cannot prevent a forced process kill. */
export function trackNativeMissionWork(service) {
  const active=new Set();let stopping=false;
  const wrapped={getReview:()=>service.getReview()};
  for(const name of ['preview','issue','execute','originals','recover'])wrapped[name]=input=>{
    if(stopping)return Promise.reject(new Error('server is stopping'));
    const work=Promise.resolve().then(()=>service[name](input));active.add(work);
    void work.finally(()=>active.delete(work)).catch(()=>{});return work;
  };
  return {service:wrapped,stop(){stopping=true},async drain(){while(active.size)await Promise.allSettled([...active])}};
}

/** Wire a previously created encrypted journal and (for execution) preinstalled
 * restricted keys to one fixed-origin server. No new database schema or
 * journal is initialized here. Recovery mode needs no signer or database. */
export async function configureNativeMissionSite({env=process.env}={}) {
  if(env.BOUNCER_NATIVE_MISSION_ENABLED!=='1'||!['execute','recover'].includes(env.BOUNCER_NATIVE_MISSION_MODE)) {
    throw new Error('explicit testnet mission enablement and mode are required');
  }
  if(env.NODE_TLS_REJECT_UNAUTHORIZED==='0')throw new Error('TLS certificate validation cannot be disabled');
  const ingress=env.BOUNCER_NATIVE_MISSION_INGRESS || 'same-origin';
  if(!['same-origin','railway-proxy'].includes(ingress))throw new Error('invalid native mission ingress');
  const siteOrigin=env.BOUNCER_WALLET_ORIGIN;
  if(ingress==='railway-proxy') {
    validateNativeProxySiteOrigin(siteOrigin);
    validateRailwayNativeBackend(env.BOUNCER_NATIVE_MISSION_BACKEND_ORIGIN);
    validateNativeProxySecret(env.BOUNCER_NATIVE_MISSION_PROXY_SECRET);
    assertRailwayNativeVolume({mountPath:env.RAILWAY_VOLUME_MOUNT_PATH,files:[env.BOUNCER_NATIVE_MISSION_FILE,
      env.BOUNCER_NATIVE_MISSION_JOURNAL_FILE,env.BOUNCER_FILE_JOURNAL_KEY_FILE,
      ...(env.BOUNCER_NATIVE_MISSION_MODE==='execute'?[env.BOUNCER_NATIVE_MISSION_AGENT_KEYS_FILE]:[])]});
  } else if(env.BOUNCER_NATIVE_MISSION_BACKEND_ORIGIN || env.BOUNCER_NATIVE_MISSION_PROXY_SECRET) {
    throw new Error('Railway proxy settings require explicit railway-proxy ingress');
  }
  const mission=readConfiguredMission(env.BOUNCER_NATIVE_MISSION_FILE);
  assertPrivateParent(env.BOUNCER_NATIVE_MISSION_JOURNAL_FILE);
  assertPrivateParent(env.BOUNCER_FILE_JOURNAL_KEY_FILE);
  const provider=new PaymentRpcProvider(env.BOUNCER_TESTNET_RPC_URL);
  if((await provider.viewNodeStatus())?.chain_id!=='testnet')throw new Error('testnet RPC is required');
  let journal,pool,server,key,hostFence;
  try {
    if(ingress==='railway-proxy') {
      hostFence=acquireRailwayNativeJournalFence({journalFile:env.BOUNCER_NATIVE_MISSION_JOURNAL_FILE,
        mode:env.BOUNCER_NATIVE_MISSION_MODE});
      // A completed recovery-start marker alone does not protect against a
      // restored/second volume. The research checkpoint is not wired into the
      // runners or browser setup yet; never let a configuration toggle bypass
      // the missing independent original fence on the hosted backend.
      if(env.BOUNCER_NATIVE_MISSION_MODE==='execute') {
        throw new Error('hosted execution remains disabled until the independent V14 original checkpoint is fully wired and recovery-tested');
      }
    }
    key=readFileJournalKeyFile(env.BOUNCER_FILE_JOURNAL_KEY_FILE);
    journal=new FileJournal(env.BOUNCER_NATIVE_MISSION_JOURNAL_FILE,mission.contract_id,mission.owner_account_id,
      {encryptionKey:key,keyFile:env.BOUNCER_FILE_JOURNAL_KEY_FILE,requireExisting:true});
    hostFence?.mark(journal);
    key.fill(0);key=null;
    if(hostFence) {
      const ids=new Set([`native-mission:${mission.id}`,...mission.goals.map(({goal})=>goal.id)]);
      const entries=journal.list();
      if(!entries.some(entry=>entry.id===`native-mission:${mission.id}`) || entries.some(entry=>!ids.has(entry.id))) {
        throw new Error('a dedicated original mission journal is required; stop and reconcile');
      }
    }
    let signers,auth;
    if(env.BOUNCER_NATIVE_MISSION_MODE==='execute') {
      signers=readConfiguredNativeSigners(env.BOUNCER_NATIVE_MISSION_AGENT_KEYS_FILE,mission,provider);
      await inspectConfiguredNativeSigners({mission,provider,signers});
      const url=validateSellerDatabaseUrl(env.BOUNCER_NATIVE_MISSION_AUTH_DATABASE_URL);
      pool=new pg.Pool({connectionString:url,max:6,connectionTimeoutMillis:5000,idleTimeoutMillis:30000});
      pool.on('error',()=>{});
      await inspectPostgresWalletPromptAuthSchema({pool});
      auth=createPostgresWalletPromptAuth({pool,origin:siteOrigin,provider:new ReadOnlyNearRpcProvider(env.BOUNCER_TESTNET_RPC_URL)});
    }
    const service=createAuthenticatedNativeMissionService({mission,provider,signers,journal,auth});
    // Validate the retained manifest and known originals before serving even a
    // read-only request. This does not replace live original-hash recovery.
    if(hostFence) await service.originals({missionSha256:service.getReview().mission_sha256});
    const guardedService=hostFence ? {...service,async originals(input) {
      const result=await service.originals(input);
      if(env.BOUNCER_NATIVE_MISSION_MODE==='recover')hostFence.recordRecoveryStart();
      return result;
    },async recover(input) {
      const result=await service.recover(input);
      if(hostFence.recoveryRequired) hostFence.completeRecovery({result,originals:await service.originals(input)});
      if(env.BOUNCER_NATIVE_MISSION_MODE==='recover')hostFence.recordRecoveryStart();
      return result;
    }} : service;
    // A disconnect does not cancel server-side work. Track each service call
    // so a graceful shutdown never closes the original journal during a send.
    const tracking=trackNativeMissionWork(guardedService);
    server=ingress==='railway-proxy'
      ? createRailwayNativeMissionBackend({siteOrigin,backendOrigin:env.BOUNCER_NATIVE_MISSION_BACKEND_ORIGIN,
        proxySecret:env.BOUNCER_NATIVE_MISSION_PROXY_SECRET,service:tracking.service})
      : createNativeMissionSite({siteOrigin,service:tracking.service,walletConnectProjectId:env.BOUNCER_WALLETCONNECT_PROJECT_ID||'',
        googleClientId:env.BOUNCER_GOOGLE_CLIENT_ID||''});
    let closed;
    return {server,mode:env.BOUNCER_NATIVE_MISSION_MODE,ingress,async close(){
      if(!closed)closed=(async()=>{
        tracking.stop();
        if(server.listening)await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
        await tracking.drain();
        try {journal.close()} finally {hostFence?.close();if(pool)await pool.end()}
      })();
      return closed;
    }};
  } catch(error) {
    key?.fill(0);if(server?.listening)server.close();
    try {journal?.close()} finally {hostFence?.close();if(pool)await pool.end()}
    throw error;
  }
}
