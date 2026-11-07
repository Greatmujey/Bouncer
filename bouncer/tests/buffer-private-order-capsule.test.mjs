import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { KeyPair } from '@near-js/crypto';
import { nep413Payload } from '../web-src/cli-login.mjs';
import { createPrivateOrderKey, sealPrivateOrder, openPrivateOrder, privateOrderCapsuleCommitment } from '../web-src/buffer-private-order-capsule.mjs';

const owner='buyer.testnet', location={origin:'https://bouncer.example.test',host:'bouncer.example.test'}, attemptId='ab'.repeat(16);
const order={brief:'A private research request: assess real testnet markets.',sku:'weekly-market-brief',
  orderId:'01234567-89ab-cdef-0123-456789abcdef',onchainOrderId:'o-123456abcdef',accessToken:'af'.repeat(24)};
function setup() {
  const key=KeyPair.fromRandom('ed25519'), ownerPublicKey=String(key.getPublicKey()), calls=[], signatures=[];
  const wallet={manifest:{id:'meteor'},signMessage:async options=>{
    calls.push(options);
    const digest=new Uint8Array(await webcrypto.subtle.digest('SHA-256',nep413Payload(options)));
    const signature=Buffer.from(key.sign(digest).signature).toString('base64'); signatures.push(signature);
    return {accountId:owner,publicKey:ownerPublicKey,signature};
  }};
  const fetch=async (url,options)=>{
    assert.equal(url,'https://test.rpc.fastnear.com');
    const body=JSON.parse(options.body); assert.equal(body.method,'query'); assert.equal(body.params.request_type,'view_access_key');
    return new Response(JSON.stringify({jsonrpc:'2.0',id:'bouncer-cli-login',result:{permission:'FullAccess'}}));
  };
  return {wallet,ownerPublicKey,fetch,calls,signatures,crypto:webcrypto,owner,location};
}

test('wallet-unlockable capsule seals the bearer and brief; only the same private signature opens it', async () => {
  const args=setup(), keyRecord=await createPrivateOrderKey(args);
  const capsule=await sealPrivateOrder({keyRecord,attemptId,privateOrder:order,crypto:webcrypto});
  const saved=JSON.stringify({keyRecord,capsule});
  assert.ok(!saved.includes(order.accessToken)); assert.ok(!saved.includes(order.brief));
  assert.ok(!saved.includes(args.signatures[0]));
  const trustedCapsuleSha256=await privateOrderCapsuleCommitment({capsule,crypto:webcrypto});
  assert.deepEqual(await openPrivateOrder({...args,keyRecord,capsule,trustedCapsuleSha256}),order);
  assert.equal(args.calls.length,3); assert.deepEqual(args.calls[0].nonce,args.calls[1].nonce);
  assert.equal(args.signatures[0],args.signatures[1]);
  assert.equal(args.calls[0].message,args.calls[1].message);
  assert.equal(args.calls[0].recipient,location.host);
  assert.ok(args.calls[0].message.includes('not a transaction'));
  assert.equal(args.calls.some(x=>x.actions || x.receiverId),false);
});

test('site, key, owner, capsule and ciphertext tampering fail closed', async () => {
  const args=setup(), keyRecord=await createPrivateOrderKey(args), capsule=await sealPrivateOrder({keyRecord,attemptId,privateOrder:order,crypto:webcrypto});
  const trustedCapsuleSha256=await privateOrderCapsuleCommitment({capsule,crypto:webcrypto});
  const open=(record,data,extra={})=>openPrivateOrder({...args,keyRecord:record,capsule:data,trustedCapsuleSha256,...extra});
  await assert.rejects(open(keyRecord,capsule,{location:{origin:'https://evil.example.test',host:'evil.example.test'}}),/CAPSULE_UNAVAILABLE/);
  await assert.rejects(open({...keyRecord,owner:'other.testnet'},capsule),/CAPSULE_UNAVAILABLE/);
  await assert.rejects(open({...keyRecord,public_key_sha256:'0'.repeat(64)},capsule),/CAPSULE_UNAVAILABLE/);
  await assert.rejects(open(keyRecord,{...capsule,attempt_id:'ff'.repeat(16)}),/CAPSULE_UNAVAILABLE/);
  await assert.rejects(open(keyRecord,{...capsule,owner:'other.testnet'}),/CAPSULE_UNAVAILABLE/);
  const ciphertext=Buffer.from(capsule.ciphertext,'base64'); ciphertext[4]^=1;
  await assert.rejects(open(keyRecord,{...capsule,ciphertext:ciphertext.toString('base64')}),/CAPSULE_UNAVAILABLE/);
  const secret=Buffer.from(keyRecord.wrapped_private,'base64'); secret[4]^=1;
  await assert.rejects(open({...keyRecord,wrapped_private:secret.toString('base64')},capsule),/CAPSULE_UNAVAILABLE/);
  const other=setup(); await assert.rejects(open(keyRecord,capsule,{wallet:other.wallet}),/CAPSULE_UNAVAILABLE/);
  const forged=await sealPrivateOrder({keyRecord,attemptId,privateOrder:{...order,brief:'A forged private seller response.'},crypto:webcrypto});
  await assert.rejects(open(keyRecord,forged),/CAPSULE_UNAVAILABLE/);
  await assert.rejects(open(keyRecord,capsule,{trustedCapsuleSha256:undefined}),/CAPSULE_UNAVAILABLE/);
});

