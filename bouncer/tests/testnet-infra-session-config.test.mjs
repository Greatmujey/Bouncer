import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { validateTestnetInfraConfig,testnetPoolerHosts,deriveTestnetCheckpointToken } from '../agent/testnet-infra-session-config.mjs';

function pair(){const keys=crypto.generateKeyPairSync('x25519');return {privateKey:keys.privateKey.export({type:'pkcs8',format:'pem'}),
  publicKey:keys.publicKey.export({type:'spki',format:'der'}).toString('base64')}}
function setup(){const a=pair(),b=pair();return {a,b,config:{version:1,run_id:'1234',mode:'provision-only',
  projects:{coordinator:{ref:'abcdefghijklmnopqrst',region:'us-east-1'},checkpoint:{ref:'bcdefghijklmnopqrstu',region:'us-west-1'}},
  session_public_keys:{coordinator:a.publicKey,checkpoint:b.publicKey}}}}

test('separate session keys derive one shared token without exposing either database credential',()=>{
  const {a,b,config}=setup();
  const x=deriveTestnetCheckpointToken({role:'coordinator',config,privateKey:a.privateKey});
  const y=deriveTestnetCheckpointToken({role:'checkpoint',config,privateKey:b.privateKey});
  assert.match(x,/^[A-Za-z0-9_-]{43}$/);assert.equal(x,y);
  assert.deepEqual(testnetPoolerHosts('coordinator',config),['aws-0-us-east-1.pooler.supabase.com','aws-1-us-east-1.pooler.supabase.com']);
  assert.notEqual(x,deriveTestnetCheckpointToken({role:'coordinator',config:{...config,run_id:'1235'},privateKey:a.privateKey}));
});

test('configuration fails closed for wrong run, shared databases, extra fields and mismatched keys',()=>{
  const {a,b,config}=setup();
  assert.throws(()=>validateTestnetInfraConfig(config,'2'));
  assert.throws(()=>validateTestnetInfraConfig({...config,extra:true},'1234'));
  assert.throws(()=>validateTestnetInfraConfig({...config,mode:'spend'},'1234'));
  assert.throws(()=>validateTestnetInfraConfig({...config,projects:{...config.projects,checkpoint:config.projects.coordinator}},'1234'));
  assert.throws(()=>deriveTestnetCheckpointToken({role:'coordinator',config,privateKey:b.privateKey}));
  assert.throws(()=>deriveTestnetCheckpointToken({role:'unknown',config,privateKey:a.privateKey}));
});
