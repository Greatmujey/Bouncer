#!/usr/bin/env node
/** Generate new locally held agent keys only. The wallet must still install
 * their exact narrow access-key permissions and policy grants separately. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { assertPrivateParent, readConfiguredMission } from '../agent/configured-native-mission-site.mjs';

export function initializeNativeAgentKeys({missionFile,agentFile}={}) {
  const mission=readConfiguredMission(missionFile);assertPrivateParent(agentFile);
  const keys=Object.create(null),publicKeys=Object.create(null),seen=new Set();let bytes,fd,dirFd,created=false;
  try {
    for(const {kind,goal} of mission.goals) {
      const pair=nearApi.KeyPair.fromRandom('ed25519'),publicKey=String(pair.getPublicKey());
      if(seen.has(publicKey))throw new Error('duplicate generated public key');seen.add(publicKey);
      const method={random:'execute_outlayer',market:'execute_outlayer',oracle:'execute_outlayer_native_project',storage:'execute_native_storage'}[kind];
      keys[goal.id]=pair.toString();publicKeys[goal.id]={kind,public_key:publicKey,receiver_id:mission.contract_id,method_name:method,
        max_gas_allowance_yocto:'1000000000000000000000000'};
    }
    bytes=Buffer.from(`${JSON.stringify({format:'bouncer-restricted-agent-keys-v1',owner_account_id:mission.owner_account_id,keys})}\n`);
    dirFd=fs.openSync(path.dirname(agentFile),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const before=fs.fstatSync(dirFd),named=fs.lstatSync(path.dirname(agentFile));
    if(before.dev!==named.dev||before.ino!==named.ino)throw new Error('agent key directory changed');
    fd=fs.openSync(agentFile,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    created=true;fs.fchmodSync(fd,0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    const after=fs.lstatSync(path.dirname(agentFile));if(before.dev!==after.dev||before.ino!==after.ino)throw new Error('agent key directory changed');
    fs.fsyncSync(dirFd);
    return {status:'AGENT_KEYS_CREATED_NOT_INSTALLED',network:'testnet',owner:mission.owner_account_id,vault:mission.contract_id,
      public_keys:publicKeys,transactions_sent:0};
  } catch(error) {
    if(created)throw new Error('agent key creation was uncertain; preserve and inspect the original file before continuing');
    if(error.code==='EEXIST')throw new Error('agent key path already exists; refusing to overwrite it');
    throw error;
  } finally {bytes?.fill(0);for(const id of Object.keys(keys))delete keys[id];if(fd!==undefined)fs.closeSync(fd);if(dirFd!==undefined)fs.closeSync(dirFd)}
}
const USAGE=`Usage: node scripts/init-native-mission-agent-keys.mjs --confirm-new-agent-keys

Generates a new distinct testnet agent key for each goal, in an exclusive
owner-only file, and prints PUBLIC keys only. No wallet key is read or created.
A wallet owner must separately approve installing each public key with the
single required vault method, bounded gas allowance and matching policy grant.
Until then these keys authorize nothing. Never overwrite an existing key file.
Required environment: BOUNCER_NATIVE_MISSION_FILE and
BOUNCER_NATIVE_MISSION_AGENT_KEYS_FILE. Paths must be in private directories.
No network request, wallet prompt or transaction is made.
`;
function main() {
  if(process.argv.length===3&&process.argv[2]==='--help'){console.log(USAGE);return}
  if(process.argv.length!==3||process.argv[2]!=='--confirm-new-agent-keys')throw new Error('explicit confirmation is required');
  const result=initializeNativeAgentKeys({missionFile:process.env.BOUNCER_NATIVE_MISSION_FILE,agentFile:process.env.BOUNCER_NATIVE_MISSION_AGENT_KEYS_FILE});
  console.log(JSON.stringify(result,null,2));
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  try{main()}catch(error){console.error(`[mission-agent-keys] ${error.message}`);process.exitCode=1}
}
