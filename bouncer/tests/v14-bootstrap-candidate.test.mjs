import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash,webcrypto} from 'node:crypto';
import {KeyPair} from '@near-js/crypto';
import {createV14BootstrapCandidate,verifyV14BootstrapCandidate} from '../web-src/v14-bootstrap-candidate.mjs';
import {openV14BootstrapRecoveryKit} from '../web-src/v14-bootstrap-recovery-kit.mjs';
import {loadV14BootstrapArtifact} from '../web-src/v14-bootstrap-artifact-client.mjs';

const crypto=webcrypto,owner='great_mujey.testnet',vault=`native.${owner}`;
const ownerKey=KeyPair.fromRandom('ed25519'),ownerPublicKey=String(ownerKey.getPublicKey());
const passphrase='synthetic only long recovery passphrase',vaultFundingYocto=String(6n*10n**24n);
const compressedV14=new Uint8Array(fs.readFileSync(new URL('../web/artifacts/v14-research.deflate',import.meta.url)));
const input={owner,ownerPublicKey,vault,vaultFundingYocto,compressedV14,passphrase,crypto};
const fingerprint=text=>createHash('sha256').update(`bouncer-v14-local-bootstrap-candidate-file-v1\0${text}`).digest('hex');
test('the non-executable lazy browser asset is bounded, canonical, digest checked, and fetched without credentials',async()=>{
  const text=fs.readFileSync(new URL('../web/v14-bootstrap-artifact-v1.json',import.meta.url),'utf8');
  let calls=0;
  const fetch=async(url,options)=>{
    calls++;assert.equal(url,'/v14-bootstrap-artifact-v1.json');assert.equal(options.method,'GET');
    assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.referrerPolicy,'no-referrer');
    return new Response(text,{status:200,headers:{'content-type':'application/json'}});
  };
  const bytes=await loadV14BootstrapArtifact({fetch,crypto});
  assert.equal(calls,1);assert.deepEqual(bytes,compressedV14);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),'e4b128d84ff0a0a5ca24616948585c4b422802d42b86939946f8189facd0dfae');
  const bad=JSON.parse(text);bad.base64=(bad.base64[0]==='A'?'B':'A')+bad.base64.slice(1);
  for(const response of [new Response(JSON.stringify(bad)),new Response(`${text}\n`),
    new Response(text+'x'.repeat(1000)),new Response(text,{headers:{'content-length':'9999999'}}),new Response(null,{status:503})]) {
    await assert.rejects(loadV14BootstrapArtifact({fetch:async()=>response,crypto}),/no transaction is authorized/);
  }
  await assert.rejects(loadV14BootstrapArtifact({crypto,timeoutMs:10,fetch:(_url,{signal})=>new Promise((_,reject)=>{
    signal.addEventListener('abort',()=>reject(new Error('synthetic timeout')),{once:true});
  })}),/no transaction is authorized/);
});
const verify=(candidate,overrides={})=>verifyV14BootstrapCandidate({text:candidate.text,expectedFingerprint:candidate.fingerprint,
  owner,vault,vaultFundingYocto,currentOwnerPublicKey:ownerPublicKey,compressedV14,passphrase,crypto,...overrides});

