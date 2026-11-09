// Shared synthetic public plan fixture. It never signs, sends or calls a chain.
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import nearApi from 'near-api-js';
import {ORACLE_TESTNET_PROJECT} from '../agent/oracle-outlayer.mjs';
import {buildV14PhoneResearchPlan} from '../agent/native-v14-phone-plan.mjs';
import {deriveV14OriginalBinding} from '../agent/v14-original-witness.mjs';

export const scope='3'.repeat(32),owner='owner.testnet',vault=`native.${owner}`;
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const key=()=>String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
export function fixture() {
  const wasm=Buffer.concat([Buffer.from([0,97,115,109,1,0,0,0]),Buffer.from('bouncer-agent-v14-native-storage-testnet synthetic')]);
  const loader=Buffer.concat([Buffer.from([0,97,115,109,1,0,0,0]),Buffer.from('synthetic loader')]);
  const codeHash=nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(wasm).digest());
  const mission={version:1,id:'witness-test',contract_id:vault,owner_account_id:owner,max_native_amount:'300',
    required_resources:['compute','api','storage'],goals:[
      {kind:'random',goal:{id:'compute',contract_id:vault,owner_account_id:owner,policy_id:'compute',amount:'100',input:{min:1,max:100},
        program:{url:'https://example.test/random.wasm',sha256:'a'.repeat(64),build_target:'wasm32-wasip1',max_instructions:10000000,max_memory_mb:128,max_execution_seconds:60}}},
      {kind:'oracle',goal:{id:'price',contract_id:vault,owner_account_id:owner,policy_id:'price',amount:'100',
        route:{project:{...ORACLE_TESTNET_PROJECT},route_revision:1,policy_revision:1,payee_revision:1,active:true},max_age_seconds:300}},
      {kind:'storage',goal:{id:'store',contract_id:vault,owner_account_id:owner,contract_code_hash:codeHash,policy_id:'store',amount:'100',
        object_id:'mission-results',value:{from_goal_ids:['compute','price']},route:{prefix:'mission-',max_value_bytes:4096,
          route_revision:1,policy_revision:1,payee_revision:1,active:true}}},
    ]};
  const inputs={mission,ownerPublicKey:key(),agentPublicKeys:{compute:key(),price:key(),store:key()},
    gasAllowances:{compute:'500',price:'500',store:'500'},dailyCaps:{compute:'500',price:'500',store:'500'},
    vaultStorageFundingYocto:'600',nativeDepositYocto:'300',vaultWasm:wasm,loaderWasm:loader,compressed:zlib.deflateRawSync(wasm),
    trustedArtifacts:{vault_sha256:sha(wasm),loader_sha256:sha(loader)}};
  const review=buildV14PhoneResearchPlan(inputs).review;
  return {inputs,review,binding:deriveV14OriginalBinding({scopeId:scope,...inputs,review,trustedReviewSha256:review.review_sha256})};
}
