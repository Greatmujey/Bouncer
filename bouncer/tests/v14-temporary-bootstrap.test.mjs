import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import nearConnect from '@hot-labs/near-connect';
import {KeyPair} from '@near-js/crypto';
import {SignedTransaction,encodeTransaction} from '@near-js/transactions';
import {validateKnownFirstPartyActionRequest,MAX_ACTION_REQUEST_CANONICAL_JSON_LENGTH} from '@meteorwallet/connect-shared/internal';
import {syntheticV14MeteorRequest} from '../integration/v14-synthetic-meteor.mjs';
import {buildV14TemporaryBootstrapPlan,signV14TemporaryBootstrapDeployment} from '../web-src/v14-bootstrap-plan.mjs';
import {sealV14BootstrapRecoveryKit,openV14BootstrapRecoveryKit} from '../web-src/v14-bootstrap-recovery-kit.mjs';
import {encodeBase58} from '../web-src/native-oracle-transaction.mjs';

const webcrypto=crypto.webcrypto,N=10n**24n;
const compressed=new Uint8Array(fs.readFileSync(new URL('../web/artifacts/v14-research.deflate',import.meta.url)));
const owner=KeyPair.fromRandom('ed25519'),temporary=KeyPair.fromRandom('ed25519');
const opts={owner:'buyer.testnet',ownerPublicKey:String(owner.getPublicKey()),vault:'store.buyer.testnet',
  temporaryPublicKey:String(temporary.getPublicKey()),vaultFundingYocto:String(6n*N),compressedV14:compressed,crypto:webcrypto};
const scope='ab'.repeat(16),capability='cd'.repeat(32),passphrase='fixture-only long passphrase';
const expected=review=>({owner:review.owner,vault:review.vault,ownerPublicKey:review.owner_public_key,
  temporaryPublicKey:review.temporary_vault_public_key,reviewSha256:review.review_sha256,scopeId:scope});

test('the exact pinned bootstrap is small for Meteor and does not authorize or send anything',async()=>{
  const plan=await buildV14TemporaryBootstrapPlan(opts);
  assert.equal(plan.review.wallet_approval_obtained,false);assert.equal(plan.review.transaction_sent,false);
  assert.equal(plan.review.vault_wasm_sha256,'28dcba2d3a4dde6e48c2dc728f264f14f7af47c83a95e829f07127bd33c699f8');
  assert.deepEqual(plan.createActions.map(a=>a.enum),['createAccount','transfer','addKey']);
  assert.deepEqual(plan.deploymentActions.map(a=>a.enum),['deployContract','functionCall','deleteKey']);
  assert.equal(plan.deploymentActions[1].functionCall.methodName,'new');
  assert.equal(plan.deploymentActions[1].functionCall.gas,30n*10n**12n);
  assert.equal(plan.deploymentActions[1].functionCall.deposit,0n);
  assert.deepEqual(nearConnect.nearActionsToConnectorActions(plan.createActions),plan.walletRequest.actions);
  const meteor=syntheticV14MeteorRequest({signerId:opts.owner,receiverId:opts.vault,actions:plan.createActions});
  assert.equal(validateKnownFirstPartyActionRequest(meteor).ok,true);
  assert.equal(MAX_ACTION_REQUEST_CANONICAL_JSON_LENGTH,400_000);
  assert.ok(Buffer.byteLength(JSON.stringify(meteor))<4_000);
  assert.equal(JSON.stringify(plan.review).includes(String(temporary)),false);
  const different=await buildV14TemporaryBootstrapPlan({...opts,vaultFundingYocto:String(7n*N)});
  assert.notEqual(plan.review.review_sha256,different.review.review_sha256);
  assert.notEqual(plan.review.stages[0].action_commitment_sha256,different.review.stages[0].action_commitment_sha256);
});

test('altered code, wrong identity, owner key reuse and excessive funding are rejected',async()=>{
  const corrupt=new Uint8Array(compressed);corrupt[23]^=1;
  for(const change of [{compressedV14:corrupt},{owner:'buyer.near'},{vault:'other.testnet'},
    {temporaryPublicKey:opts.ownerPublicKey},{temporaryPublicKey:'ed25519:11111111111111111111111111111111'},
    {vaultFundingYocto:'0'},{vaultFundingYocto:String(11n*N)}]) {
    await assert.rejects(buildV14TemporaryBootstrapPlan({...opts,...change}));
  }
});