test('fresh local candidates contain only an encrypted key, bind the pinned plan, and reopen with the separately recorded file ID',async()=>{
  const candidate=await createV14BootstrapCandidate(input),other=await createV14BootstrapCandidate(input);
  assert.match(candidate.fingerprint,/^[a-f0-9]{64}$/);
  assert.equal(candidate.fingerprint,fingerprint(candidate.text));
  assert.notEqual(candidate.fingerprint,other.fingerprint);
  assert.notEqual(candidate.temporary_public_key,other.temporary_public_key);
  assert.equal(candidate.owner,owner);assert.equal(candidate.vault,vault);
  assert.equal(candidate.owner_public_key,ownerPublicKey);
  assert.equal(candidate.vault_wasm_sha256,'28dcba2d3a4dde6e48c2dc728f264f14f7af47c83a95e829f07127bd33c699f8');
  assert.equal(candidate.transaction_authorized_by_this_operation,false);
  assert.equal(candidate.transaction_sent_by_this_operation,false);
  assert.equal(candidate.owner_enrolled_by_this_operation,false);
  assert.equal(candidate.independent_backup_verified,false);
  assert.equal(candidate.latest_head_independently_verified,false);
  assert.equal(candidate.on_chain_state_checked,false);
  const file=JSON.parse(candidate.text),kit=file.sealed_kit,review=file.review;
  assert.equal(file.format,'bouncer-v14-local-bootstrap-candidate-v1');
  const unlocked=await openV14BootstrapRecoveryKit({kit,passphrase,crypto,expected:{owner,vault,ownerPublicKey,
    temporaryPublicKey:candidate.temporary_public_key,reviewSha256:review.review_sha256,scopeId:kit.scope_id}});
  await unlocked.useSecrets(({temporaryKey,checkpointCapability})=>{
    for(const secret of [String(temporaryKey),checkpointCapability,passphrase]) {
      assert.equal(candidate.text.includes(secret),false);
      assert.equal(JSON.stringify(candidate).includes(secret),false);
    }
    assert.equal(String(temporaryKey.getPublicKey()),candidate.temporary_public_key);
  });
  unlocked.dispose();
  const checked=await verify(candidate);
  assert.equal(checked.fingerprint,candidate.fingerprint);
  assert.equal(checked.owner_key_matches_current,true);
  assert.equal(checked.independent_backup_verified,false);
  assert.equal(checked.latest_head_independently_verified,false);
  assert.equal(checked.on_chain_state_checked,false);
  assert.equal(Object.hasOwn(checked,'text'),false);
});

test('wrong fingerprint, passphrase, account, funding, artifact, or forged file never verifies',async()=>{
  const candidate=await createV14BootstrapCandidate(input);
  const badCode=compressedV14.slice();badCode[5]^=1;
  const changedReview=JSON.parse(candidate.text);changedReview.review.stages[0].action_commitment_sha256='0'.repeat(64);
  const changedKit=JSON.parse(candidate.text);changedKit.sealed_kit.ciphertext=changedKit.sealed_kit.ciphertext.replace(/^./,c=>c==='A'?'B':'A');
  const badReview=JSON.stringify(changedReview),badKit=JSON.stringify(changedKit),whitespace=`${candidate.text}\n`;
  for(const overrides of [
    {expectedFingerprint:'0'.repeat(64)}, {passphrase:'synthetic wrong recovery passphrase'},
    {owner:'other.testnet'}, {vault:'other.great_mujey.testnet'}, {vaultFundingYocto:'1'},
    {compressedV14:badCode}, {text:badReview,expectedFingerprint:fingerprint(badReview)},
    {text:badKit,expectedFingerprint:fingerprint(badKit)}, {text:whitespace,expectedFingerprint:fingerprint(whitespace)},
    {text:'x'.repeat(30_001)},
  ]) await assert.rejects(verify(candidate,overrides),/no transaction is authorized/);
  for(const invalid of ['short',' '.repeat(16),'x'.repeat(1025)])
    await assert.rejects(createV14BootstrapCandidate({...input,passphrase:invalid}));
});

test('a changed owner key is explicitly reported rather than treated as a current authorization',async()=>{
  const candidate=await createV14BootstrapCandidate(input);
  const changed=await verify(candidate,{currentOwnerPublicKey:String(KeyPair.fromRandom('ed25519').getPublicKey())});
  assert.equal(changed.owner_key_matches_current,false);
  assert.equal(changed.transaction_authorized_by_this_operation,false);
  assert.equal(changed.owner_enrolled_by_this_operation,false);
  assert.equal(changed.latest_head_independently_verified,false);
});
