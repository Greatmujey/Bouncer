import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import nearApi from 'near-api-js';
import { buildNativeOracleTrialBytes,decodeNativeHash32,encodeBase58 } from '../web-src/native-oracle-transaction.mjs';

const signers=['a.testnet','alice.testnet','long-account-name.testnet'];
test('browser Borsh bytes match the NEAR SDK across blocks, Ed25519 keys, nonces and caps',()=>{
  for(let i=0;i<40;i++){
    const bytes=i===0?Buffer.alloc(32):randomBytes(32),keyBytes=i===1?Buffer.alloc(32):randomBytes(32);
    const owner=signers[i%signers.length],publicKey=`ed25519:${nearApi.utils.serialize.base_encode(keyBytes)}`;
    const review={owner,vault:`native.${owner}`,agent_public_key:publicKey,policy_id:`price_${i}`,
      per_tx_cap_yocto:String(1n+BigInt(i)*1000n),project:{project_id:'x.testnet/example',version_key:'abc',input_data:'{}',
        max_instructions:400000000000,max_memory_mb:512,max_execution_seconds:15}};
    const current=i===39?BigInt(Number.MAX_SAFE_INTEGER)-1n:BigInt(i*i);
    const completion={block_hash:nearApi.utils.serialize.base_encode(bytes),agent_key_nonce:String(current)};
    const actual=buildNativeOracleTrialBytes(review,completion);
    const args={policy_id:review.policy_id,amount:review.per_tx_cap_yocto,
      expected_route:{project:review.project,route_revision:1,policy_revision:1,payee_revision:1,active:true}};
    const expected=nearApi.transactions.createTransaction(owner,nearApi.utils.PublicKey.from(publicKey),review.vault,current+1n,
      [nearApi.transactions.functionCall('execute_outlayer_native_project',args,300n*10n**12n,0n)],bytes);
    assert.deepEqual(Buffer.from(actual.unsigned),Buffer.from(nearApi.transactions.encodeTransaction(expected)));
    assert.equal(actual.nonce,String(current+1n));assert.deepEqual(Buffer.from(decodeNativeHash32(completion.block_hash)),bytes);
    assert.equal(encodeBase58(bytes),completion.block_hash);
  }
});

test('codec rejects malformed block hashes, public keys and unsafe or ambiguous nonces',()=>{
  const goodHash=nearApi.utils.serialize.base_encode(Buffer.alloc(32,1));
  const goodReview={owner:'a.testnet',vault:'native.a.testnet',agent_public_key:`ed25519:${goodHash}`,policy_id:'p',per_tx_cap_yocto:'1',project:{}};
  const goodCompletion={block_hash:goodHash,agent_key_nonce:'0'};
  for(const block_hash of ['','0'.repeat(32),'1'.repeat(31),'1'.repeat(33),'z'.repeat(44)])
    assert.throws(()=>buildNativeOracleTrialBytes(goodReview,{...goodCompletion,block_hash}));
  for(const agent_key_nonce of ['-1','01','1.0','1e3',String(Number.MAX_SAFE_INTEGER),'18446744073709551615'])
    assert.throws(()=>buildNativeOracleTrialBytes(goodReview,{...goodCompletion,agent_key_nonce}));
  for(const agent_public_key of ['ed25519:nope','secp256k1:'+goodHash,'ed25519:'+'1'.repeat(33)])
    assert.throws(()=>buildNativeOracleTrialBytes({...goodReview,agent_public_key},goodCompletion));
});