test('the temporary FullAccess key and checkpoint capability restore from an encrypted separate copy',async()=>{
  const {review}=await buildV14TemporaryBootstrapPlan(opts);
  const kit=await sealV14BootstrapRecoveryKit({review,temporaryKey:temporary,scopeId:scope,checkpointCapability:capability,passphrase,crypto:webcrypto});
  const copy=JSON.stringify(kit);
  assert.equal(copy.includes(String(temporary)),false);assert.equal(copy.includes(capability),false);
  const recovered=await openV14BootstrapRecoveryKit({kit:JSON.parse(copy),expected:expected(review),passphrase,crypto:webcrypto});
  assert.equal(JSON.stringify(recovered).includes(String(temporary)),false);
  await recovered.useSecrets(({temporaryKey,checkpointCapability})=>{
    assert.equal(String(temporaryKey.getPublicKey()),opts.temporaryPublicKey);
    assert.equal(checkpointCapability,capability);
    const message=new Uint8Array([1,2,3]);const sig=temporaryKey.sign(message);
    assert.equal(temporary.getPublicKey().verify(message,sig.signature),true);
  });
  recovered.dispose();await assert.rejects(recovered.useSecrets(()=>{}));
  await assert.rejects(openV14BootstrapRecoveryKit({kit,expected:expected(review),passphrase:'wrong fixture passphrase',crypto:webcrypto}));
  const altered={...kit,ciphertext:kit.ciphertext.slice(0,-4)+(kit.ciphertext.slice(-4)==='AAAA'?'BBBB':'AAAA')};
  await assert.rejects(openV14BootstrapRecoveryKit({kit:altered,expected:expected(review),passphrase,crypto:webcrypto}));
  await assert.rejects(openV14BootstrapRecoveryKit({kit,expected:{...expected(review),vault:'other.buyer.testnet'},passphrase,crypto:webcrypto}));
  await assert.rejects(sealV14BootstrapRecoveryKit({review,temporaryKey:owner,scopeId:scope,checkpointCapability:capability,passphrase,crypto:webcrypto}));
  await assert.rejects(sealV14BootstrapRecoveryKit({review:{...review,vault_funding_yocto:'1'},temporaryKey:temporary,
    scopeId:scope,checkpointCapability:capability,passphrase,crypto:webcrypto}));
});

test('one signed deployment commits to the independently reviewed pinned actions, before broadcast',async()=>{
  const {review}=await buildV14TemporaryBootstrapPlan(opts),blockHash=encodeBase58(crypto.randomBytes(32));
  const input={review,expectedReviewSha256:review.review_sha256,compressedV14:compressed,temporaryKey:temporary,
    nonce:'1',blockHash,crypto:webcrypto};
  const original=await signV14TemporaryBootstrapDeployment(input);
  assert.equal(original.status,'SIGNED_NOT_BROADCAST');assert.equal(original.transaction_sent,false);
  const decoded=SignedTransaction.decode(original.signed_bytes);
  assert.deepEqual(Buffer.from(encodeTransaction(decoded)),Buffer.from(original.signed_bytes));
  const unsigned=encodeTransaction(decoded.transaction),hash=crypto.createHash('sha256').update(unsigned).digest();
  assert.equal(original.transaction_hash,encodeBase58(hash));
  assert.equal(decoded.transaction.signerId,opts.vault);assert.equal(decoded.transaction.receiverId,opts.vault);
  assert.deepEqual(decoded.transaction.actions.map(a=>Object.keys(a)[0]),['deployContract','functionCall','deleteKey']);
  assert.equal(temporary.getPublicKey().verify(hash,Uint8Array.from(decoded.signature.ed25519Signature.data)),true);
  await assert.rejects(signV14TemporaryBootstrapDeployment({...input,nonce:'0'}));
  await assert.rejects(signV14TemporaryBootstrapDeployment({...input,expectedReviewSha256:'0'.repeat(64)}));
  await assert.rejects(signV14TemporaryBootstrapDeployment({...input,temporaryKey:owner}));
  await assert.rejects(signV14TemporaryBootstrapDeployment({...input,review:{...review,vault:'other.buyer.testnet'}}));
});
