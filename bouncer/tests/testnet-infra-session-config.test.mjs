import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { validateTestnetInfraConfig,testnetPoolerHosts,testnetPoolerSsl,deriveTestnetCheckpointToken } from '../agent/testnet-infra-session-config.mjs';

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

test('the Supabase pooler uses a pinned public CA with certificate and hostname verification enabled',()=>{
  const options=testnetPoolerSsl();
  assert.equal(options.rejectUnauthorized,true);
  assert.equal(options.checkServerIdentity,undefined);
  assert.ok(options.ca.length>1);
  const root=new crypto.X509Certificate(options.ca.at(-1));
  assert.equal(root.fingerprint256.replaceAll(':',''),'807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA');
});

test('explicit resume requires a previous run and a pinned baseline',()=>{
  const {config}=setup();
  const resumed={...config,mode:'resume-only',resume_from:{run_id:'1233',initial_head:'a'.repeat(40)}};
  assert.deepEqual(validateTestnetInfraConfig(resumed,'1234'),resumed);
  assert.throws(()=>validateTestnetInfraConfig({...resumed,resume_from:{...resumed.resume_from,run_id:'1234'}},'1234'));
  assert.throws(()=>validateTestnetInfraConfig({...resumed,resume_from:{...resumed.resume_from,initial_head:'invalid'}},'1234'));
  assert.throws(()=>validateTestnetInfraConfig({...config,mode:'resume-only'},'1234'));
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