test('limited-key access, invalid orders, and unsigned or mismatched wallets cannot enroll', async () => {
  const args=setup();
  const limited=async ()=>new Response(JSON.stringify({jsonrpc:'2.0',id:'bouncer-cli-login',result:{permission:{FunctionCall:{}}}}));
  await assert.rejects(createPrivateOrderKey({...args,fetch:limited}),/CAPSULE_UNAVAILABLE/);
  await assert.rejects(createPrivateOrderKey({...args,wallet:{signMessage:async()=>({})}}),/CAPSULE_UNAVAILABLE/);
  const keyRecord=await createPrivateOrderKey(args);
  await assert.rejects(sealPrivateOrder({keyRecord,attemptId,crypto:webcrypto,privateOrder:{...order,accessToken:'not-a-token'}}),/CAPSULE_UNAVAILABLE/);
  await assert.rejects(sealPrivateOrder({keyRecord,attemptId:'bad',crypto:webcrypto,privateOrder:order}),/CAPSULE_UNAVAILABLE/);
  await assert.rejects(sealPrivateOrder({keyRecord,attemptId,crypto:webcrypto,privateOrder:{...order,extra:'unexpected'}}),/CAPSULE_UNAVAILABLE/);
});

test('seals only a matching fixed Buffer response and returns no plaintext bearer or brief', async () => {
  const { createHash } = await import('node:crypto');
  const { sealCheckedFixedBufferOrder } = await import('../agent/buffer-private-order-seal.mjs');
  const { CIRCLE_TESTNET_USDC: token } = await import('../scripts/circle-testnet-setup.mjs');
  const { BUFFER_TESTNET_CONTRACT: seller } = await import('../experiments/buffer-forwarder/build.mjs');
  const args=setup(), keyRecord=await createPrivateOrderKey(args), agent1=String(KeyPair.fromRandom('ed25519').getPublicKey()),
    agent2=String(KeyPair.fromRandom('ed25519').getPublicKey());
  const terms={owner,vault:'vault.buyer.testnet',adapter:'forward.buyer.testnet',forwarder_agent_public_key:agent1,
    vault_agent_public_key:agent2,policy_id:'test',intent_id:'trial',amount:'20000000',expires_at_ms:Date.now()+60_000,
    native_return_cap:'1000000000000000000000000',native_reserve:'1000000000000000000000000',
    api_order_id:order.orderId,onchain_order_id:order.onchainOrderId,sku:order.sku,
    brief_sha256:createHash('sha256').update(order.brief).digest('hex')};
  const request={brief:order.brief,sku:order.sku,customerAccount:terms.adapter};
  const response={orderId:order.orderId,onchainOrderId:order.onchainOrderId,accessToken:order.accessToken,
    payment:{tokenContract:token,method:'ft_transfer_call',args:{receiver_id:seller,amount:terms.amount,
      msg:JSON.stringify({order_id:order.onchainOrderId,sku:order.sku})},attachedDeposit:'1 yoctoNEAR',gas:'100 Tgas'},nearCliCommand:'unused'};
  const input={terms,request,response,keyRecord,trustedPublicKeySha256:keyRecord.public_key_sha256,attemptId,crypto:webcrypto};
  const out=await sealCheckedFixedBufferOrder(input), text=JSON.stringify(out);
  assert.ok(!text.includes(order.accessToken)); assert.ok(!text.includes(order.brief));
  assert.equal(out.retained,false); assert.equal(out.independently_witnessed,false); assert.equal(out.delivered,false);
  assert.deepEqual(await openPrivateOrder({...args,keyRecord,capsule:out.capsule,trustedCapsuleSha256:out.capsule_sha256}),order);
  await assert.rejects(sealCheckedFixedBufferOrder({...input,response:{...response,payment:{...response.payment,tokenContract:'attacker.testnet'}}}),/UNAVAILABLE/);
  await assert.rejects(sealCheckedFixedBufferOrder({...input,trustedPublicKeySha256:'0'.repeat(64)}),/UNAVAILABLE/);
  await assert.rejects(sealCheckedFixedBufferOrder({...input,request:{...request,brief:'Changed private research brief.'}}),/UNAVAILABLE/);
});
